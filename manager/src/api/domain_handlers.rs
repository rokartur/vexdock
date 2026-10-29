use std::sync::Arc;

use axum::Extension;
use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use serde::Deserialize;
use serde_json::json;

use super::respond::{ApiError, ApiResult, bad_request, created, decode, done, lookup, ok};
use super::{Caller, Server};
use crate::database;
use crate::domains::{CreateInput, UpdateInput};

pub async fn list_domains(State(s): State<Arc<Server>>, Extension(caller): Extension<Caller>) -> ApiResult {
	let visible: Vec<_> = s.db.list_domains()?.into_iter().filter(|d| caller.allows(&d.project_id, database::ACCESS_READ)).collect();
	ok(&visible)
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct CreateDomain {
	project_id: String,
	environment_id: String,
	service: String,
	hostname: String,
	container_port: i64,
	https_enabled: bool,
	redirect_https: bool,
	certificate_source: String,
	certificate_pem: String,
	private_key_pem: String,
}

pub async fn create_domain(State(s): State<Arc<Server>>, body: Bytes) -> ApiResult {
	let req: CreateDomain = decode(&body)?;
	let input = CreateInput {
		project_id: req.project_id,
		environment_id: req.environment_id,
		service_name: req.service,
		hostname: req.hostname,
		container_port: req.container_port,
		https: req.https_enabled,
		redirect_https: req.redirect_https,
		certificate_source: req.certificate_source,
		certificate_pem: req.certificate_pem,
		private_key_pem: req.private_key_pem,
	};
	match s.domains.create(&input).await {
		(Some(domain), Ok(())) => created(&json!({"domain": domain})),
		// A domain that exists but failed certificate issuance is a partial
		// success: report it so the user can retry TLS without re-adding.
		(Some(domain), Err(err)) => created(&json!({"domain": domain, "warning": format!("{err:#}")})),
		(None, Err(err)) => Err(bad_request(format!("{err:#}"))),
		(None, Ok(())) => unreachable!("create returns a domain whenever it succeeds"),
	}
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct UpdateDomain {
	hostname: Option<String>,
	container_port: Option<i64>,
	https_enabled: Option<bool>,
	redirect_https: Option<bool>,
	certificate_source: Option<String>,
	certificate_pem: Option<String>,
	private_key_pem: Option<String>,
}

pub async fn update_domain(State(s): State<Arc<Server>>, Path(id): Path<String>, body: Bytes) -> ApiResult {
	let mut domain = s.db.domain_by_id(&id).map_err(lookup)?;
	let req: UpdateDomain = decode(&body)?;
	if let Some(hostname) = req.hostname {
		domain.hostname = hostname;
	}
	if let Some(port) = req.container_port {
		domain.container_port = port;
	}
	if let Some(https) = req.https_enabled {
		domain.https_enabled = https;
	}
	if let Some(redirect) = req.redirect_https {
		domain.redirect_https = redirect;
	}
	if let Some(source) = req.certificate_source {
		domain.certificate_source = source;
	}
	let update =
		UpdateInput { certificate_pem: req.certificate_pem.unwrap_or_default(), private_key_pem: req.private_key_pem.unwrap_or_default() };
	match s.domains.update(&mut domain, &update).await {
		(_, Ok(())) => ok(&json!({"domain": domain})),
		(false, Err(err)) => Err(bad_request(format!("{err:#}"))),
		// Saved, but the certificate or the proxy reload did not follow.
		(true, Err(err)) => ok(&json!({"domain": domain, "warning": format!("{err:#}")})),
	}
}

pub async fn delete_domain(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	s.domains.delete(&id).await?;
	done()
}

/// Retries or forces certificate issuance for a domain.
pub async fn issue_certificate(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	let domain = s.db.domain_by_id(&id).map_err(lookup)?;
	if let Err(err) = s.domains.ensure_certificate(&domain).await {
		return Err(ApiError::new(StatusCode::BAD_GATEWAY, "CERTIFICATE_FAILED", format!("{err:#}")));
	}
	ok(&s.db.certificate_by_domain(&domain.id).map_err(lookup)?)
}

pub async fn list_certificates(State(s): State<Arc<Server>>) -> ApiResult {
	ok(&s.db.list_certificates()?)
}
