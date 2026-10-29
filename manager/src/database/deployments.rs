use anyhow::Result;
use rusqlite::{Row, params};

use super::{DEPLOYMENT_QUEUED, DEPLOYMENT_RUNNING, Db, Deployment, DeploymentStep, new_id, now};

const DEPLOYMENT_COLUMNS: &str = "id, project_id, environment_id, number, service_name, commit_sha, branch, status, trigger, created_by, error, started_at, finished_at, created_at";

impl Db {
	/// Allocates the next number for the service being deployed, so a service's
	/// first deploy is #1 however long its neighbours have been running.
	pub fn create_deployment(&self, d: &mut Deployment) -> Result<()> {
		d.id = new_id();
		d.created_at = now();
		if d.status.is_empty() {
			d.status = DEPLOYMENT_QUEUED.into();
		}
		// Chosen inside the INSERT: as a separate SELECT two concurrent deploys of
		// the same service race onto one number and the UNIQUE fails one of them.
		d.number = self.conn().query_row(
			&format!(
				"INSERT INTO deployments ({DEPLOYMENT_COLUMNS}) SELECT ?, ?, ?,
				(SELECT COALESCE(MAX(number), 0) + 1 FROM deployments WHERE environment_id = ? AND service_name = ?),
				?, ?, ?, ?, ?, ?, ?, ?, ?, ? RETURNING number"
			),
			params![
				d.id,
				d.project_id,
				d.environment_id,
				d.environment_id,
				d.service_name,
				d.service_name,
				d.commit_sha,
				d.branch,
				d.status,
				d.trigger,
				d.created_by,
				d.error,
				d.started_at,
				d.finished_at,
				d.created_at
			],
			|r| r.get(0),
		)?;
		Ok(())
	}

	pub fn update_deployment(&self, d: &Deployment) -> Result<()> {
		self.exec(
			"UPDATE deployments SET commit_sha=?, branch=?, status=?, error=?, started_at=?, finished_at=? WHERE id=?",
			params![d.commit_sha, d.branch, d.status, d.error, d.started_at, d.finished_at, d.id],
		)?;
		Ok(())
	}

	pub fn deployment_by_id(&self, id: &str) -> Result<Deployment> {
		self.one(&format!("SELECT {DEPLOYMENT_COLUMNS} FROM deployments WHERE id = ?"), [id], scan_deployment)
	}

	/// One environment's history, newest first. Numbers run per service, so only
	/// time orders rows that span services.
	pub fn list_deployments(&self, environment_id: &str, limit: i64) -> Result<Vec<Deployment>> {
		let limit = if limit <= 0 { 50 } else { limit };
		self.all(
			&format!("SELECT {DEPLOYMENT_COLUMNS} FROM deployments WHERE environment_id = ? ORDER BY created_at DESC, id DESC LIMIT ?"),
			params![environment_id, limit],
			scan_deployment,
		)
	}

	/// Spans every environment: the last thing that happened anywhere in the project.
	pub fn list_project_deployments(&self, project_id: &str, limit: i64) -> Result<Vec<Deployment>> {
		let limit = if limit <= 0 { 50 } else { limit };
		self.all(
			&format!("SELECT {DEPLOYMENT_COLUMNS} FROM deployments WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?"),
			params![project_id, limit],
			scan_deployment,
		)
	}

	/// The dashboard activity list across all projects.
	pub fn recent_deployments(&self, limit: i64) -> Result<Vec<Deployment>> {
		let limit = if limit <= 0 { 10 } else { limit };
		self.all(&format!("SELECT {DEPLOYMENT_COLUMNS} FROM deployments ORDER BY created_at DESC LIMIT ?"), [limit], scan_deployment)
	}

	/// Rows left running when the manager restarted; the engine marks them failed
	/// on boot so the UI never shows a phantom pipeline.
	pub fn unfinished_deployments(&self) -> Result<Vec<Deployment>> {
		self.all(
			&format!("SELECT {DEPLOYMENT_COLUMNS} FROM deployments WHERE status IN (?, ?)"),
			[DEPLOYMENT_QUEUED, DEPLOYMENT_RUNNING],
			scan_deployment,
		)
	}

	pub fn create_step(&self, s: &mut DeploymentStep) -> Result<()> {
		s.id = new_id();
		self.exec(
			"INSERT INTO deployment_steps (id, deployment_id, position, name, status, output, started_at, finished_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			params![s.id, s.deployment_id, s.position, s.name, s.status, s.output, s.started_at, s.finished_at],
		)?;
		Ok(())
	}

	pub fn update_step(&self, s: &DeploymentStep) -> Result<()> {
		self.exec(
			"UPDATE deployment_steps SET status=?, output=?, started_at=?, finished_at=? WHERE id=?",
			params![s.status, s.output, s.started_at, s.finished_at, s.id],
		)?;
		Ok(())
	}

	pub fn list_steps(&self, deployment_id: &str) -> Result<Vec<DeploymentStep>> {
		self.all(
			"SELECT id, deployment_id, position, name, status, output, started_at, finished_at
			 FROM deployment_steps WHERE deployment_id = ? ORDER BY position",
			[deployment_id],
			|r| {
				Ok(DeploymentStep {
					id: r.get(0)?,
					deployment_id: r.get(1)?,
					position: r.get(2)?,
					name: r.get(3)?,
					status: r.get(4)?,
					output: r.get(5)?,
					started_at: r.get(6)?,
					finished_at: r.get(7)?,
				})
			},
		)
	}

	/// Keeps the newest runs per service; their steps, which hold the whole build
	/// log, cascade from deployments(id).
	pub fn prune_deployments(&self, keep_per_service: i64) -> Result<()> {
		self.exec(
			"DELETE FROM deployments WHERE id IN (
				SELECT id FROM (
					SELECT id, ROW_NUMBER() OVER (PARTITION BY environment_id, service_name ORDER BY number DESC) AS rank
					FROM deployments
				) WHERE rank > ?
			)",
			[keep_per_service],
		)?;
		Ok(())
	}

	pub fn count_deployments_by_status(&self, status: &str) -> Result<i64> {
		Ok(self.conn().query_row("SELECT COUNT(*) FROM deployments WHERE status = ?", [status], |r| r.get(0))?)
	}
}

fn scan_deployment(r: &Row) -> rusqlite::Result<Deployment> {
	Ok(Deployment {
		id: r.get(0)?,
		project_id: r.get(1)?,
		environment_id: r.get(2)?,
		number: r.get(3)?,
		service_name: r.get(4)?,
		commit_sha: r.get(5)?,
		branch: r.get(6)?,
		status: r.get(7)?,
		trigger: r.get(8)?,
		created_by: r.get(9)?,
		error: r.get(10)?,
		started_at: r.get(11)?,
		finished_at: r.get(12)?,
		created_at: r.get(13)?,
	})
}
