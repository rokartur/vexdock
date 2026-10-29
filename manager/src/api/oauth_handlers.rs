//! The manager is an OAuth 2.1 authorization server for its own MCP server, so
//! clients that cannot send a header (claude.ai, ChatGPT) can still connect. A
//! client registers itself, an administrator approves it on the dashboard's
//! consent screen with the project levels a token carries, and the grant it
//! gets is an api_tokens row (database/tokens.rs). PKCE with S256 is required.

use std::collections::HashMap;
use std::net::IpAddr;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use axum::body::Bytes;
use axum::extract::{Query, Request, State};
use axum::http::{HeaderMap, HeaderValue, Method, StatusCode, header};
use axum::middleware::{Next, from_fn};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Extension, Router};
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use url::{Host, Url};

use super::respond::{ApiError, ApiResult, bad_request, created, decode, json, ok};
use super::{Caller, Server};
use crate::database::{self, OAuthClient, ProjectGrant};
use crate::security;

const CODE_LIFETIME: Duration = Duration::from_secs(5 * 60);

/// What the registration and token endpoints read of a body.
const OAUTH_BODY_LIMIT: usize = 64 << 10;

/// The routes an OAuth client calls before it holds a token, open to any
/// origin: they run in a browser too (MCP Inspector), and none reads a cookie,
/// so no origin gains anything a server-side client does not already have.
pub fn public_routes(router: Router<Arc<Server>>) -> Router<Arc<Server>> {
	let open = Router::new()
		.route("/.well-known/oauth-authorization-server", get(authorization_server_metadata))
		.route("/.well-known/oauth-protected-resource", get(protected_resource_metadata))
		.route("/.well-known/oauth-protected-resource/mcp", get(protected_resource_metadata))
		.route("/api/oauth/register", post(oauth_register))
		.route("/api/oauth/token", post(oauth_token))
		.layer(from_fn(allow_any_origin));
	router.merge(open)
}

async fn allow_any_origin(req: Request, next: Next) -> Response {
	let mut resp = if req.method() == Method::OPTIONS {
		let mut preflight = StatusCode::NO_CONTENT.into_response();
		let headers = preflight.headers_mut();
		headers.insert(header::ACCESS_CONTROL_ALLOW_METHODS, HeaderValue::from_static("GET, POST"));
		headers.insert(header::ACCESS_CONTROL_ALLOW_HEADERS, HeaderValue::from_static("Authorization, Content-Type, MCP-Protocol-Version"));
		preflight
	} else {
		next.run(req).await
	};
	resp.headers_mut().insert(header::ACCESS_CONTROL_ALLOW_ORIGIN, HeaderValue::from_static("*"));
	resp
}

/// The authorization server's identifier, the dashboard's public origin.
/// OAuth needs https, or plain http on a loopback address for development;
/// without either every OAuth endpoint answers OAUTH_DISABLED.
fn oauth_issuer(public_url: &str) -> Result<&str, ApiError> {
	let enabled = Url::parse(public_url).is_ok_and(|u| u.scheme() == "https" || (u.scheme() == "http" && is_loopback(u.host())));
	if !enabled {
		return Err(ApiError::new(StatusCode::NOT_FOUND, "OAUTH_DISABLED", "OAuth needs PUBLIC_URL set to an https address"));
	}
	Ok(public_url)
}

fn is_loopback(host: Option<Host<&str>>) -> bool {
	match host {
		Some(Host::Domain(name)) => name == "localhost",
		Some(Host::Ipv4(ip)) => IpAddr::V4(ip).is_loopback(),
		Some(Host::Ipv6(ip)) => IpAddr::V6(ip).is_loopback(),
		None => false,
	}
}

async fn authorization_server_metadata(State(s): State<Arc<Server>>) -> ApiResult {
	let issuer = oauth_issuer(&s.cfg.public_url)?;
	ok(&json!({
		"issuer": issuer,
		"authorization_endpoint": format!("{issuer}/oauth/authorize"),
		"token_endpoint": format!("{issuer}/api/oauth/token"),
		"registration_endpoint": format!("{issuer}/api/oauth/register"),
		"response_types_supported": ["code"],
		"grant_types_supported": ["authorization_code", "refresh_token"],
		"code_challenge_methods_supported": ["S256"],
		"token_endpoint_auth_methods_supported": ["none"],
	}))
}

