use std::collections::{HashMap, HashSet};
use std::sync::Arc;

use axum::Extension;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use bollard::models::ContainerSummary;
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::docker_handlers::{PortView, host_ports};
use super::environment_handlers::EnvQuery;
use super::respond::{ApiError, ApiResult, bad_request, created, decode, done, json, lookup, ok};
use super::{Caller, Server};
use crate::database::{self, Deployment, Domain, Environment, Project};
use crate::deployments::{self, Options};
use crate::docker;
use crate::metrics;
use crate::projects::{self, CreateInput, EnvVar};

/// The stored project enriched with live state for the UI.
#[derive(Serialize)]
pub(super) struct ProjectView {
	#[serde(flatten)]
	project: Project,
	/// Ships with the project so the dashboard's picker does not need a second
	/// request per card.
	environments: Vec<Environment>,
	service_count: usize,
	running_count: usize,
	/// Containers that crashed, died or keep restarting. What is neither running
	/// nor errored is idle: created, paused, stopped or never deployed.
	errored_count: usize,
	/// database_count and compose_count split service_count by what the service
	/// is; by subtraction the rest are applications vexdock builds or pulls.
	database_count: usize,
	compose_count: usize,
	domains: Vec<Domain>,
	latest_deployment: Option<Deployment>,
}

/// The container's state word, "" when docker sent none.
pub(super) fn container_state(c: &ContainerSummary) -> String {
	c.state.map(|s| s.to_string()).unwrap_or_default()
}

/// One label of a container, "" when it does not carry it.
pub(super) fn label<'a>(c: &'a ContainerSummary, key: &str) -> &'a str {
	c.labels.as_ref().and_then(|l| l.get(key)).map_or("", String::as_str)
}

pub async fn list_projects(State(s): State<Arc<Server>>, Extension(caller): Extension<Caller>) -> ApiResult {
	let containers = s.host_containers().await;
	let mut out = Vec::new();
	for p in s.db.list_projects()? {
		if caller.allows(&p.id, database::ACCESS_READ) {
			out.push(s.project_view(p, &containers).await?);
		}
	}
	ok(&out)
}

impl Server {
	/// Every container on the daemon, read once so the project list costs one
	/// Docker call rather than one per environment. A failed read leaves every
	/// count at zero rather than failing the page.
	pub(super) async fn host_containers(&self) -> Vec<ContainerSummary> {
		self.docker.list_containers("").await.unwrap_or_else(|err| {
			tracing::warn!(error = %err, "list containers");
			Vec::new()
		})
	}

	/// The card on the projects list, so it counts across every environment: a
	/// project with a running staging is not a stopped project.
	pub(super) async fn project_view(&self, project: Project, containers: &[ContainerSummary]) -> anyhow::Result<ProjectView> {
		let services = self.db.list_project_services(&project.id)?;
		let domains = self.db.list_project_domains(&project.id)?;
		let environments = self.db.list_environments(&project.id)?;
		let mut view = ProjectView {
			service_count: services.len(),
			database_count: services.iter().filter(|s| s.kind == database::SERVICE_DATABASE).count(),
			compose_count: services.iter().filter(|s| s.kind != database::SERVICE_DATABASE && s.provider == database::PROVIDER_RAW).count(),
			running_count: 0,
			errored_count: 0,
			domains,
			latest_deployment: None,
			environments,
			project,
		};
		let owned: HashSet<&str> = view.environments.iter().map(|e| e.compose_project_name.as_str()).collect();
		for c in containers {
			if !owned.contains(label(c, docker::COMPOSE_PROJECT_LABEL)) {
				continue;
			}
			match container_state(c).as_str() {
				"running" => view.running_count += 1,
				"dead" | "restarting" => view.errored_count += 1,
				"exited" => {
					if let Ok(info) = self.docker.inspect(c.id.as_deref().unwrap_or_default()).await
						&& info.state.as_ref().is_some_and(crashed)
					{
						view.errored_count += 1;
					}
				}
				_ => {}
			}
		}
		view.latest_deployment = self.db.list_project_deployments(&view.project.id, 1).ok().and_then(|mut d| d.pop());
		Ok(view)
	}
}

