use std::collections::{BTreeMap, HashMap};
use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::Response;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use super::respond::{ApiError, ApiResult, bad_request, created, decode, done, json, ok};
use super::{Server, sse};
use crate::database::{Deployment, Registry};
use crate::domains;
use crate::events;
use crate::metrics;
use crate::projects;
use crate::security;
use crate::updater::{self, Status};

/// How many buckets a metrics window is reduced to. A chart is a few hundred
/// pixels wide, so anything denser is transferred for nothing.
const METRICS_POINTS: i64 = 240;

/// How often a live stats stream pushes. Usage numbers are read at a glance,
/// and a faster stream only spends CPU on both ends.
pub(super) const STATS_INTERVAL: Duration = Duration::from_secs(60);

impl Server {
	/// Runs the readiness probes and reports whether the platform is healthy
	/// overall. Shared by the public health endpoint and the update preflight,
	/// so both refuse or pass on identical grounds. The nginx probe is a docker
	/// exec, so it only runs when its result will be read.
	async fn health_checks(&self, with_nginx: bool) -> (BTreeMap<&'static str, String>, bool) {
		let mut checks = BTreeMap::new();
		let mut healthy = true;
		let mut record = |name: &'static str, result: anyhow::Result<()>| {
			let verdict = match result {
				Ok(()) => "ok".to_string(),
				Err(err) => {
					healthy = false;
					format!("{err:#}")
				}
			};
			checks.insert(name, verdict);
		};
		record("database", self.db.ping());
		record("docker", self.docker.ping().await);
		record("storage", writable(&self.cfg.data_dir));

		let host = metrics::read(&self.cfg.root).await;
		if host.disk_total > 0 && host.disk_total - host.disk_used < 512 << 20 {
			record("disk", Err(anyhow::anyhow!("less than 512 MB free")));
		} else {
			record("disk", Ok(()));
		}

		// A failing proxy is reported but does not make the manager unhealthy:
		// the panel must stay reachable precisely so it can be fixed.
		if with_nginx {
			let verdict = match self.nginx.test().await {
				Ok(_) => "ok".to_string(),
				Err((_, err)) => format!("{err:#}"),
			};
			checks.insert("nginx", verdict);
		}
		(checks, healthy)
	}

	pub(super) fn setting(&self, key: &str) -> String {
		self.db.setting(key).unwrap_or_default()
	}

	fn update_on_prerelease_track(&self) -> bool {
		updater::prerelease_track(&self.setting(updater::SETTING_BETA), &self.cfg.version)
	}

	fn cleanup_old_images(&self) -> bool {
		self.setting(updater::SETTING_CLEANUP_OLD_IMAGES) == "true"
	}

	/// The updater's own status plus the preferences it does not read itself.
	async fn version_status(&self, prerelease: bool) -> Status {
		let mut status = self.updater.status(prerelease).await;
		status.cleanup_old_images = self.cleanup_old_images();
		status
	}

	/// The environment name of each deployment row, once per distinct environment.
	pub(super) fn deployment_environment_names(&self, recent: &[Deployment]) -> HashMap<String, String> {
		let mut out = HashMap::new();
		for d in recent {
			if d.environment_id.is_empty() || out.contains_key(&d.environment_id) {
				continue;
			}
			if let Ok(env) = self.db.environment_by_id(&d.environment_id) {
				out.insert(d.environment_id.clone(), env.name);
			}
		}
		out
	}

	/// Persists the DNS-01 credential encrypted and applies it to the live
	/// issuer, so the next renewal uses it without a restart.
	fn set_cloudflare_token(&self, token: &str) -> anyhow::Result<()> {
		let stored = if token.is_empty() { String::new() } else { self.cipher.encrypt(token)? };
		self.db.set_setting(crate::certificates::SETTING_CLOUDFLARE_TOKEN, &stored)?;
		self.certs.set_cloudflare_token(token);
		Ok(())
	}
}

/// The unauthenticated liveness and readiness probe used by the installer, the
/// updater and Docker's own healthcheck. The per-check detail names internal
/// paths and failure modes, so only an authenticated caller gets it.
pub async fn health(State(s): State<Arc<Server>>, headers: HeaderMap) -> Response {
	let detail = s.auth.authenticate(&headers).is_ok();
	let (checks, healthy) = s.health_checks(detail).await;
	let (status, code) = if healthy { ("healthy", StatusCode::OK) } else { ("unhealthy", StatusCode::SERVICE_UNAVAILABLE) };
	let mut body = json!({"status": status});
	if detail {
		body["checks"] = json!(checks);
	}
	json(code, &body)
}

fn writable(dir: &str) -> anyhow::Result<()> {
	let probe = format!("{dir}/.write-probe");
	security::write_file_mode(std::path::Path::new(&probe), b"ok", 0o600)?;
	std::fs::remove_file(probe)?;
	Ok(())
}

pub async fn version(State(s): State<Arc<Server>>) -> ApiResult {
	ok(&s.version_status(s.update_on_prerelease_track()).await)
}

