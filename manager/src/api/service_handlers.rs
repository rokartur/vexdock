use std::collections::VecDeque;
use std::sync::Arc;
use std::time::Duration;

use axum::Extension;
use axum::body::Bytes;
use axum::extract::{OriginalUri, Path, Query, State};
use axum::http::StatusCode;
use axum::response::{IntoResponse, Response};
use bollard::container::LogOutput;
use futures::stream::BoxStream;
use futures::{Stream, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;

use super::access::forbidden;
use super::docker_handlers::container_action;
use super::environment_handlers::EnvQuery;
use super::project_handlers::VariablesRequest;
use super::respond::{ApiError, ApiResult, bad_request, created, decode, json, lookup, ok, server_error};
use super::system_handlers::{STATS_INTERVAL, WindowQuery};
use super::{Caller, Server, sse};
use crate::database::{self, Environment, Project, Service};
use crate::deployments::{self, Options};
use crate::docker::VolumeMissing;
use crate::engines::{self, SqldSpec};
use crate::projects::{DatabaseInput, ServiceInput};
use crate::security;

impl Server {
	/// The service at {id}, the environment that owns it and the project above
	/// that, which nearly every service route needs together. The environment is
	/// the one that matters at runtime: it names the containers.
	pub(super) fn lookup_service(&self, id: &str) -> Result<(Service, Project, Environment), ApiError> {
		let service = self.db.service_by_id(id).map_err(lookup)?;
		let project = self.db.project_by_id(&service.project_id).map_err(lookup)?;
		let env = self.db.environment_by_id(&service.environment_id).map_err(lookup)?;
		Ok((service, project, env))
	}

	/// Maps a stored service to its current container id.
	pub(super) async fn resolve_service_container(&self, service_id: &str) -> anyhow::Result<String> {
		let service = self.db.service_by_id(service_id)?;
		let env = self.db.environment_by_id(&service.environment_id)?;
		self.docker.service_container(&env.compose_project_name, &service.compose_service_name).await
	}
}

pub async fn get_service(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	let service = s.db.service_by_id(&id).map_err(lookup)?;
	let env = s.db.environment_by_id(&service.environment_id).map_err(lookup)?;
	match s.service_views(&env).await?.into_iter().find(|v| v.service.id == service.id) {
		Some(view) => ok(&view),
		None => Err(ApiError::new(StatusCode::NOT_FOUND, "NOT_FOUND", "Service not found")),
	}
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct CreateService {
	name: String,
	container_name: String,
	provider: String,
	repository_url: String,
	branch: String,
	build_path: String,
	credential_kind: String,
	credential_secret: String,
	git_provider_id: String,
	owner: String,
	repository: String,
	image: String,
	compose_fragment: String,
	database: Option<CreateDatabase>,
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct CreateDatabase {
	engine: String,
	version: String,
	name: String,
	user: String,
	password: String,
	image: String,
	data_path: String,
	// libSQL only.
	sqld_node: String,
	sqld_primary_url: String,
	sqld_namespaces: bool,
}

/// Adds a service the manager owns to one environment. It is the only way a
/// database reaches a project: the catalog renders it into the environment's
/// overlay compose file rather than into a project of its own.
pub async fn create_service(
	State(s): State<Arc<Server>>,
	Path(id): Path<String>,
	Query(q): Query<EnvQuery>,
	Extension(caller): Extension<Caller>,
	body: Bytes,
) -> ApiResult {
	let (_, env) = s.project_env(&id, &q)?;
	let req: CreateService = decode(&body)?;
	// Where a service comes from stays with an admin: a git connection or a
	// docker login reaches past one project, and a compose fragment can mount
	// the host. A catalog database, whose image is the engine's own, is the one
	// a project token may add.
	if !caller.is_admin() && req.database.as_ref().is_none_or(|db| !db.image.is_empty()) {
		return Err(forbidden());
	}
	let mut input = ServiceInput {
		name: req.name,
		container_name: req.container_name,
		provider: req.provider,
		repository_url: req.repository_url,
		branch: req.branch,
		build_path: req.build_path,
		credential_kind: req.credential_kind,
		credential_secret: req.credential_secret,
		git_provider_id: req.git_provider_id,
		owner: req.owner,
		repository: req.repository,
		image: req.image,
		compose_fragment: req.compose_fragment,
		database: None,
	};
	if let Some(db) = req.database {
		input.provider = database::PROVIDER_IMAGE.into();
		input.database = Some(DatabaseInput {
			engine: db.engine,
			version: db.version,
			name: db.name,
			user: db.user,
			password: db.password,
			image: db.image,
			data_path: db.data_path,
			sqld: SqldSpec { node: db.sqld_node, primary_url: db.sqld_primary_url, namespaces: db.sqld_namespaces },
		});
	}
	created(&s.projects.create_service(&env, &input).map_err(bad_request)?)
}

/// Changes where an application comes from. A database is not negotiable: its
/// volume and its credentials were rendered from the engine it was created
/// with, so a switch would orphan the data it is holding.
fn adopt_provider(service: &mut Service, want: Option<&String>) -> anyhow::Result<()> {
	let Some(want) = want.filter(|w| **w != service.provider) else { return Ok(()) };
	if service.kind != database::SERVICE_APPLICATION {
		anyhow::bail!("a database cannot change provider; delete it and create it again");
	}
	if !database::clones_from_git(want) && want != database::PROVIDER_IMAGE && want != database::PROVIDER_RAW {
		anyhow::bail!("unknown provider {want:?}");
	}
	service.provider = want.clone();
	if database::clones_from_git(want) && service.branch.is_empty() {
		service.branch = "main".into();
	}
	// The two git sources address a repository differently, and leaving the old
	// address behind would make require_complete_provider pass on a service
	// that cannot clone.
	if database::clones_from_connection(want) {
		service.repository_url.clear();
		service.credential_kind = database::GIT_CREDENTIAL_NONE.into();
		service.credential_enc.clear();
	} else {
		service.git_provider_id.clear();
		service.owner.clear();
		service.repository.clear();
	}
	// The deploy logs in whenever a username is stored, so it cannot outlive the image source.
	if want != database::PROVIDER_IMAGE {
		service.registry_url.clear();
		service.registry_username.clear();
		service.registry_password_enc.clear();
	}
	Ok(())
}

/// Rejects an edit that would leave a service claiming a provider it has no
/// address for, which reaches docker as an empty build, or mounts its renderer
/// would drop.
fn require_complete_provider(service: &Service) -> anyhow::Result<()> {
	let p = service.provider.as_str();
	if database::clones_from_connection(p) && service.repository.is_empty() {
		anyhow::bail!("a repository is required");
	}
	if p == database::PROVIDER_GIT && service.repository_url.is_empty() {
		anyhow::bail!("a repository URL is required");
	}
	if p == database::PROVIDER_IMAGE && service.image.is_empty() {
		anyhow::bail!("an image is required");
	}
	if p == database::PROVIDER_RAW && service.compose_fragment.trim().is_empty() {
		anyhow::bail!("a compose fragment is required");
	}
	if !service.mounts.is_empty() && (p == database::PROVIDER_RAW || service.kind == database::SERVICE_DATABASE) {
		anyhow::bail!("mounts are for image and git services; a compose fragment or database declares its own volumes");
	}
	Ok(())
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct UpdateService {
	display_name: Option<String>,
	provider: Option<String>,
	repository_url: Option<String>,
	branch: Option<String>,
	build_path: Option<String>,
	credential_kind: Option<String>,
	credential_secret: Option<String>,
	git_provider_id: Option<String>,
	owner: Option<String>,
	repository: Option<String>,
	image: Option<String>,
	compose_fragment: Option<String>,
	auto_deploy: Option<bool>,
	prune_build_cache: Option<bool>,
	build_type: Option<String>,
	dockerfile: Option<String>,
	build_target: Option<String>,
	output_dir: Option<String>,
	mounts: Option<String>,
	registry_url: Option<String>,
	registry_username: Option<String>,
	registry_password: Option<String>,
}

pub async fn update_service(
	State(s): State<Arc<Server>>,
	Path(id): Path<String>,
	Extension(caller): Extension<Caller>,
	body: Bytes,
) -> ApiResult {
	let (mut service, _, env) = s.lookup_service(&id)?;
	let req: UpdateService = decode(&body)?;
	// The same rule as create_service: the source is an admin's to change.
	let changes_source = req.provider.is_some()
		|| req.repository_url.is_some()
		|| req.credential_kind.is_some()
		|| req.credential_secret.is_some()
		|| req.git_provider_id.is_some()
		|| req.owner.is_some()
		|| req.repository.is_some()
		|| req.image.is_some()
		|| req.compose_fragment.is_some()
		|| req.registry_url.is_some()
		|| req.registry_username.is_some()
		|| req.registry_password.is_some();
	if changes_source && !caller.is_admin() {
		return Err(forbidden());
	}
	adopt_provider(&mut service, req.provider.as_ref()).map_err(bad_request)?;
	assign(&mut service.display_name, req.display_name);
	assign(&mut service.compose_fragment, req.compose_fragment);
	assign(&mut service.auto_deploy, req.auto_deploy);
	assign(&mut service.prune_build_cache, req.prune_build_cache);
	// An edit reaches the same git command and the same compose file as a
	// create, so it clears the same bar; skipping it would make PATCH the way
	// around the checks.
	assign_valid(&mut service.repository_url, req.repository_url, security::validate_git_url)?;
	assign_valid(&mut service.branch, req.branch, security::validate_git_ref)?;
	assign_valid(&mut service.build_path, req.build_path, security::validate_sub_path)?;
	assign_valid(&mut service.image, req.image, engines::validate_image)?;
	assign_valid(&mut service.build_type, req.build_type, validate_build_type)?;
	assign_valid(&mut service.dockerfile, req.dockerfile, security::validate_sub_path)?;
	assign_valid(&mut service.build_target, req.build_target, security::validate_build_target)?;
	assign_valid(&mut service.output_dir, req.output_dir, security::validate_sub_path)?;
	assign_valid(&mut service.mounts, req.mounts, security::validate_mounts)?;
	if req.registry_url.is_some() || req.registry_username.is_some() || req.registry_password.is_some() {
		let url = req.registry_url.unwrap_or_else(|| service.registry_url.clone());
		let username = req.registry_username.unwrap_or_else(|| service.registry_username.clone());
		let password = req.registry_password.unwrap_or_default();
		s.projects.set_registry_login(&mut service, &url, &username, &password).map_err(bad_request)?;
	}
	// Repointing a connected service means all three of connection, owner and
	// repository, because any one alone names a repository that may not exist.
	if req.git_provider_id.is_some() || req.owner.is_some() || req.repository.is_some() {
		let provider = req.git_provider_id.unwrap_or_else(|| service.git_provider_id.clone());
		let owner = req.owner.unwrap_or_else(|| service.owner.clone());
		let repository = req.repository.unwrap_or_else(|| service.repository.clone());
		s.projects.set_git_repository(&mut service, &provider, &owner, &repository).map_err(bad_request)?;
	}
	// A connection is the credential, so an edit that sets one wins over
	// credential fields the same request happened to carry.
	if let Some(kind) = req.credential_kind.filter(|_| service.git_provider_id.is_empty()) {
		let secret = req.credential_secret.unwrap_or_default();
		s.projects.set_credential(&mut service, &kind, &secret).map_err(bad_request)?;
	}
	require_complete_provider(&service).map_err(bad_request)?;
	s.db.update_service(&mut service)?;
	// The overlay is what docker reads, so an edit that never reaches it would
	// silently do nothing on the next deploy.
	s.projects.write_overlay(&env)?;
	ok(&service)
}

/// Applies an optional request field, leaving the value alone when omitted.
fn assign<T>(dst: &mut T, src: Option<T>) {
	if let Some(value) = src {
		*dst = value;
	}
}

/// assign for a field that create validates.
fn assign_valid(dst: &mut String, src: Option<String>, validate: fn(&str) -> anyhow::Result<String>) -> Result<(), ApiError> {
	if let Some(raw) = src {
		*dst = validate(&raw).map_err(bad_request)?;
	}
	Ok(())
}

fn validate_build_type(raw: &str) -> anyhow::Result<String> {
	if raw == database::BUILD_DOCKERFILE || raw == database::BUILD_STATIC {
		return Ok(raw.into());
	}
	anyhow::bail!("build type must be {} or {}", database::BUILD_DOCKERFILE, database::BUILD_STATIC)
}

/// Removes a managed service. Its named volume survives on purpose: dropping a
/// database's data is a separate, explicit act.
pub async fn delete_service(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	let (service, _, env) = s.lookup_service(&id)?;
	s.projects.delete_service(&service, &env).map_err(bad_request)?;
	// Every deploy is scoped to one service, so no later deploy would remove
	// this container as an orphan: nothing else will ever reap it, which is why
	// a client that hangs up must not abort the removal and why a failure is
	// reported rather than logged.
	let docker = Arc::clone(&s.docker);
	let removal = tokio::spawn(async move {
		match docker.service_container(&env.compose_project_name, &service.compose_service_name).await {
			Ok(id) => docker.remove(&id, true).await,
			Err(_) => Ok(()),
		}
	});
	removal
		.await
		.map_err(|err| server_error(err.into()))?
		.map_err(|err| server_error(err.context("the service is deleted but its container could not be removed")))?;
	Ok(StatusCode::NO_CONTENT.into_response())
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct DuplicateService {
	name: String,
	environment_id: String,
}

/// Puts the copy in the requested environment, or beside the original when
/// the body names none.
pub async fn duplicate_service(
	State(s): State<Arc<Server>>,
	Path(id): Path<String>,
	Extension(caller): Extension<Caller>,
	body: Bytes,
) -> ApiResult {
	let (service, _, env) = s.lookup_service(&id)?;
	let req: DuplicateService = decode(&body)?;
	let target = if req.environment_id.is_empty() { env } else { s.db.environment_by_id(&req.environment_id).map_err(lookup)? };
	// The route checked the source project; the copy lands in the target's.
	if !caller.allows(&target.project_id, database::ACCESS_WRITE) {
		return Err(forbidden());
	}
	created(&s.projects.duplicate_service(&service, &target, &req.name).map_err(bad_request)?)
}

/// A volume copy runs a container per volume, so the ceiling is generous.
const MOVE_TIMEOUT: Duration = Duration::from_secs(30 * 60);

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct MoveService {
	environment_id: String,
}

/// Carries the volume data across. The old container goes first: it belongs to
/// a compose project nothing will deploy again, and its volumes have to hold
/// still while they are copied. The source volumes are kept, as delete keeps them.
pub async fn move_service(
	State(s): State<Arc<Server>>,
	Path(id): Path<String>,
	Extension(caller): Extension<Caller>,
	body: Bytes,
) -> ApiResult {
	let (service, _, env) = s.lookup_service(&id)?;
	let req: MoveService = decode(&body)?;
	let target = s.db.environment_by_id(&req.environment_id).map_err(lookup)?;
	// The route checked the source project; moving in needs write on the target too.
	if !caller.allows(&target.project_id, database::ACCESS_WRITE) {
		return Err(forbidden());
	}
	let container = s.projects.check_move_service(&service, &env, &target).map_err(bad_request)?;
	let volumes = s.projects.service_volumes(&env, &service)?;
	// From here the work destroys a container and copies data; a browser that
	// navigates away mid-move must not leave the service half-carried.
	let work = tokio::spawn(async move {
		tokio::time::timeout(MOVE_TIMEOUT, carry(&s, service, env, target, container, volumes))
			.await
			.unwrap_or_else(|_| Err(server_error(anyhow::anyhow!("moving the service timed out"))))
	});
	work.await.map_err(|err| server_error(err.into()))?
}

async fn carry(
	s: &Server,
	mut service: Service,
	env: Environment,
	target: Environment,
	container: String,
	volumes: Vec<String>,
) -> ApiResult {
	if let Ok(id) = s.docker.service_container(&env.compose_project_name, &service.compose_service_name).await {
		s.docker.remove(&id, true).await.map_err(|err| server_error(err.context("remove the container before moving")))?;
	}
	for name in volumes {
		let from = format!("{}_{name}", env.compose_project_name);
		let to = format!("{}_{name}", target.compose_project_name);
		match s.docker.copy_volume(&from, &to).await {
			Ok(()) => {}
			// The service was never deployed here, so there is no data to carry.
			Err(err) if err.is::<VolumeMissing>() => {
				tracing::info!(service = service.id, volume = from, "move service volume: nothing to copy")
			}
			Err(err) => return Err(server_error(err.context(format!("copy volume {from}")))),
		}
	}
	s.projects.move_service(&mut service, &env, &target, &container).map_err(bad_request)?;
	if let Err(err) = s.domains.reconcile().await {
		tracing::warn!(service = service.id, error = %err, "reconcile proxy after service move");
	}
	ok(&service)
}

/// Unmasked: this is the editor, and handing the value over is the point.
pub async fn get_service_environment(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	let (service, _, _) = s.lookup_service(&id)?;
	ok(&s.projects.service_variables(&service.id)?)
}

pub async fn put_service_environment(State(s): State<Arc<Server>>, Path(id): Path<String>, body: Bytes) -> ApiResult {
	let (service, _, env) = s.lookup_service(&id)?;
	let req: VariablesRequest = decode(&body)?;
	s.projects.set_service_variables(&service.id, &req.variables).map_err(bad_request)?;
	s.projects.write_overlay(&env)?;
	Ok(StatusCode::NO_CONTENT.into_response())
}

/// Runs the deploy pipeline for one compose service only.
pub async fn deploy_service(State(s): State<Arc<Server>>, Path(id): Path<String>, Extension(caller): Extension<Caller>) -> ApiResult {
	let (service, project, env) = s.lookup_service(&id)?;
	if service.provider == database::PROVIDER_UNCONFIGURED {
		return Err(bad_request("this service has no provider yet"));
	}
	let opts = Options {
		trigger: deployments::TRIGGER_MANUAL.into(),
		actor: caller.actor(),
		service_name: service.compose_service_name,
		..Default::default()
	};
	Ok(json(StatusCode::ACCEPTED, &s.deployments.trigger(&project, &env, opts)?))
}

/// start, stop and restart; the verb comes from the route pattern, never from
/// user input.
pub async fn service_action(State(s): State<Arc<Server>>, Path(id): Path<String>, OriginalUri(uri): OriginalUri) -> ApiResult {
	let container_id = s.resolve_service_container(&id).await.map_err(bad_request)?;
	let action = uri.path().trim_end_matches('/').rsplit('/').next().unwrap_or_default().to_string();
	container_action(&s, &container_id, &action, false).await
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct LogsQuery {
	tail: String,
	follow: String,
}

pub async fn service_logs(State(s): State<Arc<Server>>, Path(id): Path<String>, Query(q): Query<LogsQuery>) -> ApiResult {
	let container_id = s.resolve_service_container(&id).await.map_err(bad_request)?;
	stream_container_logs(&s, &container_id, &q).await
}

pub async fn container_logs(State(s): State<Arc<Server>>, Path(id): Path<String>, Query(q): Query<LogsQuery>) -> ApiResult {
	stream_container_logs(&s, &id, &q).await
}

/// Tails container output over SSE. Docker logs are never copied into SQLite:
/// they are streamed straight from the engine.
async fn stream_container_logs(s: &Server, container_id: &str, q: &LogsQuery) -> ApiResult {
	let tail = if q.tail.is_empty() { "200" } else { q.tail.as_str() };
	if tail != "all" && tail.parse::<i64>().is_err() {
		return Err(bad_request("tail must be a number or 'all'"));
	}
	// The log stream only fails once polled, which may be long after the
	// headers went out; a container that is not there fails here instead.
	s.docker.inspect(container_id).await?;
	let logs = s.docker.logs(container_id, tail, q.follow != "false", true).boxed();
	Ok(sse::response(log_lines(logs)))
}

#[derive(Serialize)]
struct LogPayload<'a> {
	stream: &'a str,
	text: String,
}

/// A line that never ends (a progress bar, a stray binary blob) is flushed at
/// this size instead of growing until the container stops.
const MAX_LOG_LINE: usize = 64 * 1024;

struct LogLines {
	logs: BoxStream<'static, Result<LogOutput, bollard::errors::Error>>,
	stdout: Vec<u8>,
	stderr: Vec<u8>,
	queue: VecDeque<Bytes>,
	ticker: tokio::time::Interval,
	done: bool,
}

impl LogLines {
	fn push(&mut self, out: LogOutput) {
		let (stream, chunk) = match out {
			LogOutput::StdErr { message } => ("stderr", message),
			LogOutput::StdOut { message } | LogOutput::Console { message } => ("stdout", message),
			LogOutput::StdIn { .. } => return,
		};
		let pending = if stream == "stderr" { &mut self.stderr } else { &mut self.stdout };
		pending.extend_from_slice(&chunk);
		let mut lines = Vec::new();
		if let Some(last) = pending.iter().rposition(|b| *b == b'\n') {
			let rest = pending.split_off(last + 1);
			pending.truncate(last);
			for line in pending.split(|b| *b == b'\n') {
				lines.push(String::from_utf8_lossy(line).into_owned());
			}
			*pending = rest;
		}
		if pending.len() > MAX_LOG_LINE {
			lines.push(String::from_utf8_lossy(pending).into_owned());
			pending.clear();
		}
		for text in lines {
			self.queue.push_back(sse::event("log", &LogPayload { stream, text }));
		}
	}

	fn finish(&mut self) {
		for (stream, pending) in [("stdout", std::mem::take(&mut self.stdout)), ("stderr", std::mem::take(&mut self.stderr))] {
			let rest = String::from_utf8_lossy(&pending).trim_end_matches(['\r', '\n']).to_string();
			if !rest.is_empty() {
				self.queue.push_back(sse::event("log", &LogPayload { stream, text: rest }));
			}
		}
		self.queue.push_back(sse::event("end", &json!({"done": true})));
		self.done = true;
	}
}

fn log_lines(logs: BoxStream<'static, Result<LogOutput, bollard::errors::Error>>) -> impl Stream<Item = Bytes> + Send + 'static {
	let ticker = tokio::time::interval_at(tokio::time::Instant::now() + sse::KEEP_ALIVE_EVERY, sse::KEEP_ALIVE_EVERY);
	let state = LogLines { logs, stdout: Vec::new(), stderr: Vec::new(), queue: VecDeque::new(), ticker, done: false };
	futures::stream::unfold(state, |mut st| async move {
		loop {
			if let Some(frame) = st.queue.pop_front() {
				return Some((frame, st));
			}
			if st.done {
				return None;
			}
			tokio::select! {
				item = st.logs.next() => match item {
					Some(Ok(out)) => st.push(out),
					Some(Err(_)) | None => st.finish(),
				},
				_ = st.ticker.tick() => st.queue.push_back(sse::keep_alive()),
			}
		}
	})
}

/// Recorded usage for one service. It reads by service id, so history survives
/// the redeploys that replace the container.
pub async fn service_metrics(State(s): State<Arc<Server>>, Path(id): Path<String>, Query(q): Query<WindowQuery>) -> ApiResult {
	let (since, bucket) = q.range();
	ok(&s.db.service_metrics(&id, since, bucket)?)
}

/// Streams CPU, RAM, network and block IO for one service. Docker's own stream
/// pushes every second, far denser than anyone reads, so this polls on
/// STATS_INTERVAL instead.
pub async fn service_stats(State(s): State<Arc<Server>>, Path(id): Path<String>) -> Result<Response, ApiError> {
	let container_id = s.resolve_service_container(&id).await.map_err(bad_request)?;
	let ticker = tokio::time::interval(STATS_INTERVAL);
	Ok(sse::response(futures::stream::unfold((s, container_id, ticker), |(s, id, mut ticker)| async move {
		ticker.tick().await;
		let sample = s.docker.sample(&id).await.ok()?;
		Some((sse::event("stats", &sample), (s, id, ticker)))
	})))
}
