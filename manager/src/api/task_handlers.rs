use std::collections::HashMap;
use std::sync::Arc;

use axum::Extension;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use super::respond::{ApiError, ApiResult, bad_request, created, decode, lookup, ok};
use super::{Caller, Server};
use crate::database::{self, Project, ScheduledTask, Service};
use crate::schedule::{self, AlreadyRunning};
use crate::security;

/// The writable half of a scheduled task. Every field is optional so a PATCH
/// that omits one leaves it alone; apply then validates the result, which
/// makes create and update the same check.
#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct TaskInput {
	name: Option<String>,
	description: Option<String>,
	schedule: Option<String>,
	timezone: Option<String>,
	command: Option<String>,
	shell: Option<String>,
	enabled: Option<bool>,
}

impl TaskInput {
	fn apply(self, task: &mut ScheduledTask) -> anyhow::Result<()> {
		if let Some(name) = self.name {
			task.name = name.trim().to_string();
		}
		if let Some(description) = self.description {
			task.description = description.trim().to_string();
		}
		if let Some(expr) = self.schedule {
			task.schedule = expr.trim().to_string();
		}
		if let Some(timezone) = self.timezone {
			task.timezone = timezone.trim().to_string();
		}
		if let Some(command) = self.command {
			task.command = command;
		}
		if let Some(shell) = self.shell {
			task.shell = shell;
		}
		if let Some(enabled) = self.enabled {
			task.enabled = enabled;
		}

		if task.name.is_empty() {
			anyhow::bail!("name is required");
		}
		// Free text goes to a list cell and to the error below, so it is bounded
		// here rather than left to the request body limit.
		if task.name.len() > 200 {
			anyhow::bail!("name is too long");
		}
		if task.description.len() > 500 {
			anyhow::bail!("description is too long");
		}
		if task.timezone.len() > 64 {
			anyhow::bail!("timezone is too long");
		}
		schedule::parse(&task.schedule)?;
		if schedule::location(&task.timezone).is_err() {
			anyhow::bail!("unknown timezone {}", task.timezone);
		}
		task.shell = security::validate_task_shell(&task.shell)?;
		task.command = security::validate_task_command(&task.command)?;
		Ok(())
	}
}

/// Fills in when a task fires next, the readout that tells a user their
/// expression means what they meant. A disabled task fires never, and an
/// expression the calendar never reaches leaves the field out.
fn set_next_run(task: &mut ScheduledTask, now: DateTime<Utc>) {
	task.next_run = String::new();
	if !task.enabled {
		return;
	}
	let (Ok(parsed), Ok(zone)) = (schedule::parse(&task.schedule), schedule::location(&task.timezone)) else {
		return;
	};
	// UTC like every other timestamp the API hands out.
	if let Some(next) = parsed.next(now.with_timezone(&zone)) {
		task.next_run = database::format_time(next.with_timezone(&Utc));
	}
}

/// A task with the service and project it belongs to, so a page can name and
/// link it without a request per row. Both task lists answer this shape.
#[derive(Serialize)]
struct TaskWithOwner {
	#[serde(flatten)]
	task: ScheduledTask,
	service_name: String,
	project_id: String,
	project_name: String,
}

fn with_owners(tasks: Vec<ScheduledTask>, services: &HashMap<String, Service>, projects: &HashMap<String, Project>) -> Vec<TaskWithOwner> {
	let now = Utc::now();
	let mut out = Vec::with_capacity(tasks.len());
	for mut task in tasks {
		set_next_run(&mut task, now);
		let service = services.get(&task.service_id);
		let project_id = service.map(|s| s.project_id.clone()).unwrap_or_default();
		out.push(TaskWithOwner {
			service_name: service.map(|s| s.compose_service_name.clone()).unwrap_or_default(),
			project_name: projects.get(&project_id).map(|p| p.name.clone()).unwrap_or_default(),
			project_id,
			task,
		});
	}
	out
}

pub async fn list_all_tasks(State(s): State<Arc<Server>>, Extension(caller): Extension<Caller>) -> ApiResult {
	let tasks = s.db.all_scheduled_tasks()?;
	let services: HashMap<_, _> = s.db.all_services()?.into_iter().map(|svc| (svc.id.clone(), svc)).collect();
	let projects: HashMap<_, _> = s.db.list_projects()?.into_iter().map(|p| (p.id.clone(), p)).collect();
	let visible: Vec<_> = tasks
		.into_iter()
		.filter(|task| services.get(&task.service_id).is_some_and(|svc| caller.allows(&svc.project_id, database::ACCESS_READ)))
		.collect();
	ok(&with_owners(visible, &services, &projects))
}