/// Describes /mcp (RFC 9728). The MCP server points clients here from its 401.
async fn protected_resource_metadata(State(s): State<Arc<Server>>) -> ApiResult {
	let issuer = oauth_issuer(&s.cfg.public_url)?;
	ok(&json!({
		"resource": format!("{issuer}/mcp"),
		"authorization_servers": [issuer],
		"bearer_methods_supported": ["header"],
	}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct RegisterRequest {
	redirect_uris: Vec<String>,
	client_name: String,
}

/// Open dynamic client registration (RFC 7591). Every client is public and
/// gets no secret, whatever auth method it asked for.
async fn oauth_register(State(s): State<Arc<Server>>, body: Bytes) -> Result<Response, ApiError> {
	oauth_issuer(&s.cfg.public_url)?;
	if body.len() > OAUTH_BODY_LIMIT {
		return Ok(oauth_error(StatusCode::BAD_REQUEST, "invalid_client_metadata", "the registration is larger than 64 KiB"));
	}
	let req: RegisterRequest = match serde_json::from_slice(&body) {
		Ok(req) => req,
		Err(err) => return Ok(oauth_error(StatusCode::BAD_REQUEST, "invalid_client_metadata", &err.to_string())),
	};
	if req.redirect_uris.is_empty() || req.redirect_uris.len() > 10 {
		return Ok(oauth_error(StatusCode::BAD_REQUEST, "invalid_redirect_uri", "between 1 and 10 redirect_uris required"));
	}
	if let Some(uri) = req.redirect_uris.iter().find(|uri| !valid_redirect_uri(uri)) {
		let description = format!("{uri:?} must be https, loopback http or an app's own scheme");
		return Ok(oauth_error(StatusCode::BAD_REQUEST, "invalid_redirect_uri", &description));
	}
	let mut name = req.client_name.trim();
	if name.is_empty() {
		name = "MCP client";
	}
	if name.len() > 100 {
		return Ok(oauth_error(StatusCode::BAD_REQUEST, "invalid_client_metadata", "client_name is longer than 100 bytes"));
	}
	let client = s.db.create_oauth_client(name, &req.redirect_uris)?;
	created(&json!({
		"client_id": client.id,
		"client_id_issued_at": database::parse_time(&client.created_at).map(|t| t.timestamp()).unwrap_or_default(),
		"client_name": client.name,
		"redirect_uris": client.redirect_uris,
		"grant_types": ["authorization_code", "refresh_token"],
		"response_types": ["code"],
		"token_endpoint_auth_method": "none",
	}))
}

/// Accepts https, http on a loopback address and a native app's own scheme
/// (cursor://). The consent screen navigates to this address, so a scheme a
/// browser runs or reads locally would execute on the dashboard.
fn valid_redirect_uri(raw: &str) -> bool {
	let Ok(u) = Url::parse(raw) else {
		return false;
	};
	if u.fragment().is_some() {
		return false;
	}
	match u.scheme() {
		"https" => u.host_str().is_some_and(|host| !host.is_empty()),
		"http" => is_loopback(u.host()),
		"javascript" | "data" | "file" | "vbscript" | "blob" | "about" | "ws" | "wss" | "ftp" => false,
		_ => true,
	}
}

/// The client's authorization request, which the consent screen passes on
/// unchanged from its query string.
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct AuthorizeRequest {
	client_id: String,
	redirect_uri: String,
	response_type: String,
	code_challenge: String,
	code_challenge_method: String,
	state: String,
	resource: String,
}

/// Lets the consent screen validate the request and name the client before
/// it asks the administrator anything.
pub async fn oauth_authorize_check(State(s): State<Arc<Server>>, Query(req): Query<AuthorizeRequest>) -> ApiResult {
	let (client, _) = s.authorize_client(&req)?;
	ok(&json!({"client_name": client.name, "redirect_uri": req.redirect_uri}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
struct Approval {
	#[serde(flatten)]
	request: AuthorizeRequest,
	projects: Vec<ProjectGrant>,
}

/// Records the administrator's approval and answers with the address the
/// consent screen sends the browser back to. No projects means full access,
/// as for a token.
pub async fn oauth_authorize(State(s): State<Arc<Server>>, Extension(caller): Extension<Caller>, body: Bytes) -> ApiResult {
	let approval: Approval = decode(&body)?;
	let req = approval.request;
	let (client, issuer) = s.authorize_client(&req)?;
	s.valid_grants(&approval.projects)?;
	let code = s.codes.add(AuthCode {
		client_id: client.id,
		redirect_uri: req.redirect_uri.clone(),
		challenge: req.code_challenge,
		user_id: caller.user.id,
		grants: approval.projects,
		expires: Instant::now(),
	});
	let mut redirect = Url::parse(&req.redirect_uri).map_err(bad_request)?;
	let kept: Vec<(String, String)> = redirect
		.query_pairs()
		.filter(|(key, _)| !matches!(key.as_ref(), "code" | "iss" | "state"))
		.map(|(k, v)| (k.into_owned(), v.into_owned()))
		.collect();
	{
		let mut query = redirect.query_pairs_mut();
		query.clear().extend_pairs(kept).append_pair("code", &code).append_pair("iss", &issuer);
		if !req.state.is_empty() {
			query.append_pair("state", &req.state);
		}
	}
	ok(&json!({"redirect": redirect.as_str()}))
}

impl Server {
	/// Checks an authorization request against the registered client. A bad
	/// client or redirect URI is never redirected to, so every failure is an
	/// error for the consent screen to show.
	fn authorize_client(&self, req: &AuthorizeRequest) -> Result<(OAuthClient, String), ApiError> {
		let issuer = oauth_issuer(&self.cfg.public_url)?.to_string();
		let client = match self.db.oauth_client_by_id(&req.client_id) {
			Ok(client) => client,
			Err(err) if database::is_not_found(&err) => return Err(bad_request("unknown client_id; the client has to register again")),
			Err(err) => return Err(err.into()),
		};
		let problem = if !client.redirect_uris.contains(&req.redirect_uri) {
			"redirect_uri is not registered for this client".to_string()
		} else if req.response_type != "code" {
			r#"response_type must be "code""#.to_string()
		} else if req.code_challenge.is_empty() || req.code_challenge_method != "S256" {
			"PKCE with code_challenge_method S256 is required".to_string()
		} else if !req.resource.is_empty() && req.resource != format!("{issuer}/mcp") {
			format!("resource must be {issuer}/mcp")
		} else {
			return Ok((client, issuer));
		};
		Err(bad_request(problem))
	}
}

/// Exchanges an authorization code or a refresh token for a new token pair.
/// Errors follow RFC 6749, not the API's own envelope, because OAuth client
/// libraries parse them.
async fn oauth_token(State(s): State<Arc<Server>>, headers: HeaderMap, body: Bytes) -> Result<Response, ApiError> {
	let issuer = oauth_issuer(&s.cfg.public_url)?;
	if body.len() > OAUTH_BODY_LIMIT {
		return Ok(oauth_error(StatusCode::BAD_REQUEST, "invalid_request", "the request is larger than 64 KiB"));
	}
	let form: HashMap<String, String> = url::form_urlencoded::parse(&body).into_owned().collect();
	let field = |key: &str| form.get(key).map(String::as_str).unwrap_or_default();
	// A public client may still authenticate the RFC 6749 way, with its id as
	// the Basic username and an empty password.
	let client_id = match field("client_id") {
		"" => basic_auth_user(&headers).unwrap_or_default(),
		id => id.to_string(),
	};
	let resource = field("resource");
	if !resource.is_empty() && resource != format!("{issuer}/mcp") {
		return Ok(oauth_error(StatusCode::BAD_REQUEST, "invalid_target", &format!("resource must be {issuer}/mcp")));
	}
	let (access, refresh) = (security::random_token(32), security::random_token(32));
	let (access_hash, refresh_hash, prefix) = (security::hash_token(&access), security::hash_token(&refresh), &access[..6]);
	match field("grant_type") {
		"authorization_code" => {
			let redirect_uri = field("redirect_uri");
			let code = s.codes.take(field("code")).filter(|code| {
				code.client_id == client_id
					&& (redirect_uri.is_empty() || redirect_uri == code.redirect_uri)
					&& pkce_matches(&code.challenge, field("code_verifier"))
			});
			let Some(code) = code else {
				return Ok(oauth_error(
					StatusCode::BAD_REQUEST,
					"invalid_grant",
					"the code is unknown, used, expired or was issued to another client",
				));
			};
			let client = s.db.oauth_client_by_id(&code.client_id)?;
			s.db.create_oauth_grant(&code.user_id, &client, &code.grants, &access_hash, &refresh_hash, prefix)?;
		}
		"refresh_token" => {
			match s.db.rotate_oauth_grant(&client_id, &security::hash_token(field("refresh_token")), &access_hash, &refresh_hash, prefix) {
				Ok(()) => {}
				Err(err) if database::is_not_found(&err) => {
					return Ok(oauth_error(
						StatusCode::BAD_REQUEST,
						"invalid_grant",
						"the refresh token is unknown, expired or was already used",
					));
				}
				Err(err) => return Err(err.into()),
			}
		}
		_ => {
			return Ok(oauth_error(
				StatusCode::BAD_REQUEST,
				"unsupported_grant_type",
				r#"grant_type must be "authorization_code" or "refresh_token""#,
			));
		}
	}
	let mut resp = json(
		StatusCode::OK,
		&json!({
			"access_token": access,
			"token_type": "Bearer",
			"expires_in": database::OAUTH_ACCESS_LIFETIME.as_secs(),
			"refresh_token": refresh,
		}),
	);
	resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
	Ok(resp)
}

fn basic_auth_user(headers: &HeaderMap) -> Option<String> {
	let value = headers.get(header::AUTHORIZATION)?.to_str().ok()?;
	let encoded = value.strip_prefix("Basic ")?;
	let decoded = String::from_utf8(STANDARD.decode(encoded.trim()).ok()?).ok()?;
	let (user, _) = decoded.split_once(':')?;
	Some(user.to_string())
}

fn oauth_error(status: StatusCode, code: &str, description: &str) -> Response {
	let mut resp = json(status, &json!({"error": code, "error_description": description}));
	resp.headers_mut().insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
	resp
}

/// Checks a code verifier against its S256 challenge (RFC 7636).
fn pkce_matches(challenge: &str, verifier: &str) -> bool {
	if verifier.len() < 43 || verifier.len() > 128 {
		return false;
	}
	let computed = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
	computed.as_bytes().ct_eq(challenge.as_bytes()).into()
}

/// An approval waiting to be exchanged. Codes live in memory: a restart in
/// the minutes between consent and exchange only means clicking Allow again.
struct AuthCode {
	client_id: String,
	redirect_uri: String,
	challenge: String,
	user_id: String,
	grants: Vec<ProjectGrant>,
	expires: Instant,
}

#[derive(Default)]
pub struct AuthCodes {
	pending: Mutex<HashMap<String, AuthCode>>,
}

impl AuthCodes {
	/// Stores an approval and returns its single-use code, dropping the
	/// approvals nobody came back for.
	fn add(&self, mut code: AuthCode) -> String {
		let mut pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
		let now = Instant::now();
		pending.retain(|_, waiting| waiting.expires > now);
		let raw = security::random_token(32);
		code.expires = now + CODE_LIFETIME;
		pending.insert(security::hash_token(&raw), code);
		raw
	}

	fn take(&self, raw: &str) -> Option<AuthCode> {
		let mut pending = self.pending.lock().unwrap_or_else(|p| p.into_inner());
		pending.remove(&security::hash_token(raw)).filter(|code| Instant::now() < code.expires)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn oauth_needs_https() {
		for (public_url, enabled) in
			[("", false), ("http://203.0.113.7:3000", false), ("http://127.0.0.1:3000", true), ("https://panel.example", true)]
		{
			assert_eq!(oauth_issuer(public_url).is_ok(), enabled, "{public_url:?}");
		}
	}

	#[test]
	fn redirect_uris_a_browser_would_run_are_refused() {
		for (uri, valid) in [
			("https://claude.ai/api/mcp/auth_callback", true),
			("http://127.0.0.1:33418/callback", true),
			("http://localhost/cb", true),
			("cursor://anysphere.cursor-retrieval/oauth", true),
			("http://example.com/cb", false),
			("javascript:alert(1)", false),
			("https://claude.ai/cb#frag", false),
			("/relative", false),
		] {
			assert_eq!(valid_redirect_uri(uri), valid, "{uri}");
		}
	}
}
