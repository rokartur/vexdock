//! The REST API. Nginx is the only thing in front of it; the manager itself
//! never listens on a public interface.

mod access;
mod auth_handlers;
mod deployment_handlers;
mod docker_handlers;
mod domain_handlers;
mod engine_handlers;
mod environment_handlers;
mod git_provider_handlers;
mod oauth_handlers;
mod project_handlers;
mod respond;
mod routing_handlers;
mod service_handlers;
mod sse;
mod studio_handlers;
mod system_handlers;
mod task_handlers;
mod template_handlers;
mod terminal_handlers;
#[cfg(test)]
mod tests;
mod webhook_handlers;

use std::str::FromStr;
use std::sync::Arc;
use std::time::Instant;

use axum::Router;
use axum::extract::{DefaultBodyLimit, Request};
use axum::handler::Handler;
use axum::http::{HeaderValue, Method, StatusCode};
use axum::middleware::{Next, from_fn, from_fn_with_state};
use axum::response::{IntoResponse, Response};
use axum::routing::{MethodFilter, on};
use futures::FutureExt;

use self::access::{Access, Guard, ProjectOf};
use self::respond::ApiError;
use crate::auth::Auth;
use crate::backup::Backup;
use crate::certificates::Issuer;
use crate::config::Config;
use crate::database::Db;
use crate::deployments::Engine;
use crate::docker::Docker;
use crate::domains::Domains;
use crate::events::Bus;
use crate::nginx::Nginx;
use crate::projects::Projects;
use crate::schedule;
use crate::security::Cipher;
use crate::updater::Updater;

pub use self::access::Caller;

/// A JSON body larger than this is refused before it is parsed.
const BODY_LIMIT: usize = 2 << 20;

const READ: &str = crate::database::ACCESS_READ;
const WRITE: &str = crate::database::ACCESS_WRITE;

/// Everything the API needs, one field per subsystem.
pub struct Server {
	pub cfg: Arc<Config>,
	pub db: Arc<Db>,
	pub auth: Arc<Auth>,
	pub projects: Arc<Projects>,
	pub domains: Arc<Domains>,
	pub deployments: Arc<Engine>,
	pub docker: Arc<Docker>,
	pub nginx: Arc<Nginx>,
	pub certs: Arc<Issuer>,
	pub bus: Arc<Bus>,
	pub updater: Arc<Updater>,
	pub backups: Arc<Backup>,
	pub tasks: Arc<schedule::Runner>,
	pub cipher: Arc<Cipher>,
	/// OAuth authorization codes waiting to be exchanged.
	pub codes: oauth_handlers::AuthCodes,
}

/// Where releases, the compose file and the images come from. One constant so
/// an update never looks for a release somewhere other than the compose file
/// it is about to apply.
pub const REPO_SLUG: &str = "rokartur/vexdock";

impl Server {
	/// Wires every subsystem from the four things that come from outside.
	pub fn new(cfg: Arc<Config>, db: Arc<Db>, docker: Arc<Docker>, cipher: Arc<Cipher>) -> Arc<Server> {
		let bus = Bus::new();
		let nginx = Arc::new(Nginx::new(format!("{}/generated", cfg.nginx_dir), cfg.nginx_container.clone(), Arc::clone(&docker)));
		let certs = Arc::new(Issuer::new(
			cfg.certificates_dir.clone(),
			format!("{}/acme-challenge", cfg.nginx_dir),
			cfg.acme_directory.clone(),
			cfg.acme_email.clone(),
		));
		let auth = Arc::new(Auth::new(Arc::clone(&db), cfg.auth_database_path()));
		let projects = Arc::new(Projects::new(Arc::clone(&db), Arc::clone(&cfg), Arc::clone(&cipher)));
		let domains =
			Arc::new(Domains::new(Arc::clone(&db), Arc::clone(&cfg), Arc::clone(&docker), Arc::clone(&nginx), Arc::clone(&certs)));
		let deployments = Engine::new(
			Arc::clone(&db),
			Arc::clone(&cfg),
			Arc::clone(&projects),
			Arc::clone(&domains),
			Arc::clone(&docker),
			Arc::clone(&bus),
		);
		let backups = Arc::new(Backup::new(Arc::clone(&cfg), Arc::clone(&db), Arc::clone(&docker)));
		let updater = Arc::new(Updater::new(Arc::clone(&cfg), Arc::clone(&backups), REPO_SLUG));
		let tasks = schedule::Runner::new(Arc::clone(&db), Arc::clone(&docker));
		Arc::new(Server {
			cfg,
			db,
			auth,
			projects,
			domains,
			deployments,
			docker,
			nginx,
			certs,
			bus,
			updater,
			backups,
			tasks,
			cipher,
			codes: oauth_handlers::AuthCodes::default(),
		})
	}
}

