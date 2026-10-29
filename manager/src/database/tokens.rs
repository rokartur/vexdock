use std::time::Duration;

use anyhow::Result;
use chrono::Utc;
use rusqlite::{Row, params};
use serde::{Deserialize, Serialize};

use super::{Db, NotFound, format_time, new_id, now, parse_time};

/// The two levels a token can hold on a project. Write implies read.
pub const ACCESS_READ: &str = "read";
pub const ACCESS_WRITE: &str = "write";

/// How long an OAuth access token works, and how long a grant may sit unused
/// before its refresh token stops working. Each refresh restarts the second.
pub const OAUTH_ACCESS_LIFETIME: Duration = Duration::from_secs(3600);
pub const OAUTH_REFRESH_LIFETIME: Duration = Duration::from_secs(30 * 24 * 3600);

/// A non-cookie credential for CI, the CLI and MCP clients. Only the hash and a
/// short display prefix are stored. An admin token reaches every route; any
/// other reaches only the projects in `projects`. A token with a client_id is
/// an OAuth grant.
#[derive(Clone, Debug, Default, Serialize)]
pub struct ApiToken {
	pub id: String,
	pub user_id: String,
	pub name: String,
	pub prefix: String,
	pub admin: bool,
	pub projects: Vec<ProjectGrant>,
	pub client_id: String,
	pub last_used_at: String,
	pub created_at: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct ProjectGrant {
	pub project_id: String,
	pub level: String,
}

impl ApiToken {
	/// Whether the token may act on a project at the given level.
	pub fn allows(&self, project_id: &str, level: &str) -> bool {
		self.admin || self.projects.iter().any(|g| g.project_id == project_id && (g.level == ACCESS_WRITE || level == ACCESS_READ))
	}
}

/// An MCP client that registered itself. Clients are public: there is no
/// secret, PKCE binds the code to whoever asked for it.
#[derive(Clone, Debug, Default, Serialize)]
pub struct OAuthClient {
	pub id: String,
	pub name: String,
	pub redirect_uris: Vec<String>,
	pub created_at: String,
}

struct OAuthGrant<'a> {
	client_id: &'a str,
	refresh_hash: &'a str,
}

impl Db {
	/// Stores an admin token when grants is empty and a project token otherwise.
	pub fn create_api_token(&self, user_id: &str, name: &str, token_hash: &str, prefix: &str, grants: &[ProjectGrant]) -> Result<ApiToken> {
		self.insert_token(user_id, name, token_hash, prefix, grants, None)
	}

	/// Stores a token, and for an OAuth grant its client, refresh token and both expiries.
	fn insert_token(
		&self,
		user_id: &str,
		name: &str,
		token_hash: &str,
		prefix: &str,
		grants: &[ProjectGrant],
		oauth: Option<OAuthGrant>,
	) -> Result<ApiToken> {
		let mut t = ApiToken {
			id: new_id(),
			user_id: user_id.into(),
			name: name.into(),
			prefix: prefix.into(),
			admin: grants.is_empty(),
			projects: grants.to_vec(),
			created_at: now(),
			..Default::default()
		};
		let (mut client_id, mut refresh_hash) = (None, None);
		let (mut expires_at, mut refresh_expires_at) = (String::new(), String::new());
		if let Some(oauth) = oauth {
			t.client_id = oauth.client_id.into();
			client_id = Some(oauth.client_id);
			refresh_hash = Some(oauth.refresh_hash);
			expires_at = expiry(OAUTH_ACCESS_LIFETIME);
			refresh_expires_at = expiry(OAUTH_REFRESH_LIFETIME);
		}
		let mut conn = self.conn();
		let tx = conn.transaction()?;
		tx.execute(
			"INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, admin, client_id, expires_at, refresh_hash, refresh_expires_at, last_used_at, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)",
			params![t.id, t.user_id, t.name, token_hash, t.prefix, t.admin, client_id, expires_at, refresh_hash, refresh_expires_at, t.created_at],
		)?;
		for grant in grants {
			tx.execute(
				"INSERT INTO api_token_projects (token_id, project_id, level) VALUES (?, ?, ?)",
				params![t.id, grant.project_id, grant.level],
			)?;
		}
		tx.commit()?;
		Ok(t)
	}

	pub fn list_api_tokens(&self) -> Result<Vec<ApiToken>> {
		let mut out = self.all(
			"SELECT id, user_id, name, prefix, admin, COALESCE(client_id, ''), last_used_at, created_at FROM api_tokens ORDER BY created_at DESC",
			[],
			scan_token,
		)?;
		for t in &mut out {
			t.projects = self.token_grants(&t.id)?;
		}
		Ok(out)
	}

	pub fn delete_api_token(&self, id: &str) -> Result<()> {
		self.exec("DELETE FROM api_tokens WHERE id = ?", [id])?;
		Ok(())
	}

