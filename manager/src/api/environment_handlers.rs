use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use serde::Deserialize;

use super::Server;
use super::project_handlers::VariablesRequest;
use super::respond::{ApiError, ApiResult, bad_request, created, decode, done, lookup, ok, server_error};
use crate::database::{Environment, Project};
use crate::projects::NoServices;

/// ?environment= on a project route.
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct EnvQuery {
	pub environment: String,
}

impl Server {
	/// Loads the project named in the path with the environment the request is
	/// about. ?environment= picks one; without it the request means the
	/// project's default, which keeps an old bookmark working. The lookup checks
	/// that the environment belongs to the project, so an id from elsewhere is
	/// a 404 rather than a way across the boundary.
	pub(super) fn project_env(&self, project_id: &str, q: &EnvQuery) -> Result<(Project, Environment), ApiError> {
		let project = self.db.project_by_id(project_id).map_err(lookup)?;
		let env = self.db.environment_or_default(&project.id, &q.environment).map_err(lookup)?;
		Ok((project, env))
	}

	/// An environment addressed by its own id, with the project it belongs to.
	fn environment_and_project(&self, id: &str) -> Result<(Environment, Project), ApiError> {
		let env = self.db.environment_by_id(id).map_err(lookup)?;
		let project = self.db.project_by_id(&env.project_id).map_err(lookup)?;
		Ok((env, project))
	}
}

pub async fn list_environments(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	let project = s.db.project_by_id(&id).map_err(lookup)?;
	ok(&s.db.list_environments(&project.id)?)
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct CreateEnvironment {
	name: String,
	branch: String,
}

pub async fn create_environment(State(s): State<Arc<Server>>, Path(id): Path<String>, body: Bytes) -> ApiResult {
	let project = s.db.project_by_id(&id).map_err(lookup)?;
	let req: CreateEnvironment = decode(&body)?;
	created(&s.projects.create_environment(&project, &req.name, &req.branch).map_err(bad_request)?)
}

pub async fn get_environment(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	ok(&s.environment_and_project(&id)?.0)
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct UpdateEnvironment {
	name: Option<String>,
	branch: Option<String>,
}

pub async fn update_environment(State(s): State<Arc<Server>>, Path(id): Path<String>, body: Bytes) -> ApiResult {
	let (mut env, _) = s.environment_and_project(&id)?;
	let req: UpdateEnvironment = decode(&body)?;
	let name = req.name.unwrap_or_else(|| env.name.clone());
	let branch = req.branch.unwrap_or_else(|| env.branch.clone());
	s.projects.update_environment(&mut env, &name, &branch).map_err(bad_request)?;
	ok(&env)
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct VolumesQuery {
	pub volumes: String,
}

/// Stops the environment's containers before dropping it, so deleting the
/// record never leaves a stack running with nothing pointing at it. Volumes go
/// too on ?volumes=true: an environment is a disposable copy.
pub async fn delete_environment(State(s): State<Arc<Server>>, Path(id): Path<String>, Query(q): Query<VolumesQuery>) -> ApiResult {
	let (env, project) = s.environment_and_project(&id)?;
	// delete_environment refuses the default environment too, but the teardown
	// below is destructive and irreversible, so the refusal comes first.
	if env.is_default {
		return Err(bad_request("the default environment cannot be deleted"));
	}
	// The compose project name lives only in this row, so deleting it after a
	// failed teardown leaves containers nothing can find or stop.
	let teardown = match s.projects.compose_project(&project, &env) {
		Ok(compose_project) => s.compose_down(&compose_project, q.volumes == "true").await,
		Err(err) => Err(err),
	};
	if let Err(err) = teardown
		&& !is_no_services(&err)
	{
		tracing::error!(environment = env.id, error = %err, "compose down during environment delete");
		return Err(server_error(err.context(format!("stop environment {}", env.name))));
	}
	s.projects.delete_environment(&env).map_err(bad_request)?;
	if let Err(err) = s.domains.reconcile().await {
		tracing::warn!(error = %err, "reconcile after environment delete");
	}
	done()
}

pub async fn get_environment_variables(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	let (env, _) = s.environment_and_project(&id)?;
	ok(&s.projects.environment_variables(&env.id)?)
}

pub async fn put_environment_variables(State(s): State<Arc<Server>>, Path(id): Path<String>, body: Bytes) -> ApiResult {
	let (env, project) = s.environment_and_project(&id)?;
	let req: VariablesRequest = decode(&body)?;
	s.projects.set_environment_variables(&env.id, &req.variables).map_err(bad_request)?;
	s.projects.write_env_file(&project, &env)?;
	ok(&s.projects.environment_variables(&env.id)?)
}

/// Nothing to render is not a failed teardown: the delete paths skip it.
pub(super) fn is_no_services(err: &anyhow::Error) -> bool {
	err.chain().any(|e| e.is::<NoServices>())
}
