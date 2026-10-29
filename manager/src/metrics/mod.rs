//! Host-level CPU, memory and disk usage for the dashboard, sampled into the
//! database on a tick so the panel can draw history instead of only what
//! arrived while the page was open.

use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use futures::StreamExt;
use serde::Serialize;

use crate::database::{ContainerSample, Db, HostPoint};
use crate::docker::{COMPOSE_PROJECT_LABEL, COMPOSE_SERVICE_LABEL, Docker};

/// Between readings, and the resolution every chart is drawn at: the API refuses
/// to bucket finer. A minute keeps a week at ten thousand host rows.
pub const INTERVAL: Duration = Duration::from_secs(60);

/// How far back readings are kept; the scheduler prunes the rest.
pub const RETENTION: Duration = Duration::from_secs(7 * 24 * 3600);

/// Bounds concurrent Docker stats calls. Each blocks for a CPU cycle, so they
/// run together, but not unbounded on a busy host.
const PARALLEL_SAMPLES: usize = 8;

/// The snapshot rendered on the dashboard.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Host {
	pub cpu_percent: f64,
	pub memory_used: u64,
	pub memory_total: u64,
	pub disk_used: u64,
	pub disk_total: u64,
	pub load_average: f64,
}

/// Samples the host; `path` selects the filesystem reported as disk usage. The
/// platform targets Linux; elsewhere the /proc reads find nothing and the
/// dashboard shows zeros rather than wrong numbers.
pub async fn read(path: &str) -> Host {
	let (memory_used, memory_total) = memory();
	let (disk_used, disk_total) = disk(path);
	Host { cpu_percent: cpu_percent().await, memory_used, memory_total, disk_used, disk_total, load_average: load_average() }
}

/// Samples /proc/stat twice; containers see the host file, which is exactly
/// what the dashboard should report.
async fn cpu_percent() -> f64 {
	let Some((first, first_idle)) = cpu_totals() else { return 0.0 };
	tokio::time::sleep(Duration::from_millis(200)).await;
	let Some((second, second_idle)) = cpu_totals() else { return 0.0 };
	let total = second.saturating_sub(first) as f64;
	let idle = second_idle.saturating_sub(first_idle) as f64;
	if total <= 0.0 { 0.0 } else { (total - idle) / total * 100.0 }
}

fn cpu_totals() -> Option<(u64, u64)> {
	let body = std::fs::read_to_string("/proc/stat").ok()?;
	let line = body.lines().find(|line| line.starts_with("cpu "))?;
	let (mut total, mut idle) = (0, 0);
	for (i, field) in line.split_whitespace().skip(1).enumerate() {
		let Ok(v) = field.parse::<u64>() else { continue };
		total += v;
		// Fields 3 and 4 are idle and iowait.
		if i == 3 || i == 4 {
			idle += v;
		}
	}
	Some((total, idle))
}

fn memory() -> (u64, u64) {
	let Ok(body) = std::fs::read_to_string("/proc/meminfo") else { return (0, 0) };
	let mut values: HashMap<&str, u64> = HashMap::new();
	for line in body.lines() {
		let parts: Vec<&str> = line.split_whitespace().collect();
		if parts.len() < 2 {
			continue;
		}
		if let Ok(v) = parts[1].parse::<u64>() {
			values.insert(parts[0].trim_end_matches(':'), v * 1024);
		}
	}
	let total = values.get("MemTotal").copied().unwrap_or(0);
	let value = |key: &str| values.get(key).copied().unwrap_or(0);
	let available = values.get("MemAvailable").copied().unwrap_or_else(|| value("MemFree") + value("Buffers") + value("Cached"));
	(total.saturating_sub(available), total)
}

fn disk(path: &str) -> (u64, u64) {
	let Ok(c_path) = std::ffi::CString::new(path) else { return (0, 0) };
	let mut fs: libc::statvfs = unsafe { std::mem::zeroed() };
	// SAFETY: c_path is a valid NUL-terminated string and fs is a properly sized out-parameter.
	if unsafe { libc::statvfs(c_path.as_ptr(), &mut fs) } != 0 {
		return (0, 0);
	}
	let block = fs.f_frsize as u64;
	let total = fs.f_blocks as u64 * block;
	let free = fs.f_bavail as u64 * block;
	(total.saturating_sub(free), total)
}

