//! The project lifecycle: on-disk layout, environment files and the compose
//! invocation each project resolves to.

mod environments;
mod git_providers;
mod overlay;
mod portable;
mod registry;
mod services;

pub use git_providers::*;
pub use overlay::*;
pub use portable::*;
pub use registry::*;

use std::sync::{Arc, LazyLock};

use anyhow::{Result, bail};
use regex::Regex;

use crate::config::Config;
use crate::database::{self, Db, Project};
use crate::engines::SqldSpec;
use crate::security::{self, Cipher};

pub struct Projects {
	db: Arc<Db>,
	cfg: Arc<Config>,
	cipher: Arc<Cipher>,
}

/// The validated payload of the New Project wizard. A project is a grouping, so
/// this is a name and its labels; what gets deployed is decided per service.
#[derive(Clone, Debug, Default)]
pub struct CreateInput {
	pub name: String,
	pub tags: Vec<String>,
}

/// The create form of one service inside a project. Which fields matter is
/// decided by provider; database is set only for a catalog database.
#[derive(Clone, Debug, Default)]
pub struct ServiceInput {
	pub name: String,
	/// Overrides what the container is called on the host; empty takes the
	/// project's own name for it.
	pub container_name: String,
	pub provider: String,
	pub repository_url: String,
	pub branch: String,
	pub build_path: String,
	/// Authenticate a private clone of the plain git provider.
	pub credential_kind: String,
	pub credential_secret: String,
	/// The four connected providers name a repository instead of a URL.
	pub git_provider_id: String,
	pub owner: String,
	pub repository: String,
	/// The reference an image service runs.
	pub image: String,
	/// The YAML body of a raw service.
	pub compose_fragment: String,
	pub database: Option<DatabaseInput>,
}

/// The Database branch of the create form.
#[derive(Clone, Debug, Default)]
pub struct DatabaseInput {
	pub engine: String,
	pub version: String,
	pub name: String,
	pub user: String,
	pub password: String,
	/// Pins the reference to run over version for every engine, which is what
	/// preserves a version across an import. data_path is "other image" only.
	pub image: String,
	pub data_path: String,
	/// libSQL's own half of the form, ignored by every other engine.
	pub sqld: SqldSpec,
}

/// How many labels one project can carry; they live in one column and display inline.
pub const MAX_TAGS: usize = 20;

/// Slugifies free-form labels: comma-free for storage, compared
/// case-insensitively, duplicates dropped.
pub fn normalize_tags(tags: &[String]) -> Vec<String> {
	let mut out: Vec<String> = Vec::new();
	for raw in tags {
		if raw.trim().is_empty() {
			continue;
		}
		let tag = slugify(raw);
		if out.contains(&tag) {
			continue;
		}
		out.push(tag);
		if out.len() == MAX_TAGS {
			break;
		}
	}
	out
}

static NON_SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new("[^a-z0-9]+").unwrap());

/// A URL-safe, unique-ish slug from a display name.
pub fn slugify(name: &str) -> String {
	let lowered = name.trim().to_lowercase();
	let mut s = NON_SLUG.replace_all(&lowered, "-").trim_matches('-').to_string();
	if s.is_empty() {
		s = "project".into();
	}
	if s.len() > 48 {
		s = s[..48].trim_matches('-').to_string();
	}
	s
}

impl Projects {
	pub fn new(db: Arc<Db>, cfg: Arc<Config>, cipher: Arc<Cipher>) -> Projects {
		Projects { db, cfg, cipher }
	}

	/// Validates the input, persists the project and lays out its directory.
	pub fn create(&self, input: &CreateInput) -> Result<Project> {
		let name = input.name.trim();
		if name.is_empty() {
			bail!("project name is required");
		}
		let slug = slugify(name);
		security::validate_slug(&slug)?;
		let id = database::new_id();
		let mut p = Project {
			compose_project_name: compose_project_name(&id),
			id,
			name: name.to_string(),
			slug,
			tags: input.tags.clone(),
			..Default::default()
		};
		self.validate(&mut p)?;
		if let Err(err) = self.db.create_project(&mut p) {
			if err.to_string().contains("UNIQUE") {
				bail!("a project named {name:?} already exists");
			}
			return Err(err);
		}
		// The default environment carries the project's own id and namespace: what
		// migration 0010 backfilled for projects that predate environments.
		let mut env = database::Environment {
			id: p.id.clone(),
			project_id: p.id.clone(),
			name: "Production".into(),
			slug: "production".into(),
			compose_project_name: p.compose_project_name.clone(),
			is_default: true,
			..Default::default()
		};
		if let Err(err) = self.db.create_environment(&mut env).and_then(|()| self.prepare_dirs(&env)) {
			let _ = self.db.delete_project(&p.id);
			return Err(err);
		}
		Ok(p)
	}

