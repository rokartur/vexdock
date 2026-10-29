use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::{Credential, KIND_TOKEN, api_root};

// Provider types. They name both git_providers.provider_type and
// services.provider, so a service sourced from a connection says which kind
// of connection it wants.
pub const PROVIDER_GITHUB: &str = "github";
pub const PROVIDER_GITLAB: &str = "gitlab";
pub const PROVIDER_BITBUCKET: &str = "bitbucket";
pub const PROVIDER_GITEA: &str = "gitea";

pub fn is_provider_type(s: &str) -> bool {
	matches!(s, PROVIDER_GITHUB | PROVIDER_GITLAB | PROVIDER_BITBUCKET | PROVIDER_GITEA)
}

/// Go's url.PathEscape: everything but unreserved characters and the
/// sub-delimiters a path segment may carry.
const PATH_SEGMENT: &AsciiSet = &NON_ALPHANUMERIC
	.remove(b'-')
	.remove(b'_')
	.remove(b'.')
	.remove(b'~')
	.remove(b'$')
	.remove(b'&')
	.remove(b'+')
	.remove(b',')
	.remove(b';')
	.remove(b'=')
	.remove(b':')
	.remove(b'@');

pub fn path_escape(s: &str) -> String {
	utf8_percent_encode(s, PATH_SEGMENT).to_string()
}

/// Go's url.QueryEscape.
pub fn query_escape(s: &str) -> String {
	url::form_urlencoded::byte_serialize(s.as_bytes()).collect()
}

/// One connected provider with its secrets already decrypted and, for the OAuth
/// providers, already refreshed. Every listing and every clone goes through it,
/// so the four providers differ in exactly one place: how it gets filled in.
#[derive(Clone, Debug, Default)]
pub struct Account {
	pub kind: String,
	/// The origin of the instance the account lives on; both the API root and
	/// the clone URL derive from it.
	pub host: String,
	/// Authenticates GitHub (an installation token), GitLab and Gitea (an OAuth access token).
	pub token: String,
	/// Bitbucket's credential pair: a username with an app password, or an
	/// account email with an API token.
	pub username: String,
	pub password: String,
	/// Narrows a listing to one GitLab group, Gitea organization or Bitbucket
	/// workspace. Empty lists everything the credential reaches.
	pub scope: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Repository {
	pub name: String,
	pub owner: String,
	pub url: String,
}

/// The client every provider call shares. The timeout is per request and a
/// large organization's listing is several, so it is generous.
pub(super) fn provider_http() -> reqwest::Client {
	reqwest::Client::builder().timeout(Duration::from_secs(30)).build().expect("static client config")
}

/// Turns a provider's error response into a message worth showing. The body is
/// capped because a misconfigured instance answers with an HTML login page.
pub(super) async fn api_error(provider: &str, response: reqwest::Response) -> anyhow::Error {
	let status = response.status();
	let body = response.bytes().await.unwrap_or_default();
	let detail = String::from_utf8_lossy(&body[..body.len().min(512)]).trim().to_string();
	if detail.is_empty() {
		return anyhow!("{provider} api: {status}");
	}
	anyhow!("{provider} api: {status}: {detail}")
}

fn str_at<'a>(v: &'a Value, path: &[&str]) -> &'a str {
	path.iter().fold(v, |v, key| &v[*key]).as_str().unwrap_or("")
}

impl Account {
	pub fn credential(&self) -> Credential {
		if self.kind == PROVIDER_BITBUCKET {
			return Credential { kind: KIND_TOKEN.into(), value: self.password.clone(), user: self.username.clone() };
		}
		// GitHub, GitLab and Gitea all accept the OAuth token as the password with
		// a placeholder username; oauth2 is the name all three document.
		Credential { kind: KIND_TOKEN.into(), value: self.token.clone(), user: "oauth2".into() }
	}

	/// The HTTPS remote for one repository. Credentials stay out of it: they
	/// reach git through askpass, never a process listing or a deployment log.
	pub fn clone_url(&self, owner: &str, repository: &str) -> String {
		format!("{}/{owner}/{repository}.git", self.host.trim_end_matches('/'))
	}

	/// What the account can deploy from, in one shape whatever the provider.
	pub async fn repositories(&self) -> Result<Vec<Repository>> {
		match self.kind.as_str() {
			PROVIDER_GITHUB => self.github_repositories().await,
			PROVIDER_GITLAB => self.gitlab_repositories().await,
			PROVIDER_BITBUCKET => self.bitbucket_repositories().await,
			PROVIDER_GITEA => self.gitea_repositories().await,
			other => bail!("unknown git provider {other:?}"),
		}
	}

	pub async fn branches(&self, owner: &str, repository: &str) -> Result<Vec<String>> {
		if owner.is_empty() || repository.is_empty() {
			bail!("owner and repository are required");
		}
		match self.kind.as_str() {
			PROVIDER_GITHUB => self.named_branches(&self.api_url(&format!("/repos/{owner}/{repository}/branches?per_page=100"))).await,
			PROVIDER_GITLAB => {
				let project = path_escape(&format!("{owner}/{repository}"));
				self.named_branches(&self.api_url(&format!("/projects/{project}/repository/branches?per_page=100"))).await
			}
			PROVIDER_BITBUCKET => {
				let page = self.get(&self.api_url(&format!("/repositories/{owner}/{repository}/refs/branches?pagelen=100"))).await?;
				Ok(page["values"].as_array().into_iter().flatten().map(|b| str_at(b, &["name"]).to_string()).collect())
			}
			PROVIDER_GITEA => self.named_branches(&self.api_url(&format!("/repos/{owner}/{repository}/branches?limit=100"))).await,
			other => bail!("unknown git provider {other:?}"),
		}
	}

