//! A connection is created in two halves. The first writes the row: the app
//! credentials the owner registered, or the credential pair they pasted. The
//! second is the handshake with the host, which returns through the redirect
//! handlers at the bottom of this file and is what flips connected to true.
//!
//! The row's id is the OAuth state throughout. The host echoes it back, it is
//! unguessable for the same reason every other id is, and it says which
//! connection the code belongs to without a side table of pending handshakes.

use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use super::Server;
use super::respond::{ApiError, ApiResult, bad_request, created, decode, done, lookup, ok};
use crate::auth;
use crate::database::{self, BitbucketProvider, GitHubProvider, GitLabProvider, GitProvider, GiteaProvider};
use crate::git::{self, Account};
use crate::security;

pub async fn list_git_providers(State(s): State<Arc<Server>>, headers: HeaderMap) -> ApiResult {
	let mut providers = s.db.list_git_providers()?;
	for provider in &mut providers {
		s.attach_webhook_url(&headers, provider);
	}
	ok(&json!({"git_providers": providers}))
}

pub async fn get_git_provider(State(s): State<Arc<Server>>, Path(id): Path<String>, headers: HeaderMap) -> ApiResult {
	let mut provider = s.db.git_provider_by_id(&id).map_err(lookup)?;
	s.attach_webhook_url(&headers, &mut provider);
	ok(&provider)
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct RenameRequest {
	name: String,
}

pub async fn rename_git_provider(State(s): State<Arc<Server>>, Path(id): Path<String>, body: Bytes) -> ApiResult {
	let req: RenameRequest = decode(&body)?;
	let name = req.name.trim();
	if name.is_empty() {
		return Err(bad_request("name is required"));
	}
	s.db.rename_git_provider(&id, name).map_err(lookup)?;
	done()
}

/// Refuses while services still clone through the connection, because
/// deleting it would leave them unable to deploy with nothing in the UI
/// explaining why.
pub async fn delete_git_provider(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	let provider = s.db.git_provider_by_id(&id).map_err(lookup)?;
	let services = s.db.services_for_provider(&id)?.len();
	if services > 0 {
		let message = format!("{services} service(s) still deploy from this connection");
		return Err(ApiError::new(StatusCode::CONFLICT, "GIT_PROVIDER_IN_USE", message).with_details(json!({"services": services})));
	}
	s.db.delete_git_provider(&id).map_err(lookup)?;
	// The cached installation token outlives the row otherwise, and would keep
	// working until it expired.
	if let Some(github) = &provider.github {
		git::forget_installation(&github.installation_id);
	}
	done()
}

/// Lists what the connection can clone. The dashboard calls it to fill the
/// repository picker, so it is also the honest test of whether it still works.
pub async fn git_provider_repositories(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	let account = s.git_account(&id).await?;
	let repositories = account.repositories().await.map_err(provider_error)?;
	ok(&json!({"repositories": repositories}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct BranchesQuery {
	owner: String,
	repository: String,
}

pub async fn git_provider_branches(State(s): State<Arc<Server>>, Path(id): Path<String>, Query(q): Query<BranchesQuery>) -> ApiResult {
	if q.owner.is_empty() || q.repository.is_empty() {
		return Err(bad_request("owner and repository are required"));
	}
	let account = s.git_account(&id).await?;
	let branches = account.branches(&q.owner, &q.repository).await.map_err(provider_error)?;
	ok(&json!({"branches": branches}))
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct CreateGitHub {
	name: String,
	github_url: String,
	organization: String,
}

/// Writes the empty connection and hands back the App manifest. The dashboard
/// POSTs that manifest to GitHub, which walks the owner through creating the
/// App and returns to the callback below with a code.
pub async fn create_github_provider(State(s): State<Arc<Server>>, headers: HeaderMap, body: Bytes) -> ApiResult {
	let req: CreateGitHub = decode(&body)?;
	let host = host_or_default(&req.github_url, "https://github.com");
	let mut provider = GitProvider {
		id: database::new_id(),
		name: req.name.trim().to_string(),
		provider_type: database::PROVIDER_GITHUB.to_string(),
		github: Some(GitHubProvider { url: host.clone(), ..Default::default() }),
		..Default::default()
	};
	if provider.name.is_empty() {
		return Err(bad_request("name is required"));
	}
	s.db.create_git_provider(&mut provider)?;
	// GitHub requires a globally unique App name, so the connection's own name
	// is not usable as it stands.
	let manifest = git::new_app_manifest(&format!("vexdock-{}", &provider.id[..8]), &s.public_origin(&headers));
	let target = match req.organization.trim() {
		"" => format!("{host}/settings/apps/new"),
		org => format!("{host}/organizations/{org}/settings/apps/new"),
	};
	created(&json!({
		"git_provider_id": provider.id,
		"manifest": manifest,
		"manifest_url": format!("{target}?state={}", provider.id),
	}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct CallbackQuery {
	code: String,
	state: String,
	installation_id: String,
}

/// Where GitHub returns once the App exists. The code is single use and lives
/// ten minutes; exchanging it yields the private key the manager signs with
/// from then on.
pub async fn github_callback(State(s): State<Arc<Server>>, Query(q): Query<CallbackQuery>) -> ApiResult {
	if q.code.is_empty() || q.state.is_empty() {
		return Err(bad_request("github returned no code"));
	}
	let provider = s.db.git_provider_by_id(&q.state).map_err(lookup)?;
	let Some(mut g) = provider.github else {
		return Err(bad_request(format!("{:?} is not a github connection", provider.name)));
	};
	let creds = git::exchange_app_manifest(&g.url, &q.code).await.map_err(provider_error)?;
	g.app_name = creds.name;
	g.app_id = creds.app_id;
	g.client_id = creds.client_id;
	g.client_secret_enc = s.projects.encrypt(&creds.client_secret)?;
	g.private_key_enc = s.projects.encrypt(&creds.private_key)?;
	g.webhook_secret_enc = s.projects.encrypt(&creds.webhook_secret)?;
	s.db.update_github_app(&g)?;
	// The App exists but reaches nothing yet: the owner still has to install it
	// and pick the repositories it may read.
	Ok(found(&git::install_url(&g.url, &creds.slug, &provider.id)))
}

/// Records which installation the App became. Without it there is nothing to
/// mint a token against.
pub async fn github_installed(State(s): State<Arc<Server>>, Query(q): Query<CallbackQuery>) -> ApiResult {
	if q.installation_id.is_empty() || q.state.is_empty() {
		return Err(bad_request("github returned no installation"));
	}
	s.db.set_github_installation(&q.state, &q.installation_id).map_err(lookup)?;
	git::forget_installation(&q.installation_id);
	Ok(redirect_to_settings())
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct SaveGitLab {
	name: String,
	gitlab_url: String,
	application_id: String,
	secret: String,
	group_name: String,
}

/// Creates or re-registers a GitLab OAuth application. It answers with the
/// URL the owner has to visit to authorize it, because an application
/// without a grant cannot read anything.
pub async fn save_gitlab_provider(State(s): State<Arc<Server>>, id: Option<Path<String>>, headers: HeaderMap, body: Bytes) -> ApiResult {
	let req: SaveGitLab = decode(&body)?;
	let host = host_or_default(&req.gitlab_url, "https://gitlab.com");
	if req.application_id.trim().is_empty() || req.secret.trim().is_empty() {
		return Err(bad_request("application id and secret are required"));
	}
	let redirect_uri = s.redirect_uri(&headers, database::PROVIDER_GITLAB);
	let mut g = GitLabProvider {
		git_provider_id: id.map(|Path(id)| id).unwrap_or_default(),
		url: host.clone(),
		application_id: req.application_id.trim().to_string(),
		redirect_uri: redirect_uri.clone(),
		secret_enc: s.projects.encrypt(req.secret.trim())?,
		group_name: req.group_name.trim().to_string(),
		..Default::default()
	};
	if g.git_provider_id.is_empty() {
		let provider = s.create_provider(database::PROVIDER_GITLAB, &req.name, |p| {
			g.git_provider_id = p.id.clone();
			p.gitlab = Some(g.clone());
		})?;
		g.git_provider_id = provider.id;
	} else {
		s.db.update_gitlab_app(&g).map_err(lookup)?;
	}
	let authorize =
		git::authorize_url(database::PROVIDER_GITLAB, &host, &g.application_id, &redirect_uri, &g.git_provider_id, git::GITLAB_SCOPES)
			.map_err(bad_request)?;
	ok(&json!({"git_provider_id": g.git_provider_id, "authorize_url": authorize}))
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct SaveGitea {
	name: String,
	gitea_url: String,
	client_id: String,
	client_secret: String,
	organization_name: String,
}

/// GitLab's flow with Gitea's scope names.
pub async fn save_gitea_provider(State(s): State<Arc<Server>>, id: Option<Path<String>>, headers: HeaderMap, body: Bytes) -> ApiResult {
	let req: SaveGitea = decode(&body)?;
	let host = host_or_default(&req.gitea_url, "https://gitea.com");
	if req.client_id.trim().is_empty() || req.client_secret.trim().is_empty() {
		return Err(bad_request("client id and secret are required"));
	}
	let redirect_uri = s.redirect_uri(&headers, database::PROVIDER_GITEA);
	let mut g = GiteaProvider {
		git_provider_id: id.map(|Path(id)| id).unwrap_or_default(),
		url: host.clone(),
		redirect_uri: redirect_uri.clone(),
		client_id: req.client_id.trim().to_string(),
		client_secret_enc: s.projects.encrypt(req.client_secret.trim())?,
		scopes: git::GITEA_SCOPES.to_string(),
		organization_name: req.organization_name.trim().to_string(),
		..Default::default()
	};
	if g.git_provider_id.is_empty() {
		let provider = s.create_provider(database::PROVIDER_GITEA, &req.name, |p| {
			g.git_provider_id = p.id.clone();
			p.gitea = Some(g.clone());
		})?;
		g.git_provider_id = provider.id;
	} else {
		s.db.update_gitea_app(&g).map_err(lookup)?;
	}
	let authorize = git::authorize_url(database::PROVIDER_GITEA, &host, &g.client_id, &redirect_uri, &g.git_provider_id, git::GITEA_SCOPES)
		.map_err(bad_request)?;
	ok(&json!({"git_provider_id": g.git_provider_id, "authorize_url": authorize}))
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct SaveBitbucket {
	name: String,
	bitbucket_username: String,
	app_password: String,
	bitbucket_email: String,
	api_token: String,
	bitbucket_workspace_name: String,
}

/// Takes a credential pair rather than an app, so there is no handshake: the
/// connection is usable the moment it is stored.
pub async fn save_bitbucket_provider(State(s): State<Arc<Server>>, id: Option<Path<String>>, body: Bytes) -> ApiResult {
	let req: SaveBitbucket = decode(&body)?;
	let (username, app_password) = (req.bitbucket_username.trim(), req.app_password.trim());
	let (email, api_token) = (req.bitbucket_email.trim(), req.api_token.trim());
	let has_app_password = !username.is_empty() && !app_password.is_empty();
	let has_api_token = !email.is_empty() && !api_token.is_empty();
	if !has_app_password && !has_api_token {
		return Err(bad_request("give either a username and app password, or an email and API token"));
	}
	let encrypt = |secret: &str| if secret.is_empty() { Ok(String::new()) } else { s.projects.encrypt(secret) };
	let mut g = BitbucketProvider {
		git_provider_id: id.map(|Path(id)| id).unwrap_or_default(),
		username: username.to_string(),
		email: email.to_string(),
		workspace_name: req.bitbucket_workspace_name.trim().to_string(),
		password_enc: encrypt(app_password)?,
		api_token_enc: encrypt(api_token)?,
	};
	if g.git_provider_id.is_empty() {
		let provider = s.create_provider(database::PROVIDER_BITBUCKET, &req.name, |p| {
			g.git_provider_id = p.id.clone();
			p.bitbucket = Some(g.clone());
		})?;
		return created(&json!({"git_provider_id": provider.id}));
	}
	s.db.update_bitbucket_credentials(&g).map_err(lookup)?;
	ok(&json!({"git_provider_id": g.git_provider_id}))
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct OAuthCallbackQuery {
	code: String,
	state: String,
}

/// Finishes a GitLab or Gitea authorization. Both hosts return a code that is
/// exchanged for a grant, and both rotate their refresh token, so the pair is
/// stored rather than just the access token.
pub async fn oauth_callback(
	State(s): State<Arc<Server>>,
	Path(provider_type): Path<String>,
	Query(q): Query<OAuthCallbackQuery>,
) -> ApiResult {
	if q.code.is_empty() || q.state.is_empty() {
		return Err(bad_request(format!("{provider_type} returned no authorization code")));
	}
	let provider = s.db.git_provider_by_id(&q.state).map_err(lookup)?;
	if provider.provider_type != provider_type {
		return Err(bad_request(format!("{:?} is not a {provider_type} connection", provider.name)));
	}
	match (provider_type.as_str(), provider.gitlab, provider.gitea) {
		(database::PROVIDER_GITLAB, Some(mut g), _) => {
			let secret = s.cipher.decrypt(&g.secret_enc)?;
			let tokens = git::exchange_code(database::PROVIDER_GITLAB, &g.url, &g.application_id, &secret, &g.redirect_uri, &q.code)
				.await
				.map_err(provider_error)?;
			s.projects.store_gitlab_tokens(&mut g, &tokens)?;
		}
		(database::PROVIDER_GITEA, _, Some(mut g)) => {
			let secret = s.cipher.decrypt(&g.client_secret_enc)?;
			let tokens = git::exchange_code(database::PROVIDER_GITEA, &g.url, &g.client_id, &secret, &g.redirect_uri, &q.code)
				.await
				.map_err(provider_error)?;
			// Gitea's repository listing is per user, so who authorized decides
			// what the connection can see and is worth recording.
			let account = Account {
				kind: database::PROVIDER_GITEA.to_string(),
				host: g.url.clone(),
				token: tokens.access_token.clone(),
				..Default::default()
			};
			let username = account.authenticated_user().await.map_err(provider_error)?;
			s.projects.store_gitea_tokens(&mut g, &tokens, &username)?;
		}
		_ => return Err(bad_request(format!("{provider_type:?} does not use oauth"))),
	}
	Ok(redirect_to_settings())
}

impl Server {
	async fn git_account(&self, id: &str) -> Result<Account, ApiError> {
		self.projects
			.git_account(id)
			.await
			.map_err(|err| ApiError::new(StatusCode::BAD_REQUEST, "GIT_PROVIDER_UNAVAILABLE", format!("{err:#}")))
	}

	/// What the settings page pastes into the host's hook configuration.
	/// GitHub sets its own hook up from the manifest and signs it, so it never
	/// needs one.
	fn attach_webhook_url(&self, headers: &HeaderMap, p: &mut GitProvider) {
		if p.provider_type == database::PROVIDER_GITHUB || p.webhook_secret_enc.is_empty() {
			return;
		}
		let Ok(secret) = self.cipher.decrypt(&p.webhook_secret_enc) else {
			return;
		};
		p.webhook_url = format!("{}/api/deploy/{}?token={}", self.public_origin(headers), p.provider_type, git::query_escape(&secret));
	}

	/// Writes the parent row and its detail in one transaction. The caller
	/// fills the detail, because only it knows which of the four it is.
	fn create_provider(&self, provider_type: &str, name: &str, attach: impl FnOnce(&mut GitProvider)) -> Result<GitProvider, ApiError> {
		let mut provider = GitProvider {
			id: database::new_id(),
			name: name.trim().to_string(),
			provider_type: provider_type.to_string(),
			..Default::default()
		};
		if provider.name.is_empty() {
			return Err(bad_request("name is required"));
		}
		if provider_type != database::PROVIDER_GITHUB {
			provider.webhook_secret_enc = self.cipher.encrypt(&security::random_token(24))?;
		}
		attach(&mut provider);
		self.db.create_git_provider(&mut provider).map_err(bad_request)?;
		Ok(provider)
	}

	/// The address a provider has to come back to. PLATFORM_PUBLIC_URL wins
	/// when set, because an install that knows its own domain should not depend
	/// on which hostname a browser used; otherwise the request answers, so
	/// connecting works on a fresh install with no domain configured yet.
	fn public_origin(&self, headers: &HeaderMap) -> String {
		if !self.cfg.public_url.is_empty() {
			return self.cfg.public_url.clone();
		}
		auth::origin(headers)
	}

	/// What the owner registers with the host, so it has to match byte for
	/// byte on both sides. It is stored on the connection for that reason: the
	/// exchange repeats whatever the authorization used.
	fn redirect_uri(&self, headers: &HeaderMap, provider_type: &str) -> String {
		format!("{}/api/providers/{provider_type}/callback", self.public_origin(headers))
	}
}

fn provider_error(err: anyhow::Error) -> ApiError {
	ApiError::new(StatusCode::BAD_GATEWAY, "GIT_PROVIDER_ERROR", format!("{err:#}"))
}

fn found(location: &str) -> Response {
	let mut resp = StatusCode::FOUND.into_response();
	if let Ok(value) = HeaderValue::from_str(location) {
		resp.headers_mut().insert(header::LOCATION, value);
	}
	resp
}

/// Sends the browser back to where the owner started. The redirect handlers
/// are reached by navigation, not by fetch, so JSON would leave them staring at it.
fn redirect_to_settings() -> Response {
	found("/system/settings/git")
}

fn host_or_default(raw: &str, fallback: &str) -> String {
	match raw.trim().trim_end_matches('/') {
		"" => fallback.to_string(),
		host => host.to_string(),
	}
}
