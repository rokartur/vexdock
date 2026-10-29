//! Runs user-defined cron tasks inside service containers: the cron expression
//! parser and the once-a-minute runner loop.

mod cron;

pub use cron::*;

use std::collections::HashSet;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use chrono::{DateTime, Timelike, Utc};

use crate::database::{Db, ScheduledTask, TaskRun};
use crate::docker::Docker;

/// Ticks once a minute and execs every task whose schedule matches that
/// minute. Ticks missed while the manager was down are not replayed.
pub struct Runner {
	db: Arc<Db>,
	docker: Arc<Docker>,
	running: Mutex<HashSet<String>>,
}

/// Bounds a single execution so a hung command cannot hold its task forever.
/// ponytail: one global limit, make it per-task if a job needs longer.
const TASK_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// A task's previous run has not finished. A slow job must not pile up on
/// itself, from the tick or from "run now".
#[derive(Debug, thiserror::Error)]
#[error("this task is already running")]
pub struct AlreadyRunning;

impl Runner {
	pub fn new(db: Arc<Db>, docker: Arc<Docker>) -> Arc<Runner> {
		Arc::new(Runner { db, docker, running: Mutex::new(HashSet::new()) })
	}

	pub async fn run(self: Arc<Self>) {
		loop {
			// Aligned to the wall clock minute so tasks fire on :00, not on the boot offset.
			let now = Utc::now();
			let into_minute = Duration::from_secs(now.second() as u64) + Duration::from_nanos(now.nanosecond() as u64);
			tokio::time::sleep(Duration::from_secs(60).saturating_sub(into_minute)).await;
			self.tick(Utc::now());
		}
	}

	fn tick(self: &Arc<Self>, now: DateTime<Utc>) {
		let tasks = match self.db.enabled_scheduled_tasks() {
			Ok(tasks) => tasks,
			Err(err) => {
				tracing::error!(component = "tasks", error = %format!("{err:#}"), "scheduled tasks: load failed");
				return;
			}
		};
		for task in tasks.into_iter().filter(|task| due(task, now)) {
			let runner = self.clone();
			tokio::spawn(async move {
				match runner.execute(task.clone()).await {
					Err(err) if err.is::<AlreadyRunning>() => {
						tracing::warn!(component = "tasks", task = %task.id, name = %task.name, "scheduled task skipped, previous run still going");
					}
					Err(err) | Ok((_, Some(err))) => {
						tracing::error!(component = "tasks", task = %task.id, name = %task.name, error = %format!("{err:#}"), "scheduled task failed")
					}
					Ok((_, None)) => {}
				}
			});
		}
	}

	/// Runs one task now and records the result. Shared with the manual "run
	/// now" endpoint, which spawns it so a browser walking away does not kill a
	/// half-finished command.
	/// The outer error means no run was recorded; the inner one is a run that
	/// was recorded as failed.
	pub async fn execute(self: Arc<Self>, task: ScheduledTask) -> Result<(TaskRun, Option<anyhow::Error>)> {
		if !self.running.lock().unwrap_or_else(|p| p.into_inner()).insert(task.id.clone()) {
			return Err(AlreadyRunning.into());
		}
		let result = self.execute_claimed(&task).await;
		self.running.lock().unwrap_or_else(|p| p.into_inner()).remove(&task.id);
		result
	}

	async fn execute_claimed(&self, task: &ScheduledTask) -> Result<(TaskRun, Option<anyhow::Error>)> {
		let mut run = self.db.start_task_run(&task.id)?;
		// A missing container or a refused exec is a failed run, not a lost one:
		// it lands in the history with the reason as its output.
		let executed = match tokio::time::timeout(TASK_TIMEOUT, self.exec(task)).await {
			Ok(result) => result,
			Err(_) => Err(anyhow::anyhow!("the task ran longer than {} minutes", TASK_TIMEOUT.as_secs() / 60)),
		};
		let (output, exit_code, exec_err) = match executed {
			Ok((output, code)) => (output, code, None),
			Err(err) => (format!("{err:#}"), -1, Some(err)),
		};
		self.db.finish_task_run(&mut run, exit_code, &output)?;
		Ok((run, exec_err))
	}

	async fn exec(&self, task: &ScheduledTask) -> Result<(String, i64)> {
		let service = self.db.service_by_id(&task.service_id)?;
		let env = self.db.environment_by_id(&service.environment_id)?;
		let container_id = self.docker.service_container(&env.compose_project_name, &service.compose_service_name).await?;
		let shell = if task.shell.is_empty() { "sh" } else { &task.shell };
		// The user's own shell line in their own container: the reach the built-in
		// terminal already gives them. The shell is one of two constants, checked on save.
		self.docker.exec_output(&container_id, &[format!("/bin/{shell}"), "-c".into(), task.command.clone()]).await
	}
}

/// Whether a task fires at this instant. Each task reads the instant against
/// its own wall clock, which is what makes "0 3 * * *" mean 3am where the user
/// lives. A task the manager cannot make sense of is loud and skipped.
fn due(task: &ScheduledTask, now: DateTime<Utc>) -> bool {
	let parsed = match parse(&task.schedule) {
		Ok(parsed) => parsed,
		Err(err) => {
			tracing::warn!(component = "tasks", task = %task.id, schedule = %task.schedule, error = %err, "scheduled task has an invalid schedule");
			return false;
		}
	};
	match location(&task.timezone) {
		Ok(tz) => parsed.matches(&now.with_timezone(&tz)),
		Err(err) => {
			tracing::warn!(component = "tasks", task = %task.id, timezone = %task.timezone, error = %err, "scheduled task has an unknown timezone");
			false
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	/// The same instant fires a task in its own zone, not in UTC.
	#[test]
	fn due_reads_the_task_zone() {
		let task = ScheduledTask { schedule: "0 3 * * *".into(), timezone: "Europe/Warsaw".into(), ..Default::default() };
		let at = |s: &str| DateTime::parse_from_rfc3339(s).unwrap().with_timezone(&Utc);
		assert!(due(&task, at("2024-03-07T02:00:00Z")));
		assert!(!due(&task, at("2024-03-07T03:00:00Z")));
		let broken = ScheduledTask { schedule: "0 3 * * *".into(), timezone: "Mars/Olympus".into(), ..Default::default() };
		assert!(!due(&broken, at("2024-03-07T03:00:00Z")));
	}
}
