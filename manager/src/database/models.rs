use serde::{Deserialize, Serialize};

/// A lexicographically sortable ULID used as the primary key of every record
/// and as the on-disk project directory name.
pub fn new_id() -> String {
	ulid::Ulid::new().to_string()
}

// Accounts and sessions belong to the better-auth service and its own database;
// this module does not model them.

/// Groups environments, services and domains under one name. It owns no source
/// of its own: where code comes from is a per service decision.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Project {
	pub id: String,
	pub name: String,
	pub slug: String,
	pub compose_project_name: String,
	pub tags: Vec<String>,
	pub created_at: String,
	pub updated_at: String,
}

pub const GIT_CREDENTIAL_NONE: &str = "none";
pub const GIT_CREDENTIAL_TOKEN: &str = "token";
pub const GIT_CREDENTIAL_SSH: &str = "ssh_key";

pub const BUILD_DOCKERFILE: &str = "dockerfile";
pub const BUILD_STATIC: &str = "static";

/// One environment variable. Values are always encrypted at rest; is_secret only
/// controls whether the value is masked in API responses.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ProjectSecret {
	pub id: String,
	pub project_id: String,
	pub key: String,
	pub value: String,
	pub is_secret: bool,
	pub created_at: String,
	pub updated_at: String,
}

/// An application is built or pulled and answers on a domain, a database is a
/// curated image with a volume and a connection string.
pub const SERVICE_APPLICATION: &str = "application";
pub const SERVICE_DATABASE: &str = "database";

/// Where a service's compose definition comes from. The five git values clone
/// over the same code path; raw is a pasted compose fragment, image a published
/// reference, unconfigured a name that renders into nothing.
pub const PROVIDER_UNCONFIGURED: &str = "unconfigured";
pub const PROVIDER_GITHUB: &str = "github";
pub const PROVIDER_GITLAB: &str = "gitlab";
pub const PROVIDER_BITBUCKET: &str = "bitbucket";
pub const PROVIDER_GITEA: &str = "gitea";
pub const PROVIDER_GIT: &str = "git";
pub const PROVIDER_IMAGE: &str = "image";
pub const PROVIDER_RAW: &str = "raw";

pub fn clones_from_git(provider: &str) -> bool {
	matches!(provider, PROVIDER_GITHUB | PROVIDER_GITLAB | PROVIDER_BITBUCKET | PROVIDER_GITEA | PROVIDER_GIT)
}

