//! The deploy pipeline: one environment at a time, every step persisted, every
//! line streamed to the browser over SSE.

use std::collections::HashMap;
use std::io::Write;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use serde::Serialize;
use tokio::sync::{Semaphore, oneshot};

use crate::config::Config;
use crate::database::{self, Db, Deployment, DeploymentStep, Environment, Project};
use crate::docker::{self, Docker};
use crate::domains::Domains;
use crate::events::{self, Bus};
use crate::git;
use crate::projects::Projects;

// Step names, in pipeline order. Clone and checkout only appear when the
// service is cloned from a repository.
pub const STEP_CLONE: &str = "clone";
pub const STEP_CHECKOUT: &str = "checkout";
pub const STEP_VALIDATE: &str = "validate";
pub const STEP_PULL: &str = "pull";
pub const STEP_BUILD: &str = "build";
pub const STEP_START: &str = "start";
pub const STEP_HEALTHCHECK: &str = "healthcheck";
pub const STEP_PROXY: &str = "proxy";
pub const STEP_FINISH: &str = "finish";

// Triggers recorded on a deployment.
pub const TRIGGER_MANUAL: &str = "manual";
pub const TRIGGER_WEBHOOK: &str = "webhook";
pub const TRIGGER_ROLLBACK: &str = "rollback";

/// How long the pipeline waits for containers to settle.
const HEALTH_TIMEOUT: Duration = Duration::from_secs(3 * 60);

/// Bounds a whole deployment. A large image build is slow but not this slow, so
/// anything that reaches it is stuck rather than working.
const DEPLOY_TIMEOUT: Duration = Duration::from_secs(45 * 60);

/// How many environments deploy at once. Each pipeline spawns a git and a
/// compose process and a build on top, so on the 1 GB host the installer
/// accepts, three at once is an OOM kill of the applications already running.
const MAX_CONCURRENT: usize = 2;

/// Bounds the live buffer, not only what close_step stores: a build streaming
/// progress for the whole deploy timeout would otherwise sit in the heap.
const STEP_OUTPUT_LIMIT: usize = 64 * 1024;

pub struct Engine {
	db: Arc<Db>,
	cfg: Arc<Config>,
	projects: Arc<Projects>,
	domains: Arc<Domains>,
	docker: Arc<Docker>,
	bus: Arc<Bus>,
	// ponytail: in-process locks, sufficient while the manager is a single process.
	locks: Mutex<HashMap<String, Arc<tokio::sync::Mutex<()>>>>,
	cancels: Mutex<HashMap<String, oneshot::Sender<()>>>,
	/// The global concurrency cap; a pipeline holds a permit from the moment it
	/// starts work until it finishes.
	slots: Semaphore,
}

/// One deployment request.
#[derive(Clone, Debug, Default)]
pub struct Options {
	pub trigger: String,
	pub actor: String,
	/// Pins the checkout, used by rollback. Empty means the branch head.
	pub commit_sha: String,
	/// The compose service this deploy runs for. Deploying a whole environment
	/// is one deployment per service.
	pub service_name: String,
}

/// The deployment was withdrawn, queued or running.
#[derive(Debug, thiserror::Error)]
#[error("cancelled")]
pub struct Cancelled;

impl Engine {
	pub fn new(
		db: Arc<Db>,
		cfg: Arc<Config>,
		projects: Arc<Projects>,
		domains: Arc<Domains>,
		docker: Arc<Docker>,
		bus: Arc<Bus>,
	) -> Arc<Engine> {
		Arc::new(Engine {
			db,
			cfg,
			projects,
			domains,
			docker,
			bus,
			locks: Mutex::default(),
			cancels: Mutex::default(),
			slots: Semaphore::new(MAX_CONCURRENT),
		})
	}

	/// Marks deployments that were in flight when the manager stopped as
	/// failed, so the UI never shows a pipeline that nothing is running.
	pub fn recover_interrupted(&self) -> Result<()> {
		for mut d in self.db.unfinished_deployments()? {
			d.status = database::DEPLOYMENT_FAILED.into();
			d.error = "interrupted by a manager restart".into();
			d.finished_at = database::now();
			self.db.update_deployment(&d)?;
		}
		Ok(())
	}

