//! Runtime configuration from the environment.
//!
//! The manager container bind-mounts the host platform root at the *same* path
//! inside the container (see compose.yml) so that paths handed to the Docker
//! daemon resolve identically on both sides.

use std::path::Path;
use std::time::Duration;

use anyhow::{Context, Result};

use crate::security::create_dir_mode;

#[derive(Clone, Debug)]
pub struct Config {
	/// The platform state directory, identical on host and in-container.
	pub root: String,
	pub data_dir: String,
	pub projects_dir: String,
	pub nginx_dir: String,
	pub certificates_dir: String,
	pub backups_dir: String,
	pub secrets_dir: String,
	pub system_dir: String,
	pub listen_addr: String,
	/// The shared docker network joining Nginx and user services.
	pub proxy_network: String,
	/// The manager's own network with Nginx and auth. With no host in
	/// listen_addr the API binds only there and on loopback.
	pub internal_network: String,
	/// The container name used for `nginx -t` and reloads.
	pub nginx_container: String,
	/// The externally reachable dashboard origin, when known.
	pub public_url: String,
	pub version: String,
	pub acme_directory: String,
	pub acme_email: String,
	/// Renewal starts when a certificate expires within this window.
	pub acme_renew_before: Duration,
}

pub const LETS_ENCRYPT_PRODUCTION: &str = "https://acme-v02.api.letsencrypt.org/directory";
pub const LETS_ENCRYPT_STAGING: &str = "https://acme-staging-v02.api.letsencrypt.org/directory";

impl Config {
	/// Builds the configuration and creates every state directory it needs.
	pub fn load() -> Result<Config> {
		let mut root = env("PLATFORM_ROOT", "/opt/vexdock");
		if !root.starts_with('/') {
			root = std::path::absolute(&root).context("resolve PLATFORM_ROOT")?.to_string_lossy().into_owned();
		}
		let acme_dir = if bool_env("PLATFORM_ACME_STAGING", false) { LETS_ENCRYPT_STAGING } else { LETS_ENCRYPT_PRODUCTION };
		let c = Config::at(&root);
		let c = Config {
			listen_addr: env("PLATFORM_LISTEN", ":8080"),
			proxy_network: env("PLATFORM_PROXY_NETWORK", "vexdock-proxy"),
			internal_network: env("PLATFORM_INTERNAL_NETWORK", "vexdock-internal"),
			nginx_container: env("PLATFORM_NGINX_CONTAINER", "vexdock-nginx"),
			public_url: env("PLATFORM_PUBLIC_URL", "").trim_end_matches('/').to_string(),
			version: env("PLATFORM_VERSION", "dev"),
			acme_directory: env("PLATFORM_ACME_DIRECTORY", acme_dir),
			acme_email: env("PLATFORM_ACME_EMAIL", ""),
			..c
		};
		for dir in [&c.data_dir, &c.projects_dir, &c.nginx_dir, &c.certificates_dir, &c.backups_dir, &c.system_dir] {
			create_dir_mode(Path::new(dir), 0o755).with_context(|| format!("create {dir}"))?;
		}
		// Secrets are readable by the manager only.
		create_dir_mode(Path::new(&c.secrets_dir), 0o700).with_context(|| format!("create {}", c.secrets_dir))?;
		for sub in ["generated", "custom", "acme-challenge"] {
			let dir = format!("{}/{sub}", c.nginx_dir);
			create_dir_mode(Path::new(&dir), 0o755).with_context(|| format!("create {dir}"))?;
		}
		Ok(c)
	}

	/// A configuration rooted at `root` with every other setting at its default.
	/// Tests use it directly; `load` overlays the environment on it.
	pub fn at(root: &str) -> Config {
		Config {
			root: root.to_string(),
			data_dir: format!("{root}/data"),
			projects_dir: format!("{root}/projects"),
			nginx_dir: format!("{root}/nginx"),
			certificates_dir: format!("{root}/certificates"),
			backups_dir: format!("{root}/backups"),
			secrets_dir: format!("{root}/secrets"),
			system_dir: format!("{root}/system"),
			listen_addr: ":8080".into(),
			proxy_network: "vexdock-proxy".into(),
			internal_network: "vexdock-internal".into(),
			nginx_container: "vexdock-nginx".into(),
			public_url: String::new(),
			version: "dev".into(),
			acme_directory: LETS_ENCRYPT_PRODUCTION.into(),
			acme_email: String::new(),
			acme_renew_before: Duration::from_secs(30 * 24 * 3600),
		}
	}

	/// The SQLite file backing the whole management plane.
	pub fn database_path(&self) -> String {
		format!("{}/app.db", self.data_dir)
	}

	/// The better-auth database. The auth service writes it, the manager reads it.
	pub fn auth_database_path(&self) -> String {
		format!("{}/auth.db", self.data_dir)
	}

	/// The AES-GCM key protecting secrets stored in SQLite.
	pub fn master_key_path(&self) -> String {
		format!("{}/master.key", self.secrets_dir)
	}

	/// The on-disk home of one project, keyed by ULID (never by name).
	pub fn project_dir(&self, id: &str) -> String {
		format!("{}/{id}", self.projects_dir)
	}
}

fn env(key: &str, fallback: &str) -> String {
	match std::env::var(key) {
		Ok(v) if !v.trim().is_empty() => v.trim().to_string(),
		_ => fallback.to_string(),
	}
}

/// Go's strconv.ParseBool vocabulary.
fn bool_env(key: &str, fallback: bool) -> bool {
	match env(key, "").as_str() {
		"1" | "t" | "T" | "TRUE" | "true" | "True" => true,
		"0" | "f" | "F" | "FALSE" | "false" | "False" => false,
		_ => fallback,
	}
}