	/// Normalizes and checks a project's mutable fields. Creation and every update run through it.
	pub fn validate(&self, p: &mut Project) -> Result<()> {
		p.tags = normalize_tags(&p.tags);
		p.name = p.name.trim().to_string();
		if p.name.is_empty() {
			bail!("project name is required");
		}
		if p.slug.is_empty() {
			p.slug = slugify(&p.name);
		}
		security::validate_slug(&p.slug)
	}

	fn prepare_dirs(&self, env: &database::Environment) -> Result<()> {
		for dir in [self.repository_dir(&env.id), format!("{}/metadata", self.cfg.project_dir(&env.id))] {
			security::create_dir_mode(std::path::Path::new(&dir), 0o750)?;
		}
		Ok(())
	}

	fn repository_dir(&self, id: &str) -> String {
		format!("{}/repository", self.cfg.project_dir(id))
	}

	/// The generated .env consumed by docker compose.
	pub fn env_file_path(&self, env: &database::Environment) -> String {
		format!("{}/.env", self.cfg.project_dir(&env.id))
	}

	/// The compose invocation for an environment, writing the .env file first so
	/// compose and the containers see the same values. Every service the
	/// environment owns is rendered into one generated file; nothing else is read.
	pub fn compose_project(&self, p: &Project, env: &database::Environment) -> Result<crate::compose::Project> {
		let env_file = self.write_env_file(p, env)?;
		let overlay = self.write_overlay(env)?;
		if overlay.is_empty() {
			return Err(anyhow::Error::new(NoServices).context(format!("environment {}", env.slug)));
		}
		Ok(crate::compose::Project {
			name: env.compose_project_name.clone(),
			dir: self.repository_dir(&env.id),
			files: vec![overlay],
			env_file,
		})
	}

	/// Materialises what an environment's containers see at 0600 and returns its
	/// path, or "" when there are no variables (so compose omits --env-file). The
	/// file is always written, even empty: a compose env_file: .env has to open
	/// something. The environment's own variables layer over the project's shared set.
	pub fn write_env_file(&self, p: &Project, env: &database::Environment) -> Result<String> {
		let shared = self.project_variables(&p.id)?;
		let own = self.environment_variables(&env.id)?;
		let vars = merge_variables(&[shared, own]);
		let path = self.env_file_path(env);
		write_env_file(&path, &vars)?;
		Ok(if vars.is_empty() { String::new() } else { path })
	}
}

/// Nothing to render, not a failed render: the delete paths skip teardown on it
/// and treat every other error as fatal.
#[derive(Debug, thiserror::Error)]
#[error("no configured service to deploy")]
pub struct NoServices;

/// Namespaces every docker resource of one environment, which keeps production
/// and staging from sharing a container or a volume.
pub fn compose_project_name(id: &str) -> String {
	format!("p_{}", id.to_lowercase())
}

/// Layers narrower sets over wider ones, last wins, sorted so a regenerated
/// .env only changes when a value did.
fn merge_variables(sets: &[Vec<EnvVar>]) -> Vec<EnvVar> {
	let mut by_key = std::collections::BTreeMap::new();
	for set in sets {
		for v in set {
			by_key.insert(v.key.clone(), v.clone());
		}
	}
	by_key.into_values().collect()
}

/// Renders vars to an env file at 0600. The environment file and each managed
/// service's file go through here so their escaping cannot drift.
fn write_env_file(path: &str, vars: &[EnvVar]) -> Result<()> {
	let mut b = String::from("# generated by the platform - edit through the dashboard\n");
	for v in vars {
		b.push_str(&format!("{}={}\n", v.key, escape_env_value(&v.value)));
	}
	if let Some(dir) = std::path::Path::new(path).parent() {
		security::create_dir_mode(dir, 0o750)?;
	}
	security::write_file_mode(std::path::Path::new(path), b.as_bytes(), 0o600)?;
	Ok(())
}

/// Quotes values so newlines and spaces survive compose parsing. A dollar
/// becomes $$ because compose interpolates inside double quotes as well as
/// outside, so a raw $ would eat the rest: p$ssw0rd would reach the container as p.
fn escape_env_value(v: &str) -> String {
	if v.is_empty() {
		return "\"\"".into();
	}
	if !v.contains([' ', '\t', '\n', '"', '\'', '$', '#']) {
		return v.to_string();
	}
	let mut out = String::from("\"");
	for c in v.chars() {
		match c {
			'\\' => out.push_str("\\\\"),
			'"' => out.push_str("\\\""),
			'\n' => out.push_str("\\n"),
			'$' => out.push_str("$$"),
			c => out.push(c),
		}
	}
	out.push('"');
	out
}

