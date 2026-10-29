//! GitLab and Gitea connect as OAuth applications. Both speak the same
//! authorization-code flow, so the only per-provider details are the two
//! endpoint paths and the scope names.

use anyhow::{Result, anyhow, bail};
use serde::Deserialize;

use super::{Account, PROVIDER_GITEA, PROVIDER_GITLAB, api_error, provider_http};

/// Read the user to confirm who authorized, read repositories to clone them,
/// api to list projects.
pub const GITLAB_SCOPES: &str = "api read_user read_repository";

/// Gitea rejects an authorization whose scopes are not a subset of what the
/// application was registered with, so this is also what the owner ticks.
pub const GITEA_SCOPES: &str = "read:repository read:user read:organization";

/// One OAuth grant.
#[derive(Clone, Debug, Default)]
pub struct Tokens {
	pub access_token: String,
	pub refresh_token: String,
	/// When the access token stops working, as a Unix second, computed from the
	/// lifetime both providers return.
	pub expires_at: i64,
}

impl Tokens {
	/// Whether the access token needs refreshing. The minute of slack keeps a
	/// token from expiring between the check and the clone that uses it.
	pub fn expired(&self) -> bool {
		self.expires_at == 0 || chrono::Utc::now().timestamp() + 60 >= self.expires_at
	}
}

/// Encodes pairs sorted by key, the way Go's url.Values.Encode does.
fn encode(pairs: &[(&str, &str)]) -> String {
	let mut sorted = pairs.to_vec();
	sorted.sort_by_key(|(key, _)| *key);
	url::form_urlencoded::Serializer::new(String::new()).extend_pairs(sorted).finish()
}

/// Where the owner approves the application. `state` comes back untouched on
/// the callback, which is how the return leg knows its connection.
pub fn authorize_url(provider_type: &str, host: &str, client_id: &str, redirect_uri: &str, state: &str, scopes: &str) -> Result<String> {
	let query =
		encode(&[("client_id", client_id), ("redirect_uri", redirect_uri), ("response_type", "code"), ("state", state), ("scope", scopes)]);
	let base = host.trim_end_matches('/');
	match provider_type {
		PROVIDER_GITLAB => Ok(format!("{base}/oauth/authorize?{query}")),
		PROVIDER_GITEA => Ok(format!("{base}/login/oauth/authorize?{query}")),
		other => bail!("{other} does not authorize through oauth"),
	}
}

/// Turns the authorization code from the callback into tokens.
pub async fn exchange_code(
	provider_type: &str,
	host: &str,
	client_id: &str,
	client_secret: &str,
	redirect_uri: &str,
	code: &str,
) -> Result<Tokens> {
	oauth_token(
		provider_type,
		host,
		&encode(&[
			("client_id", client_id),
			("client_secret", client_secret),
			("code", code),
			("grant_type", "authorization_code"),
			("redirect_uri", redirect_uri),
		]),
	)
	.await
}

/// Trades a refresh token for a fresh grant. Both providers rotate the refresh
/// token on every use, so the result has to be stored.
pub async fn refresh_tokens(
	provider_type: &str,
	host: &str,
	client_id: &str,
	client_secret: &str,
	redirect_uri: &str,
	refresh_token: &str,
) -> Result<Tokens> {
	if refresh_token.is_empty() {
		bail!("{provider_type} connection has not been authorized yet");
	}
	oauth_token(
		provider_type,
		host,
		&encode(&[
			("client_id", client_id),
			("client_secret", client_secret),
			("refresh_token", refresh_token),
			("grant_type", "refresh_token"),
			("redirect_uri", redirect_uri),
		]),
	)
	.await
}

async fn oauth_token(provider_type: &str, host: &str, form: &str) -> Result<Tokens> {
	#[derive(Deserialize)]
	struct Payload {
		#[serde(default)]
		access_token: String,
		#[serde(default)]
		refresh_token: String,
		#[serde(default)]
		expires_in: i64,
		#[serde(default)]
		error: String,
		#[serde(default)]
		error_description: String,
	}
	let base = host.trim_end_matches('/');
	let endpoint = match provider_type {
		PROVIDER_GITLAB => format!("{base}/oauth/token"),
		PROVIDER_GITEA => format!("{base}/login/oauth/access_token"),
		other => bail!("{other} does not authorize through oauth"),
	};
	let response = provider_http()
		.post(endpoint)
		.header("Content-Type", "application/x-www-form-urlencoded")
		.header("Accept", "application/json")
		.header("User-Agent", "vexdock")
		.body(form.to_string())
		.send()
		.await?;
	if !response.status().is_success() {
		return Err(api_error(provider_type, response).await);
	}
	let payload: Payload = response.json().await?;
	if !payload.error.is_empty() {
		bail!("{provider_type} oauth: {}: {}", payload.error, payload.error_description);
	}
	if payload.access_token.is_empty() {
		return Err(anyhow!("{provider_type} returned no access token"));
	}
	let expires_at = if payload.expires_in > 0 { chrono::Utc::now().timestamp() + payload.expires_in } else { 0 };
	Ok(Tokens { access_token: payload.access_token, refresh_token: payload.refresh_token, expires_at })
}

impl Account {
	/// The login name of whoever authorized the connection, which is what the
	/// dashboard shows to make a connection recognisable.
	pub async fn authenticated_user(&self) -> Result<String> {
		let user = self.get(&self.api_url("/user")).await?;
		let username = user["username"].as_str().unwrap_or("");
		if !username.is_empty() {
			return Ok(username.to_string());
		}
		Ok(user["login"].as_str().unwrap_or("").to_string())
	}
}