/// Builds the router. Routes marked Public are open; the rest go through a
/// guard (access.rs) and need a session cookie or a bearer API token.
pub fn router(s: Arc<Server>) -> Router {
	let routes = Routes { router: Router::new(), server: Arc::clone(&s) }
		.route("GET /api/health", Public, system_handlers::health)
		.route("GET /api/system/version", Public, system_handlers::version)
		.route("POST /api/deploy/{provider}", Public, webhook_handlers::provider_webhook)
		.route("GET /api/oauth/authorize", Admin, oauth_handlers::oauth_authorize_check)
		.route("POST /api/oauth/authorize", Admin, oauth_handlers::oauth_authorize)
		.route("GET /api/me", SignedIn, auth_handlers::me)
		.route("GET /api/projects", SignedIn, project_handlers::list_projects)
		.route("POST /api/projects", Admin, project_handlers::create_project)
		.route("GET /api/projects/{id}", Project(READ, ProjectOf::Path), project_handlers::get_project)
		.route("PATCH /api/projects/{id}", Project(WRITE, ProjectOf::Path), project_handlers::update_project)
		.route("DELETE /api/projects/{id}", Admin, project_handlers::delete_project)
		.route("POST /api/projects/{id}/deploy", Project(WRITE, ProjectOf::Path), project_handlers::deploy)
		.route("POST /api/projects/{id}/redeploy", Project(WRITE, ProjectOf::Path), project_handlers::deploy)
		.route("POST /api/projects/{id}/stop", Project(WRITE, ProjectOf::Path), project_handlers::stop_project)
		.route("GET /api/projects/{id}/variables", Project(WRITE, ProjectOf::Path), project_handlers::get_project_variables)
		.route("PUT /api/projects/{id}/variables", Project(WRITE, ProjectOf::Path), project_handlers::put_project_variables)
		.route("GET /api/projects/{id}/environments", Project(READ, ProjectOf::Path), environment_handlers::list_environments)
		.route("POST /api/projects/{id}/environments", Project(WRITE, ProjectOf::Path), environment_handlers::create_environment)
		.route("GET /api/projects/{id}/services", Project(READ, ProjectOf::Path), project_handlers::list_services)
		.route("POST /api/projects/{id}/services", Project(WRITE, ProjectOf::Path), service_handlers::create_service)
		.route("POST /api/projects/{id}/services/template", Project(WRITE, ProjectOf::Path), template_handlers::create_from_template)
		.route("GET /api/projects/{id}/services/export", Project(WRITE, ProjectOf::Path), project_handlers::export_services)
		.route("GET /api/projects/{id}/deployments", Project(READ, ProjectOf::Path), project_handlers::list_deployments)
		.route("GET /api/projects/{id}/domains", Project(READ, ProjectOf::Path), project_handlers::list_project_domains)
		.route("GET /api/services/{id}", Project(READ, ProjectOf::Service), service_handlers::get_service)
		.route("PATCH /api/services/{id}", Project(WRITE, ProjectOf::Service), service_handlers::update_service)
		.route("DELETE /api/services/{id}", Project(WRITE, ProjectOf::Service), service_handlers::delete_service)
		.route("POST /api/services/{id}/duplicate", Project(WRITE, ProjectOf::Service), service_handlers::duplicate_service)
		.route("POST /api/services/{id}/move", Project(WRITE, ProjectOf::Service), service_handlers::move_service)
		.route("GET /api/services/{id}/database", Project(WRITE, ProjectOf::Service), engine_handlers::service_database)
		.route("GET /api/services/{id}/studio", Project(WRITE, ProjectOf::Service), studio_handlers::studio_schema)
		.route("GET /api/services/{id}/studio/rows", Project(WRITE, ProjectOf::Service), studio_handlers::studio_rows)
		.route("POST /api/services/{id}/studio/changes", Project(WRITE, ProjectOf::Service), studio_handlers::studio_changes)
		.route("POST /api/services/{id}/studio/query", Project(WRITE, ProjectOf::Service), studio_handlers::studio_query)
		.route("GET /api/services/{id}/variables", Project(WRITE, ProjectOf::Service), service_handlers::get_service_environment)
		.route("PUT /api/services/{id}/variables", Project(WRITE, ProjectOf::Service), service_handlers::put_service_environment)
		.route("POST /api/services/{id}/deploy", Project(WRITE, ProjectOf::Service), service_handlers::deploy_service)
		.route("POST /api/services/{id}/start", Project(WRITE, ProjectOf::Service), service_handlers::service_action)
		.route("POST /api/services/{id}/stop", Project(WRITE, ProjectOf::Service), service_handlers::service_action)
		.route("POST /api/services/{id}/restart", Project(WRITE, ProjectOf::Service), service_handlers::service_action)
		.route("GET /api/services/{id}/logs", Project(READ, ProjectOf::Service), service_handlers::service_logs)
		.route("GET /api/services/{id}/stats", Project(READ, ProjectOf::Service), service_handlers::service_stats)
		.route("GET /api/services/{id}/metrics", Project(READ, ProjectOf::Service), service_handlers::service_metrics)
		.route("GET /api/services/{id}/terminal", Project(WRITE, ProjectOf::Service), terminal_handlers::terminal)
		.route("POST /api/services/{id}/exec", Project(WRITE, ProjectOf::Service), terminal_handlers::exec)
		.route("GET /api/services/{id}/tasks", Project(READ, ProjectOf::Service), task_handlers::list_service_tasks)
		.route("POST /api/services/{id}/tasks", Project(WRITE, ProjectOf::Service), task_handlers::create_service_task)
		.route("GET /api/services/{id}/redirects", Project(READ, ProjectOf::Service), routing_handlers::list_service_redirects)
		.route("POST /api/services/{id}/redirects", Project(WRITE, ProjectOf::Service), routing_handlers::create_service_redirect)
		.route(
			"DELETE /api/services/{id}/redirects/{redirectId}",
			Project(WRITE, ProjectOf::Service),
			routing_handlers::delete_service_redirect,
		)
		.route("GET /api/services/{id}/basic-auth", Project(WRITE, ProjectOf::Service), routing_handlers::list_service_basic_auth)
		.route("POST /api/services/{id}/basic-auth", Project(WRITE, ProjectOf::Service), routing_handlers::create_service_basic_auth)
		.route(
			"DELETE /api/services/{id}/basic-auth/{userId}",
			Project(WRITE, ProjectOf::Service),
			routing_handlers::delete_service_basic_auth,
		)
		.route("GET /api/services/{id}/ports", Project(READ, ProjectOf::Service), routing_handlers::list_service_ports)
		.route("POST /api/services/{id}/ports", Project(WRITE, ProjectOf::Service), routing_handlers::create_service_port)
		.route("DELETE /api/services/{id}/ports/{portId}", Project(WRITE, ProjectOf::Service), routing_handlers::delete_service_port)
		.route("GET /api/tasks", SignedIn, task_handlers::list_all_tasks)
		.route("PATCH /api/tasks/{id}", Project(WRITE, ProjectOf::Task), task_handlers::update_task)
		.route("DELETE /api/tasks/{id}", Project(WRITE, ProjectOf::Task), task_handlers::delete_task)
		.route("POST /api/tasks/{id}/run", Project(WRITE, ProjectOf::Task), task_handlers::run_task)
		.route("GET /api/tasks/{id}/runs", Project(READ, ProjectOf::Task), task_handlers::task_runs)
		.route("GET /api/environments/{id}", Project(READ, ProjectOf::Environment), environment_handlers::get_environment)
		.route("PATCH /api/environments/{id}", Project(WRITE, ProjectOf::Environment), environment_handlers::update_environment)
		.route("DELETE /api/environments/{id}", Project(WRITE, ProjectOf::Environment), environment_handlers::delete_environment)
		.route(
			"GET /api/environments/{id}/variables",
			Project(WRITE, ProjectOf::Environment),
			environment_handlers::get_environment_variables,
		)
		.route(
			"PUT /api/environments/{id}/variables",
			Project(WRITE, ProjectOf::Environment),
			environment_handlers::put_environment_variables,
		)
		.route("GET /api/domains", SignedIn, domain_handlers::list_domains)
		.route("POST /api/domains", Project(WRITE, ProjectOf::Body), domain_handlers::create_domain)
		.route("PATCH /api/domains/{id}", Project(WRITE, ProjectOf::Domain), domain_handlers::update_domain)
		.route("DELETE /api/domains/{id}", Project(WRITE, ProjectOf::Domain), domain_handlers::delete_domain)
		.route("POST /api/domains/{id}/certificate", Project(WRITE, ProjectOf::Domain), domain_handlers::issue_certificate)
		.route("GET /api/deployments/{id}", Project(READ, ProjectOf::Deployment), deployment_handlers::get_deployment)
		.route("GET /api/deployments/{id}/events", Project(READ, ProjectOf::Deployment), deployment_handlers::deployment_events)
		.route("POST /api/deployments/{id}/cancel", Project(WRITE, ProjectOf::Deployment), deployment_handlers::cancel_deployment)
		.route("POST /api/deployments/{id}/rollback", Project(WRITE, ProjectOf::Deployment), deployment_handlers::rollback)
		.route("GET /api/docker/containers", Admin, docker_handlers::list_containers)
		.route("POST /api/docker/containers/{id}/{action}", Admin, docker_handlers::container_action_route)
		.route("GET /api/docker/containers/{id}/logs", Admin, service_handlers::container_logs)
		.route("GET /api/docker/images", Admin, docker_handlers::list_images)
		.route("POST /api/docker/images/pull", Admin, docker_handlers::pull_image)
		.route("DELETE /api/docker/images/{id}", Admin, docker_handlers::remove_image)
		.route("GET /api/docker/volumes", Admin, docker_handlers::list_volumes)
		.route("DELETE /api/docker/volumes/{name}", Admin, docker_handlers::remove_volume)
		.route("GET /api/docker/networks", Admin, docker_handlers::list_networks)
		.route("GET /api/docker/cleanup", Admin, docker_handlers::cleanup_preview)
		.route("POST /api/docker/cleanup/{kind}", Admin, docker_handlers::cleanup)
		.route("GET /api/registries", Admin, system_handlers::list_registries)
		.route("POST /api/registries", Admin, system_handlers::create_registry)
		.route("DELETE /api/registries/{id}", Admin, system_handlers::delete_registry)
		.route("GET /api/git-providers", Admin, git_provider_handlers::list_git_providers)
		.route("GET /api/git-providers/{id}", Admin, git_provider_handlers::get_git_provider)
		.route("PATCH /api/git-providers/{id}", Admin, git_provider_handlers::rename_git_provider)
		.route("DELETE /api/git-providers/{id}", Admin, git_provider_handlers::delete_git_provider)
		.route("GET /api/git-providers/{id}/repositories", Admin, git_provider_handlers::git_provider_repositories)
		.route("GET /api/git-providers/{id}/branches", Admin, git_provider_handlers::git_provider_branches)
		.route("POST /api/git-providers/github", Admin, git_provider_handlers::create_github_provider)
		.route("POST /api/git-providers/gitlab", Admin, git_provider_handlers::save_gitlab_provider)
		.route("PUT /api/git-providers/{id}/gitlab", Admin, git_provider_handlers::save_gitlab_provider)
		.route("POST /api/git-providers/bitbucket", Admin, git_provider_handlers::save_bitbucket_provider)
		.route("PUT /api/git-providers/{id}/bitbucket", Admin, git_provider_handlers::save_bitbucket_provider)
		.route("POST /api/git-providers/gitea", Admin, git_provider_handlers::save_gitea_provider)
		.route("PUT /api/git-providers/{id}/gitea", Admin, git_provider_handlers::save_gitea_provider)
		.route("GET /api/providers/github/callback", Admin, git_provider_handlers::github_callback)
		.route("GET /api/providers/github/installed", Admin, git_provider_handlers::github_installed)
		.route("GET /api/providers/{provider}/callback", Admin, git_provider_handlers::oauth_callback)
		.route("GET /api/tokens", Admin, auth_handlers::list_tokens)
		.route("POST /api/tokens", Admin, auth_handlers::create_token)
		.route("DELETE /api/tokens/{id}", Admin, auth_handlers::delete_token)
		.route("GET /api/templates", SignedIn, template_handlers::list_templates)
		.route("GET /api/engines", SignedIn, engine_handlers::list_engines)
		.route("GET /api/engines/{slug}/versions", SignedIn, engine_handlers::engine_versions)
		.route("GET /api/system/info", Admin, system_handlers::system_info)
		.route("GET /api/system/stats", Admin, system_handlers::system_stats)
		.route("GET /api/system/metrics", Admin, system_handlers::system_metrics)
		.route("GET /api/system/events", Admin, system_handlers::system_events)
		.route("GET /api/system/settings", Admin, system_handlers::get_settings)
		.route("PUT /api/system/settings", Admin, system_handlers::put_settings)
		.route("GET /api/system/certificates", Admin, domain_handlers::list_certificates)
		.route("POST /api/system/backup", Admin, system_handlers::backup)
		.route("GET /api/system/backups", Admin, system_handlers::list_backups)
		.route("DELETE /api/system/backups/{name}", Admin, system_handlers::delete_backup)
		.route("PUT /api/system/version", Admin, system_handlers::put_version_settings)
		.route("POST /api/system/version/check", Admin, system_handlers::version_check)
		.route("POST /api/system/update", Admin, system_handlers::update)
		.route("GET /api/system/update/status", Admin, system_handlers::update_status);
	oauth_handlers::public_routes(routes.router)
		.fallback(|| async { respond::not_found() })
		.layer(DefaultBodyLimit::max(BODY_LIMIT))
		.layer(from_fn(request_logger))
		.layer(from_fn(recover_panics))
		.with_state(s)
}

