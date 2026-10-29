//! Git providers are stored as a parent row naming the connection and a child
//! row holding whatever credentials that provider uses. Reading one always means
//! reading both, so every query here joins rather than leaving the caller to
//! remember which child table to look in.

use anyhow::{Result, anyhow, bail};
use rusqlite::{Connection, OptionalExtension, params};

use super::{
	BitbucketProvider, Db, GitHubProvider, GitLabProvider, GitProvider, GiteaProvider, NotFound, PROVIDER_BITBUCKET, PROVIDER_GITEA,
	PROVIDER_GITHUB, PROVIDER_GITLAB, new_id, now,
};

const GITHUB_COLUMNS: &str = "git_provider_id, github_app_name, github_app_id, github_client_id,
	github_client_secret, github_installation_id, github_private_key, github_webhook_secret, github_url";
const GITLAB_COLUMNS: &str = "git_provider_id, gitlab_url, application_id, redirect_uri, secret,
	access_token, refresh_token, group_name, expires_at";
const BITBUCKET_COLUMNS: &str = "git_provider_id, bitbucket_username, app_password, bitbucket_email,
	api_token, bitbucket_workspace_name";
const GITEA_COLUMNS: &str = "git_provider_id, gitea_url, redirect_uri, client_id, client_secret,
	gitea_username, access_token, refresh_token, expires_at, scopes, last_authenticated_at,
	organization_name";

impl Db {
	/// Writes the parent row and the child row for its type in one transaction,
	/// so a connection is never half a connection. The child matching
	/// provider_type must be set; its git_provider_id is filled in here.
	pub fn create_git_provider(&self, p: &mut GitProvider) -> Result<()> {
		p.id = new_id();
		p.created_at = now();
		let mut conn = self.conn();
		let tx = conn.transaction()?;
		tx.execute(
			"INSERT INTO git_providers (id, name, provider_type, created_at, webhook_secret_enc) VALUES (?, ?, ?, ?, ?)",
			params![p.id, p.name, p.provider_type, p.created_at, p.webhook_secret_enc],
		)?;
		insert_git_provider_detail(&tx, p)?;
		tx.commit()?;
		Ok(())
	}

	/// One connection with its credentials.
	pub fn git_provider_by_id(&self, id: &str) -> Result<GitProvider> {
		let mut p = self.one(
			"SELECT id, name, provider_type, created_at, webhook_secret_enc FROM git_providers WHERE id = ?",
			[id],
			scan_git_provider,
		)?;
		load_git_provider_detail(&self.conn(), &mut p)?;
		Ok(p)
	}

	/// Every connection with its credentials, newest last so the dashboard's order is stable.
	pub fn list_git_providers(&self) -> Result<Vec<GitProvider>> {
		let mut out = self.all(
			"SELECT id, name, provider_type, created_at, webhook_secret_enc FROM git_providers ORDER BY created_at, name",
			[],
			scan_git_provider,
		)?;
		let conn = self.conn();
		for p in &mut out {
			load_git_provider_detail(&conn, p)?;
		}
		Ok(out)
	}

	/// The GitHub connection a webhook delivery belongs to. The payload names the
	/// installation, whose connection holds the secret the delivery is signed with.
	pub fn git_provider_by_installation(&self, installation_id: &str) -> Result<GitProvider> {
		let id: String = self.one(
			"SELECT git_provider_id FROM github WHERE github_installation_id = ? AND github_installation_id != ''",
			[installation_id],
			|r| r.get(0),
		)?;
		self.git_provider_by_id(&id)
	}

	/// Changes only the label. Credentials are replaced through their own update.
	pub fn rename_git_provider(&self, id: &str, name: &str) -> Result<()> {
		affected_one(self.exec("UPDATE git_providers SET name = ? WHERE id = ?", [name, id])?)
	}

	/// Gives a connection made before the secret existed one.
	pub fn set_webhook_secret(&self, id: &str, secret_enc: &str) -> Result<()> {
		affected_one(self.exec("UPDATE git_providers SET webhook_secret_enc = ? WHERE id = ?", [secret_enc, id])?)
	}

	/// Stores the credentials GitHub returns from the manifest exchange, the only
	/// moment an App's identity is written.
	pub fn update_github_app(&self, g: &GitHubProvider) -> Result<()> {
		affected_one(self.exec(
			"UPDATE github SET github_app_name = ?, github_app_id = ?, github_client_id = ?,
				github_client_secret = ?, github_private_key = ?, github_webhook_secret = ?
			 WHERE git_provider_id = ?",
			params![g.app_name, g.app_id, g.client_id, g.client_secret_enc, g.private_key_enc, g.webhook_secret_enc, g.git_provider_id],
		)?)
	}

	/// Records which App installation a connection clones through: the last step
	/// of connecting GitHub, and where "pick different repositories" lands.
	pub fn set_github_installation(&self, id: &str, installation_id: &str) -> Result<()> {
		affected_one(self.exec("UPDATE github SET github_installation_id = ? WHERE git_provider_id = ?", [installation_id, id])?)
	}

