use std::sync::Arc;

use axum::Extension;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use futures::StreamExt;
use serde_json::json;

use super::respond::{ApiResult, bad_request, done, json, lookup, ok};
use super::{Caller, Server, sse};
use crate::database;
use crate::deployments::{self, Options};
use crate::events;

pub async fn get_deployment(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	let deployment = s.db.deployment_by_id(&id).map_err(lookup)?;
	let steps = s.db.list_steps(&deployment.id)?;
	ok(&json!({"deployment": deployment, "steps": steps}))
}

/// Streams the live pipeline log. It replays the steps already recorded so a
/// late subscriber still sees the whole deployment.
pub async fn deployment_events(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	let deployment = s.db.deployment_by_id(&id).map_err(lookup)?;
	// Subscribe before replaying so nothing is lost in between.
	let sub = s.bus.subscribe(&events::deployment_topic(&deployment.id));
	let steps = s.db.list_steps(&deployment.id)?;
	let snapshot = sse::event("snapshot", &json!({"deployment": deployment, "steps": steps}));
	let finished = deployment.status != database::DEPLOYMENT_QUEUED && deployment.status != database::DEPLOYMENT_RUNNING;
	if finished {
		let closed = sse::event("deployment.closed", &serde_json::Value::Null);
		return Ok(sse::response(futures::stream::iter([snapshot, closed])));
	}
	Ok(sse::response(futures::stream::once(async { snapshot }).chain(sse::bus(sub))))
}

pub async fn cancel_deployment(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	s.deployments.cancel(&id).map_err(bad_request)?;
	done()
}

/// Redeploys the exact commit of a previous successful deployment.
pub async fn rollback(State(s): State<Arc<Server>>, Path(id): Path<String>, Extension(caller): Extension<Caller>) -> ApiResult {
	let target = s.db.deployment_by_id(&id).map_err(lookup)?;
	if target.commit_sha.is_empty() {
		return Err(bad_request("this deployment has no commit to roll back to"));
	}
	if target.service_name.is_empty() {
		return Err(bad_request("this deployment ran before deploys were scoped to a service; deploy the service instead"));
	}
	let project = s.db.project_by_id(&target.project_id).map_err(lookup)?;
	// A rollback redeploys the environment the original deployment ran in.
	let env = s.db.environment_by_id(&target.environment_id).map_err(lookup)?;
	let opts = Options {
		trigger: deployments::TRIGGER_ROLLBACK.into(),
		actor: caller.actor(),
		commit_sha: target.commit_sha,
		service_name: target.service_name,
	};
	Ok(json(StatusCode::ACCEPTED, &s.deployments.trigger(&project, &env, opts)?))
}
