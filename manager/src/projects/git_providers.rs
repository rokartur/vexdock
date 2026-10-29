use anyhow::{Result, anyhow, bail};

use super::Projects;
use crate::database::{self, GitHubProvider, GitLabProvider, GitProvider, GiteaProvider, Service};
use crate::git::{self, Account, Credential, Tokens};
use crate::security;

/// The remote one service clones and the credential that opens it. A
/// provider-sourced service names an owner and a repository, and the connection
/// decides the host and the token, so a connection can be re-authorized without
/// touching any service.
#[derive(Clone, Debug, Default)]
pub struct GitSource {
	pub url: String,
	pub cred: Credential,
}

impl Projects {
	/// A stored connection is not usable as it stands: its secrets are
	/// encrypted, a GitHub App holds a private key rather than a token, and a
	/// GitLab or Gitea grant expires. This is the single place that turns one
	/// into something that lists and clones, so every caller authenticates alike.
	pub async fn git_account(&self, git_provider_id: &str) -> Result<Account> {
		let provider = self.git_provider(git_provider_id)?;
		self.account_for(provider).await
	}

	fn git_provider(&self, id: &str) -> Result<GitProvider> {
		self.db.git_provider_by_id(id).map_err(
			|err| {
				if database::is_not_found(&err) { anyhow!("unknown git provider {id:?}") } else { err }
			},
		)
	}

	async fn account_for(&self, provider: GitProvider) -> Result<Account> {
		match provider {
			GitProvider { github: Some(g), .. } => self.github_account(&g).await,
			GitProvider { gitlab: Some(mut g), .. } => self.gitlab_account(&mut g).await,
			GitProvider { bitbucket: Some(g), .. } => self.bitbucket_account(&g),
			GitProvider { gitea: Some(mut g), .. } => self.gitea_account(&mut g).await,
			GitProvider { provider_type, .. } => bail!("unknown git provider type {provider_type:?}"),
		}
	}

	/// Mints an installation token from the App's private key. The token is
	/// scoped to the installation's repositories and lives about an hour, so it
	/// is resolved per use rather than stored.
	async fn github_account(&self, g: &GitHubProvider) -> Result<Account> {
		let key = self.cipher.decrypt(&g.private_key_enc)?;
		let token = git::installation_token(&g.url, &g.app_id, &key, &g.installation_id).await?;
		Ok(Account { kind: database::PROVIDER_GITHUB.into(), host: g.url.clone(), token, ..Default::default() })
	}

	/// Returns the stored access token, refreshing the grant first when it is
	/// about to expire. GitLab rotates the refresh token on every use, so the
	/// new pair is written back before it is used.
	async fn gitlab_account(&self, g: &mut GitLabProvider) -> Result<Account> {
		if g.access_token_enc.is_empty() {
			bail!("this gitlab connection has not been authorized yet");
		}
		let mut tokens = self.decrypt_tokens(&g.access_token_enc, &g.refresh_enc, g.expires_at)?;
		if tokens.expired() {
			let secret = self.cipher.decrypt(&g.secret_enc)?;
			let refreshed =
				git::refresh_tokens(database::PROVIDER_GITLAB, &g.url, &g.application_id, &secret, &g.redirect_uri, &tokens.refresh_token)
					.await
					.map_err(|err| anyhow!("gitlab connection expired and could not be refreshed: {err:#}"))?;
			self.store_gitlab_tokens(g, &refreshed)?;
			tokens = refreshed;
		}
		Ok(Account {
			kind: database::PROVIDER_GITLAB.into(),
			host: g.url.clone(),
			token: tokens.access_token,
			scope: g.group_name.clone(),
			..Default::default()
		})
	}

	/// Prefers the API token pair: Atlassian is retiring app passwords and a
	/// connection that has both should use the one that will keep working.
	fn bitbucket_account(&self, g: &database::BitbucketProvider) -> Result<Account> {
		let (username, password) = if !g.api_token_enc.is_empty() {
			(g.email.clone(), self.cipher.decrypt(&g.api_token_enc)?)
		} else if !g.password_enc.is_empty() {
			(g.username.clone(), self.cipher.decrypt(&g.password_enc)?)
		} else {
			bail!("this bitbucket connection has no credential");
		};
		Ok(Account {
			kind: database::PROVIDER_BITBUCKET.into(),
			host: "https://bitbucket.org".into(),
			scope: g.workspace_name.clone(),
			username,
			password,
			..Default::default()
		})
	}

	/// Mirrors gitlab_account; Gitea rotates refresh tokens the same way.
	async fn gitea_account(&self, g: &mut GiteaProvider) -> Result<Account> {
		if g.access_token_enc.is_empty() {
			bail!("this gitea connection has not been authorized yet");
		}
		let mut tokens = self.decrypt_tokens(&g.access_token_enc, &g.refresh_enc, g.expires_at)?;
		if tokens.expired() {
			let secret = self.cipher.decrypt(&g.client_secret_enc)?;
			let refreshed =
				git::refresh_tokens(database::PROVIDER_GITEA, &g.url, &g.client_id, &secret, &g.redirect_uri, &tokens.refresh_token)
					.await
					.map_err(|err| anyhow!("gitea connection expired and could not be refreshed: {err:#}"))?;
			let username = g.username.clone();
			self.store_gitea_tokens(g, &refreshed, &username)?;
			tokens = refreshed;
		}
		Ok(Account {
			kind: database::PROVIDER_GITEA.into(),
			host: g.url.clone(),
			token: tokens.access_token,
			scope: g.organization_name.clone(),
			..Default::default()
		})
	}