struct Routes {
	router: Router<Arc<Server>>,
	server: Arc<Server>,
}

impl Routes {
	/// Registers one "METHOD /path" with its access level.
	fn route<H, T>(mut self, spec: &str, access: Access, handler: H) -> Self
	where
		H: Handler<T, Arc<Server>>,
		T: 'static,
	{
		let (method, path) = spec.split_once(' ').expect("route spec is METHOD /path");
		let filter = MethodFilter::try_from(Method::from_str(method).expect("valid method")).expect("routable method");
		let mut endpoint = on(filter, handler);
		if !matches!(access, Access::Public) {
			endpoint = endpoint.route_layer(from_fn_with_state(Guard { server: Arc::clone(&self.server), access }, access::guard));
		}
		self.router = self.router.route(path, endpoint);
		self
	}
}

use Access::{Admin, Project, Public, SignedIn};

/// One structured line per request, with a request id.
async fn request_logger(req: Request, next: Next) -> Response {
	let start = Instant::now();
	let request_id = crate::security::random_token(8);
	let (method, path) = (req.method().clone(), req.uri().path().to_string());
	let mut resp = next.run(req).await;
	if let Ok(value) = HeaderValue::from_str(&request_id) {
		resp.headers_mut().insert("x-request-id", value);
	}
	tracing::info!(request_id, %method, path, status = resp.status().as_u16(), duration_ms = start.elapsed().as_millis() as u64, "request");
	resp
}

/// Keeps one bad handler from taking the connection down with it.
async fn recover_panics(req: Request, next: Next) -> Response {
	let path = req.uri().path().to_string();
	match std::panic::AssertUnwindSafe(next.run(req)).catch_unwind().await {
		Ok(resp) => resp,
		Err(panic) => {
			let message = panic.downcast_ref::<&str>().map(|s| s.to_string()).or_else(|| panic.downcast_ref::<String>().cloned());
			tracing::error!(path, panic = message.unwrap_or_default(), "panic recovered");
			ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL", "Internal server error").into_response()
		}
	}
}