	/// Resolves a bearer token and records its use. An expired OAuth access token
	/// is not found. The user it points at lives in the better-auth database.
	pub fn api_token_by_hash(&self, token_hash: &str) -> Result<ApiToken> {
		let (mut t, expires_at) = self.one(
			"SELECT id, user_id, name, prefix, admin, COALESCE(client_id, ''), last_used_at, created_at, expires_at FROM api_tokens WHERE token_hash = ?",
			[token_hash],
			|r| Ok((scan_token(r)?, r.get::<_, String>(8)?)),
		)?;
		if !expires_at.is_empty() && parse_time(&expires_at).is_none_or(|at| at < Utc::now()) {
			return Err(NotFound.into());
		}
		t.projects = self.token_grants(&t.id)?;
		// A minute of resolution is all the tokens page shows; writing on every
		// request would queue a CI run's calls behind the single writer connection.
		let recently_used = parse_time(&t.last_used_at).is_some_and(|at| Utc::now() - at < chrono::Duration::minutes(1));
		if !recently_used {
			// The token is already authenticated; losing this bookkeeping write must not turn it into a 401.
			let _ = self.exec("UPDATE api_tokens SET last_used_at = ? WHERE id = ?", params![now(), t.id]);
		}
		Ok(t)
	}

	fn token_grants(&self, token_id: &str) -> Result<Vec<ProjectGrant>> {
		self.all("SELECT project_id, level FROM api_token_projects WHERE token_id = ? ORDER BY project_id", [token_id], |r| {
			Ok(ProjectGrant { project_id: r.get(0)?, level: r.get(1)? })
		})
	}

	/// Registers a client. Registration needs no credential, so it also clears
	/// out what nobody uses: grants past their refresh lifetime, and clients a day
	/// old that hold no grant.
	pub fn create_oauth_client(&self, name: &str, redirect_uris: &[String]) -> Result<OAuthClient> {
		let uris = serde_json::to_string(redirect_uris)?;
		self.exec("DELETE FROM api_tokens WHERE client_id IS NOT NULL AND refresh_expires_at < ?", [expiry(Duration::ZERO)])?;
		self.exec(
			"DELETE FROM oauth_clients WHERE created_at < ?
			 AND id NOT IN (SELECT client_id FROM api_tokens WHERE client_id IS NOT NULL)",
			[format_time(Utc::now() - chrono::Duration::hours(24))],
		)?;
		let c = OAuthClient { id: new_id(), name: name.into(), redirect_uris: redirect_uris.to_vec(), created_at: now() };
		self.exec(
			"INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)",
			params![c.id, c.name, uris, c.created_at],
		)?;
		Ok(c)
	}

	pub fn oauth_client_by_id(&self, id: &str) -> Result<OAuthClient> {
		let (mut c, uris) = self.one("SELECT id, name, redirect_uris, created_at FROM oauth_clients WHERE id = ?", [id], |r| {
			Ok((OAuthClient { id: r.get(0)?, name: r.get(1)?, redirect_uris: Vec::new(), created_at: r.get(3)? }, r.get::<_, String>(2)?))
		})?;
		c.redirect_uris = serde_json::from_str(&uris)?;
		Ok(c)
	}

	/// Stores the token pair an authorization code was exchanged for, named after
	/// the client so the tokens page can tell grants apart.
	pub fn create_oauth_grant(
		&self,
		user_id: &str,
		client: &OAuthClient,
		grants: &[ProjectGrant],
		access_hash: &str,
		refresh_hash: &str,
		prefix: &str,
	) -> Result<ApiToken> {
		self.insert_token(user_id, &client.name, access_hash, prefix, grants, Some(OAuthGrant { client_id: &client.id, refresh_hash }))
	}

	/// Trades a live refresh token for a new pair. A refresh token that comes back
	/// after it was rotated has leaked, so its grant is revoked (OAuth 2.1,
	/// section 4.3.1); the caller gets NotFound for both.
	pub fn rotate_oauth_grant(
		&self,
		client_id: &str,
		refresh_hash: &str,
		access_hash: &str,
		new_refresh_hash: &str,
		prefix: &str,
	) -> Result<()> {
		let rotated = self.exec(
			"UPDATE api_tokens SET token_hash = ?, prefix = ?, expires_at = ?,
			 previous_refresh_hash = refresh_hash, refresh_hash = ?, refresh_expires_at = ?
			 WHERE client_id = ? AND refresh_hash = ? AND refresh_expires_at > ?",
			params![
				access_hash,
				prefix,
				expiry(OAUTH_ACCESS_LIFETIME),
				new_refresh_hash,
				expiry(OAUTH_REFRESH_LIFETIME),
				client_id,
				refresh_hash,
				expiry(Duration::ZERO)
			],
		)?;
		if rotated == 1 {
			return Ok(());
		}
		self.exec("DELETE FROM api_tokens WHERE client_id = ? AND previous_refresh_hash = ?", [client_id, refresh_hash])?;
		Err(NotFound.into())
	}
}

fn scan_token(r: &Row) -> rusqlite::Result<ApiToken> {
	Ok(ApiToken {
		id: r.get(0)?,
		user_id: r.get(1)?,
		name: r.get(2)?,
		prefix: r.get(3)?,
		admin: r.get::<_, i64>(4)? != 0,
		client_id: r.get(5)?,
		last_used_at: r.get(6)?,
		created_at: r.get(7)?,
		projects: Vec::new(),
	})
}

/// A moment d from now in a format that sorts as text (RFC3339, whole seconds).
fn expiry(d: Duration) -> String {
	(Utc::now() + d).format("%Y-%m-%dT%H:%M:%SZ").to_string()
}
