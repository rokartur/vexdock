//! Every authenticated route is registered through one of three guards, so a
//! route nobody classified does not exist. A dashboard session and an admin
//! token pass all three; a project token passes signed_in, and project only for
//! the projects it was granted.

use std::net::SocketAddr;
use std::sync::Arc;

use axum::body::Body;
use axum::extract::{ConnectInfo, RawPathParams, Request, State};
use axum::http::{Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};

use super::Server;
use super::respond::{ApiError, server_error};
use crate::auth::{self, User};
use crate::database::{self, AuditEntry};

#[derive(Clone, Copy)]
pub enum Access {
	/// Straight on the router, no credential.
	Public,
	/// Any credential: who am I, the catalogs, and the lists that filter
	/// themselves down to what the caller may see.
	SignedIn,
	/// Reaches past one project: Docker, the system, git providers, registries,
	/// tokens, and creating or deleting a project.
	Admin,
	/// Inside one project, at database::ACCESS_READ or ACCESS_WRITE.
	Project(&'static str, ProjectOf),
}

/// Names the project a request acts on.
#[derive(Clone, Copy)]
pub enum ProjectOf {
	Path,
	Service,
	Environment,
	Deployment,
	Domain,
	Task,
	/// POST /api/domains, the one route that names its project in the body. A
	/// body that is not JSON names no project, so a project token gets 403
	/// rather than the handler's 400.
	Body,
}

/// Who made the request, put into the request's extensions by the guard.
#[derive(Clone)]
pub struct Caller {
	pub user: User,
	pub via_cookie: bool,
	method: String,
	path: String,
	client_ip: String,
}

impl Caller {
	pub fn is_admin(&self) -> bool {
		self.user.token.as_ref().is_none_or(|t| t.admin)
	}

	pub fn allows(&self, project_id: &str, level: &str) -> bool {
		self.user.token.as_ref().is_none_or(|t| t.allows(project_id, level))
	}

