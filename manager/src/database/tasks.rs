use std::collections::HashMap;

use anyhow::Result;
use rusqlite::{Row, ToSql, params};
use serde::{Deserialize, Serialize};

use super::{Db, new_id, now};

/// A cron job that runs inside a service's container.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ScheduledTask {
	pub id: String,
	pub service_id: String,
	pub name: String,
	pub description: String,
	pub schedule: String,
	/// The IANA zone whose wall clock the schedule is read against.
	pub timezone: String,
	pub command: String,
	/// "sh" or "bash", whichever the image actually ships.
	pub shell: String,
	pub enabled: bool,
	pub created_at: String,
	pub updated_at: String,
	/// The newest execution, absent until the task has run once. Its output is
	/// left empty: a list of tasks should not carry a megabyte of console noise.
	#[serde(skip_serializing_if = "Option::is_none", default)]
	pub last_run: Option<TaskRun>,
	/// When the schedule fires next, computed on read.
	#[serde(skip_serializing_if = "String::is_empty", default)]
	pub next_run: String,
}

/// One execution of a scheduled task.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct TaskRun {
	pub id: String,
	pub task_id: String,
	pub started_at: String,
	pub finished_at: String,
	pub exit_code: i64,
	pub output: String,
}

const TASK_COLUMNS: &str = "id, service_id, name, description, schedule, timezone, command, shell, enabled, created_at, updated_at";

/// Caps what one run can write into SQLite. The tail is what matters when a
/// command fails, so the head is what gets dropped.
const MAX_RUN_OUTPUT: usize = 64 << 10;

impl Db {
	/// A service's tasks, newest run attached.
	pub fn scheduled_tasks_by_service(&self, service_id: &str) -> Result<Vec<ScheduledTask>> {
		self.list_tasks("WHERE service_id = ?", &[&service_id])
	}

	/// Every task on the server, newest run attached.
	pub fn all_scheduled_tasks(&self) -> Result<Vec<ScheduledTask>> {
		self.list_tasks("", &[])
	}

	fn list_tasks(&self, filter: &str, args: &[&dyn ToSql]) -> Result<Vec<ScheduledTask>> {
		let mut out = self.all(&format!("SELECT {TASK_COLUMNS} FROM scheduled_tasks {filter} ORDER BY created_at"), args, scan_task)?;
		let mut last = self.last_run_per_task(filter, args)?;
		for task in &mut out {
			task.last_run = last.remove(&task.id);
		}
		Ok(out)
	}

