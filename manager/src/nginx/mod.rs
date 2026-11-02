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

// Exits 0 once every accepting worker started after the reload. A worker that is
// shutting down renames itself and stops accepting, so `process$` skips it.
// Exit 3: the master kept the old workers for 10s, e.g. it rejected the config.
const RELOAD_AND_WAIT: &str = r#"
workers() { ps -o pid,args | awk '/nginx: worker process$/ { print $1 }'; }
before=" $(workers | xargs) "
nginx -s reload || exit 1
for _ in $(seq 200); do
	now=$(workers)
	stale=0
	for pid in $now; do case "$before" in *" $pid "*) stale=1 ;; esac; done
	[ -n "$now" ] && [ "$stale" = 0 ] && exit 0
	sleep 0.05
done
exit 3
"#;

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
	/// in-flight connections, and returns once only workers on the new
	/// configuration accept: `nginx -s reload` returns as soon as it signals the
	/// master, while the old workers still serve the previous upstreams.
	pub async fn reload(&self) -> Result<()> {
		let argv = ["sh".to_string(), "-c".to_string(), RELOAD_AND_WAIT.to_string()];
		let (out, code) = tokio::time::timeout(Duration::from_secs(30), self.docker.exec_output(&self.nginx_container, &argv))
			.await
			.map_err(|_| anyhow!("nginx reload: timed out"))?
			.context("nginx reload")?;
		match code {
			0 => Ok(()),
			3 => bail!("nginx reload: the workers still run the previous configuration after 10s"),
			_ => bail!("nginx reload exited with {code}: {}", condense(&out, None)),
		}
	}

	/// Whether the proxy container opens a TCP connection to `host:port`.
	/// BusyBox nc has no -z; exec attaches no stdin, so it connects and exits 0.
	pub async fn can_connect(&self, host: &str, port: i64) -> bool {
		let argv = ["nc".to_string(), "-w".to_string(), "1".to_string(), host.to_string(), port.to_string()];
		let probe = self.docker.exec_output(&self.nginx_container, &argv);
		matches!(tokio::time::timeout(Duration::from_secs(5), probe).await, Ok(Ok((_, 0))))
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