	/// Replaces the OAuth application. Changing it invalidates the grant, so the
	/// caller clears the tokens with it.
	pub fn update_gitlab_app(&self, g: &GitLabProvider) -> Result<()> {
		affected_one(self.exec(
			"UPDATE gitlab SET gitlab_url = ?, application_id = ?, redirect_uri = ?, secret = ?,
				group_name = ? WHERE git_provider_id = ?",
			params![g.url, g.application_id, g.redirect_uri, g.secret_enc, g.group_name, g.git_provider_id],
		)?)
	}

	/// Stores a grant from the first authorization or a refresh. GitLab rotates
	/// the refresh token on every use.
	pub fn set_gitlab_tokens(&self, id: &str, access_enc: &str, refresh_enc: &str, expires_at: i64) -> Result<()> {
		affected_one(self.exec(
			"UPDATE gitlab SET access_token = ?, refresh_token = ?, expires_at = ? WHERE git_provider_id = ?",
			params![access_enc, refresh_enc, expires_at, id],
		)?)
	}

	pub fn update_bitbucket_credentials(&self, g: &BitbucketProvider) -> Result<()> {
		affected_one(self.exec(
			"UPDATE bitbucket SET bitbucket_username = ?, app_password = ?, bitbucket_email = ?,
				api_token = ?, bitbucket_workspace_name = ? WHERE git_provider_id = ?",
			params![g.username, g.password_enc, g.email, g.api_token_enc, g.workspace_name, g.git_provider_id],
		)?)
	}

	pub fn update_gitea_app(&self, g: &GiteaProvider) -> Result<()> {
		affected_one(self.exec(
			"UPDATE gitea SET gitea_url = ?, redirect_uri = ?, client_id = ?, client_secret = ?,
				scopes = ?, organization_name = ? WHERE git_provider_id = ?",
			params![g.url, g.redirect_uri, g.client_id, g.client_secret_enc, g.scopes, g.organization_name, g.git_provider_id],
		)?)
	}

	/// Stores a grant and who it belongs to.
	pub fn set_gitea_tokens(&self, id: &str, access_enc: &str, refresh_enc: &str, username: &str, expires_at: i64) -> Result<()> {
		affected_one(self.exec(
			"UPDATE gitea SET access_token = ?, refresh_token = ?, gitea_username = ?, expires_at = ?,
				last_authenticated_at = ? WHERE git_provider_id = ?",
			params![access_enc, refresh_enc, username, expires_at, chrono::Utc::now().timestamp(), id],
		)?)
	}

	/// Removes the connection. The child row cascades; services that cloned
	/// through it fall back to unconfigured, because a deploy that silently used a
	/// different credential would be worse than one that stops.
	pub fn delete_git_provider(&self, id: &str) -> Result<()> {
		let mut conn = self.conn();
		let tx = conn.transaction()?;
		tx.execute(
			"UPDATE services SET provider = ?, git_provider_id = '', owner = '', repository = '' WHERE git_provider_id = ?",
			params![super::PROVIDER_UNCONFIGURED, id],
		)?;
		affected_one(tx.execute("DELETE FROM git_providers WHERE id = ?", [id])?)?;
		tx.commit()?;
		Ok(())
	}

	/// Every service that clones through a connection, whatever repository it points at.
	pub fn services_for_provider(&self, git_provider_id: &str) -> Result<Vec<super::Service>> {
		self.all(
			&format!("SELECT {} FROM services WHERE git_provider_id = ?", super::projects::SERVICE_COLUMNS),
			[git_provider_id],
			super::projects::scan_service,
		)
	}

	/// Every service a push to this repository should redeploy: on this
	/// connection, pointing at this owner and repository, tracking the branch.
	pub fn services_for_repository(
		&self,
		git_provider_id: &str,
		owner: &str,
		repository: &str,
		branch: &str,
	) -> Result<Vec<super::Service>> {
		self.all(
			&format!(
				"SELECT {} FROM services
				 WHERE git_provider_id = ? AND owner = ? COLLATE NOCASE AND repository = ? COLLATE NOCASE AND branch = ?",
				super::projects::SERVICE_COLUMNS
			),
			[git_provider_id, owner, repository, branch],
			super::projects::scan_service,
		)
	}
}

fn affected_one(n: usize) -> Result<()> {
	if n == 0 {
		return Err(NotFound.into());
	}
	Ok(())
}

fn scan_git_provider(r: &rusqlite::Row) -> rusqlite::Result<GitProvider> {
	Ok(GitProvider {
		id: r.get(0)?,
		name: r.get(1)?,
		provider_type: r.get(2)?,
		created_at: r.get(3)?,
		webhook_secret_enc: r.get(4)?,
		..Default::default()
	})
}

