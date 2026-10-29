use std::process::Stdio;
use std::time::Duration;

use anyhow::{Result, bail};
use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use super::Projects;
use crate::database::Service;
use crate::security;

impl Projects {
	/// Stores the private registry an image-sourced service pulls from. An
	/// empty username clears the login; an empty password keeps the stored one.
	pub fn set_registry_login(&self, svc: &mut Service, registry_url: &str, username: &str, password: &str) -> Result<()> {
		if username.trim().is_empty() {
			svc.registry_url.clear();
			svc.registry_username.clear();
			svc.registry_password_enc.clear();
			return Ok(());
		}
		let user = security::validate_command_arg("registry username", username)?;
		let url =
			if registry_url.trim().is_empty() { String::new() } else { security::validate_command_arg("registry url", registry_url)? };
		if password.is_empty() {
			if svc.registry_password_enc.is_empty() {
				bail!("a registry password is required");
			}
		} else {
			svc.registry_password_enc = self.cipher.encrypt(password)?;
		}
		svc.registry_url = url;
		svc.registry_username = user;
		Ok(())
	}

	/// Logs the daemon into the service's registry, if it has one.
	pub async fn registry_login(&self, svc: &Service) -> Result<()> {
		if svc.registry_username.is_empty() {
			return Ok(());
		}
		let password = self.cipher.decrypt(&svc.registry_password_enc)?;
		docker_login(&svc.registry_url, &svc.registry_username, &password).await
	}
}

/// Authenticates the daemon against a registry; an empty URL is Docker Hub.
/// The password is piped on stdin so it never appears in the process arguments.
pub async fn docker_login(registry_url: &str, username: &str, password: &str) -> Result<()> {
	let mut cmd = Command::new("docker");
	cmd.args(["login", "--username", username, "--password-stdin"]);
	if !registry_url.is_empty() {
		cmd.arg(registry_url);
	}
	cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
	let run = async {
		let mut child = cmd.spawn()?;
		let mut stdin = child.stdin.take().expect("stdin is piped");
		stdin.write_all(password.as_bytes()).await?;
		drop(stdin);
		anyhow::Ok(child.wait_with_output().await?)
	};
	let Ok(output) = tokio::time::timeout(Duration::from_secs(30), run).await else {
		bail!("registry login failed: timed out");
	};
	let output = output?;
	if !output.status.success() {
		let mut combined = String::from_utf8_lossy(&output.stdout).into_owned();
		combined.push_str(&String::from_utf8_lossy(&output.stderr));
		bail!("registry login failed: {}", combined.trim());
	}
	Ok(())
}
