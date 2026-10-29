//! Authenticates API requests. It does not issue credentials: logging in,
//! signing up and session lifetime belong to the better-auth service, which
//! owns its own SQLite database. The manager opens that database read-only and
//! validates the session cookie the browser presents.

use std::sync::{Arc, Mutex};

use anyhow::{Context, Result};
use axum::http::HeaderMap;
use chrono::{DateTime, Utc};
use rusqlite::types::Value;
use rusqlite::{Connection, OpenFlags, OptionalExtension};
use serde::Serialize;

use crate::database::{ApiToken, Db};
use crate::security::hash_token;

/// The cookie better-auth sets. Its value is "<token>.<signature>"; the token
/// is what the session table stores.
pub const SESSION_COOKIE: &str = "better-auth.session_token";

/// The request carried no usable credential.
#[derive(Debug, thiserror::Error)]
#[error("no valid session")]
pub struct NoSession;

/// The authenticated principal, as stored by better-auth.
#[derive(Clone, Debug, Default, Serialize)]
pub struct User {
	pub id: String,
	pub email: String,
	pub name: String,
	/// The API token the request came with. A dashboard session has none and is
	/// the administrator.
	#[serde(skip)]
	pub token: Option<ApiToken>,
}

pub struct Auth {
	db: Arc<Db>,
	path: String,
	// Opened on first use: the auth service creates the file on its first boot
	// and the manager picks it up on the next request.
	auth: Mutex<Option<Connection>>,
}

impl Auth {
	pub fn new(db: Arc<Db>, auth_database_path: String) -> Auth {
		Auth { db, path: auth_database_path, auth: Mutex::new(None) }
	}

	/// Resolves a request to a user, accepting either a better-auth session
	/// cookie or a platform API token. The bool is true for a cookie session.
	pub fn authenticate(&self, headers: &HeaderMap) -> Result<(User, bool)> {
		if !via_cookie(headers) {
			let raw = header(headers, "authorization").trim_start_matches("Bearer ").trim().to_string();
			// API tokens are not sent automatically by browsers, so no CSRF check.
			return Ok((self.user_by_api_token(&raw)?, false));
		}
		let cookie = cookie(headers, SESSION_COOKIE).unwrap_or_default();
		if cookie.is_empty() {
			return Err(NoSession.into());
		}
		Ok((self.user_by_session(session_token(&cookie))?, true))
	}

	fn with_auth_db<T>(&self, query: impl FnOnce(&Connection) -> Result<T>) -> Result<T> {
		let mut guard = self.auth.lock().unwrap_or_else(|poisoned| poisoned.into_inner());
		if guard.is_none() {
			let conn = Connection::open_with_flags(&self.path, OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX)
				.context("open auth database")?;
			conn.busy_timeout(std::time::Duration::from_secs(5))?;
			*guard = Some(conn);
		}
		query(guard.as_ref().expect("opened above"))
	}

	fn user_by_session(&self, token: &str) -> Result<User> {
		if token.is_empty() {
			return Err(NoSession.into());
		}
		let row = self.with_auth_db(|conn| {
			conn.query_row(
				"SELECT u.id, u.email, u.name, s.expiresAt FROM session s JOIN user u ON u.id = s.userId WHERE s.token = ?",
				[token],
				|r| Ok((User { id: r.get(0)?, email: r.get(1)?, name: r.get(2)?, token: None }, r.get::<_, Value>(3)?)),
			)
			.optional()
			.context("read session")
		})?;
		let Some((user, expires)) = row else {
			return Err(NoSession.into());
		};
		if session_expiry(&expires).is_some_and(|at| at < Utc::now()) {
			return Err(NoSession.into());
		}
		Ok(user)
	}

	fn user_by_api_token(&self, raw: &str) -> Result<User> {
		let token = self.db.api_token_by_hash(&hash_token(raw)).map_err(|_| NoSession)?;
		// The token records which better-auth user created it; the current details
		// make a renamed account show everywhere.
		let mut user = self.user_by_id(&token.user_id).unwrap_or_else(|_| User {
			id: token.user_id.clone(),
			email: format!("api-token:{}", token.name),
			..Default::default()
		});
		user.token = Some(token);
		Ok(user)
	}

	fn user_by_id(&self, id: &str) -> Result<User> {
		self.with_auth_db(|conn| {
			Ok(conn.query_row("SELECT id, email, name FROM user WHERE id = ?", [id], |r| {
				Ok(User { id: r.get(0)?, email: r.get(1)?, name: r.get(2)?, token: None })
			})?)
		})
	}
}

