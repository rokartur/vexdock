//! A service's redirects and basic-auth users live in the nginx vhosts of its
//! domains, so every change reconciles the proxy. Its ports are compose ports
//! and take effect on the next deploy.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use serde::Deserialize;

use super::Server;
use super::respond::{ApiError, ApiResult, bad_request, created, decode, lookup, ok};
use crate::database::{self, ServiceBasicAuth, ServicePort, ServiceRedirect};
use crate::nginx;
use crate::security;

pub async fn list_service_redirects(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	ok(&s.db.service_redirects(&id)?)
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct CreateRedirect {
	regex: String,
	replacement: String,
	permanent: bool,
}

pub async fn create_service_redirect(State(s): State<Arc<Server>>, Path(id): Path<String>, body: Bytes) -> ApiResult {
	s.db.service_by_id(&id).map_err(lookup)?;
	let req: CreateRedirect = decode(&body)?;
	let replacement = security::validate_redirect(&req.regex, &req.replacement).map_err(bad_request)?;
	let mut redirect = ServiceRedirect { service_id: id, regex: req.regex, replacement, permanent: req.permanent, ..Default::default() };
	s.db.create_service_redirect(&mut redirect)?;
	if let Err(err) = s.domains.reconcile().await {
		s.undo_routing_rule(s.db.delete_service_redirect(&redirect.service_id, &redirect.id)).await;
		return Err(bad_request(format!("nginx rejected the redirect: {err:#}")));
	}
	created(&redirect)
}

pub async fn delete_service_redirect(State(s): State<Arc<Server>>, Path((id, redirect_id)): Path<(String, String)>) -> ApiResult {
	s.db.delete_service_redirect(&id, &redirect_id)?;
	s.reconcile_after_delete().await
}

pub async fn list_service_basic_auth(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	ok(&s.db.service_basic_auths(&id)?)
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct CreateBasicAuth {
	username: String,
	password: String,
}

pub async fn create_service_basic_auth(State(s): State<Arc<Server>>, Path(id): Path<String>, body: Bytes) -> ApiResult {
	s.db.service_by_id(&id).map_err(lookup)?;
	let req: CreateBasicAuth = decode(&body)?;
	security::validate_basic_auth_user(&req.username, &req.password).map_err(bad_request)?;
	let mut user = ServiceBasicAuth {
		service_id: id,
		username: req.username.clone(),
		password_hash: nginx::hash_password(&req.password),
		..Default::default()
	};
	if let Err(err) = s.db.create_service_basic_auth(&mut user) {
		if err.to_string().contains("UNIQUE") {
			return Err(ApiError::new(StatusCode::CONFLICT, "CONFLICT", format!("user {:?} already exists", req.username)));
		}
		return Err(err.into());
	}
	if let Err(err) = s.domains.reconcile().await {
		s.undo_routing_rule(s.db.delete_service_basic_auth(&user.service_id, &user.id)).await;
		return Err(err.into());
	}
	created(&user)
}

pub async fn delete_service_basic_auth(State(s): State<Arc<Server>>, Path((id, user_id)): Path<(String, String)>) -> ApiResult {
	s.db.delete_service_basic_auth(&id, &user_id)?;
	s.reconcile_after_delete().await
}

pub async fn list_service_ports(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	ok(&s.db.service_ports(&id)?)
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct CreatePort {
	published: i64,
	target: i64,
	protocol: String,
}

pub async fn create_service_port(State(s): State<Arc<Server>>, Path(id): Path<String>, body: Bytes) -> ApiResult {
	let service = s.db.service_by_id(&id).map_err(lookup)?;
	if service.provider == database::PROVIDER_RAW {
		return Err(bad_request("a compose fragment declares its ports in its own YAML"));
	}
	let req: CreatePort = decode(&body)?;
	security::validate_published_port(req.published, req.target, &req.protocol).map_err(bad_request)?;
	let mut port = ServicePort {
		service_id: service.id,
		published: req.published,
		target: req.target,
		protocol: req.protocol.clone(),
		..Default::default()
	};
	if let Err(err) = s.db.create_service_port(&mut port) {
		if err.to_string().contains("UNIQUE") {
			let message = format!("host port {}/{} is already published by a service", req.published, req.protocol);
			return Err(ApiError::new(StatusCode::CONFLICT, "CONFLICT", message));
		}
		return Err(err.into());
	}
	created(&port)
}

pub async fn delete_service_port(State(s): State<Arc<Server>>, Path((id, port_id)): Path<(String, String)>) -> ApiResult {
	s.db.delete_service_port(&id, &port_id)?;
	Ok(StatusCode::NO_CONTENT.into_response())
}

impl Server {
	/// Removes a rule nginx refused and puts the proxy back on the config it
	/// had, so one bad rule cannot wedge every later reconcile.
	async fn undo_routing_rule(&self, deleted: anyhow::Result<()>) {
		if let Err(err) = deleted {
			tracing::error!(error = %err, "remove rejected routing rule");
			return;
		}
		if let Err(err) = self.domains.reconcile().await {
			tracing::error!(error = %err, "reconcile after removing rejected routing rule");
		}
	}

	async fn reconcile_after_delete(&self) -> ApiResult {
		self.domains.reconcile().await?;
		Ok(StatusCode::NO_CONTENT.into_response())
	}
}
