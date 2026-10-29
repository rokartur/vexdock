use anyhow::{Context, Result, bail};

use super::{EnvVar, Projects, SERVICES_DIR_NAME, ServiceInput};
use crate::database::{self, Environment, Service};
use crate::engines;
use crate::security;

impl Projects {
	/// Validates and stores the repository fields of a git service. The four
	/// connected providers name a repository on a connection; the plain git
	/// provider carries its own URL and credential.
	fn apply_git(&self, svc: &mut Service, input: &ServiceInput) -> Result<()> {
		let branch = if input.branch.is_empty() { "main" } else { &input.branch };
		svc.branch = security::validate_git_ref(branch)?;
		svc.build_path = security::validate_sub_path(&input.build_path)?;
		if database::clones_from_connection(&svc.provider) {
			return self.set_git_repository(svc, &input.git_provider_id, &input.owner, &input.repository);
		}
		svc.repository_url = security::validate_git_url(&input.repository_url)?;
		self.set_credential(svc, &input.credential_kind, &input.credential_secret)
	}

	/// Settles what the service's container is called on the host. Without one
	/// compose falls back to the environment's opaque id, so the default is the
	/// project's slug and the service's name: "rokartur-db". A second environment
	/// puts its own name in between, since a container name is unique host-wide.
	fn container_name(&self, env: &Environment, service: &str, override_name: &str) -> Result<String> {
		let mut name = override_name.trim().to_string();
		if name.is_empty() {
			let project = self.db.project_by_id(&env.project_id)?;
			name = if env.is_default { format!("{}-{service}", project.slug) } else { format!("{}-{}-{service}", project.slug, env.slug) };
		}
		security::validate_container_name(&name)?;
		if self.db.service_by_container_name(&name).is_ok() {
			bail!("another service already runs a container named {name:?}");
		}
		Ok(name)
	}

	/// Adds a service the manager owns to a project. A database is rendered from
	/// the catalog before the row is written, so an invalid engine or version
	/// fails without leaving a half-created service behind.
	pub fn create_service(&self, env: &Environment, input: &ServiceInput) -> Result<Service> {
		let name = input.name.trim();
		security::validate_service_name(name)?;
		if self.db.service_by_name(&env.id, name).is_ok() {
			bail!("this environment already has a service named {name:?}");
		}
		let container = self.container_name(env, name, &input.container_name)?;

		let mut svc = Service {
			id: database::new_id(),
			project_id: env.project_id.clone(),
			environment_id: env.id.clone(),
			compose_service_name: name.into(),
			container_name: container,
			kind: database::SERVICE_APPLICATION.into(),
			provider: input.provider.clone(),
			credential_kind: database::GIT_CREDENTIAL_NONE.into(),
			build_type: database::BUILD_DOCKERFILE.into(),
			..Default::default()
		};
		let mut seed = Vec::new();

		match input.provider.as_str() {
			// An application is created as a bare name. Where its image comes from
			// is answered later, in the service's own settings.
			database::PROVIDER_UNCONFIGURED => {}
			p if database::clones_from_git(p) => self.apply_git(&mut svc, input)?,
			database::PROVIDER_IMAGE => match &input.database {
				None => svc.image = engines::validate_image(&input.image)?,
				Some(db) => {
					let rendered = engines::render(&engines::Spec {
						engine: db.engine.clone(),
						tag: db.version.clone(),
						database: db.name.clone(),
						user: db.user.clone(),
						password: db.password.clone(),
						image: db.image.clone(),
						data_path: db.data_path.clone(),
						sqld: db.sqld.clone(),
						name: name.into(),
						// Only rendered to validate the spec here; write_overlay
						// writes the real file once the row exists.
						env_file: self.service_env_file_path(env, name),
					})?;
					svc.kind = database::SERVICE_DATABASE.into();
					svc.engine = db.engine.clone();
					svc.image = rendered.image;
					// Re-rendering the overlay needs the same path back; the catalog
					// only knows it for curated engines.
					svc.data_path = db.data_path.trim().into();
					seed = rendered.env;
				}
			},
			database::PROVIDER_RAW => {
				if input.compose_fragment.trim().is_empty() {
					bail!("a compose fragment is required");
				}
				svc.compose_fragment = input.compose_fragment.clone();
			}
			other => bail!("unknown service provider {other:?}"),
		}

		self.db.create_service(&mut svc)?;
		if !seed.is_empty() {
			let vars: Vec<EnvVar> =
				seed.into_iter().map(|v| EnvVar { key: v.key, value: v.value, is_secret: v.secret, ..Default::default() }).collect();
			if let Err(err) = self.set_service_variables(&svc.id, &vars) {
				// A database without its credentials cannot start, and the row
				// would be a trap rather than a service.
				let _ = self.db.delete_service(&svc.id);
				return Err(err.context("store database credentials"));
			}
		}
		if let Err(err) = self.write_overlay(env) {
			let _ = self.db.delete_service(&svc.id);
			return Err(err);
		}
		Ok(svc)
	}