	fn decrypt_tokens(&self, access_enc: &str, refresh_enc: &str, expires_at: i64) -> Result<Tokens> {
		let access_token = self.cipher.decrypt(access_enc)?;
		let refresh_token = if refresh_enc.is_empty() { String::new() } else { self.cipher.decrypt(refresh_enc)? };
		Ok(Tokens { access_token, refresh_token, expires_at })
	}

	/// Encrypts and persists a grant. The OAuth callback stores the first grant
	/// through the same path a refresh does.
	pub fn store_gitlab_tokens(&self, g: &mut GitLabProvider, tokens: &Tokens) -> Result<()> {
		let (access, refresh) = self.encrypt_tokens(tokens)?;
		self.db.set_gitlab_tokens(&g.git_provider_id, &access, &refresh, tokens.expires_at)?;
		g.access_token_enc = access;
		g.refresh_enc = refresh;
		g.expires_at = tokens.expires_at;
		Ok(())
	}

	/// Encrypts and persists a grant along with who authorized it.
	pub fn store_gitea_tokens(&self, g: &mut GiteaProvider, tokens: &Tokens, username: &str) -> Result<()> {
		let (access, refresh) = self.encrypt_tokens(tokens)?;
		self.db.set_gitea_tokens(&g.git_provider_id, &access, &refresh, username, tokens.expires_at)?;
		g.access_token_enc = access;
		g.refresh_enc = refresh;
		g.expires_at = tokens.expires_at;
		g.username = username.into();
		Ok(())
	}

	fn encrypt_tokens(&self, tokens: &Tokens) -> Result<(String, String)> {
		let access = self.cipher.encrypt(&tokens.access_token)?;
		let refresh = if tokens.refresh_token.is_empty() { String::new() } else { self.cipher.encrypt(&tokens.refresh_token)? };
		Ok((access, refresh))
	}

	/// Stores a provider secret at rest, through the same cipher as every other
	/// secret the manager holds.
	pub fn encrypt(&self, plaintext: &str) -> Result<String> {
		self.cipher.encrypt(plaintext)
	}

	/// Resolves what a service clones. A plain git service uses the URL and
	/// credential stored on it; the four connected providers go through their
	/// connection.
	pub async fn git_source_for(&self, svc: &Service) -> Result<GitSource> {
		if !database::clones_from_connection(&svc.provider) {
			return Ok(GitSource { url: svc.repository_url.clone(), cred: self.credential(svc)? });
		}
		if svc.git_provider_id.is_empty() {
			bail!("service {:?} is not connected to a git provider", svc.compose_service_name);
		}
		let account = self.git_account(&svc.git_provider_id).await?;
		if account.kind != svc.provider {
			bail!("service {:?} expects a {} connection", svc.compose_service_name, svc.provider);
		}
		Ok(GitSource { url: account.clone_url(&svc.owner, &svc.repository), cred: account.credential() })
	}

	/// Decrypts the credential stored directly on a plain git service.
	fn credential(&self, svc: &Service) -> Result<Credential> {
		if svc.credential_kind.is_empty() || svc.credential_kind == database::GIT_CREDENTIAL_NONE || svc.credential_enc.is_empty() {
			return Ok(Credential { kind: git::KIND_NONE.into(), ..Default::default() });
		}
		let value = self.cipher.decrypt(&svc.credential_enc)?;
		Ok(Credential { kind: svc.credential_kind.clone(), value, ..Default::default() })
	}

	/// Points a service at a repository on a connection. The connection has to
	/// exist and be of the provider the service claims: a GitHub service cloning
	/// through a GitLab grant would fail at deploy time with nothing useful to say.
	pub fn set_git_repository(&self, svc: &mut Service, git_provider_id: &str, owner: &str, repository: &str) -> Result<()> {
		let provider = self.git_provider(git_provider_id)?;
		if provider.provider_type != svc.provider {
			bail!("{:?} is a {} connection, not {}", provider.name, provider.provider_type, svc.provider);
		}
		let (owner, repository) = (owner.trim(), repository.trim());
		security::validate_repository_owner(owner)?;
		security::validate_repository_name(repository)?;
		svc.git_provider_id = provider.id;
		svc.owner = owner.into();
		svc.repository = repository.into();
		// The URL and the hand-entered credential belong to the plain git source
		// and would be stale the moment the connection is re-pointed.
		svc.repository_url.clear();
		svc.credential_kind = database::GIT_CREDENTIAL_NONE.into();
		svc.credential_enc.clear();
		Ok(())
	}
}
