use anyhow::{Result, anyhow};
use bollard::models::{ContainerMemoryStats, ContainerStatsResponse};
use bollard::query_parameters::StatsOptions;
use futures::StreamExt;
use serde::Serialize;

use super::Docker;

/// The flattened per-container metric the UI renders.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Sample {
	pub container_id: String,
	pub name: String,
	pub cpu_percent: f64,
	pub memory_usage: u64,
	pub memory_limit: u64,
	pub memory_percent: f64,
	pub network_rx: u64,
	pub network_tx: u64,
	pub block_read: u64,
	pub block_write: u64,
	pub pids: u64,
}

/// Converts a raw Docker stats frame. CPU percentage needs the previous frame
/// embedded in the response, which the Engine provides.
pub fn sample_from(s: &ContainerStatsResponse) -> Sample {
	let memory = s.memory_stats.clone().unwrap_or_default();
	let mut sample = Sample {
		container_id: s.id.clone().unwrap_or_default(),
		name: s.name.clone().unwrap_or_default().trim_start_matches('/').to_string(),
		memory_usage: memory_usage(&memory),
		memory_limit: memory.limit.unwrap_or(0),
		pids: s.pids_stats.as_ref().and_then(|p| p.current).unwrap_or(0),
		..Default::default()
	};
	if sample.memory_limit > 0 {
		sample.memory_percent = sample.memory_usage as f64 / sample.memory_limit as f64 * 100.0;
	}
	sample.cpu_percent = cpu_percent(s);
	for n in s.networks.as_ref().into_iter().flat_map(|n| n.values()) {
		sample.network_rx += n.rx_bytes.unwrap_or(0);
		sample.network_tx += n.tx_bytes.unwrap_or(0);
	}
	let entries = s.blkio_stats.as_ref().and_then(|b| b.io_service_bytes_recursive.clone()).unwrap_or_default();
	for e in entries {
		match e.op.as_deref() {
			Some("read" | "Read") => sample.block_read += e.value.unwrap_or(0),
			Some("write" | "Write") => sample.block_write += e.value.unwrap_or(0),
			_ => {}
		}
	}
	sample
}

impl Docker {
	/// Reads one container once. The Engine waits for a second CPU cycle before
	/// answering, which makes the CPU percentage meaningful; the one-shot
	/// endpoint returns no previous cycle and would always report zero.
	pub async fn sample(&self, id: &str) -> Result<Sample> {
		let mut stats = self.api.stats(id, Some(StatsOptions { stream: false, one_shot: false }));
		let frame = stats.next().await.ok_or_else(|| anyhow!("no stats for {id}"))??;
		Ok(sample_from(&frame))
	}
}

/// Subtracts the page cache the way `docker stats` does, so the panel matches the CLI.
fn memory_usage(m: &ContainerMemoryStats) -> u64 {
	let usage = m.usage.unwrap_or(0);
	let stats = m.stats.clone().unwrap_or_default();
	for key in ["inactive_file", "total_inactive_file"] {
		if let Some(&v) = stats.get(key)
			&& v < usage
		{
			return usage - v;
		}
	}
	let cache = stats.get("cache").copied().unwrap_or(0);
	if cache < usage { usage - cache } else { usage }
}

fn cpu_percent(s: &ContainerStatsResponse) -> f64 {
	let cpu = s.cpu_stats.clone().unwrap_or_default();
	let pre = s.precpu_stats.clone().unwrap_or_default();
	let total = |c: &bollard::models::ContainerCpuStats| c.cpu_usage.as_ref().and_then(|u| u.total_usage).unwrap_or(0) as f64;
	let cpu_delta = total(&cpu) - total(&pre);
	let system_delta = cpu.system_cpu_usage.unwrap_or(0) as f64 - pre.system_cpu_usage.unwrap_or(0) as f64;
	if cpu_delta <= 0.0 || system_delta <= 0.0 {
		return 0.0;
	}
	let mut cpus = cpu.online_cpus.unwrap_or(0) as f64;
	if cpus == 0.0 {
		cpus = cpu.cpu_usage.as_ref().and_then(|u| u.percpu_usage.as_ref()).map_or(0, Vec::len) as f64;
	}
	if cpus == 0.0 {
		cpus = 1.0;
	}
	cpu_delta / system_delta * cpus * 100.0
}