pub async fn list_service_tasks(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	let service = s.db.service_by_id(&id).map_err(lookup)?;
	let tasks = s.db.scheduled_tasks_by_service(&id)?;
	let project = s.db.project_by_id(&service.project_id)?;
	let services = HashMap::from([(service.id.clone(), service)]);
	let projects = HashMap::from([(project.id.clone(), project)]);
	ok(&with_owners(tasks, &services, &projects))
}

pub async fn create_service_task(State(s): State<Arc<Server>>, Path(id): Path<String>, body: Bytes) -> ApiResult {
	s.db.service_by_id(&id).map_err(lookup)?;
	let input: TaskInput = decode(&body)?;
	let mut task = ScheduledTask { service_id: id, enabled: true, ..Default::default() };
	input.apply(&mut task).map_err(bad_request)?;
	s.db.create_scheduled_task(&mut task)?;
	set_next_run(&mut task, Utc::now());
	created(&task)
}

pub async fn update_task(State(s): State<Arc<Server>>, Path(id): Path<String>, body: Bytes) -> ApiResult {
	let mut task = s.db.scheduled_task_by_id(&id).map_err(lookup)?;
	let input: TaskInput = decode(&body)?;
	input.apply(&mut task).map_err(bad_request)?;
	s.db.update_scheduled_task(&mut task)?;
	set_next_run(&mut task, Utc::now());
	ok(&task)
}

pub async fn delete_task(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	s.db.scheduled_task_by_id(&id).map_err(lookup)?;
	s.db.delete_scheduled_task(&id)?;
	Ok(StatusCode::NO_CONTENT.into_response())
}

/// Executes a task now. A non-zero exit, or a container that refused the
/// exec, is still a 200: the run happened and its result is in the payload.
pub async fn run_task(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	let task = s.db.scheduled_task_by_id(&id).map_err(lookup)?;
	// Spawned so a browser walking away does not kill a half-finished command.
	let execution = tokio::spawn(Arc::clone(&s.tasks).execute(task));
	match execution.await.map_err(anyhow::Error::from)? {
		Ok((run, _)) => ok(&run),
		Err(err) if err.is::<AlreadyRunning>() => Err(ApiError::new(StatusCode::CONFLICT, "TASK_RUNNING", err.to_string())),
		Err(err) => Err(err.into()),
	}
}

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct RunsQuery {
	limit: String,
}

pub async fn task_runs(State(s): State<Arc<Server>>, Path(id): Path<String>, Query(q): Query<RunsQuery>) -> ApiResult {
	s.db.scheduled_task_by_id(&id).map_err(lookup)?;
	ok(&s.db.task_runs(&id, q.limit.parse().unwrap_or(0))?)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn with_owners_names_the_service_and_project_of_every_task() {
		let service = |id: &str, name: &str, project: &str| {
			(id.to_string(), Service { id: id.into(), compose_service_name: name.into(), project_id: project.into(), ..Default::default() })
		};
		let project = |id: &str, name: &str| (id.to_string(), Project { id: id.into(), name: name.into(), ..Default::default() });
		let services = HashMap::from([service("svc-1", "api", "proj-1"), service("svc-2", "worker", "proj-2")]);
		let projects = HashMap::from([project("proj-1", "Shop"), project("proj-2", "Blog")]);
		let task = |id: &str, service_id: &str, enabled: bool| ScheduledTask {
			id: id.into(),
			service_id: service_id.into(),
			schedule: "*/5 * * * *".into(),
			timezone: "UTC".into(),
			enabled,
			..Default::default()
		};
		let got = with_owners(vec![task("t1", "svc-1", true), task("t2", "svc-2", false)], &services, &projects);
		let owners: Vec<_> = got.iter().map(|t| (t.service_name.as_str(), t.project_id.as_str(), t.project_name.as_str())).collect();
		assert_eq!(owners, [("api", "proj-1", "Shop"), ("worker", "proj-2", "Blog")]);
		assert!(!got[0].task.next_run.is_empty(), "an enabled task has a next run");
		assert!(got[1].task.next_run.is_empty(), "a disabled task fires never");
	}
}
