use anyhow::Result;
use rusqlite::{Row, params};

use super::{Db, Project, Service, bool_to_int, new_id, now};

const PROJECT_COLUMNS: &str = "id, name, slug, compose_project_name, created_at, updated_at, tags";

impl Db {
	pub fn create_project(&self, p: &mut Project) -> Result<()> {
		p.created_at = now();
		p.updated_at = now();
		self.exec(
			&format!("INSERT INTO projects ({PROJECT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)"),
			params![p.id, p.name, p.slug, p.compose_project_name, p.created_at, p.updated_at, p.tags.join(",")],
		)?;
		Ok(())
	}

	pub fn update_project(&self, p: &mut Project) -> Result<()> {
		p.updated_at = now();
		self.exec(
			"UPDATE projects SET name=?, slug=?, updated_at=?, tags=? WHERE id=?",
			params![p.name, p.slug, p.updated_at, p.tags.join(","), p.id],
		)?;
		Ok(())
	}

	pub fn delete_project(&self, id: &str) -> Result<()> {
		self.exec("DELETE FROM projects WHERE id = ?", [id])?;
		Ok(())
	}

	pub fn list_projects(&self) -> Result<Vec<Project>> {
		self.all(&format!("SELECT {PROJECT_COLUMNS} FROM projects ORDER BY created_at DESC"), [], scan_project)
	}

	pub fn project_by_id(&self, id: &str) -> Result<Project> {
		self.one(&format!("SELECT {PROJECT_COLUMNS} FROM projects WHERE id = ?"), [id], scan_project)
	}

	pub fn upsert_secret(&self, sc: SecretScope, owner_id: &str, key: &str, encrypted: &str, is_secret: bool) -> Result<()> {
		let (table, owner) = (sc.table, sc.owner);
		self.exec(
			&format!(
				"INSERT INTO {table} (id, {owner}, key, encrypted_value, is_secret, created_at, updated_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT ({owner}, key) DO UPDATE SET encrypted_value = excluded.encrypted_value,
				     is_secret = excluded.is_secret, updated_at = excluded.updated_at"
			),
			params![new_id(), owner_id, key, encrypted, bool_to_int(is_secret), now(), now()],
		)?;
		Ok(())
	}

	pub fn delete_secret(&self, sc: SecretScope, owner_id: &str, key: &str) -> Result<()> {
		self.exec(&format!("DELETE FROM {} WHERE {} = ? AND key = ?", sc.table, sc.owner), [owner_id, key])?;
		Ok(())
	}

	pub fn list_secrets(&self, sc: SecretScope, owner_id: &str) -> Result<Vec<EncryptedSecret>> {
		self.all(
			&format!("SELECT key, encrypted_value, is_secret, updated_at FROM {} WHERE {} = ? ORDER BY key", sc.table, sc.owner),
			[owner_id],
			|r| Ok(EncryptedSecret { key: r.get(0)?, encrypted: r.get(1)?, is_secret: r.get::<_, i64>(2)? != 0, updated_at: r.get(3)? }),
		)
	}

	/// Records a service the dashboard owns. Its definition is rendered into the
	/// environment's compose file rather than read out of one.
	pub fn create_service(&self, s: &mut Service) -> Result<()> {
		s.created_at = now();
		s.updated_at = now();
		self.exec(
			&format!(
				"INSERT INTO services ({SERVICE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
			),
			params![
				s.id,
				s.project_id,
				s.environment_id,
				s.compose_service_name,
				s.container_name,
				s.display_name,
				s.kind,
				s.provider,
				s.repository_url,
				s.branch,
				s.build_path,
				s.credential_kind,
				s.credential_enc,
				s.git_provider_id,
				s.owner,
				s.repository,
				s.image,
				s.engine,
				s.data_path,
				s.compose_fragment,
				bool_to_int(s.auto_deploy),
				bool_to_int(s.prune_build_cache),
				s.build_type,
				s.dockerfile,
				s.build_target,
				s.output_dir,
				s.mounts,
				s.registry_url,
				s.registry_username,
				s.registry_password_enc,
				s.created_at,
				s.updated_at
			],
		)?;
		Ok(())
	}