	/// Enqueues a deployment and returns immediately; the pipeline runs in the
	/// background so the HTTP request is never held open by a build.
	pub fn trigger(self: &Arc<Self>, project: &Project, env: &Environment, opts: Options) -> Result<Deployment> {
		if opts.service_name.is_empty() {
			bail!("a deployment needs a service to deploy");
		}
		// An environment can pin a branch of its own, overriding what each
		// service asks for; staging deploying main is the default, not a rule.
		let reference = if opts.commit_sha.is_empty() { env.branch.clone() } else { opts.commit_sha.clone() };
		let mut d = Deployment {
			project_id: project.id.clone(),
			environment_id: env.id.clone(),
			service_name: opts.service_name,
			branch: reference.clone(),
			status: database::DEPLOYMENT_QUEUED.into(),
			trigger: opts.trigger,
			created_by: opts.actor,
			commit_sha: opts.commit_sha,
			..Default::default()
		};
		self.db.create_deployment(&mut d)?;
		self.bus.publish(events::TOPIC_SYSTEM, "deployment.queued", &d);
		let engine = Arc::clone(self);
		let (environment_id, deployment_id) = (env.id.clone(), d.id.clone());
		tokio::spawn(async move { engine.run(&environment_id, &deployment_id, &reference).await });
		Ok(d)
	}

	/// Stops a queued or running deployment. Dropping the pipeline's future
	/// kills compose and git rather than leaving them orphaned.
	pub fn cancel(&self, deployment_id: &str) -> Result<()> {
		let cancel = self.cancels.lock().unwrap().remove(deployment_id);
		match cancel {
			Some(cancel) => {
				let _ = cancel.send(());
				Ok(())
			}
			None => bail!("deployment is not queued or running"),
		}
	}

	/// The per-environment lock: the same environment never deploys twice at
	/// once, a queued deployment waits here. Production and staging own
	/// separate directories and containers, so they deploy side by side.
	fn lock_for(&self, environment_id: &str) -> Arc<tokio::sync::Mutex<()>> {
		Arc::clone(self.locks.lock().unwrap().entry(environment_id.to_string()).or_default())
	}

	async fn run(&self, environment_id: &str, deployment_id: &str, reference: &str) {
		// Cancellable from the moment it is queued, so a deployment waiting on
		// the lock can be withdrawn instead of running once the lock frees up.
		let (cancel, cancelled) = oneshot::channel();
		self.cancels.lock().unwrap().insert(deployment_id.to_string(), cancel);
		let mut p = Pipeline::new(self, deployment_id, reference);
		let outcome = tokio::select! {
			result = self.run_locked(&mut p, environment_id) => result,
			_ = cancelled => Err(Cancelled.into()),
		};
		self.cancels.lock().unwrap().remove(deployment_id);
		p.finish(outcome);
	}

	async fn run_locked(&self, p: &mut Pipeline<'_>, environment_id: &str) -> Result<()> {
		let lock = self.lock_for(environment_id);
		let _environment = lock.lock().await;
		// The slot comes after the environment lock, so a deployment queued
		// behind its own environment holds no slot another one could use.
		let _slot = self.slots.acquire().await?;
		// The clock starts once the pipeline owns the lock and a slot: a wedged
		// clone or pull would otherwise hold the lock forever.
		match tokio::time::timeout(DEPLOY_TIMEOUT, p.execute()).await {
			Ok(result) => result,
			Err(_) => Err(anyhow!("deployment timed out after {} minutes", DEPLOY_TIMEOUT.as_secs() / 60)),
		}
	}
}

/// The state of one running deployment.
struct Pipeline<'a> {
	e: &'a Engine,
	deployment_id: String,
	reference: String,
	deployment: Option<Deployment>,
	project: Project,
	environment: Environment,
	/// The compose service this deploy runs for.
	target: String,
	position: i64,
	current: Option<DeploymentStep>,
	buf: Vec<u8>,
	truncated: bool,
}

#[derive(Serialize)]
struct LogLine<'a> {
	step: &'a str,
	text: &'a str,
	at: String,
}

