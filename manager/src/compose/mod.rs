//! Drives the official `docker compose` CLI. The platform never reimplements
//! Compose semantics: it shells out with one argument per list element (never
//! through `sh -c`) and reads back the resolved JSON config.

use std::collections::BTreeMap;
use std::io::Write;
use std::process::{ExitStatus, Stdio};

use anyhow::{Context, Result, bail};
use serde::Deserialize;
use serde_json::Value;
use tokio::io::AsyncReadExt;
use tokio::process::Command;

/// One compose invocation: which directory, which files and under which
/// compose project name its resources live.
#[derive(Clone, Debug, Default)]
pub struct Project {
	/// --project-name, e.g. p_01JABCXYZ
	pub name: String,
	/// --project-directory, the repository root on disk
	pub dir: String,
	/// The compose files in merge order: the project's own first, then the
	/// overlay the manager generates for the services it owns.
	pub files: Vec<String>,
	/// Absolute path to the project .env, when present.
	pub env_file: String,
}

/// The subset of `docker compose config --format json` the platform needs.
#[derive(Clone, Debug, Default, Deserialize)]
pub struct Config {
	#[serde(default)]
	pub name: String,
	#[serde(default)]
	pub services: BTreeMap<String, ConfigService>,
	#[serde(default)]
	pub volumes: BTreeMap<String, Value>,
	#[serde(default)]
	pub networks: BTreeMap<String, Value>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ConfigService {
	#[serde(default)]
	pub image: String,
	#[serde(default)]
	pub build: Option<Value>,
	#[serde(default)]
	pub ports: Vec<ConfigPort>,
	#[serde(default)]
	pub environment: BTreeMap<String, Value>,
	#[serde(default)]
	pub labels: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct ConfigPort {
	#[serde(default)]
	pub target: i64,
	#[serde(default)]
	pub published: String,
	#[serde(default)]
	pub protocol: String,
}

/// Decodes `docker compose config --format json` output.
pub fn parse_config(raw: &[u8]) -> Result<Config> {
	let cfg: Config = serde_json::from_slice(raw).context("parse compose config")?;
	if cfg.services.is_empty() {
		bail!("compose file declares no services");
	}
	Ok(cfg)
}

impl Project {
	fn args(&self, extra: &[&str]) -> Vec<String> {
		let mut args: Vec<String> =
			vec!["compose".into(), "--project-name".into(), self.name.clone(), "--project-directory".into(), self.dir.clone()];
		for file in &self.files {
			args.push("--file".into());
			args.push(file.clone());
		}
		if !self.env_file.is_empty() {
			args.push("--env-file".into());
			args.push(self.env_file.clone());
		}
		args.extend(extra.iter().map(|s| s.to_string()));
		args
	}

	/// Resolves and type-checks the compose file, returning the config.
	pub async fn validate(&self) -> Result<Config> {
		let output = Command::new("docker").args(self.args(&["config", "--format", "json"])).kill_on_drop(true).output().await?;
		if !output.status.success() {
			let stderr = String::from_utf8_lossy(&output.stderr);
			bail!("compose config failed: {}", first_lines(&stderr, &exit_text(output.status)));
		}
		parse_config(&output.stdout)
	}

	/// Executes a compose subcommand, streaming combined output to `out`.
	pub async fn run(&self, out: &mut (dyn Write + Send), extra: &[&str]) -> Result<()> {
		let mut cmd = Command::new("docker");
		cmd.args(self.args(extra));
		let status = run_streaming(cmd, out).await?;
		if !status.success() {
			bail!("docker compose {} failed: {}", extra.join(" "), exit_text(status));
		}
		Ok(())
	}

	// Each of these acts on one compose service, the one being deployed.
	//
	// Pull reports registry failures rather than hiding them behind
	// --ignore-pull-failures: the caller knows whether the service builds its
	// own image and can decide a failed pull is survivable.
	pub async fn pull(&self, out: &mut (dyn Write + Send), service: &str) -> Result<()> {
		self.run(out, &["pull", service]).await
	}

	pub async fn build(&self, out: &mut (dyn Write + Send), service: &str) -> Result<()> {
		self.run(out, &["build", service]).await
	}

	/// No --remove-orphans: a single-service deploy must not tear siblings down
	/// just because they were not named.
	pub async fn up(&self, out: &mut (dyn Write + Send), service: &str) -> Result<()> {
		self.run(out, &["up", "-d", service]).await
	}

	pub async fn down(&self, out: &mut (dyn Write + Send), remove_volumes: bool) -> Result<()> {
		let mut args = vec!["down", "--remove-orphans"];
		if remove_volumes {
			args.push("--volumes");
		}
		self.run(out, &args).await
	}
}

/// An exit status the way the dashboard has always shown it: "exit status 1",
/// or "signal: 9" for a process killed before it could exit.
pub fn exit_text(status: ExitStatus) -> String {
	use std::os::unix::process::ExitStatusExt;
	match (status.code(), status.signal()) {
		(Some(code), _) => format!("exit status {code}"),
		(None, Some(signal)) => format!("signal: {signal}"),
		(None, None) => status.to_string(),
	}
}

/// Runs a command with stdout and stderr both written to `out` as they arrive.
/// Dropping the future kills the process, which is how a cancelled deploy stops it.
pub async fn run_streaming(mut cmd: Command, out: &mut (dyn Write + Send)) -> Result<ExitStatus> {
	cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).kill_on_drop(true);
	let mut child = cmd.spawn().context("start command")?;
	let mut stdout = child.stdout.take().expect("piped");
	let mut stderr = child.stderr.take().expect("piped");
	let (mut out_buf, mut err_buf) = ([0u8; 8192], [0u8; 8192]);
	let (mut out_open, mut err_open) = (true, true);
	while out_open || err_open {
		tokio::select! {
			n = stdout.read(&mut out_buf), if out_open => match n? {
				0 => out_open = false,
				n => out.write_all(&out_buf[..n])?,
			},
			n = stderr.read(&mut err_buf), if err_open => match n? {
				0 => err_open = false,
				n => out.write_all(&err_buf[..n])?,
			},
		}
	}
	Ok(child.wait().await?)
}

/// Keeps compose stderr readable in a deployment log line.
pub fn first_lines(stderr: &str, fallback: &str) -> String {
	let s = stderr.trim();
	if s.is_empty() {
		return fallback.to_string();
	}
	s.lines().take(8).collect::<Vec<_>>().join("; ")
}

#[cfg(test)]
mod tests {
	use super::*;