	/// Names the caller on a deployment record.
	pub fn actor(&self) -> String {
		self.user.email.clone()
	}
}

#[derive(Clone)]
pub struct Guard {
	pub server: Arc<Server>,
	pub access: Access,
}

/// Requires authentication and, for cookie sessions, that a mutation came from
/// the dashboard itself; then the route's access level; then records every
/// state-changing call, whoever made it and however they authenticated.
pub async fn guard(State(g): State<Guard>, mut req: Request, next: Next) -> Response {
	let s = &g.server;
	let Ok((user, via_cookie)) = s.auth.authenticate(req.headers()) else {
		return ApiError::new(StatusCode::UNAUTHORIZED, "UNAUTHORIZED", "Authentication required").into_response();
	};
	let caller =
		Caller { user, via_cookie, method: req.method().to_string(), path: req.uri().path().to_string(), client_ip: client_ip(&req) };
	let audited = is_mutation(req.method()) || writes_credentials(req.uri().path());

	// A cookie is attached by the browser to cross-site requests too, so
	// mutations must prove they originate from the panel. Bearer tokens are
	// never sent automatically and need no such check.
	let response = if via_cookie && is_mutation(req.method()) && !auth::same_origin(req.headers()) {
		ApiError::new(StatusCode::FORBIDDEN, "CROSS_ORIGIN", "Cross-origin request rejected").into_response()
	} else {
		match check(s, g.access, &caller, &mut req).await {
			Ok(()) => {
				req.extensions_mut().insert(caller.clone());
				next.run(req).await
			}
			Err(err) => err.into_response(),
		}
	};
	if audited {
		s.audit(&caller, response.status().as_u16());
	}
	response
}

async fn check(s: &Server, access: Access, caller: &Caller, req: &mut Request) -> Result<(), ApiError> {
	match access {
		Access::Public | Access::SignedIn => Ok(()),
		Access::Admin if caller.is_admin() => Ok(()),
		Access::Admin => Err(forbidden()),
		Access::Project(..) if caller.is_admin() => Ok(()),
		Access::Project(level, of) => {
			let project_id = match project_of(s, of, req).await {
				Ok(id) => id,
				Err(err) if database::is_not_found(&err) => String::new(),
				Err(err) => return Err(server_error(err)),
			};
			// A missing resource answers like a forbidden one, so a project token
			// cannot probe for ids outside its projects.
			if project_id.is_empty() || !caller.allows(&project_id, level) {
				return Err(forbidden());
			}
			Ok(())
		}
	}
}

async fn project_of(s: &Server, of: ProjectOf, req: &mut Request) -> anyhow::Result<String> {
	let id = path_id(req).await;
	Ok(match of {
		ProjectOf::Path => id,
		ProjectOf::Service => s.db.service_by_id(&id)?.project_id,
		ProjectOf::Environment => s.db.environment_by_id(&id)?.project_id,
		ProjectOf::Deployment => s.db.deployment_by_id(&id)?.project_id,
		ProjectOf::Domain => s.db.domain_by_id(&id)?.project_id,
		ProjectOf::Task => {
			let task = s.db.scheduled_task_by_id(&id)?;
			s.db.service_by_id(&task.service_id)?.project_id
		}
		ProjectOf::Body => {
			// The body is put back for the handler.
			let body = std::mem::take(req.body_mut());
			let bytes = axum::body::to_bytes(body, super::BODY_LIMIT).await?;
			*req.body_mut() = Body::from(bytes.clone());
			#[derive(serde::Deserialize)]
			struct Named {
				#[serde(default)]
				project_id: String,
			}
			serde_json::from_slice::<Named>(&bytes).map(|n| n.project_id).unwrap_or_default()
		}
	})
}

async fn path_id(req: &mut Request) -> String {
	use axum::RequestExt;
	let Ok(params) = req.extract_parts::<RawPathParams>().await else { return String::new() };
	params.iter().find(|(name, _)| *name == "id").map(|(_, value)| value.to_string()).unwrap_or_default()
}

pub fn forbidden() -> ApiError {
	ApiError::new(StatusCode::FORBIDDEN, "FORBIDDEN", "This token has no access to that")
}

/// Identifies the caller for audit entries, honouring the header Nginx sets.
fn client_ip(req: &Request) -> String {
	if let Some(forwarded) = req.headers().get("x-real-ip").and_then(|v| v.to_str().ok()).filter(|v| !v.is_empty()) {
		return forwarded.into();
	}
	req.extensions().get::<ConnectInfo<SocketAddr>>().map(|info| info.0.ip().to_string()).unwrap_or_default()
}

/// The GET endpoints that store a git provider's access token when the host
/// redirects the owner back. They change state, so they are audited like a
/// mutation; the cross-origin check stays off them because the redirect
/// legitimately arrives from the provider.
fn writes_credentials(path: &str) -> bool {
	path.ends_with("/callback") || path == "/api/providers/github/installed"
}

pub fn is_mutation(method: &Method) -> bool {
	!matches!(*method, Method::GET | Method::HEAD | Method::OPTIONS)
}

impl Server {
	/// Records a mutation. A failed write is logged and swallowed: losing an
	/// audit line must never turn a successful action into an error.
	pub(super) fn audit(&self, caller: &Caller, status: u16) {
		let entry = AuditEntry {
			actor: if caller.user.email.is_empty() { "unknown".into() } else { caller.user.email.clone() },
			method: caller.method.clone(),
			path: caller.path.clone(),
			status: status.into(),
			client_ip: caller.client_ip.clone(),
			credential: if caller.via_cookie { "session" } else { "api-token" }.into(),
			..Default::default()
		};
		if let Err(err) = self.db.record_audit(&entry) {
			tracing::warn!(path = caller.path, error = %err, "audit write failed");
		}
	}
}