/// One environment entry as returned to the API.
#[derive(Clone, Debug, Default, serde::Serialize, serde::Deserialize)]
pub struct EnvVar {
	pub key: String,
	pub value: String,
	#[serde(default)]
	pub is_secret: bool,
	#[serde(default)]
	pub updated_at: String,
}

// Variables come in three layers: a project's reach every environment, an
// environment's only that copy, a service's only itself. write_env_file merges
// them at deploy time, narrowest last. None of the three mask on read: the
// editor is where a secret is meant to be legible (docs/security.md).
impl Projects {
	/// The set shared by every environment of a project.
	pub fn project_variables(&self, project_id: &str) -> Result<Vec<EnvVar>> {
		self.variables(database::PROJECT_SCOPE, project_id)
	}

	/// The set that makes production differ from staging.
	pub fn environment_variables(&self, environment_id: &str) -> Result<Vec<EnvVar>> {
		self.variables(database::ENVIRONMENT_SCOPE, environment_id)
	}

	/// The variables only one service sees.
	pub fn service_variables(&self, service_id: &str) -> Result<Vec<EnvVar>> {
		self.variables(database::SERVICE_SCOPE, service_id)
	}

	fn variables(&self, scope: database::SecretScope, owner_id: &str) -> Result<Vec<EnvVar>> {
		let mut out = Vec::new();
		for row in self.db.list_secrets(scope, owner_id)? {
			let value = self.cipher.decrypt(&row.encrypted).map_err(|err| anyhow::anyhow!("decrypt {}: {err}", row.key))?;
			out.push(EnvVar { key: row.key, value, is_secret: row.is_secret, updated_at: row.updated_at });
		}
		out.sort_by(|a, b| a.key.cmp(&b.key));
		Ok(out)
	}

	/// Replaces the whole set shared across environments.
	pub fn set_project_variables(&self, project_id: &str, vars: &[EnvVar]) -> Result<()> {
		self.set_variables(database::PROJECT_SCOPE, project_id, vars)
	}

	/// Replaces the whole set of one environment.
	pub fn set_environment_variables(&self, environment_id: &str, vars: &[EnvVar]) -> Result<()> {
		self.set_variables(database::ENVIRONMENT_SCOPE, environment_id, vars)
	}

	/// Replaces the whole variable set of a single service.
	pub fn set_service_variables(&self, service_id: &str, vars: &[EnvVar]) -> Result<()> {
		self.set_variables(database::SERVICE_SCOPE, service_id, vars)
	}

	fn set_variables(&self, scope: database::SecretScope, owner_id: &str, vars: &[EnvVar]) -> Result<()> {
		let existing = self.db.list_secrets(scope, owner_id)?;
		// Every key is validated before the first write, so a rejected payload
		// leaves the stored set exactly as it was.
		let mut incoming = std::collections::HashSet::new();
		for v in vars {
			let key = v.key.trim();
			security::validate_env_key(key)?;
			incoming.insert(key.to_string());
		}
		for v in vars {
			// A masked value means "unchanged": never overwrite a real secret with dots.
			if v.value == security::MASKED_VALUE {
				continue;
			}
			let enc = self.cipher.encrypt(&v.value)?;
			self.db.upsert_secret(scope, owner_id, v.key.trim(), &enc, v.is_secret)?;
		}
		for row in existing {
			if !incoming.contains(&row.key) {
				self.db.delete_secret(scope, owner_id, &row.key)?;
			}
		}
		Ok(())
	}

	/// Encrypts a git credential onto a service. An empty secret with a
	/// credential already stored means "keep current".
	pub fn set_credential(&self, svc: &mut database::Service, kind: &str, secret: &str) -> Result<()> {
		match kind {
			"" | database::GIT_CREDENTIAL_NONE => {
				svc.credential_kind = database::GIT_CREDENTIAL_NONE.into();
				svc.credential_enc.clear();
				Ok(())
			}
			database::GIT_CREDENTIAL_TOKEN | database::GIT_CREDENTIAL_SSH => {
				if secret.trim().is_empty() {
					if !svc.credential_enc.is_empty() && svc.credential_kind == kind {
						return Ok(());
					}
					bail!("a credential value is required for {kind}");
				}
				svc.credential_enc = self.cipher.encrypt(secret)?;
				svc.credential_kind = kind.into();
				Ok(())
			}
			other => bail!("unknown credential kind {other:?}"),
		}
	}

	/// Deletes a project's on-disk state after it is torn down.
	pub fn remove_directory(&self, id: &str) -> Result<()> {
		// Defensive: only ever remove a path inside the projects root.
		security::resolve_inside(&self.cfg.projects_dir, id)?;
		match std::fs::remove_dir_all(self.cfg.project_dir(id)) {
			Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err.into()),
			_ => Ok(()),
		}
	}
}

#[cfg(test)]
mod tests;
