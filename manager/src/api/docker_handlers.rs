use std::collections::HashMap;
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use bollard::models::Port;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::Server;
use super::project_handlers::{container_state, label};
use super::respond::{ApiError, ApiResult, bad_request, decode, done, ok, server_error};
use crate::database::ContainerUsage;
use crate::docker::{self, TailWriter};
use crate::metrics;

/// How much recorded history the containers list carries per row, bucketed at
/// the sampler's own resolution so one bucket is one reading.
const USAGE_WINDOW_SECS: i64 = 30 * 60;

/// Bounds a manual image pull; a large image on a slow link is minutes, a
/// stuck registry connection is forever.
const PULL_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// What a pull keeps of the daemon's progress stream. It reports every layer
/// several times a second, megabytes nobody reads; the tail carries the result.
const PULL_OUTPUT_LIMIT: usize = 64 * 1024;

/// The shape the Docker Resources screens render. Foreign containers are
/// listed but flagged, so the platform never pretends to manage stacks it did
/// not create.
#[derive(Serialize)]
struct ContainerView {
	id: String,
	names: Vec<String>,
	image: String,
	state: String,
	status: String,
	created: i64,
	labels: HashMap<String, String>,
	managed: bool,
	project: String,
	service: String,
	networks: Vec<String>,
	ports: Vec<PortView>,
	/// Recorded by the sampler, so a container younger than one tick has none.
	#[serde(flatten)]
	usage: ContainerUsage,
}

/// A port bound on the host; ip is "0.0.0.0" or "::" when it listens on every address.
#[derive(Serialize)]
pub(super) struct PortView {
	ip: String,
	published: u16,
	target: u16,
	protocol: String,
}

/// The ports a container publishes on the host; an exposed but unpublished
/// port has no host side.
pub(super) fn host_ports(ports: &[Port]) -> Vec<PortView> {
	ports
		.iter()
		.filter_map(|p| {
			let published = p.public_port.filter(|port| *port != 0)?;
			Some(PortView {
				ip: p.ip.clone().unwrap_or_default(),
				published,
				target: p.private_port,
				protocol: p.typ.map(|t| t.to_string()).unwrap_or_default(),
			})
		})
		.collect()
}