	const RESOLVED: &str = r#"{
	  "name": "p_01jabc",
	  "services": {
	    "web": {"image": "nginx:alpine", "ports": [{"mode": "ingress", "target": 3000, "published": "3000", "protocol": "tcp"}], "healthcheck": {"test": ["CMD", "true"]}},
	    "api": {"build": {"context": "."}, "ports": [{"mode": "ingress", "target": 8080, "protocol": "tcp"}]},
	    "worker": {"image": "busybox"}
	  },
	  "volumes": {"data": {}},
	  "networks": {"default": {}}
	}"#;

	#[test]
	fn parses_config() {
		let cfg = parse_config(RESOLVED.as_bytes()).unwrap();
		assert_eq!(cfg.name, "p_01jabc");
		assert_eq!(cfg.services.len(), 3);
		assert!(cfg.services["api"].build.is_some(), "build section lost");
	}

	#[test]
	fn rejects_empty_config() {
		assert!(parse_config(br#"{"services":{}}"#).is_err());
		assert!(parse_config(b"not json").is_err());
	}

	#[test]
	fn args_keep_every_value_separate() {
		let mut p = Project {
			name: "p_01jabc".into(),
			dir: "/projects/01jabc/repository".into(),
			// The overlay is a second --file, and its order is what lets a managed service override.
			files: vec!["/projects/01jabc/repository/compose.yml".into(), "/projects/01jabc/managed.yml".into()],
			env_file: "/projects/01jabc/.env".into(),
		};
		assert_eq!(
			p.args(&["up", "-d"]),
			[
				"compose",
				"--project-name",
				"p_01jabc",
				"--project-directory",
				"/projects/01jabc/repository",
				"--file",
				"/projects/01jabc/repository/compose.yml",
				"--file",
				"/projects/01jabc/managed.yml",
				"--env-file",
				"/projects/01jabc/.env",
				"up",
				"-d"
			]
		);
		p.env_file.clear();
		assert!(!p.args(&["down"]).contains(&"--env-file".to_string()));
	}
}
