use std::collections::HashMap;
use std::sync::Arc;

use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::Serialize;
use serde_json::json;

use super::Server;
use super::respond::{ApiError, ApiResult, bad_request, ok};
use crate::engines::{self, Connection};

/// The database catalog the create form is built from.
pub async fn list_engines() -> ApiResult {
	ok(&engines::CATALOG)
}

/// The image tags one engine offers. Best effort by design: when Docker Hub is
/// unreachable the catalog's offline list comes back with 200 rather than
/// failing the form, and live says which of the two the caller got.
pub async fn engine_versions(Path(slug): Path<String>) -> ApiResult {
	let Some(engine) = engines::by_slug(&slug) else {
		return Err(ApiError::new(StatusCode::NOT_FOUND, "NOT_FOUND", "Unknown database engine"));
	};
	if engine.repository.is_empty() {
		return Err(bad_request("a custom image has no version list; type the full image reference"));
	}
	let (versions, live) = match engines::versions(engine).await {
		Ok(versions) => (versions, true),
		Err(err) => {
			tracing::debug!(engine = engine.slug, error = %err, "engine version lookup fell back to the catalog");
			(engine.versions.iter().map(|v| v.to_string()).collect(), false)
		}
	};
	ok(&json!({"versions": versions, "live": live}))
}

#[derive(Serialize)]
struct DatabaseView {
	#[serde(flatten)]
	connection: Connection,
	name: &'static str,
	versions: &'static [&'static str],
	data_volume: String,
}

/// The connection panel of a database service. The values come from the
/// service's own environment, which the container was started with, so an
/// edited variable shows here immediately.
pub async fn service_database(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	let (service, _, env) = s.lookup_service(&id)?;
	let Some(engine) = engines::by_slug(&service.engine) else {
		return Err(bad_request("this service is not a database"));
	};
	// Unmasked: the panel exists to hand over the password, behind the same
	// guard as the environment editor.
	let values: HashMap<String, String> = s.projects.service_variables(&service.id)?.into_iter().map(|v| (v.key, v.value)).collect();
	ok(&DatabaseView {
		// The hostname is the compose service name: sibling services reach it
		// there over the default network.
		connection: engines::describe(engine, &service.compose_service_name, &service.image, &values),
		name: engine.name,
		versions: engine.versions,
		// Compose namespaces volumes by project, the name docker knows the data by.
		data_volume: format!("{}_{}-data", env.compose_project_name, service.compose_service_name),
	})
}
