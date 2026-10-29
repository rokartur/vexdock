use std::collections::HashSet;
use std::sync::Arc;

use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use serde::Deserialize;
use serde_json::json;

use super::Server;
use super::environment_handlers::EnvQuery;
use super::respond::{ApiResult, bad_request, created, decode};
use crate::database::{self, Environment};
use crate::domains::CreateInput;
use crate::projects::{EnvVar, ServiceInput};
use crate::templates::{self, Variable};

/// The application catalog the template picker is built from.
pub async fn list_templates() -> ApiResult {
	super::respond::ok(&templates::CATALOG)
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct CreateFromTemplate {
	slug: String,
	hostname: String,
}

/// Installs one catalog entry into an environment: its generated values become
/// environment variables, each compose service becomes a raw service, and the
/// domain it declares points at the service that serves it. Nothing records
/// the template afterwards; the rows are ordinary from here on.
pub async fn create_from_template(
	State(s): State<Arc<Server>>,
	Path(id): Path<String>,
	Query(q): Query<EnvQuery>,
	body: Bytes,
) -> ApiResult {
	let (project, env) = s.project_env(&id, &q)?;
	let req: CreateFromTemplate = decode(&body)?;
	let rendered = templates::render(&req.slug, &req.hostname).map_err(bad_request)?;
	s.seed_template_variables(&env, &rendered.variables)?;

	let mut services = Vec::with_capacity(rendered.services.len());
	for svc in rendered.services {
		let input = ServiceInput {
			name: svc.name.to_string(),
			provider: database::PROVIDER_RAW.to_string(),
			compose_fragment: svc.fragment.to_string(),
			..Default::default()
		};
		match s.projects.create_service(&env, &input) {
			Ok(service) => services.push(service),
			Err(err) => {
				// Half a template is a stack that cannot start, so the services
				// that did land go back out rather than being found later.
				for landed in &services {
					let _ = s.projects.delete_service(landed, &env);
				}
				return Err(bad_request(format!("{}: {err:#}", svc.name)));
			}
		}
	}
	let Some(target) = rendered.domain else {
		return created(&json!({"services": services}));
	};

	let input = CreateInput {
		project_id: project.id,
		environment_id: env.id,
		service_name: target.service.to_string(),
		hostname: req.hostname,
		container_port: target.port,
		https: true,
		redirect_https: true,
		certificate_source: database::CERT_LETS_ENCRYPT.to_string(),
		..Default::default()
	};
	match s.domains.create(&input).await {
		(domain, Ok(())) => created(&json!({"services": services, "domain": domain})),
		// The services exist either way, and the certificate cannot be issued
		// before the app answers, so a failure is reported, not rolled back.
		(domain, Err(err)) => created(&json!({"services": services, "domain": domain, "warning": format!("{err:#}")})),
	}
}

impl Server {
	/// Adds a template's values to the environment. A key the environment
	/// already holds keeps its value: a second install, or a password the user
	/// has since changed, has to see it.
	fn seed_template_variables(&self, env: &Environment, vars: &[Variable]) -> anyhow::Result<()> {
		if vars.is_empty() {
			return Ok(());
		}
		let mut merged = self.projects.environment_variables(&env.id)?;
		let have: HashSet<String> = merged.iter().map(|v| v.key.clone()).collect();
		for v in vars {
			if have.contains(&v.key) {
				continue;
			}
			merged.push(EnvVar { key: v.key.clone(), value: v.value.clone(), is_secret: v.secret, ..Default::default() });
		}
		self.projects.set_environment_variables(&env.id, &merged)
	}
}