	/// A provider-relative path made absolute; every provider roots its API elsewhere.
	pub(super) fn api_url(&self, path: &str) -> String {
		let host = self.host.trim_end_matches('/');
		match self.kind.as_str() {
			PROVIDER_GITHUB => format!("{}{path}", api_root(host)),
			PROVIDER_GITLAB => format!("{host}/api/v4{path}"),
			PROVIDER_BITBUCKET => format!("https://api.bitbucket.org/2.0{path}"),
			PROVIDER_GITEA => format!("{host}/api/v1{path}"),
			_ => format!("{host}{path}"),
		}
	}

	/// The three providers whose branch listing is an array of objects with a name.
	async fn named_branches(&self, endpoint: &str) -> Result<Vec<String>> {
		let payload = self.get(endpoint).await?;
		Ok(payload.as_array().into_iter().flatten().map(|b| str_at(b, &["name"]).to_string()).collect())
	}

	pub(super) async fn get(&self, endpoint: &str) -> Result<Value> {
		let mut request = provider_http().get(endpoint).header("User-Agent", "vexdock");
		request = match self.kind.as_str() {
			PROVIDER_BITBUCKET => request.basic_auth(&self.username, Some(&self.password)),
			PROVIDER_GITHUB => request
				.bearer_auth(&self.token)
				.header("Accept", "application/vnd.github+json")
				.header("X-GitHub-Api-Version", "2022-11-28"),
			_ => request.bearer_auth(&self.token),
		};
		let response = request.send().await?;
		if !response.status().is_success() {
			return Err(api_error(&self.kind, response).await);
		}
		Ok(response.json().await?)
	}

	/// What the App installation was granted: the set the owner ticked when
	/// installing, never everything a person can see.
	async fn github_repositories(&self) -> Result<Vec<Repository>> {
		let page = self.get(&self.api_url("/installation/repositories?per_page=100")).await?;
		Ok(page["repositories"]
			.as_array()
			.into_iter()
			.flatten()
			.map(|r| Repository {
				name: str_at(r, &["name"]).into(),
				owner: str_at(r, &["owner", "login"]).into(),
				url: str_at(r, &["html_url"]).into(),
			})
			.collect())
	}

	/// The projects the authorizing user is a member of, narrowed to one group
	/// when the connection names one.
	async fn gitlab_repositories(&self) -> Result<Vec<Repository>> {
		let projects = self.get(&self.api_url("/projects?membership=true&per_page=100&order_by=last_activity_at")).await?;
		let mut repos = Vec::new();
		for p in projects.as_array().into_iter().flatten() {
			let (name, path) = (str_at(p, &["name"]), str_at(p, &["path_with_namespace"]));
			let mut owner = str_at(p, &["namespace", "full_path"]).to_string();
			if owner.is_empty() {
				// Older GitLab omits the namespace object; the path carries it.
				owner = path.strip_suffix(&format!("/{name}")).unwrap_or(path).to_string();
			}
			if !self.scope.is_empty() && !owner.split('/').next().unwrap_or("").eq_ignore_ascii_case(&self.scope) {
				continue;
			}
			// path_with_namespace is what clones, so its last segment is the slug,
			// not the display name GitLab also returns.
			let slug = path.rsplit('/').next().unwrap_or(path);
			repos.push(Repository { name: slug.into(), owner, url: str_at(p, &["web_url"]).into() });
		}
		Ok(repos)
	}

	/// A workspace's repositories, or every repository the credential is a
	/// member of when no workspace is named.
	async fn bitbucket_repositories(&self) -> Result<Vec<Repository>> {
		let endpoint = if self.scope.is_empty() {
			self.api_url("/repositories?role=member&pagelen=100")
		} else {
			self.api_url(&format!("/repositories/{}?pagelen=100", path_escape(&self.scope)))
		};
		let page = self.get(&endpoint).await?;
		Ok(page["values"]
			.as_array()
			.into_iter()
			.flatten()
			.filter_map(|r| {
				let (owner, slug) = str_at(r, &["full_name"]).split_once('/')?;
				Some(Repository { name: slug.into(), owner: owner.into(), url: str_at(r, &["links", "html", "href"]).into() })
			})
			.collect())
	}

	/// The authorizing user's repositories, or one organization's.
	async fn gitea_repositories(&self) -> Result<Vec<Repository>> {
		let endpoint = if self.scope.is_empty() {
			self.api_url("/user/repos?limit=100")
		} else {
			self.api_url(&format!("/orgs/{}/repos?limit=100", path_escape(&self.scope)))
		};
		let payload = self.get(&endpoint).await?;
		Ok(payload
			.as_array()
			.into_iter()
			.flatten()
			.map(|r| Repository {
				name: str_at(r, &["name"]).into(),
				owner: str_at(r, &["owner", "login"]).into(),
				url: str_at(r, &["html_url"]).into(),
			})
			.collect())
	}
}