/// The providers that clone through a connected account: they list
/// repositories, mint their own credentials and receive their own webhooks.
pub fn clones_from_connection(provider: &str) -> bool {
	matches!(provider, PROVIDER_GITHUB | PROVIDER_GITLAB | PROVIDER_BITBUCKET | PROVIDER_GITEA)
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Service {
	pub id: String,
	pub project_id: String,
	/// The real owner: production and staging each have their own row for the
	/// same compose service name.
	pub environment_id: String,
	pub compose_service_name: String,
	/// What docker ps shows. Empty on services created before the column
	/// existed, which keeps compose's own name for them.
	pub container_name: String,
	pub display_name: String,
	#[serde(rename = "type")]
	pub kind: String,
	pub provider: String,
	/// The remote of a plain git source. A provider-sourced service names its
	/// repository through git_provider_id, owner and repository.
	pub repository_url: String,
	pub branch: String,
	pub build_path: String,
	/// Authenticate the clone of a plain git repository. The plaintext never
	/// leaves the manager.
	pub credential_kind: String,
	#[serde(skip)]
	pub credential_enc: String,
	pub git_provider_id: String,
	pub owner: String,
	pub repository: String,
	/// The reference an image service runs and a database service was created
	/// with. Changing the version is an edit of this field and a redeploy.
	pub image: String,
	/// The catalog slug backing a database service, empty otherwise.
	pub engine: String,
	/// Where a custom database engine's volume mounts.
	pub data_path: String,
	/// The YAML body a raw service contributes, indented under its own key.
	pub compose_fragment: String,
	/// Arms this service for the webhook.
	pub auto_deploy: bool,
	/// Sweeps dangling build cache after this service builds.
	pub prune_build_cache: bool,
	/// How a git-sourced service becomes an image. dockerfile and build_target
	/// apply to BUILD_DOCKERFILE only, output_dir to BUILD_STATIC only.
	pub build_type: String,
	pub dockerfile: String,
	pub build_target: String,
	pub output_dir: String,
	/// Named volumes, one "volume:/path" per line.
	pub mounts: String,
	/// Log an image service into a private registry before its pull; empty URL is Docker Hub.
	pub registry_url: String,
	pub registry_username: String,
	#[serde(skip)]
	pub registry_password_enc: String,
	pub created_at: String,
	pub updated_at: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Domain {
	pub id: String,
	pub project_id: String,
	pub environment_id: String,
	pub service_id: String,
	pub hostname: String,
	pub container_port: i64,
	pub https_enabled: bool,
	pub redirect_https: bool,
	/// CERT_LETS_ENCRYPT or CERT_CUSTOM.
	pub certificate_source: String,
	pub created_at: String,
	pub updated_at: String,
}

pub const CERT_PENDING: &str = "pending";
pub const CERT_ISSUED: &str = "issued";
pub const CERT_FAILED: &str = "failed";

pub const CERT_LETS_ENCRYPT: &str = "letsencrypt";
pub const CERT_CUSTOM: &str = "custom";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Certificate {
	pub id: String,
	pub domain_id: String,
	pub hostname: String,
	pub issuer: String,
	pub issued_at: String,
	pub expires_at: String,
	pub last_renewed_at: String,
	pub status: String,
	pub last_error: String,
	pub source: String,
}

pub const DEPLOYMENT_QUEUED: &str = "queued";
pub const DEPLOYMENT_RUNNING: &str = "running";
pub const DEPLOYMENT_SUCCESS: &str = "success";
pub const DEPLOYMENT_FAILED: &str = "failed";
pub const DEPLOYMENT_CANCELLED: &str = "cancelled";

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Deployment {
	pub id: String,
	pub project_id: String,
	pub environment_id: String,
	/// Counts this service's deploys in this environment, starting at 1.
	pub number: i64,
	/// The compose service the pipeline ran for. Empty only on rows written
	/// before deploys were scoped to a service.
	pub service_name: String,
	pub commit_sha: String,
	pub branch: String,
	pub status: String,
	pub trigger: String,
	pub created_by: String,
	pub error: String,
	pub started_at: String,
	pub finished_at: String,
	pub created_at: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct DeploymentStep {
	pub id: String,
	pub deployment_id: String,
	pub position: i64,
	pub name: String,
	pub status: String,
	pub output: String,
	pub started_at: String,
	pub finished_at: String,
}

/// One connection to a git host, reused by any service that clones from it.
/// Exactly one of the four detail structs is set, decided by provider_type.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct GitProvider {
	#[serde(rename = "git_provider_id")]
	pub id: String,
	pub name: String,
	pub provider_type: String,
	pub created_at: String,
	/// Whether the connection can reach repositories yet: GitHub still has to be
	/// installed and the OAuth providers authorized after creation.
	pub connected: bool,
	/// Authenticates deliveries from the three hosts that cannot sign them.
	#[serde(skip)]
	pub webhook_secret_enc: String,
	/// The hook address with that secret in it, assembled by the API because
	/// only a request knows the panel's public origin.
	#[serde(skip_serializing_if = "String::is_empty", default)]
	pub webhook_url: String,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub github: Option<GitHubProvider>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub gitlab: Option<GitLabProvider>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub bitbucket: Option<BitbucketProvider>,
	#[serde(skip_serializing_if = "Option::is_none")]
	pub gitea: Option<GiteaProvider>,
}

impl GitProvider {
	pub(crate) fn mark_connected(&mut self) {
		self.connected = if let Some(p) = &self.github {
			!p.installation_id.is_empty() && !p.private_key_enc.is_empty()
		} else if let Some(p) = &self.gitlab {
			!p.access_token_enc.is_empty()
		} else if let Some(p) = &self.bitbucket {
			!p.password_enc.is_empty() || !p.api_token_enc.is_empty()
		} else if let Some(p) = &self.gitea {
			!p.access_token_enc.is_empty()
		} else {
			self.connected
		};
	}
}

/// A GitHub App: created through the manifest flow, installed by its owner and
/// cloning with an installation token minted from the private key.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct GitHubProvider {
	pub git_provider_id: String,
	#[serde(rename = "github_app_name")]
	pub app_name: String,
	#[serde(rename = "github_app_id")]
	pub app_id: String,
	#[serde(rename = "github_client_id")]
	pub client_id: String,
	#[serde(skip)]
	pub client_secret_enc: String,
	/// Empty until the owner finishes the install.
	#[serde(rename = "github_installation_id")]
	pub installation_id: String,
	#[serde(skip)]
	pub private_key_enc: String,
	#[serde(skip)]
	pub webhook_secret_enc: String,
	#[serde(rename = "github_url")]
	pub url: String,
}

/// An OAuth application registered on a GitLab instance.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct GitLabProvider {
	pub git_provider_id: String,
	#[serde(rename = "gitlab_url")]
	pub url: String,
	pub application_id: String,
	pub redirect_uri: String,
	#[serde(skip)]
	pub secret_enc: String,
	#[serde(skip)]
	pub access_token_enc: String,
	#[serde(skip)]
	pub refresh_enc: String,
	/// Narrows the repository listing to one group; empty lists everything.
	pub group_name: String,
	pub expires_at: i64,
}

/// A credential pair: an app password or, winning when set, an email and API token.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct BitbucketProvider {
	pub git_provider_id: String,
	#[serde(rename = "bitbucket_username")]
	pub username: String,
	#[serde(skip)]
	pub password_enc: String,
	#[serde(rename = "bitbucket_email")]
	pub email: String,
	#[serde(skip)]
	pub api_token_enc: String,
	#[serde(rename = "bitbucket_workspace_name")]
	pub workspace_name: String,
}

/// An OAuth application on a Gitea instance, GitLab's shape with Gitea's scopes.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct GiteaProvider {
	pub git_provider_id: String,
	#[serde(rename = "gitea_url")]
	pub url: String,
	pub redirect_uri: String,
	pub client_id: String,
	#[serde(skip)]
	pub client_secret_enc: String,
	#[serde(rename = "gitea_username")]
	pub username: String,
	#[serde(skip)]
	pub access_token_enc: String,
	#[serde(skip)]
	pub refresh_enc: String,
	pub expires_at: i64,
	pub scopes: String,
	pub last_authenticated_at: i64,
	/// Narrows the repository listing to one organization.
	pub organization_name: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Registry {
	pub id: String,
	pub name: String,
	pub url: String,
	pub username: String,
	#[serde(skip)]
	pub encrypted_password: String,
	pub created_at: String,
}

/// A deployable copy of a project. It owns the compose project name and the
/// directory its containers are built from. Every project has exactly one
/// default environment, which is not deletable.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Environment {
	pub id: String,
	pub project_id: String,
	pub name: String,
	pub slug: String,
	/// Overrides the branch of every git service in this environment.
	pub branch: String,
	pub compose_project_name: String,
	pub is_default: bool,
	pub created_at: String,
	pub updated_at: String,
}