	/// Writes src into an environment under a new name, with the variables it
	/// cannot start without. The git credential travels encrypted as it is,
	/// since the same manager holds the key.
	pub(super) fn copy_service(&self, src: &Service, env: &Environment, name: &str) -> Result<Service> {
		let name = name.trim();
		security::validate_service_name(name)?;
		if self.db.service_by_name(&env.id, name).is_ok() {
			bail!("this environment already has a service named {name:?}");
		}
		let vars = self.service_variables(&src.id)?;
		// The copy cannot answer to the container name the original already
		// holds, so it takes the one its own environment would have given it.
		let container = self.container_name(env, name, "")?;

		let mut copied = Service {
			id: database::new_id(),
			project_id: env.project_id.clone(),
			environment_id: env.id.clone(),
			compose_service_name: name.into(),
			container_name: container,
			..src.clone()
		};
		self.db.create_service(&mut copied)?;
		if let Err(err) = self.set_service_variables(&copied.id, &vars) {
			let _ = self.db.delete_service(&copied.id);
			return Err(err);
		}
		Ok(copied)
	}

	/// Copies a service under a new name, with its variables and its scheduled
	/// tasks. Not its volumes, so the copy starts on empty data, and not its
	/// domains, since a hostname answers in one place only.
	pub fn duplicate_service(&self, src: &Service, env: &Environment, name: &str) -> Result<Service> {
		let copied = self.copy_service(src, env, name)?;
		let result = (|| {
			for mut task in self.db.scheduled_tasks_by_service(&src.id)? {
				task.service_id = copied.id.clone();
				self.db.create_scheduled_task(&mut task)?;
			}
			self.write_overlay(env)
		})();
		if let Err(err) = result {
			let _ = self.db.delete_service(&copied.id);
			return Err(err);
		}
		Ok(copied)
	}

	/// Answers whether move_service would be allowed, without touching anything,
	/// and returns the container name the service would take. The caller removes
	/// the old container before it can copy the volumes, so it has to ask first:
	/// a move rejected after that leaves the service down with nothing moved.
	pub fn check_move_service(&self, svc: &Service, from: &Environment, to: &Environment) -> Result<String> {
		if from.id == to.id {
			bail!("this service is already in that environment");
		}
		if self.db.service_by_name(&to.id, &svc.compose_service_name).is_ok() {
			bail!("the target environment already has a service named {:?}", svc.compose_service_name);
		}
		self.container_name(to, &svc.compose_service_name, "")
	}

	/// Hands a service to another environment: the row changes owner, the
	/// container takes the name that environment would give it, the git checkout
	/// follows on disk and both overlays are rewritten. Copying the volume data
	/// and removing the old container are the caller's job; both need docker.
	pub fn move_service(&self, svc: &mut Service, from: &Environment, to: &Environment, container: &str) -> Result<()> {
		security::create_dir_mode(std::path::Path::new(&format!("{}/{SERVICES_DIR_NAME}", self.cfg.project_dir(&to.id))), 0o750)?;
		// The row moves before anything on disk does: a rename and a delete that
		// ran against a move the database then refused would leave the source
		// overlay pointing at an env_file nothing can recreate.
		svc.project_id = to.project_id.clone();
		svc.environment_id = to.id.clone();
		svc.container_name = container.into();
		self.db.move_service(svc)?;
		ignore_missing(std::fs::rename(self.service_dir(from, &svc.compose_service_name), self.service_dir(to, &svc.compose_service_name)))
			.context("move the service directory")?;
		ignore_missing(std::fs::remove_file(self.service_env_file_path(from, &svc.compose_service_name)))?;
		self.write_overlay(from)?;
		self.write_overlay(to)?;
		Ok(())
	}

	/// Names the volumes a service's compose body declares, before compose
	/// prefixes each of them with the environment's compose project name.
	pub fn service_volumes(&self, env: &Environment, svc: &Service) -> Result<Vec<String>> {
		// A service nobody configured yet has no body to render.
		if svc.provider == database::PROVIDER_UNCONFIGURED {
			return Ok(Vec::new());
		}
		let vars = self.service_variables(&svc.id)?;
		let (_, volumes) = self.render_service(env, svc, &vars)?;
		Ok(volumes)
	}

	/// Drops a managed service and rewrites the overlay without it. Removing its
	/// container is the caller's job. The named volume is deliberately left
	/// behind: deleting a database's data is a separate, explicit act. The row's
	/// secrets go with it, so a generated password does not outlive the delete.
	pub fn delete_service(&self, svc: &Service, env: &Environment) -> Result<()> {
		self.db.delete_service(&svc.id)?;
		ignore_missing(std::fs::remove_file(self.service_env_file_path(env, &svc.compose_service_name)))?;
		self.write_overlay(env)?;
		Ok(())
	}
}

pub(super) fn ignore_missing(result: std::io::Result<()>) -> std::io::Result<()> {
	match result {
		Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(()),
		other => other,
	}
}