pub async fn list_containers(State(s): State<Arc<Server>>) -> ApiResult {
	let containers = s.docker.list_containers("").await?;
	let managed = s.db.compose_project_names()?;
	let since = chrono::Utc::now().timestamp() - USAGE_WINDOW_SECS;
	let mut usage = s.db.container_usage(since, metrics::INTERVAL.as_secs() as i64)?;
	let mut out = Vec::new();
	for c in &containers {
		let id = c.id.clone().unwrap_or_default();
		let project = label(c, docker::COMPOSE_PROJECT_LABEL).to_string();
		out.push(ContainerView {
			names: c.names.clone().unwrap_or_default(),
			image: c.image.clone().unwrap_or_default(),
			state: container_state(c),
			status: c.status.clone().unwrap_or_default(),
			created: c.created.unwrap_or_default(),
			labels: c.labels.clone().unwrap_or_default(),
			managed: managed.contains(&project),
			service: label(c, docker::COMPOSE_SERVICE_LABEL).to_string(),
			networks: c
				.network_settings
				.as_ref()
				.and_then(|n| n.networks.as_ref())
				.map(|n| n.keys().cloned().collect())
				.unwrap_or_default(),
			ports: host_ports(c.ports.as_deref().unwrap_or_default()),
			usage: usage.remove(&id).unwrap_or_default(),
			project,
			id,
		});
	}
	ok(&out)
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct ForceQuery {
	force: String,
}

pub async fn container_action_route(
	State(s): State<Arc<Server>>,
	Path((id, action)): Path<(String, String)>,
	Query(q): Query<ForceQuery>,
) -> ApiResult {
	container_action(&s, &id, &action, q.force == "true").await
}

/// Runs one lifecycle verb on a container. The service route only ever routes
/// start, stop and restart; remove is reachable through the raw container
/// route alone.
pub(super) async fn container_action(s: &Server, id: &str, action: &str, force: bool) -> ApiResult {
	match action {
		"start" => s.docker.start(id).await?,
		"stop" => s.docker.stop(id).await?,
		"restart" => s.docker.restart(id).await?,
		"remove" => s.docker.remove(id, force).await?,
		_ => return Err(bad_request("unsupported container action")),
	}
	done()
}

/// Keeps the four Docker Resources screens on one convention instead of the
/// SDK's own shapes.
#[derive(Serialize)]
struct ImageView {
	id: String,
	repo_tags: Vec<String>,
	created: i64,
	size: i64,
	containers: Vec<ImageContainer>,
}

#[derive(Serialize, Clone)]
struct ImageContainer {
	id: String,
	name: String,
}

pub async fn list_images(State(s): State<Arc<Server>>) -> ApiResult {
	let images = s.docker.list_images().await?;
	let containers = s.docker.list_containers("").await?;
	let mut by_image: HashMap<String, Vec<ImageContainer>> = HashMap::new();
	for c in containers {
		let name = c.names.as_ref().and_then(|n| n.first()).map(|n| n.trim_start_matches('/').to_string()).unwrap_or_default();
		by_image.entry(c.image_id.unwrap_or_default()).or_default().push(ImageContainer { id: c.id.unwrap_or_default(), name });
	}
	let out: Vec<ImageView> = images
		.into_iter()
		.map(|img| ImageView {
			containers: by_image.get(&img.id).cloned().unwrap_or_default(),
			id: img.id,
			repo_tags: img.repo_tags,
			created: img.created,
			size: img.size,
		})
		.collect();
	ok(&out)
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct PullImage {
	reference: String,
}

/// Waits for the pull and answers with the daemon's own progress output in one payload.
pub async fn pull_image(State(s): State<Arc<Server>>, body: Bytes) -> ApiResult {
	let req: PullImage = decode(&body)?;
	let reference = req.reference.trim().to_string();
	if reference.is_empty() || reference.starts_with('-') {
		return Err(bad_request("a valid image reference is required"));
	}
	// The pull must finish even if the client disconnects: the image is what
	// the operator asked for, not the response body.
	let pull = tokio::spawn(async move {
		let mut out = TailWriter::new(PULL_OUTPUT_LIMIT);
		let result = tokio::time::timeout(PULL_TIMEOUT, s.docker.pull_image(&reference, &mut out)).await;
		result.unwrap_or_else(|_| Err(anyhow::anyhow!("the pull timed out"))).map(|()| out.string())
	});
	let output = pull.await.map_err(|err| server_error(err.into()))?.map_err(bad_request)?;
	ok(&json!({"output": output}))
}

pub async fn remove_image(State(s): State<Arc<Server>>, Path(id): Path<String>, Query(q): Query<ForceQuery>) -> ApiResult {
	s.docker.remove_image(&id, q.force == "true").await.map_err(bad_request)?;
	done()
}

#[derive(Serialize)]
struct VolumeView {
	name: String,
	project: String,
	driver: String,
	created_at: String,
	/// size and ref_count are -1 when Docker did not report usage data.
	size: i64,
	ref_count: i64,
}

pub async fn list_volumes(State(s): State<Arc<Server>>) -> ApiResult {
	let out: Vec<VolumeView> = s
		.docker
		.volume_usage()
		.await?
		.into_iter()
		.map(|v| VolumeView {
			project: v.labels.get(docker::COMPOSE_PROJECT_LABEL).cloned().unwrap_or_default(),
			size: v.usage_data.as_ref().map_or(-1, |u| u.size),
			ref_count: v.usage_data.as_ref().map_or(-1, |u| u.ref_count),
			created_at: v.created_at.unwrap_or_default(),
			name: v.name,
			driver: v.driver,
		})
		.collect();
	ok(&out)
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct ConfirmQuery {
	confirm: String,
}

fn confirmation_required(message: &str) -> ApiError {
	ApiError::new(StatusCode::PRECONDITION_REQUIRED, "CONFIRMATION_REQUIRED", message)
}

pub async fn remove_volume(State(s): State<Arc<Server>>, Path(name): Path<String>, Query(q): Query<ConfirmQuery>) -> ApiResult {
	// Deleting a volume destroys data; the client must confirm explicitly.
	if q.confirm != "true" {
		return Err(confirmation_required("Deleting a volume is irreversible. Repeat the request with confirm=true."));
	}
	s.docker.remove_volume(&name, false).await.map_err(bad_request)?;
	done()
}

#[derive(Serialize)]
struct NetworkView {
	id: String,
	name: String,
	driver: String,
	scope: String,
	subnets: Vec<String>,
	labels: HashMap<String, String>,
	containers: Vec<NetworkContainer>,
}

#[derive(Serialize)]
struct NetworkContainer {
	id: String,
	name: String,
	ipv4: String,
}

pub async fn list_networks(State(s): State<Arc<Server>>) -> ApiResult {
	let mut out = Vec::new();
	for n in s.docker.list_networks().await? {
		let id = n.id.clone().unwrap_or_default();
		let mut view = NetworkView {
			name: n.name.unwrap_or_default(),
			driver: n.driver.unwrap_or_default(),
			scope: n.scope.unwrap_or_default(),
			labels: n.labels.unwrap_or_default(),
			containers: Vec::new(),
			subnets: Vec::new(),
			id,
		};
		// A network that cannot be inspected still belongs in the list; it just
		// has no membership to show.
		if let Ok(inspect) = s.docker.inspect_network(&view.id).await {
			for (id, c) in inspect.containers.unwrap_or_default() {
				view.containers.push(NetworkContainer { id, name: c.name.unwrap_or_default(), ipv4: c.ipv4_address.unwrap_or_default() });
			}
			for cfg in inspect.ipam.and_then(|i| i.config).unwrap_or_default() {
				if let Some(subnet) = cfg.subnet.filter(|s| !s.is_empty()) {
					view.subnets.push(subnet);
				}
			}
		}
		out.push(view);
	}
	ok(&out)
}

/// What a cleanup would reclaim, without touching anything. Nothing is ever
/// pruned automatically.
pub async fn cleanup_preview(State(s): State<Arc<Server>>) -> ApiResult {
	let usage = s.docker.disk_usage().await?;
	let (mut unused_images, mut stopped_containers, mut unused_volumes, mut build_cache) = (0i64, 0i64, 0i64, 0i64);
	let mut in_use = std::collections::HashSet::new();
	for c in usage.containers.unwrap_or_default() {
		in_use.insert(c.image_id.clone().unwrap_or_default());
		if c.state.map(|s| s.to_string()).as_deref() != Some("running") {
			stopped_containers += c.size_rw.unwrap_or_default();
		}
	}
	for img in usage.images.unwrap_or_default() {
		if img.containers == 0 && !in_use.contains(&img.id) {
			unused_images += img.size;
		}
	}
	for v in usage.volumes.unwrap_or_default() {
		if let Some(u) = v.usage_data.filter(|u| u.ref_count == 0) {
			unused_volumes += u.size;
		}
	}
	for c in usage.build_cache.unwrap_or_default() {
		if !c.in_use.unwrap_or_default() {
			build_cache += c.size.unwrap_or_default();
		}
	}
	ok(&json!({
		"unused_images": unused_images,
		"build_cache": build_cache,
		"stopped_containers": stopped_containers,
		"unused_volumes": unused_volumes,
		"layers_size": usage.layers_size.unwrap_or_default(),
	}))
}

pub async fn cleanup(State(s): State<Arc<Server>>, Path(kind): Path<String>, Query(q): Query<ConfirmQuery>) -> ApiResult {
	// An image can be pulled again and a network recreated, but an unused
	// volume is data: pruning is the same irreversible delete as removing one by
	// name and asks for the same confirmation.
	if kind == "volumes" && q.confirm != "true" {
		return Err(confirmation_required("Pruning unused volumes is irreversible. Repeat the request with confirm=true."));
	}
	ok(&s.docker.prune(&kind).await.map_err(bad_request)?)
}