impl<'a> Pipeline<'a> {
	fn new(e: &'a Engine, deployment_id: &str, reference: &str) -> Pipeline<'a> {
		Pipeline {
			e,
			deployment_id: deployment_id.into(),
			reference: reference.into(),
			deployment: None,
			project: Project::default(),
			environment: Environment::default(),
			target: String::new(),
			position: 0,
			current: None,
			buf: Vec::new(),
			truncated: false,
		}
	}

	async fn execute(&mut self) -> Result<()> {
		let mut deployment = self.e.db.deployment_by_id(&self.deployment_id)?;
		self.project = self.e.db.project_by_id(&deployment.project_id)?;
		self.environment = self.e.db.environment_by_id(&deployment.environment_id)?;
		self.target = deployment.service_name.clone();
		deployment.status = database::DEPLOYMENT_RUNNING.into();
		deployment.started_at = database::now();
		self.e.db.update_deployment(&deployment)?;
		self.publish("deployment.started", &deployment);
		self.deployment = Some(deployment);

		// The checkout has to exist before compose resolves the build context.
		self.checkout().await?;

		let compose_project = self.e.projects.compose_project(&self.project, &self.environment);
		self.begin(STEP_VALIDATE);
		let compose_project = self.check(compose_project)?;
		let cfg = self.check(compose_project.validate().await)?;
		let Some(service) = cfg.services.get(&self.target) else {
			return Err(self.fail(anyhow!("compose has no service {:?}", self.target)));
		};
		let builds = service.build.is_some();
		self.printf(&format!("Compose is valid; deploying service {}", self.target));
		self.complete();

		self.begin(STEP_PULL);
		let login = self.registry_login().await;
		self.check(login)?;
		let target = self.target.clone();
		if let Err(err) = compose_project.pull(self, &target).await {
			// A service that builds its own image can survive a failed pull of its
			// bases; one that only names an image cannot, and letting it through
			// redeploys the stale local copy and records a success.
			if !builds {
				return Err(self.fail(err));
			}
			self.printf(&format!("pull reported: {err:#}"));
		}
		self.complete();

		self.begin(STEP_BUILD);
		if builds {
			let built = compose_project.build(self, &target).await;
			self.check(built)?;
			self.prune_build_cache().await;
		} else {
			self.printf(&format!("{target} declares no build context, skipping"));
		}
		self.complete();

		self.begin(STEP_START);
		let up = compose_project.up(self, &target).await;
		self.check(up)?;
		self.complete();

		self.begin(STEP_HEALTHCHECK);
		let healthy = self.wait_healthy().await;
		self.check(healthy)?;
		self.complete();

		self.begin(STEP_PROXY);
		let reconciled = self.e.domains.reconcile().await;
		self.check(reconciled)?;
		self.printf("Proxy configuration reconciled");
		self.complete();
		Ok(())
	}

	/// Syncs the repository of the service being deployed and records the
	/// commit it landed on. Skipped when the service does not come from a repository.
	async fn checkout(&mut self) -> Result<()> {
		let services = self.e.db.list_services(&self.environment.id);
		let services = services.inspect_err(|_| self.begin(STEP_CLONE));
		let services = self.check(services)?;
		let Some(svc) = services.into_iter().rfind(|s| s.compose_service_name == self.target && database::clones_from_git(&s.provider))
		else {
			return Ok(());
		};

		self.begin(STEP_CLONE);
		let source = self.e.projects.git_source_for(&svc).await;
		let source = self.check(source)?;
		let reference = if self.reference.is_empty() { svc.branch.clone() } else { self.reference.clone() };
		let repo = git::Repo {
			url: source.url.clone(),
			reference: reference.clone(),
			dir: format!("{}/repository", self.e.projects.service_dir(&self.environment, &svc.compose_service_name)),
			cred: source.cred,
			known_hosts: format!("{}/known_hosts", self.e.cfg.secrets_dir),
		};
		self.printf(&format!("Fetching {} @ {reference} for service {}", source.url, svc.compose_service_name));
		let sha = repo.sync(self).await;
		let sha = self.check(sha)?;
		self.complete();

		self.begin(STEP_CHECKOUT);
		self.printf(&format!("{} checked out at {}", svc.compose_service_name, short(&sha)));
		let deployment = self.deployment.as_mut().expect("execute loaded the deployment");
		deployment.commit_sha = sha;
		let updated = self.e.db.update_deployment(deployment);
		self.check(updated)?;
		self.complete();
		Ok(())
	}

	async fn registry_login(&mut self) -> Result<()> {
		let svc = self.e.db.service_by_name(&self.environment.id, &self.target)?;
		if svc.registry_username.is_empty() {
			return Ok(());
		}
		let registry = if svc.registry_url.is_empty() { "Docker Hub" } else { &svc.registry_url };
		self.printf(&format!("Logging in to {registry} as {}", svc.registry_username));
		self.e.projects.registry_login(&svc).await
	}

	/// Sweeps dangling build cache when the service asks for it. The image is
	/// already built, so a failed sweep is a log line rather than a failed deploy.
	async fn prune_build_cache(&mut self) {
		let svc = match self.e.db.service_by_name(&self.environment.id, &self.target) {
			Ok(svc) => svc,
			Err(err) => return self.printf(&format!("build cache cleanup skipped: {err:#}")),
		};
		if !svc.prune_build_cache {
			return;
		}
		match self.e.docker.prune_dangling_build_cache().await {
			Ok(report) => {
				self.printf(&format!("Build cache cleanup removed {} records, freeing {} MB", report.removed, report.freed >> 20))
			}
			Err(err) => self.printf(&format!("build cache cleanup failed: {err:#}")),
		}
	}

	/// Polls the target's containers until they are running and, when a
	/// healthcheck is declared, until Docker reports them healthy.
	async fn wait_healthy(&mut self) -> Result<()> {
		let deadline = tokio::time::Instant::now() + HEALTH_TIMEOUT;
		loop {
			let containers: Vec<_> = self
				.e
				.docker
				.list_containers(&self.environment.compose_project_name)
				.await?
				.into_iter()
				.filter(|c| c.labels.as_ref().and_then(|l| l.get(docker::COMPOSE_SERVICE_LABEL)) == Some(&self.target))
				.collect();
			if containers.is_empty() {
				bail!("compose started no container for service {}", self.target);
			}
			let mut pending = Vec::new();
			for c in containers {
				let name = self.target.clone();
				let Ok(info) = self.e.docker.inspect(c.id.as_deref().unwrap_or_default()).await else {
					pending.push(name);
					continue;
				};
				let Some(state) = info.state else {
					pending.push(name);
					continue;
				};
				if let Some(health) = state.health {
					let status = health.status.map(|s| s.to_string()).unwrap_or_default();
					match status.as_str() {
						"healthy" => {}
						"unhealthy" => bail!("service {name} is unhealthy"),
						_ => pending.push(format!("{name} (health: {status})")),
					}
				} else if state.running == Some(true) {
				} else if state.restarting == Some(true) {
					pending.push(format!("{name} (restarting)"));
				} else if let Some(code) = state.exit_code.filter(|code| *code != 0) {
					bail!("service {name} exited with code {code}");
				}
				// One-shot containers that exited cleanly are acceptable.
			}
			if pending.is_empty() {
				self.printf(&format!("Service {} is healthy", self.target));
				return Ok(());
			}
			if tokio::time::Instant::now() > deadline {
				bail!("timed out waiting for: {}", pending.join(", "));
			}
			self.printf(&format!("Waiting for {}", pending.join(", ")));
			tokio::time::sleep(Duration::from_secs(3)).await;
		}
	}

	/// The one place a deployment leaves queued or running. It settles the row
	/// even when the pipeline never read it, which is what a cancel while
	/// queued looks like.
	fn finish(&mut self, outcome: Result<()>) {
		// A cancel or a timeout drops the pipeline mid-step; that step failed.
		if let Err(err) = &outcome
			&& self.current.is_some()
		{
			self.printf(&format!("ERROR: {err:#}"));
			self.close_step(database::DEPLOYMENT_FAILED);
		}
		let mut deployment = match self.deployment.take() {
			Some(d) => d,
			None => match self.e.db.deployment_by_id(&self.deployment_id) {
				Ok(d) => d,
				Err(err) => {
					tracing::error!(deployment = %self.deployment_id, error = %err, "finish deployment");
					return;
				}
			},
		};
		deployment.finished_at = database::now();
		match &outcome {
			Ok(()) => {
				deployment.status = database::DEPLOYMENT_SUCCESS.into();
				self.begin(STEP_FINISH);
				self.printf("Deployment completed");
				self.complete();
			}
			Err(err) if err.is::<Cancelled>() => {
				deployment.status = database::DEPLOYMENT_CANCELLED.into();
				deployment.error = "cancelled".into();
			}
			Err(err) => {
				deployment.status = database::DEPLOYMENT_FAILED.into();
				deployment.error = format!("{err:#}");
			}
		}
		if let Err(err) = self.e.db.update_deployment(&deployment) {
			tracing::error!(error = %err, "persist deployment result");
		}
		let kind = format!("deployment.{}", deployment.status);
		self.publish(&kind, &deployment);
		self.e.bus.publish(events::TOPIC_SYSTEM, &kind, &deployment);
		self.publish("deployment.closed", ());
	}

	/// Opens a new step, persisting it so a reloaded page shows history.
	fn begin(&mut self, name: &str) {
		self.position += 1;
		self.buf.clear();
		self.truncated = false;
		let mut step = DeploymentStep {
			deployment_id: self.deployment_id.clone(),
			position: self.position,
			name: name.into(),
			status: database::DEPLOYMENT_RUNNING.into(),
			started_at: database::now(),
			..Default::default()
		};
		if let Err(err) = self.e.db.create_step(&mut step) {
			tracing::error!(error = %err, "create deployment step");
		}
		self.publish("step.started", &step);
		self.current = Some(step);
	}

	fn complete(&mut self) {
		self.close_step(database::DEPLOYMENT_SUCCESS);
	}

	/// Fails the open step with err and hands err back for the caller to return.
	fn fail(&mut self, err: anyhow::Error) -> anyhow::Error {
		if self.current.is_some() {
			self.printf(&format!("ERROR: {err:#}"));
		}
		self.close_step(database::DEPLOYMENT_FAILED);
		err
	}

	/// Passes a value through, failing the open step on an error.
	fn check<T>(&mut self, result: Result<T>) -> Result<T> {
		result.map_err(|err| self.fail(err))
	}

	fn close_step(&mut self, status: &str) {
		let Some(mut step) = self.current.take() else {
			return;
		};
		step.status = status.into();
		step.finished_at = database::now();
		step.output = tail(&String::from_utf8_lossy(&self.buf), STEP_OUTPUT_LIMIT, self.truncated);
		if let Err(err) = self.e.db.update_step(&step) {
			tracing::error!(error = %err, "update deployment step");
		}
		self.publish(&format!("step.{status}"), &step);
	}

	/// Keeps the last STEP_OUTPUT_LIMIT bytes; the tail says why a step failed,
	/// so the head is what gets dropped.
	fn append(&mut self, b: &[u8]) {
		self.buf.extend_from_slice(b);
		if self.buf.len() > 2 * STEP_OUTPUT_LIMIT {
			self.truncated = true;
			self.buf.drain(..self.buf.len() - STEP_OUTPUT_LIMIT);
		}
	}

	fn printf(&mut self, line: &str) {
		self.append(format!("{line}\n").as_bytes());
		self.publish_line(line);
	}

	fn publish_line(&self, text: &str) {
		let step = self.current.as_ref().map_or("", |s| s.name.as_str());
		self.publish("log", LogLine { step, text, at: chrono::Utc::now().format("%Y-%m-%dT%H:%M:%SZ").to_string() });
	}

	fn publish(&self, kind: &str, data: impl Serialize) {
		self.e.bus.publish(&events::deployment_topic(&self.deployment_id), kind, data);
	}
}

/// Compose and git output streams straight into the deployment log.
impl Write for Pipeline<'_> {
	fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
		self.append(b);
		let text = String::from_utf8_lossy(b);
		for line in text.trim_end_matches('\n').split('\n') {
			if !line.trim().is_empty() {
				self.publish_line(line);
			}
		}
		Ok(b.len())
	}

	fn flush(&mut self) -> std::io::Result<()> {
		Ok(())
	}
}

fn short(sha: &str) -> &str {
	sha.get(..7).unwrap_or(sha)
}

/// The last n bytes of step output, so a chatty build cannot bloat the database.
fn tail(s: &str, n: usize, truncated: bool) -> String {
	let mut start = s.len().saturating_sub(n);
	while !s.is_char_boundary(start) {
		start += 1;
	}
	if truncated || start > 0 { format!("... truncated ...\n{}", &s[start..]) } else { s.to_string() }
}

#[cfg(test)]
mod tests;
