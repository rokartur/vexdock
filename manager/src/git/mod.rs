//! Wraps the git CLI for repository sources, and the git hosts' own APIs.
//!
//! Credentials never reach the command line (world-readable via ps) and never
//! reach the deployment log: tokens are passed through GIT_ASKPASS and SSH keys
//! through a 0600 temp file referenced by GIT_SSH_COMMAND.

mod github;
mod oauth;
mod provider;

pub use github::*;
pub use oauth::*;
pub use provider::*;

use std::io::Write;
use std::path::Path;

use anyhow::{Context, Result, anyhow, bail};
use tokio::process::Command;

use crate::compose::{exit_text, run_streaming};

/// The secret for a private repository.
#[derive(Clone, Debug, Default)]
pub struct Credential {
	/// "none", "token" or "ssh_key"
	pub kind: String,
	pub value: String,
	/// The HTTP basic username paired with a token. GitHub, GitLab and Gitea
	/// ignore it, Bitbucket authenticates by it; defaults to GitHub's placeholder.
	pub user: String,
}

pub const KIND_NONE: &str = "none";
pub const KIND_TOKEN: &str = "token";
pub const KIND_SSH_KEY: &str = "ssh_key";

const REMOTE_REFSPEC: &str = "+refs/heads/*:refs/remotes/origin/*";

/// A checkout on disk.
#[derive(Clone, Debug, Default)]
pub struct Repo {
	pub url: String,
	pub reference: String,
	pub dir: String,
	pub cred: Credential,
	/// The file SSH pins host keys in. It has to outlive one sync, or
	/// accept-new accepts a new key every time and pins nothing.
	pub known_hosts: String,
}

/// The environment git runs with. Holds the temp dir with the askpass script
/// or key file; dropping it deletes them.
struct GitEnv {
	vars: Vec<(String, String)>,
	_secrets: Option<tempfile::TempDir>,
}

impl Repo {
	/// Makes dir contain the repository at the ref, cloning on first use and
	/// fetching afterwards. Returns the checked-out commit SHA.
	pub async fn sync(&self, log: &mut (dyn Write + Send)) -> Result<String> {
		let env = self.environment()?;
		if !Path::new(&format!("{}/.git", self.dir)).exists() {
			std::fs::create_dir_all(&self.dir)?;
			// Shallow clone keeps deployments fast and disks small.
			let shallow = run(log, "", &env, &["clone", "--depth", "1", "--branch", &self.reference, "--", &self.url, &self.dir]).await;
			if shallow.is_err() {
				// A commit SHA or an unusual ref cannot be cloned with --branch.
				run(log, "", &env, &["clone", "--", &self.url, &self.dir]).await?;
			}
		} else {
			run(log, &self.dir, &env, &["remote", "set-url", "origin", &self.url]).await?;
			// The explicit refspec overrides the single-branch one --depth 1 wrote
			// at clone time; without it only the original branch ever updates.
			run(log, &self.dir, &env, &["fetch", "--prune", "--tags", "--force", "origin", REMOTE_REFSPEC]).await?;
		}
		self.checkout(log, &env).await?;
		self.head_sha().await
	}

	async fn checkout(&self, log: &mut (dyn Write + Send), env: &GitEnv) -> Result<()> {
		if self.try_checkout(log, env).await.is_ok() {
			return Ok(());
		}
		// A --depth 1 clone holds one commit of one branch, so rolling back to an
		// older SHA misses until the rest of the history is fetched. Complete
		// repositories reject --unshallow, which leaves the retry to report the ref.
		let _ = run(log, &self.dir, env, &["fetch", "--tags", "--force", "--unshallow", "origin", REMOTE_REFSPEC]).await;
		self.try_checkout(log, env).await.with_context(|| format!("checkout {:?} failed", self.reference))
	}

	async fn try_checkout(&self, log: &mut (dyn Write + Send), env: &GitEnv) -> Result<()> {
		// Prefer the remote-tracking branch so a fetch actually moves the checkout.
		let remote = format!("origin/{}", self.reference);
		if run(log, &self.dir, env, &["checkout", "--force", "--detach", &remote]).await.is_ok() {
			return Ok(());
		}
		// Otherwise the ref is a tag or a commit SHA.
		run(log, &self.dir, env, &["checkout", "--force", "--detach", &self.reference]).await
	}

	pub async fn head_sha(&self) -> Result<String> {
		let output = Command::new("git").args(["-C", &self.dir, "rev-parse", "HEAD"]).output().await?;
		if !output.status.success() {
			bail!("read HEAD: {}", exit_text(output.status));
		}
		Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
	}

	fn environment(&self) -> Result<GitEnv> {
		let mut vars: Vec<(String, String)> = [("GIT_TERMINAL_PROMPT", "0"), ("GIT_CONFIG_NOSYSTEM", "1"), ("GCM_INTERACTIVE", "never")]
			.iter()
			.map(|(k, v)| (k.to_string(), v.to_string()))
			.collect();
		if self.cred.kind == KIND_NONE || self.cred.value.is_empty() {
			return Ok(GitEnv { vars, _secrets: None });
		}
		let dir = tempfile::Builder::new().prefix("vexdock-git-").tempdir()?;
		match self.cred.kind.as_str() {
			KIND_TOKEN => {
				let askpass = dir.path().join("askpass.sh");
				let script = "#!/bin/sh\ncase \"$1\" in\n*[Uu]sername*) printf '%s' \"$GIT_CRED_USER\" ;;\n*) printf '%s' \"$GIT_CRED_TOKEN\" ;;\nesac\n";
				crate::security::write_file_mode(&askpass, script.as_bytes(), 0o700)?;
				let user = if self.cred.user.is_empty() { "x-access-token" } else { &self.cred.user };
				vars.push(("GIT_ASKPASS".into(), askpass.to_string_lossy().into_owned()));
				vars.push(("GIT_CRED_USER".into(), user.to_string()));
				vars.push(("GIT_CRED_TOKEN".into(), self.cred.value.clone()));
			}
			KIND_SSH_KEY => {
				let key_path = dir.path().join("id_key");
				let mut key = self.cred.value.clone();
				if !key.ends_with('\n') {
					key.push('\n');
				}
				crate::security::write_file_mode(&key_path, key.as_bytes(), 0o600)?;
				vars.push((
					"GIT_SSH_COMMAND".into(),
					format!(
						"ssh -i {} -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile={}",
						key_path.display(),
						self.known_hosts
					),
				));
			}
			other => return Err(anyhow!("unknown git credential kind {other:?}")),
		}
		Ok(GitEnv { vars, _secrets: Some(dir) })
	}
}

async fn run(log: &mut (dyn Write + Send), dir: &str, env: &GitEnv, args: &[&str]) -> Result<()> {
	let mut cmd = Command::new("git");
	cmd.args(args).envs(env.vars.iter().map(|(k, v)| (k, v)));
	if !dir.is_empty() {
		cmd.current_dir(dir);
	}
	let status = run_streaming(cmd, log).await?;
	if !status.success() {
		bail!("git {}: {}", args[0], exit_text(status));
	}
	Ok(())
}
