//! Sign-in, sign-up and sessions belong to the better-auth service; Nginx
//! routes /api/auth/* there. What remains here is the manager's own view of
//! the caller and the API tokens it issues for CI.

use std::collections::HashSet;
use std::sync::Arc;

use axum::Extension;
use axum::body::Bytes;
use axum::extract::{Path, State};
use serde::Deserialize;
use serde_json::json;

use super::respond::{ApiError, ApiResult, bad_request, created, decode, done, ok, server_error};
use super::{Caller, Server};
use crate::database::{self, ProjectGrant};
use crate::security;

/// Also tells the caller what it may do, so an agent holding a project token
/// can find its projects before guessing at ids.
pub async fn me(Extension(caller): Extension<Caller>) -> ApiResult {
	let access = match &caller.user.token {
		Some(token) => json!({"admin": token.admin, "projects": token.projects}),
		None => json!({"admin": true, "projects": []}),
	};
	ok(&json!({"user": caller.user, "access": access}))
}

pub async fn list_tokens(State(s): State<Arc<Server>>) -> ApiResult {
	ok(&s.db.list_api_tokens()?)
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct CreateToken {
	name: String,
	projects: Vec<ProjectGrant>,
}

/// Returns the raw token exactly once. Without projects the token is an admin
/// token; with them it reaches only those projects.
pub async fn create_token(State(s): State<Arc<Server>>, Extension(caller): Extension<Caller>, body: Bytes) -> ApiResult {
	let req: CreateToken = decode(&body)?;
	if req.name.is_empty() {
		return Err(bad_request("token name is required"));
	}
	s.valid_grants(&req.projects)?;
	let raw = security::random_token(32);
	let token = s.db.create_api_token(&caller.user.id, &req.name, &security::hash_token(&raw), &raw[..6], &req.projects)?;
	created(&json!({"token": token, "value": raw}))
}

impl Server {
	/// Checks the project list a token or an OAuth grant is asked for.
	pub(super) fn valid_grants(&self, grants: &[ProjectGrant]) -> Result<(), ApiError> {
		let mut seen = HashSet::new();
		for grant in grants {
			if grant.level != database::ACCESS_READ && grant.level != database::ACCESS_WRITE {
				return Err(bad_request(format!("level must be {:?} or {:?}", database::ACCESS_READ, database::ACCESS_WRITE)));
			}
			if !seen.insert(grant.project_id.as_str()) {
				return Err(bad_request(format!("project {} is listed twice", grant.project_id)));
			}
			if let Err(err) = self.db.project_by_id(&grant.project_id) {
				if database::is_not_found(&err) {
					return Err(bad_request(format!("no project {}", grant.project_id)));
				}
				return Err(server_error(err));
			}
		}
		Ok(())
	}
}

pub async fn delete_token(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	s.db.delete_api_token(&id)?;
	done()
}