	/// The newest run of every task matching the same clause, in one query.
	fn last_run_per_task(&self, filter: &str, args: &[&dyn ToSql]) -> Result<HashMap<String, TaskRun>> {
		let runs = self.all(
			&format!(
				"SELECT id, task_id, started_at, finished_at, exit_code FROM (
					SELECT id, task_id, started_at, finished_at, exit_code,
					       ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY started_at DESC) AS rank
					FROM scheduled_task_runs
					WHERE task_id IN (SELECT id FROM scheduled_tasks {filter})
				) WHERE rank = 1"
			),
			args,
			|r| {
				Ok(TaskRun {
					id: r.get(0)?,
					task_id: r.get(1)?,
					started_at: r.get(2)?,
					finished_at: r.get(3)?,
					exit_code: r.get(4)?,
					output: String::new(),
				})
			},
		)?;
		Ok(runs.into_iter().map(|run| (run.task_id.clone(), run)).collect())
	}

	/// Every task the runner should consider on a tick.
	pub fn enabled_scheduled_tasks(&self) -> Result<Vec<ScheduledTask>> {
		self.all(&format!("SELECT {TASK_COLUMNS} FROM scheduled_tasks WHERE enabled = 1"), [], scan_task)
	}

	pub fn scheduled_task_by_id(&self, id: &str) -> Result<ScheduledTask> {
		self.one(&format!("SELECT {TASK_COLUMNS} FROM scheduled_tasks WHERE id = ?"), [id], scan_task)
	}

	pub fn create_scheduled_task(&self, t: &mut ScheduledTask) -> Result<()> {
		t.id = new_id();
		t.created_at = now();
		t.updated_at = now();
		self.exec(
			&format!("INSERT INTO scheduled_tasks ({TASK_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
			params![
				t.id,
				t.service_id,
				t.name,
				t.description,
				t.schedule,
				t.timezone,
				t.command,
				t.shell,
				t.enabled,
				t.created_at,
				t.updated_at
			],
		)?;
		Ok(())
	}

	pub fn update_scheduled_task(&self, t: &mut ScheduledTask) -> Result<()> {
		t.updated_at = now();
		self.exec(
			"UPDATE scheduled_tasks SET name = ?, description = ?, schedule = ?, timezone = ?,
			        command = ?, shell = ?, enabled = ?, updated_at = ? WHERE id = ?",
			params![t.name, t.description, t.schedule, t.timezone, t.command, t.shell, t.enabled, t.updated_at, t.id],
		)?;
		Ok(())
	}

	pub fn delete_scheduled_task(&self, id: &str) -> Result<()> {
		self.exec("DELETE FROM scheduled_tasks WHERE id = ?", [id])?;
		Ok(())
	}

	/// Records an execution that is under way. The run it returns is what
	/// finish_task_run completes, so no caller has to read the row back.
	pub fn start_task_run(&self, task_id: &str) -> Result<TaskRun> {
		let run = TaskRun { id: new_id(), task_id: task_id.into(), started_at: now(), exit_code: -1, ..Default::default() };
		self.exec(
			"INSERT INTO scheduled_task_runs (id, task_id, started_at) VALUES (?, ?, ?)",
			params![run.id, run.task_id, run.started_at],
		)?;
		Ok(run)
	}

	/// Stores the result and updates run to match what was written.
	pub fn finish_task_run(&self, run: &mut TaskRun, exit_code: i64, output: &str) -> Result<()> {
		let mut output = output.to_string();
		if output.len() > MAX_RUN_OUTPUT {
			let mut start = output.len() - MAX_RUN_OUTPUT;
			while !output.is_char_boundary(start) {
				start += 1;
			}
			output = format!("[output truncated]\n{}", &output[start..]);
		}
		run.finished_at = now();
		run.exit_code = exit_code;
		run.output = output;
		self.exec(
			"UPDATE scheduled_task_runs SET finished_at = ?, exit_code = ?, output = ? WHERE id = ?",
			params![run.finished_at, run.exit_code, run.output, run.id],
		)?;
		Ok(())
	}

	/// Closes out runs in flight when the manager stopped, so the UI never shows
	/// an execution nothing is running.
	pub fn recover_interrupted_task_runs(&self) -> Result<()> {
		self.exec(
			"UPDATE scheduled_task_runs SET finished_at = ?, output = ? WHERE finished_at = ''",
			params![now(), "interrupted by a manager restart"],
		)?;
		Ok(())
	}

	/// A task's executions, newest first.
	pub fn task_runs(&self, task_id: &str, limit: i64) -> Result<Vec<TaskRun>> {
		let limit = if limit <= 0 { 20 } else { limit.min(100) };
		self.all(
			"SELECT id, task_id, started_at, finished_at, exit_code, output
			 FROM scheduled_task_runs WHERE task_id = ? ORDER BY started_at DESC LIMIT ?",
			params![task_id, limit],
			|r| {
				Ok(TaskRun {
					id: r.get(0)?,
					task_id: r.get(1)?,
					started_at: r.get(2)?,
					finished_at: r.get(3)?,
					exit_code: r.get(4)?,
					output: r.get(5)?,
				})
			},
		)
	}

	/// Keeps the newest n runs per task.
	pub fn prune_task_runs(&self, keep_per_task: i64) -> Result<()> {
		self.exec(
			"DELETE FROM scheduled_task_runs WHERE id IN (
				SELECT id FROM (
					SELECT id, ROW_NUMBER() OVER (PARTITION BY task_id ORDER BY started_at DESC) AS rank
					FROM scheduled_task_runs
				) WHERE rank > ?
			)",
			[keep_per_task],
		)?;
		Ok(())
	}
}

fn scan_task(r: &Row) -> rusqlite::Result<ScheduledTask> {
	Ok(ScheduledTask {
		id: r.get(0)?,
		service_id: r.get(1)?,
		name: r.get(2)?,
		description: r.get(3)?,
		schedule: r.get(4)?,
		timezone: r.get(5)?,
		command: r.get(6)?,
		shell: r.get(7)?,
		enabled: r.get::<_, i64>(8)? != 0,
		created_at: r.get(9)?,
		updated_at: r.get(10)?,
		last_run: None,
		next_run: String::new(),
	})
}