	pub fn update_service(&self, s: &mut Service) -> Result<()> {
		s.updated_at = now();
		self.exec(
			"UPDATE services SET display_name = ?, type = ?, provider = ?, repository_url = ?, branch = ?,
			 build_path = ?, credential_kind = ?, credential_enc = ?, git_provider_id = ?, owner = ?, repository = ?,
			 image = ?, engine = ?, data_path = ?, compose_fragment = ?, auto_deploy = ?, prune_build_cache = ?,
			 build_type = ?, dockerfile = ?, build_target = ?, output_dir = ?, mounts = ?, registry_url = ?, registry_username = ?,
			 registry_password_enc = ?, updated_at = ? WHERE id = ?",
			params![
				s.display_name,
				s.kind,
				s.provider,
				s.repository_url,
				s.branch,
				s.build_path,
				s.credential_kind,
				s.credential_enc,
				s.git_provider_id,
				s.owner,
				s.repository,
				s.image,
				s.engine,
				s.data_path,
				s.compose_fragment,
				bool_to_int(s.auto_deploy),
				bool_to_int(s.prune_build_cache),
				s.build_type,
				s.dockerfile,
				s.build_target,
				s.output_dir,
				s.mounts,
				s.registry_url,
				s.registry_username,
				s.registry_password_enc,
				s.updated_at,
				s.id
			],
		)?;
		Ok(())
	}

	/// Writes the three columns update_service leaves alone, plus the service's
	/// domains, which repeat the project and environment. Scheduled tasks key on
	/// the service id, so they follow by themselves.
	pub fn move_service(&self, s: &mut Service) -> Result<()> {
		let mut conn = self.conn();
		let tx = conn.transaction()?;
		s.updated_at = now();
		tx.execute(
			"UPDATE services SET project_id = ?, environment_id = ?, container_name = ?, updated_at = ? WHERE id = ?",
			params![s.project_id, s.environment_id, s.container_name, s.updated_at, s.id],
		)?;
		tx.execute(
			"UPDATE domains SET project_id = ?, environment_id = ?, updated_at = ? WHERE service_id = ?",
			params![s.project_id, s.environment_id, s.updated_at, s.id],
		)?;
		tx.commit()?;
		Ok(())
	}

	pub fn delete_service(&self, id: &str) -> Result<()> {
		self.exec("DELETE FROM services WHERE id = ?", [id])?;
		Ok(())
	}

	pub fn service_by_name(&self, environment_id: &str, name: &str) -> Result<Service> {
		self.one(
			&format!("SELECT {SERVICE_COLUMNS} FROM services WHERE environment_id = ? AND compose_service_name = ?"),
			[environment_id, name],
			scan_service,
		)
	}

	/// Spans every project: a container name is unique on the whole host.
	pub fn service_by_container_name(&self, name: &str) -> Result<Service> {
		self.one(&format!("SELECT {SERVICE_COLUMNS} FROM services WHERE container_name = ?"), [name], scan_service)
	}

	pub fn service_by_id(&self, id: &str) -> Result<Service> {
		self.one(&format!("SELECT {SERVICE_COLUMNS} FROM services WHERE id = ?"), [id], scan_service)
	}

	/// One environment's services. Anything that needs every service a project
	/// owns wants list_project_services instead.
	pub fn list_services(&self, environment_id: &str) -> Result<Vec<Service>> {
		self.all(
			&format!("SELECT {SERVICE_COLUMNS} FROM services WHERE environment_id = ? ORDER BY compose_service_name"),
			[environment_id],
			scan_service,
		)
	}