fn load_average() -> f64 {
	std::fs::read_to_string("/proc/loadavg")
		.ok()
		.and_then(|body| body.split_whitespace().next().and_then(|v| v.parse().ok()))
		.unwrap_or(0.0)
}

/// Writes host and container readings on a fixed tick. Without it nothing is
/// recorded: the SSE endpoints only sample while a browser is watching.
pub struct Sampler {
	db: Arc<Db>,
	docker: Arc<Docker>,
	root: String,
}

impl Sampler {
	pub fn new(db: Arc<Db>, docker: Arc<Docker>, root: String) -> Sampler {
		Sampler { db, docker, root }
	}

	pub async fn run(self) {
		let mut ticker = tokio::time::interval(INTERVAL);
		loop {
			ticker.tick().await;
			self.sample().await;
		}
	}

	async fn sample(&self) {
		let at = chrono::Utc::now().timestamp();
		let host = read(&self.root).await;
		let point = HostPoint {
			at,
			cpu_percent: host.cpu_percent,
			memory_used: host.memory_used,
			memory_total: host.memory_total,
			disk_used: host.disk_used,
			disk_total: host.disk_total,
		};
		if let Err(err) = self.db.record_host_metric(at, &point) {
			tracing::warn!(component = "metrics", error = %format!("{err:#}"), "record host metrics");
		}
		let samples = match self.containers().await {
			Ok(samples) => samples,
			Err(err) => {
				tracing::warn!(component = "metrics", error = %format!("{err:#}"), "sample containers");
				return;
			}
		};
		if let Err(err) = self.db.record_container_metrics(at, &samples) {
			tracing::warn!(component = "metrics", error = %format!("{err:#}"), "record container metrics");
		}
	}

	/// Every running container, tagged with the service it belongs to when the
	/// platform manages it.
	async fn containers(&self) -> Result<Vec<ContainerSample>> {
		let running = self.docker.list_containers("").await?;
		let services = &self.service_ids()?;
		let running = running.into_iter().filter(|c| c.state.map(|s| s.to_string()).as_deref() == Some("running"));
		let samples = futures::stream::iter(running)
			.map(|summary| async move {
				let id = summary.id.clone().unwrap_or_default();
				// A container that stopped mid-tick is normal, not worth a log line.
				let sample = self.docker.sample(&id).await.ok()?;
				let labels = summary.labels.unwrap_or_default();
				let label = |key: &str| labels.get(key).cloned().unwrap_or_default();
				let key = format!("{}/{}", label(COMPOSE_PROJECT_LABEL), label(COMPOSE_SERVICE_LABEL));
				Some(ContainerSample {
					container_id: id,
					service_id: services.get(&key).cloned().unwrap_or_default(),
					cpu_percent: sample.cpu_percent,
					memory_usage: sample.memory_usage,
					memory_limit: sample.memory_limit,
					network_rx: sample.network_rx,
					network_tx: sample.network_tx,
					block_read: sample.block_read,
					block_write: sample.block_write,
				})
			})
			.buffer_unordered(PARALLEL_SAMPLES)
			.filter_map(|sample| async move { sample })
			.collect()
			.await;
		Ok(samples)
	}

	/// Maps compose project and service labels to platform service ids. The
	/// compose project label names an environment, not a project, so the walk
	/// goes through environments or staging's containers land on production's services.
	fn service_ids(&self) -> Result<HashMap<String, String>> {
		let mut ids = HashMap::new();
		for project in self.db.list_projects()? {
			for env in self.db.list_environments(&project.id)? {
				for service in self.db.list_services(&env.id)? {
					ids.insert(format!("{}/{}", env.compose_project_name, service.compose_service_name), service.id);
				}
			}
		}
		Ok(ids)
	}
}
