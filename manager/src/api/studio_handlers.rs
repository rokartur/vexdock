use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::json;

use super::Server;
use super::respond::{ApiError, ApiResult, bad_request, decode, ok};
use crate::engines;
use crate::studio::{self, Changes, Conn, RowsQuery, Unsupported};

/// Bounds one Studio request end to end: connect, run, read.
const STUDIO_TIMEOUT: Duration = Duration::from_secs(30);

pub async fn studio_schema(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	let namespaces = s.with_studio(&id, async |conn| conn.schema().await).await?;
	ok(&json!({"schemas": namespaces}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct RowsParams {
	schema: String,
	table: String,
	sort: String,
	limit: String,
	offset: String,
	order: String,
	#[serde(rename = "where")]
	filters: String,
}

pub async fn studio_rows(State(s): State<Arc<Server>>, Path(id): Path<String>, Query(params): Query<RowsParams>) -> ApiResult {
	let q = rows_query(params).map_err(bad_request)?;
	ok(&s.with_studio(&id, async |conn| conn.rows(&q).await).await?)
}

pub async fn studio_changes(State(s): State<Arc<Server>>, Path(id): Path<String>, body: Bytes) -> ApiResult {
	let changes: Changes = decode(&body)?;
	let affected = s.with_studio(&id, async |conn| conn.apply(&changes).await).await?;
	ok(&json!({"affected": affected}))
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct QueryRequest {
	schema: String,
	query: String,
}

pub async fn studio_query(State(s): State<Arc<Server>>, Path(id): Path<String>, body: Bytes) -> ApiResult {
	let req: QueryRequest = decode(&body)?;
	if req.query.is_empty() {
		return Err(bad_request("query is required"));
	}
	let started = Instant::now();
	let mut result = s.with_studio(&id, async |conn| conn.query(&req.schema, &req.query).await).await?;
	result.duration_ms = started.elapsed().as_millis() as i64;
	ok(&result)
}

impl Server {
	/// Opens a database service's running container over its compose network,
	/// runs op on it and closes it again; the credentials never leave the manager.
	/// ponytail: connect per request; a pool per service once the latency hurts.
	async fn with_studio<T>(&self, service_id: &str, op: impl AsyncFnOnce(&mut Conn) -> anyhow::Result<T>) -> Result<T, ApiError> {
		let session = async {
			let mut conn = self.open_studio(service_id).await?;
			let result = op(&mut conn).await.map_err(studio_failed);
			conn.close().await;
			result
		};
		tokio::time::timeout(STUDIO_TIMEOUT, session)
			.await
			.map_err(|_| ApiError::new(StatusCode::GATEWAY_TIMEOUT, "QUERY_FAILED", "the database did not answer in time"))?
	}

	async fn open_studio(&self, service_id: &str) -> Result<Conn, ApiError> {
		let (service, _, env) = self.lookup_service(service_id)?;
		let Some(engine) = engines::by_slug(&service.engine).filter(|e| e.slug != engines::CUSTOM) else {
			return Err(ApiError::new(StatusCode::BAD_REQUEST, "STUDIO_UNSUPPORTED", "Studio opens the catalog's databases only"));
		};
		let container_id = self
			.docker
			.service_container(&env.compose_project_name, &service.compose_service_name)
			.await
			.map_err(|err| ApiError::new(StatusCode::CONFLICT, "DATABASE_NOT_RUNNING", format!("{err:#}")))?;
		let info = self.docker.inspect(&container_id).await?;
		if !info.state.and_then(|state| state.running).unwrap_or(false) {
			return Err(ApiError::new(StatusCode::CONFLICT, "DATABASE_NOT_RUNNING", "the database is not running - start or redeploy it"));
		}
		let values: HashMap<String, String> = self.projects.service_variables(&service.id)?.into_iter().map(|v| (v.key, v.value)).collect();
		let mut target = engines::describe(engine, &service.compose_service_name, &service.image, &values);
		target.host = self.docker.reach_container(&container_id, &env.compose_project_name).await?;
		studio::open(&target).await.map_err(studio_failed)
	}
}

/// Passes the database's own message through: it is what the user needs to
/// fix their query, and it is their database.
fn studio_failed(err: anyhow::Error) -> ApiError {
	if err.is::<Unsupported>() {
		return ApiError::new(StatusCode::BAD_REQUEST, "STUDIO_UNSUPPORTED", err.to_string());
	}
	ApiError::new(StatusCode::BAD_REQUEST, "QUERY_FAILED", format!("{err:#}"))
}

fn rows_query(params: RowsParams) -> anyhow::Result<RowsQuery> {
	if params.table.is_empty() {
		anyhow::bail!("table is required");
	}
	let number = |name: &str, raw: &str| -> anyhow::Result<i64> {
		if raw.is_empty() {
			return Ok(0);
		}
		raw.parse().map_err(|_| anyhow::anyhow!("{name} must be a number"))
	};
	let desc = match params.order.as_str() {
		"" | "asc" => false,
		"desc" => true,
		_ => anyhow::bail!("order is asc or desc"),
	};
	let filters = if params.filters.is_empty() {
		Vec::new()
	} else {
		serde_json::from_str(&params.filters).map_err(|err| anyhow::anyhow!("where must be a JSON list of filters: {err}"))?
	};
	RowsQuery {
		limit: number("limit", &params.limit)?,
		offset: number("offset", &params.offset)?,
		namespace: params.schema,
		table: params.table,
		sort: params.sort,
		desc,
		filters,
	}
	.normalize()
}