	/// Spans every environment, which is what reconciliation and anything
	/// counting a project's footprint needs.
	pub fn list_project_services(&self, project_id: &str) -> Result<Vec<Service>> {
		self.all(
			&format!("SELECT {SERVICE_COLUMNS} FROM services WHERE project_id = ? ORDER BY environment_id, compose_service_name"),
			[project_id],
			scan_service,
		)
	}

	/// Spans every project, for views that list something owned by a service
	/// without knowing which one first.
	pub fn all_services(&self) -> Result<Vec<Service>> {
		self.all(&format!("SELECT {SERVICE_COLUMNS} FROM services"), [], scan_service)
	}
}

fn scan_project(r: &Row) -> rusqlite::Result<Project> {
	let tags: String = r.get(6)?;
	Ok(Project {
		id: r.get(0)?,
		name: r.get(1)?,
		slug: r.get(2)?,
		compose_project_name: r.get(3)?,
		created_at: r.get(4)?,
		updated_at: r.get(5)?,
		tags: if tags.is_empty() { Vec::new() } else { tags.split(',').map(String::from).collect() },
	})
}

/// Which variable set a secret belongs to. A project's set is shared by
/// everything it runs; a service's set is seen by that container alone, which
/// lets two databases in one project both define POSTGRES_PASSWORD. Both are
/// fixed strings, never caller input.
#[derive(Clone, Copy, Debug)]
pub struct SecretScope {
	table: &'static str,
	owner: &'static str,
}

pub const PROJECT_SCOPE: SecretScope = SecretScope { table: "project_secrets", owner: "project_id" };
pub const ENVIRONMENT_SCOPE: SecretScope = SecretScope { table: "environment_secrets", owner: "environment_id" };
pub const SERVICE_SCOPE: SecretScope = SecretScope { table: "service_secrets", owner: "service_id" };

/// The raw row; callers decrypt through the security cipher.
#[derive(Clone, Debug, Default)]
pub struct EncryptedSecret {
	pub key: String,
	pub encrypted: String,
	pub is_secret: bool,
	pub updated_at: String,
}

// The container id is deliberately not stored: it changes on every recreate.
pub(super) const SERVICE_COLUMNS: &str =
	"id, project_id, environment_id, compose_service_name, container_name, display_name, type, provider,
	repository_url, branch, build_path, credential_kind, credential_enc, git_provider_id, owner, repository, image,
	engine, data_path, compose_fragment, auto_deploy, prune_build_cache, build_type, dockerfile, build_target,
	output_dir, mounts, registry_url, registry_username, registry_password_enc, created_at, updated_at";

pub(super) fn scan_service(r: &Row) -> rusqlite::Result<Service> {
	Ok(Service {
		id: r.get(0)?,
		project_id: r.get(1)?,
		environment_id: r.get(2)?,
		compose_service_name: r.get(3)?,
		container_name: r.get(4)?,
		display_name: r.get(5)?,
		kind: r.get(6)?,
		provider: r.get(7)?,
		repository_url: r.get(8)?,
		branch: r.get(9)?,
		build_path: r.get(10)?,
		credential_kind: r.get(11)?,
		credential_enc: r.get(12)?,
		git_provider_id: r.get(13)?,
		owner: r.get(14)?,
		repository: r.get(15)?,
		image: r.get(16)?,
		engine: r.get(17)?,
		data_path: r.get(18)?,
		compose_fragment: r.get(19)?,
		auto_deploy: r.get::<_, i64>(20)? != 0,
		prune_build_cache: r.get::<_, i64>(21)? != 0,
		build_type: r.get(22)?,
		dockerfile: r.get(23)?,
		build_target: r.get(24)?,
		output_dir: r.get(25)?,
		mounts: r.get(26)?,
		registry_url: r.get(27)?,
		registry_username: r.get(28)?,
		registry_password_enc: r.get(29)?,
		created_at: r.get(30)?,
		updated_at: r.get(31)?,
	})
}