/// Tells a crash from a stop: docker stop exits 0, 143 (SIGTERM) or 137
/// (SIGKILL after the grace period), and 137 is only a crash when the OOM
/// killer sent it.
pub(super) fn crashed(state: &bollard::models::ContainerState) -> bool {
	match state.exit_code.unwrap_or_default() {
		0 | 143 => false,
		137 => state.oom_killed.unwrap_or_default(),
		_ => true,
	}
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct CreateProject {
	name: String,
	tags: Vec<String>,
}

pub async fn create_project(State(s): State<Arc<Server>>, body: Bytes) -> ApiResult {
	let req: CreateProject = decode(&body)?;
	let project = s.projects.create(&CreateInput { name: req.name, tags: req.tags }).map_err(bad_request)?;
	created(&s.project_view(project, &s.host_containers().await).await?)
}

pub async fn get_project(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	let project = s.db.project_by_id(&id).map_err(lookup)?;
	ok(&s.project_view(project, &s.host_containers().await).await?)
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct UpdateProject {
	name: Option<String>,
	tags: Option<Vec<String>>,
}

pub async fn update_project(State(s): State<Arc<Server>>, Path(id): Path<String>, body: Bytes) -> ApiResult {
	let mut project = s.db.project_by_id(&id).map_err(lookup)?;
	let req: UpdateProject = decode(&body)?;
	if let Some(name) = req.name {
		project.slug = projects::slugify(&name);
		project.name = name;
	}
	if let Some(tags) = req.tags {
		project.tags = tags;
	}
	s.projects.validate(&mut project).map_err(bad_request)?;
	s.db.update_project(&mut project)?;
	ok(&s.project_view(project, &s.host_containers().await).await?)
}

/// Refuses a project that still has services: deleting a service tears its
/// containers down, so an empty project has nothing left running under its
/// namespaces once its records go.
pub async fn delete_project(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	let project = s.db.project_by_id(&id).map_err(lookup)?;
	let services = s.db.list_project_services(&project.id)?;
	if !services.is_empty() {
		return Err(ApiError::new(
			StatusCode::CONFLICT,
			"PROJECT_NOT_EMPTY",
			format!("{} service(s) still in this project; delete them first", services.len()),
		)
		.with_details(json!({"services": services.len()})));
	}
	let environments = s.db.list_environments(&project.id)?;
	s.db.delete_project(&project.id)?;
	for env in &environments {
		if let Err(err) = s.projects.remove_directory(&env.id) {
			tracing::warn!(environment = env.id, error = %err, "remove environment directory");
		}
	}
	if let Err(err) = s.domains.reconcile().await {
		tracing::warn!(error = %err, "reconcile after project delete");
	}
	done()
}

pub async fn deploy(
	State(s): State<Arc<Server>>,
	Path(id): Path<String>,
	Query(q): Query<EnvQuery>,
	Extension(caller): Extension<Caller>,
) -> ApiResult {
	let (project, env) = s.project_env(&id, &q)?;
	let opts = Options { trigger: deployments::TRIGGER_MANUAL.into(), actor: caller.actor(), ..Default::default() };
	let queued = s.deploy_environment(&project, &env, opts)?;
	if queued.is_empty() {
		return Err(bad_request("this environment has no service to deploy"));
	}
	Ok(json(StatusCode::ACCEPTED, &queued))
}

impl Server {
	/// Queues one deployment per service. A deployment always targets a single
	/// service, so deploying an environment is that fan-out; the engine's
	/// per-environment lock runs them one after another.
	pub(super) fn deploy_environment(&self, project: &Project, env: &Environment, opts: Options) -> anyhow::Result<Vec<Deployment>> {
		let mut queued = Vec::new();
		for svc in self.db.list_services(&env.id)? {
			// A service whose source is still unanswered is not in the compose file.
			if svc.provider == database::PROVIDER_UNCONFIGURED || svc.provider.is_empty() {
				continue;
			}
			let opts = Options { service_name: svc.compose_service_name, ..opts.clone() };
			queued.push(self.deployments.trigger(project, env, opts)?);
		}
		Ok(queued)
	}

	/// Detaches the manager first: Studio may have joined the project's
	/// network, and compose cannot remove a network the manager is still on.
	pub(super) async fn compose_down(&self, p: &crate::compose::Project, remove_volumes: bool) -> anyhow::Result<()> {
		self.docker.leave_project_networks(&p.name).await?;
		p.down(&mut LogWriter, remove_volumes).await
	}
}

/// Stops the stack without deleting anything.
pub async fn stop_project(State(s): State<Arc<Server>>, Path(id): Path<String>, Query(q): Query<EnvQuery>) -> ApiResult {
	let (project, env) = s.project_env(&id, &q)?;
	let compose_project = s.projects.compose_project(&project, &env).map_err(bad_request)?;
	s.compose_down(&compose_project, false).await?;
	done()
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct ExportQuery {
	environment: String,
	secrets: String,
}

/// The project's managed services as a base64 blob for another project's
/// import. Secret values are withheld unless ?secrets=true asks explicitly,
/// because the blob is only encoded, and it leaves here for a clipboard.
pub async fn export_services(
	State(s): State<Arc<Server>>,
	Path(id): Path<String>,
	Query(q): Query<ExportQuery>,
	Extension(caller): Extension<Caller>,
) -> ApiResult {
	let (project, env) = s.project_env(&id, &EnvQuery { environment: q.environment })?;
	let secrets = q.secrets == "true";
	let payload = s.projects.export_services(&project, &env, secrets)?;
	if secrets {
		// The one read that hands over plaintext secrets, so it is recorded like
		// a mutation: a stolen token draining a project this way leaves a trace.
		s.audit(&caller, 200);
		tracing::warn!(project = project.name, "exported services with secret values");
	}
	ok(&json!({"payload": payload, "secrets": secrets}))
}

/// The set shared by every environment. Unmasked: this is the editor, and
/// handing the value over is the point.
pub async fn get_project_variables(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	ok(&s.projects.project_variables(&id)?)
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
pub(super) struct VariablesRequest {
	pub variables: Vec<EnvVar>,
}

pub async fn put_project_variables(State(s): State<Arc<Server>>, Path(id): Path<String>, body: Bytes) -> ApiResult {
	let project = s.db.project_by_id(&id).map_err(lookup)?;
	let req: VariablesRequest = decode(&body)?;
	s.projects.set_project_variables(&project.id, &req.variables).map_err(bad_request)?;
	// A shared variable changes what every environment's containers see, so
	// every .env is rewritten, not just the one the request came from.
	for env in s.db.list_environments(&project.id)? {
		s.projects.write_env_file(&project, &env)?;
	}
	ok(&s.projects.project_variables(&project.id)?)
}

/// The stored service with its current container.
#[derive(Serialize)]
pub(super) struct ServiceView {
	#[serde(flatten)]
	pub service: database::Service,
	pub container_id: String,
	pub state: String,
	pub status: String,
	/// What the container was actually started from, which drifts from the
	/// configured image between an edit and the next deploy.
	pub running_image: String,
	/// The host ports the container holds open now, which drift from the
	/// service's ports the same way until the next deploy.
	pub published_ports: Vec<PortView>,
	pub health: String,
	pub restart_count: i64,
	pub created_unix: i64,
	/// The sampler's newest reading, so a list can show usage without a stats
	/// stream per row. Zero when nothing recent was recorded.
	pub cpu_percent: f64,
	pub memory_usage: u64,
}

/// How old the newest recorded sample may be before a service reads as having
/// no current usage: two missed sampler ticks means the container is gone.
const STALE_READING_SECS: i64 = 3 * metrics::INTERVAL.as_secs() as i64;

pub async fn list_services(State(s): State<Arc<Server>>, Path(id): Path<String>, Query(q): Query<EnvQuery>) -> ApiResult {
	let (_, env) = s.project_env(&id, &q)?;
	ok(&s.service_views(&env).await?)
}

impl Server {
	pub(super) async fn service_views(&self, env: &Environment) -> anyhow::Result<Vec<ServiceView>> {
		let services = self.db.list_services(&env.id)?;
		// Without this the page would render every running service as stopped.
		let containers = self.docker.list_containers(&env.compose_project_name).await?;
		let usage = self.db.latest_service_metrics(chrono::Utc::now().timestamp() - STALE_READING_SECS)?;
		let mut by_service: HashMap<&str, &ContainerSummary> = HashMap::new();
		for c in &containers {
			let name = label(c, docker::COMPOSE_SERVICE_LABEL);
			let replace = match by_service.get(name) {
				None => true,
				Some(existing) => container_state(c) == "running" && container_state(existing) != "running",
			};
			if replace {
				by_service.insert(name, c);
			}
		}
		let mut out = Vec::new();
		for svc in services {
			let mut view = ServiceView {
				container_id: String::new(),
				state: String::new(),
				status: String::new(),
				running_image: String::new(),
				published_ports: Vec::new(),
				health: String::new(),
				restart_count: 0,
				created_unix: 0,
				cpu_percent: 0.0,
				memory_usage: 0,
				service: svc,
			};
			if let Some(c) = by_service.get(view.service.compose_service_name.as_str()) {
				let id = c.id.clone().unwrap_or_default();
				view.state = container_state(c);
				view.status = c.status.clone().unwrap_or_default();
				view.running_image = c.image.clone().unwrap_or_default();
				view.published_ports = host_ports(c.ports.as_deref().unwrap_or_default());
				view.created_unix = c.created.unwrap_or_default();
				if let Ok(info) = self.docker.inspect(&id).await {
					view.restart_count = info.restart_count.unwrap_or_default();
					if let Some(health) = info.state.and_then(|st| st.health).and_then(|h| h.status) {
						view.health = health.to_string();
					}
				}
				if let Some(reading) = usage.get(&view.service.id).filter(|_| view.state == "running") {
					view.cpu_percent = reading.cpu_percent;
					view.memory_usage = reading.memory_usage;
				}
				view.container_id = id;
			}
			out.push(view);
		}
		Ok(out)
	}
}

pub async fn list_deployments(State(s): State<Arc<Server>>, Path(id): Path<String>, Query(q): Query<EnvQuery>) -> ApiResult {
	let (_, env) = s.project_env(&id, &q)?;
	ok(&s.db.list_deployments(&env.id, 50)?)
}

pub async fn list_project_domains(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	ok(&s.db.list_project_domains(&id)?)
}

/// Compose output that is not attached to a deployment (teardown, stop) goes
/// to the log.
pub(super) struct LogWriter;

impl std::io::Write for LogWriter {
	fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
		tracing::info!(output = String::from_utf8_lossy(b).trim_end_matches(['\n', '\r']), "compose");
		Ok(b.len())
	}

	fn flush(&mut self) -> std::io::Result<()> {
		Ok(())
	}
}