fn insert_git_provider_detail(conn: &Connection, p: &mut GitProvider) -> Result<()> {
	match p.provider_type.as_str() {
		PROVIDER_GITHUB => {
			let g = p.github.get_or_insert_with(GitHubProvider::default);
			g.git_provider_id = p.id.clone();
			if g.url.is_empty() {
				g.url = "https://github.com".into();
			}
			conn.execute(
				&format!("INSERT INTO github ({GITHUB_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
				params![
					g.git_provider_id,
					g.app_name,
					g.app_id,
					g.client_id,
					g.client_secret_enc,
					g.installation_id,
					g.private_key_enc,
					g.webhook_secret_enc,
					g.url
				],
			)?;
		}
		PROVIDER_GITLAB => {
			let g = p.gitlab.as_mut().ok_or_else(|| anyhow!("gitlab connection is missing its details"))?;
			g.git_provider_id = p.id.clone();
			conn.execute(
				&format!("INSERT INTO gitlab ({GITLAB_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
				params![
					g.git_provider_id,
					g.url,
					g.application_id,
					g.redirect_uri,
					g.secret_enc,
					g.access_token_enc,
					g.refresh_enc,
					g.group_name,
					g.expires_at
				],
			)?;
		}
		PROVIDER_BITBUCKET => {
			let g = p.bitbucket.as_mut().ok_or_else(|| anyhow!("bitbucket connection is missing its details"))?;
			g.git_provider_id = p.id.clone();
			conn.execute(
				&format!("INSERT INTO bitbucket ({BITBUCKET_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?)"),
				params![g.git_provider_id, g.username, g.password_enc, g.email, g.api_token_enc, g.workspace_name],
			)?;
		}
		PROVIDER_GITEA => {
			let g = p.gitea.as_mut().ok_or_else(|| anyhow!("gitea connection is missing its details"))?;
			g.git_provider_id = p.id.clone();
			conn.execute(
				&format!("INSERT INTO gitea ({GITEA_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
				params![
					g.git_provider_id,
					g.url,
					g.redirect_uri,
					g.client_id,
					g.client_secret_enc,
					g.username,
					g.access_token_enc,
					g.refresh_enc,
					g.expires_at,
					g.scopes,
					g.last_authenticated_at,
					g.organization_name
				],
			)?;
		}
		other => bail!("unknown git provider type {other:?}"),
	}
	Ok(())
}

/// Fills in whichever child row belongs to this type. A parent without its
/// child is a broken row rather than an empty connection, so it reports not found.
fn load_git_provider_detail(conn: &Connection, p: &mut GitProvider) -> Result<()> {
	let id = p.id.as_str();
	let found = match p.provider_type.as_str() {
		PROVIDER_GITHUB => {
			p.github = conn
				.query_row(&format!("SELECT {GITHUB_COLUMNS} FROM github WHERE git_provider_id = ?"), [id], |r| {
					Ok(GitHubProvider {
						git_provider_id: r.get(0)?,
						app_name: r.get(1)?,
						app_id: r.get(2)?,
						client_id: r.get(3)?,
						client_secret_enc: r.get(4)?,
						installation_id: r.get(5)?,
						private_key_enc: r.get(6)?,
						webhook_secret_enc: r.get(7)?,
						url: r.get(8)?,
					})
				})
				.optional()?;
			p.github.is_some()
		}
		PROVIDER_GITLAB => {
			p.gitlab = conn
				.query_row(&format!("SELECT {GITLAB_COLUMNS} FROM gitlab WHERE git_provider_id = ?"), [id], |r| {
					Ok(GitLabProvider {
						git_provider_id: r.get(0)?,
						url: r.get(1)?,
						application_id: r.get(2)?,
						redirect_uri: r.get(3)?,
						secret_enc: r.get(4)?,
						access_token_enc: r.get(5)?,
						refresh_enc: r.get(6)?,
						group_name: r.get(7)?,
						expires_at: r.get(8)?,
					})
				})
				.optional()?;
			p.gitlab.is_some()
		}
		PROVIDER_BITBUCKET => {
			p.bitbucket = conn
				.query_row(&format!("SELECT {BITBUCKET_COLUMNS} FROM bitbucket WHERE git_provider_id = ?"), [id], |r| {
					Ok(BitbucketProvider {
						git_provider_id: r.get(0)?,
						username: r.get(1)?,
						password_enc: r.get(2)?,
						email: r.get(3)?,
						api_token_enc: r.get(4)?,
						workspace_name: r.get(5)?,
					})
				})
				.optional()?;
			p.bitbucket.is_some()
		}
		PROVIDER_GITEA => {
			p.gitea = conn
				.query_row(&format!("SELECT {GITEA_COLUMNS} FROM gitea WHERE git_provider_id = ?"), [id], |r| {
					Ok(GiteaProvider {
						git_provider_id: r.get(0)?,
						url: r.get(1)?,
						redirect_uri: r.get(2)?,
						client_id: r.get(3)?,
						client_secret_enc: r.get(4)?,
						username: r.get(5)?,
						access_token_enc: r.get(6)?,
						refresh_enc: r.get(7)?,
						expires_at: r.get(8)?,
						scopes: r.get(9)?,
						last_authenticated_at: r.get(10)?,
						organization_name: r.get(11)?,
					})
				})
				.optional()?;
			p.gitea.is_some()
		}
		other => bail!("unknown git provider type {other:?}"),
	};
	if !found {
		return Err(NotFound.into());
	}
	p.mark_connected();
	Ok(())
}
