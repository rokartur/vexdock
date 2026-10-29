//! Renders and safely applies the reverse-proxy configuration.

mod generate;

pub use generate::*;

use std::collections::BTreeMap;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result, anyhow, bail};
use tokio::sync::Mutex;

use crate::docker::Docker;

/// Owns the generated config directory and the reload cycle.
///
/// Applying is a full reconcile: the caller renders the complete desired set
/// and the manager makes the directory match it. A failed `nginx -t` restores
/// the exact previous directory contents, so a bad config can never take the
/// proxy down. Hand-written files in the custom directory are never touched.
pub struct Nginx {
	generated_dir: String,
	nginx_container: String,
	docker: Arc<Docker>,
	/// The files on disk are ahead of the running proxy. Held across a whole
	/// apply, which is also what serializes them.
	reload_pending: Mutex<bool>,
}

/// File name to contents, the shape of the generated directory.
pub type FileSet = BTreeMap<String, String>;

impl Nginx {
	pub fn new(generated_dir: String, nginx_container: String, docker: Arc<Docker>) -> Nginx {
		Nginx { generated_dir, nginx_container, docker, reload_pending: Mutex::new(false) }
	}

	/// Writes the desired file set, validates it and reloads Nginx.
	pub async fn apply(&self, desired: &FileSet) -> Result<()> {
		let mut reload_pending = self.reload_pending.lock().await;
		let before = self.snapshot()?;
		// reload_pending survives a failed reload: disk already matches desired,
		// so without it every later apply returns early and the proxy keeps
		// serving the old configuration forever.
		if &before == desired && !*reload_pending {
			return Ok(());
		}
		if let Err(err) = self.write(desired) {
			let _ = self.write(&before);
			return Err(err);
		}
		if let Err((out, err)) = self.test().await {
			// Restore byte-for-byte, so the running proxy keeps the last known-good configuration.
			if let Err(restore_err) = self.write(&before) {
				tracing::error!(component = "nginx", error = %restore_err, "nginx rollback failed");
			}
			tracing::error!(component = "nginx", output = %out, "generated nginx configuration rejected");
			bail!("nginx configuration test failed: {}", condense(&out, Some(&err)));
		}
		if let Err(err) = self.reload().await {
			*reload_pending = true;
			return Err(err);
		}
		*reload_pending = false;
		tracing::info!(component = "nginx", vhosts = desired.len(), "nginx configuration applied");
		Ok(())
	}

	/// `nginx -t` inside the proxy container; the error carries its output.
	pub async fn test(&self) -> Result<String, (String, anyhow::Error)> {
		let argv = ["nginx".to_string(), "-t".to_string()];
		match tokio::time::timeout(Duration::from_secs(30), self.docker.exec_output(&self.nginx_container, &argv)).await {
			Err(_) => Err((String::new(), anyhow!("nginx -t timed out"))),
			Ok(Err(err)) => Err((String::new(), err)),
			Ok(Ok((out, 0))) => Ok(out),
			Ok(Ok((out, code))) => Err((out, anyhow!("nginx -t exited with {code}"))),
		}
	}

	/// Asks Nginx to pick up the validated configuration without dropping
	/// in-flight connections.
	pub async fn reload(&self) -> Result<()> {
		let argv = ["nginx".to_string(), "-s".to_string(), "reload".to_string()];
		let (out, code) = tokio::time::timeout(Duration::from_secs(30), self.docker.exec_output(&self.nginx_container, &argv))
			.await
			.map_err(|_| anyhow!("nginx reload: timed out"))?
			.context("nginx reload")?;
		if code != 0 {
			bail!("nginx reload exited with {code}: {}", condense(&out, None));
		}
		Ok(())
	}

	fn snapshot(&self) -> Result<FileSet> {
		let mut out = FileSet::new();
		for entry in std::fs::read_dir(&self.generated_dir).context("read generated dir")? {
			let entry = entry?;
			let name = entry.file_name().to_string_lossy().into_owned();
			if entry.file_type()?.is_dir() || !(name.ends_with(".conf") || name.ends_with(".htpasswd")) {
				continue;
			}
			out.insert(name, std::fs::read_to_string(entry.path())?);
		}
		Ok(out)
	}

	/// Makes the directory contain exactly the given files.
	fn write(&self, files: &FileSet) -> Result<()> {
		for name in self.snapshot()?.keys() {
			if !files.contains_key(name) {
				std::fs::remove_file(format!("{}/{name}", self.generated_dir))?;
			}
		}
		for (name, body) in files {
			let path = format!("{}/{name}", self.generated_dir);
			let tmp = format!("{path}.tmp");
			std::fs::write(&tmp, body)?;
			std::fs::rename(&tmp, &path)?;
		}
		Ok(())
	}
}

fn condense(out: &str, err: Option<&anyhow::Error>) -> String {
	let s = out.trim();
	if s.is_empty()
		&& let Some(err) = err
	{
		return err.to_string();
	}
	let lines: Vec<&str> = s.split('\n').collect();
	lines[lines.len().saturating_sub(6)..].join("; ")
}

#[cfg(test)]
mod tests;
