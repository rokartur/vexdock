use anyhow::{Result, bail};

use super::{Projects, compose_project_name, slugify};
use crate::database::{self, Environment, Project};
use crate::security;

impl Projects {
	/// Adds a deployable copy of a project: a fresh id, so its own directory and
	/// docker namespace, seeded with the default environment's services.
	/// Domains do not come with it: they name one host.
	pub fn create_environment(&self, p: &Project, name: &str, branch: &str) -> Result<Environment> {
		let name = name.trim();
		if name.is_empty() {
			bail!("environment name is required");
		}
		let slug = slugify(name);
		security::validate_slug(&slug)?;
		let branch = branch.trim();
		if !branch.is_empty() {
			security::validate_git_ref(branch)?;
		}
		let id = database::new_id();
		let mut env = Environment {
			compose_project_name: compose_project_name(&id),
			id,
			project_id: p.id.clone(),
			name: name.into(),
			slug,
			branch: branch.into(),
			..Default::default()
		};
		if let Err(err) = self.db.create_environment(&mut env) {
			if err.to_string().contains("UNIQUE") {
				bail!("this project already has an environment named {name:?}");
			}
			return Err(err);
		}
		if let Err(err) = self.prepare_dirs(&env).and_then(|()| self.seed_services(p, &env)) {
			let _ = self.db.delete_environment(&env.id);
			return Err(err);
		}
		Ok(env)
	}

	/// Copies the default environment's services into a new one, so a staging
	/// environment starts as a copy of production rather than as nothing.
	/// Variables come along: a database without its credentials cannot start.
	fn seed_services(&self, p: &Project, env: &Environment) -> Result<()> {
		let source = self.db.default_environment(&p.id)?;
		if source.id == env.id {
			return Ok(());
		}
		for svc in self.db.list_services(&source.id)? {
			let name = svc.compose_service_name.clone();
			self.copy_service(&svc, env, &name)?;
		}
		self.write_overlay(env)?;
		Ok(())
	}

	/// Renames an environment or repoints its branch. The slug and the compose
	/// project name stay put: the namespace names running containers, so
	/// changing it would orphan every one of them.
	pub fn update_environment(&self, env: &mut Environment, name: &str, branch: &str) -> Result<()> {
		let name = name.trim();
		if name.is_empty() {
			bail!("environment name is required");
		}
		let branch = branch.trim();
		if !branch.is_empty() {
			security::validate_git_ref(branch)?;
		}
		env.name = name.into();
		env.branch = branch.into();
		self.db.update_environment(env)
	}

	/// Removes an environment's record and its directory. The caller stops the
	/// containers first. The default environment is refused: a project with
	/// none has nothing to deploy and no way back through the dashboard.
	pub fn delete_environment(&self, env: &Environment) -> Result<()> {
		if env.is_default {
			bail!("the default environment cannot be deleted");
		}
		self.db.delete_environment(&env.id)?;
		match std::fs::remove_dir_all(self.cfg.project_dir(&env.id)) {
			Err(err) if err.kind() != std::io::ErrorKind::NotFound => Err(err.into()),
			_ => Ok(()),
		}
	}
}