/// better-auth writes a date as ISO text through Kysely, but an integer of
/// milliseconds is what some of its adapters store; read both.
fn session_expiry(value: &Value) -> Option<DateTime<Utc>> {
	match value {
		Value::Text(text) => DateTime::parse_from_rfc3339(text)
			.map(|t| t.with_timezone(&Utc))
			.or_else(|_| chrono::NaiveDateTime::parse_from_str(text, "%Y-%m-%d %H:%M:%S").map(|t| t.and_utc()))
			.ok(),
		Value::Integer(n) if *n > 100_000_000_000 => DateTime::from_timestamp_millis(*n),
		Value::Integer(n) => DateTime::from_timestamp(*n, 0),
		Value::Real(f) => DateTime::from_timestamp_millis(*f as i64),
		_ => None,
	}
}

/// Strips the signature better-auth appends to the cookie value.
fn session_token(cookie_value: &str) -> &str {
	match cookie_value.find('.') {
		Some(idx) if idx > 0 => &cookie_value[..idx],
		_ => cookie_value,
	}
}

pub(crate) fn header<'a>(headers: &'a HeaderMap, name: &str) -> &'a str {
	headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or("")
}

/// The first cookie with this name, the way Go's Request.Cookie picks it.
pub fn cookie(headers: &HeaderMap, name: &str) -> Option<String> {
	for value in headers.get_all("cookie") {
		let Ok(value) = value.to_str() else { continue };
		for pair in value.split(';') {
			if let Some((key, val)) = pair.trim().split_once('=')
				&& key == name
			{
				return Some(val.trim_matches('"').to_string());
			}
		}
	}
	None
}

/// Which credential a request carries: a Bearer header is an API token,
/// anything else can only be the session cookie. `authenticate` decides the
/// same way; a handler that has to name the credential asks here.
pub fn via_cookie(headers: &HeaderMap) -> bool {
	!header(headers, "authorization").starts_with("Bearer ")
}

/// Whether a state-changing request came from the dashboard itself. Browsers
/// cannot forge Origin, and same-origin fetches always send it for non-GET
/// requests, so this is the CSRF defense for cookie sessions.
pub fn same_origin(headers: &HeaderMap) -> bool {
	let origin = header(headers, "origin");
	if origin.is_empty() {
		// No Origin: not made by a browser page; a cross-site form post always carries one.
		return true;
	}
	let Some((scheme, host)) = split_origin(origin) else {
		return false;
	};
	canonical_origin(&scheme, &host) == canonical_origin(&request_scheme(headers), header(headers, "host"))
}

/// Spells an origin out in full so two ways of writing the same one compare
/// equal. The port is always present (a browser omits the default one, a Host
/// header may carry it) and so is the scheme, or http on 80 and TLS on 443 would
/// both reduce to the bare hostname.
fn canonical_origin(scheme: &str, host: &str) -> String {
	let scheme = scheme.to_lowercase();
	let mut host = host.to_lowercase();
	if !has_port(&host) {
		match scheme.as_str() {
			"https" => host.push_str(":443"),
			"http" => host.push_str(":80"),
			_ => {}
		}
	}
	format!("{scheme}://{host}")
}

/// What Go's net.SplitHostPort accepts: `host:port` or `[v6]:port`.
fn has_port(host: &str) -> bool {
	match host.strip_prefix('[') {
		Some(rest) => rest.split_once(']').is_some_and(|(_, after)| after.starts_with(':')),
		None => host.matches(':').count() == 1,
	}
}

/// The scheme the browser used. Nginx sets X-Forwarded-Proto on the panel's
/// /api/ location; a manager reached directly is plain http, and then the
/// Origin says http too. A cross-site request cannot set this header.
fn request_scheme(headers: &HeaderMap) -> String {
	let proto = header(headers, "x-forwarded-proto").split(',').next().unwrap_or("").trim();
	if proto.is_empty() { "http".into() } else { proto.to_string() }
}

/// The address the browser reached this manager on, which is what a provider
/// redirects back to. Only ask after the session and same-origin checks passed,
/// because Host is the client's to send.
pub fn origin(headers: &HeaderMap) -> String {
	format!("{}://{}", request_scheme(headers), header(headers, "host"))
}

/// Separates an Origin into scheme and host. A page served from
/// http://panel:8080 must not pass as the dashboard on panel:443.
fn split_origin(origin: &str) -> Option<(String, String)> {
	let (scheme, host) = origin.trim().split_once("://")?;
	let scheme = scheme.to_lowercase();
	if scheme != "http" && scheme != "https" {
		return None;
	}
	// An Origin carries no path and no credentials, but tolerate a trailing slash.
	let host = host.strip_suffix('/').unwrap_or(host);
	if host.is_empty() || host.contains(['/', '@']) {
		return None;
	}
	Some((scheme, host.to_string()))
}

#[cfg(test)]
mod tests;