/// Forces a release lookup, bypassing the two-minute cache behind the public
/// version endpoint. Protected: an unauthenticated caller could otherwise
/// spend the GitHub rate limit.
pub async fn version_check(State(s): State<Arc<Server>>) -> ApiResult {
	s.updater.invalidate().await;
	ok(&s.version_status(s.update_on_prerelease_track()).await)
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct VersionSettings {
	beta: bool,
	cleanup_old_images: bool,
}

/// Stores the update preferences: the beta (prerelease) track and whether a
/// successful update prunes the images it replaced. Both come on every call.
pub async fn put_version_settings(State(s): State<Arc<Server>>, body: Bytes) -> ApiResult {
	let req: VersionSettings = decode(&body)?;
	s.db.set_setting(updater::SETTING_BETA, &req.beta.to_string())?;
	s.db.set_setting(updater::SETTING_CLEANUP_OLD_IMAGES, &req.cleanup_old_images.to_string())?;
	ok(&s.version_status(req.beta).await)
}

pub async fn system_info(State(s): State<Arc<Server>>) -> ApiResult {
	let info = s.docker.info().await?;
	let projects = s.db.list_projects()?;
	let recent = s.db.recent_deployments(20)?;
	let names: HashMap<&str, &str> = projects.iter().map(|p| (p.id.as_str(), p.name.as_str())).collect();
	let environments = s.deployment_environment_names(&recent);
	let activity: Vec<Value> = recent
		.iter()
		.map(|d| {
			json!({
				"deployment": d,
				"project_name": names.get(d.project_id.as_str()).copied().unwrap_or_default(),
				"environment_name": environments.get(&d.environment_id).cloned().unwrap_or_default(),
			})
		})
		.collect();
	ok(&json!({
		"host": {
			"docker_version": info.server_version.unwrap_or_default(),
			"os": info.operating_system.unwrap_or_default(),
			"architecture": info.architecture.unwrap_or_default(),
			"cpus": info.ncpu.unwrap_or_default(),
			"memory_total": info.mem_total.unwrap_or_default(),
			"name": info.name.unwrap_or_default(),
		},
		"projects": projects.len(),
		"containers": info.containers.unwrap_or_default(),
		"containers_running": info.containers_running.unwrap_or_default(),
		"containers_stopped": info.containers_stopped.unwrap_or_default(),
		"images": info.images.unwrap_or_default(),
		"recent_deployments": activity,
		"version": s.cfg.version,
	}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub(super) struct WindowQuery {
	window: String,
}

impl WindowQuery {
	/// The start of the ?window= range, in unix seconds, and the bucket size in
	/// seconds that reduces it to METRICS_POINTS. Windows are capped at the
	/// retention period so a request cannot ask for pruned data.
	pub(super) fn range(&self) -> (i64, i64) {
		let minutes = match self.window.as_str() {
			"1h" => 60,
			"6h" => 6 * 60,
			"24h" => 24 * 60,
			"7d" => 7 * 24 * 60,
			_ => 30,
		};
		let window = minutes * 60;
		let bucket = (window / METRICS_POINTS).max(metrics::INTERVAL.as_secs() as i64);
		(chrono::Utc::now().timestamp() - window, bucket)
	}
}

/// Recorded host usage for the requested window, which seeds the dashboard
/// charts before live samples start arriving.
pub async fn system_metrics(State(s): State<Arc<Server>>, Query(q): Query<WindowQuery>) -> ApiResult {
	let (since, bucket) = q.range();
	ok(&s.db.host_metrics(since, bucket)?)
}

/// Streams host CPU, RAM and disk over SSE. The sampler records a point every
/// metrics::INTERVAL, so this only keeps the panel's current reading fresh.
pub async fn system_stats(State(s): State<Arc<Server>>) -> Response {
	let root = s.cfg.root.clone();
	let ticker = tokio::time::interval(STATS_INTERVAL);
	sse::response(futures::stream::unfold((root, ticker), |(root, mut ticker)| async move {
		ticker.tick().await;
		let frame = sse::event("stats", &metrics::read(&root).await);
		Some((frame, (root, ticker)))
	}))
}

/// Streams docker and platform events so the panel updates itself.
pub async fn system_events(State(s): State<Arc<Server>>) -> Response {
	sse::response(sse::bus(s.bus.subscribe(events::TOPIC_SYSTEM)))
}

#[derive(Serialize, Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct SettingsPayload {
	dashboard_domain: String,
	dashboard_https: bool,
	acme_email: String,
	/// Write-only: absent leaves the stored token alone, "" clears it. Reads
	/// report only whether one is present.
	#[serde(skip_serializing_if = "Option::is_none")]
	cloudflare_api_token: Option<String>,
	cloudflare_token_set: bool,
}

fn settings(s: &Server) -> SettingsPayload {
	SettingsPayload {
		dashboard_domain: s.setting(domains::SETTING_DASHBOARD_DOMAIN),
		dashboard_https: s.setting(domains::SETTING_DASHBOARD_HTTPS) == "true",
		acme_email: s.cfg.acme_email.clone(),
		cloudflare_api_token: None,
		cloudflare_token_set: s.certs.dns01_enabled(),
	}
}

pub async fn get_settings(State(s): State<Arc<Server>>) -> ApiResult {
	ok(&settings(&s))
}

pub async fn put_settings(State(s): State<Arc<Server>>, body: Bytes) -> ApiResult {
	let req: SettingsPayload = decode(&body)?;
	// The token first: a wildcard dashboard domain needs DNS-01, so a single PUT
	// carrying both would otherwise fail on the domain and drop the token.
	if let Some(token) = &req.cloudflare_api_token {
		s.set_cloudflare_token(token)?;
	}
	s.domains.set_dashboard_domain(&req.dashboard_domain, req.dashboard_https).await.map_err(bad_request)?;
	ok(&settings(&s))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct BackupQuery {
	volumes: String,
}

/// Volume archives can take minutes and grow to many gigabytes, so the caller
/// asks for them explicitly.
pub async fn backup(State(s): State<Arc<Server>>, Query(q): Query<BackupQuery>) -> ApiResult {
	created(&s.backups.create(q.volumes == "true").await?)
}

pub async fn list_backups(State(s): State<Arc<Server>>) -> ApiResult {
	ok(&s.backups.list()?)
}

pub async fn delete_backup(State(s): State<Arc<Server>>, Path(name): Path<String>) -> ApiResult {
	s.backups.delete(&name).map_err(bad_request)?;
	done()
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct UpdateRequest {
	version: String,
}

/// Hands the swap to a detached updater container.
pub async fn update(State(s): State<Arc<Server>>, body: Bytes) -> ApiResult {
	let req: UpdateRequest = if body.is_empty() { UpdateRequest::default() } else { decode(&body)? };
	// An update recreates the whole stack; starting one on a platform that is
	// already failing turns a bad day into an unbootable one.
	let (checks, healthy) = s.health_checks(false).await;
	if !healthy {
		let failing: Vec<String> = checks.iter().filter(|(_, v)| *v != "ok").map(|(k, v)| format!("{k}: {v}")).collect();
		return Err(ApiError::new(
			StatusCode::CONFLICT,
			"UNHEALTHY",
			format!("not updating an unhealthy platform: {}", failing.join("; ")),
		)
		.with_details(json!({"checks": checks})));
	}
	// Detached from the request: a tab closed mid-launch would otherwise drop
	// the launch after the container started and leave the state file wrong.
	let (prerelease, cleanup) = (s.update_on_prerelease_track(), s.cleanup_old_images());
	let updater = Arc::clone(&s.updater);
	let started = tokio::spawn(async move { updater.start(&req.version, prerelease, cleanup).await });
	started.await.map_err(bad_request)?.map_err(bad_request)?;
	Ok(json(
		StatusCode::ACCEPTED,
		&json!({"status": "started", "message": "The platform is updating. The dashboard will reconnect automatically."}),
	))
}

/// The state file the updater writes as it goes, which is how the panel
/// renders progress across the manager's own restart.
pub async fn update_status(State(s): State<Arc<Server>>) -> ApiResult {
	let state = s.updater.state();
	let mut body = serde_json::to_value(&state).map_err(bad_request)?;
	// After a rollback the failed container is kept precisely so its log can explain it.
	if state.phase == updater::PHASE_ROLLED_BACK {
		let log = s.updater.log_tail().await;
		if !log.is_empty() {
			body["log"] = json!(log);
		}
	}
	ok(&body)
}

pub async fn list_registries(State(s): State<Arc<Server>>) -> ApiResult {
	ok(&s.db.list_registries()?)
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct CreateRegistry {
	name: String,
	url: String,
	username: String,
	password: String,
}

/// Stores credentials encrypted and verifies them by logging in, so a typo is
/// caught here rather than during a deployment.
pub async fn create_registry(State(s): State<Arc<Server>>, body: Bytes) -> ApiResult {
	let req: CreateRegistry = decode(&body)?;
	if req.name.is_empty() || req.password.is_empty() {
		return Err(bad_request("name, url, username and token are all required"));
	}
	// Both reach the docker CLI as arguments, so they are validated before
	// they are stored rather than at the point of use.
	let url = security::validate_command_arg("url", &req.url).map_err(bad_request)?;
	let username = security::validate_command_arg("username", &req.username).map_err(bad_request)?;
	let encrypted_password = s.cipher.encrypt(&req.password)?;
	let mut registry = Registry { name: req.name, url, username, encrypted_password, ..Default::default() };
	s.db.create_registry(&mut registry).map_err(bad_request)?;
	if let Err(err) = projects::docker_login(&registry.url, &registry.username, &req.password).await {
		let _ = s.db.delete_registry(&registry.id);
		return Err(bad_request(format!("{err:#}")));
	}
	created(&registry)
}

pub async fn delete_registry(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	s.db.delete_registry(&id)?;
	done()
}
