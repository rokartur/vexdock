use std::collections::HashSet;

use anyhow::Result;
use rusqlite::Row;

use super::{Db, Environment, NotFound, bool_to_int, now};

const ENVIRONMENT_COLUMNS: &str = "id, project_id, name, slug, branch, compose_project_name, is_default, created_at, updated_at";

impl Db {
	pub fn create_environment(&self, e: &mut Environment) -> Result<()> {
		e.created_at = now();
		e.updated_at = now();
		self.exec(
			&format!("INSERT INTO environments ({ENVIRONMENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"),
			(
				&e.id,
				&e.project_id,
				&e.name,
				&e.slug,
				&e.branch,
				&e.compose_project_name,
				bool_to_int(e.is_default),
				&e.created_at,
				&e.updated_at,
			),
		)?;
		Ok(())
	}

	pub fn update_environment(&self, e: &mut Environment) -> Result<()> {
		e.updated_at = now();
		self.exec(
			"UPDATE environments SET name = ?, slug = ?, branch = ?, updated_at = ? WHERE id = ?",
			(&e.name, &e.slug, &e.branch, &e.updated_at, &e.id),
		)?;
		Ok(())
	}

	pub fn delete_environment(&self, id: &str) -> Result<()> {
		self.exec("DELETE FROM environments WHERE id = ?", [id])?;
		Ok(())
	}

	pub fn environment_by_id(&self, id: &str) -> Result<Environment> {
		self.one(&format!("SELECT {ENVIRONMENT_COLUMNS} FROM environments WHERE id = ?"), [id], scan_environment)
	}

	/// Where a project opens and where anything that names a project but no
	/// environment lands.
	pub fn default_environment(&self, project_id: &str) -> Result<Environment> {
		self.one(
			&format!("SELECT {ENVIRONMENT_COLUMNS} FROM environments WHERE project_id = ? ORDER BY is_default DESC, created_at LIMIT 1"),
			[project_id],
			scan_environment,
		)
	}

	/// Resolves an explicit environment against the project it must belong to,
	/// falling back to the default. The ownership check stops an id from another
	/// project reaching across the boundary.
	pub fn environment_or_default(&self, project_id: &str, environment_id: &str) -> Result<Environment> {
		if environment_id.is_empty() {
			return self.default_environment(project_id);
		}
		let env = self.environment_by_id(environment_id)?;
		if env.project_id != project_id {
			return Err(NotFound.into());
		}
		Ok(env)
	}

	pub fn list_environments(&self, project_id: &str) -> Result<Vec<Environment>> {
		self.all(
			&format!("SELECT {ENVIRONMENT_COLUMNS} FROM environments WHERE project_id = ? ORDER BY is_default DESC, name"),
			[project_id],
			scan_environment,
		)
	}

	/// The docker namespaces the platform owns: how a container or volume is
	/// told apart from one somebody started by hand on the same daemon.
	pub fn compose_project_names(&self) -> Result<HashSet<String>> {
		let names = self.all("SELECT compose_project_name FROM environments", [], |r| r.get(0))?;
		Ok(names.into_iter().collect())
	}
}

fn scan_environment(r: &Row) -> rusqlite::Result<Environment> {
	Ok(Environment {
		id: r.get(0)?,
		project_id: r.get(1)?,
		name: r.get(2)?,
		slug: r.get(3)?,
		branch: r.get(4)?,
		compose_project_name: r.get(5)?,
		is_default: r.get::<_, i64>(6)? == 1,
		created_at: r.get(7)?,
		updated_at: r.get(8)?,
	})
}
