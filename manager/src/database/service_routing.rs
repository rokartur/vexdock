use anyhow::Result;
use rusqlite::params;
use serde::{Deserialize, Serialize};

use super::{Db, bool_to_int, new_id, now};

/// Sends a request whose full URL matches `regex` to `replacement`, which may
/// use the regex's captures as $1, $2 and so on.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ServiceRedirect {
	pub id: String,
	pub service_id: String,
	pub regex: String,
	pub replacement: String,
	pub permanent: bool,
	pub created_at: String,
}

/// One user nginx lets through to the service's domains.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ServiceBasicAuth {
	pub id: String,
	pub service_id: String,
	pub username: String,
	#[serde(skip)]
	pub password_hash: String,
	pub created_at: String,
}

/// Publishes `target` of the service's container on the host's `published` port.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ServicePort {
	pub id: String,
	pub service_id: String,
	pub published: i64,
	pub target: i64,
	pub protocol: String,
	pub created_at: String,
}

impl Db {
	pub fn create_service_redirect(&self, r: &mut ServiceRedirect) -> Result<()> {
		r.id = new_id();
		r.created_at = now();
		self.exec(
			"INSERT INTO service_redirects (id, service_id, regex, replacement, permanent, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			params![r.id, r.service_id, r.regex, r.replacement, bool_to_int(r.permanent), r.created_at],
		)?;
		Ok(())
	}

	/// In creation order, which is the order nginx tries them.
	pub fn service_redirects(&self, service_id: &str) -> Result<Vec<ServiceRedirect>> {
		self.all(
			"SELECT id, service_id, regex, replacement, permanent, created_at FROM service_redirects WHERE service_id = ? ORDER BY created_at, id",
			[service_id],
			|r| {
				Ok(ServiceRedirect {
					id: r.get(0)?,
					service_id: r.get(1)?,
					regex: r.get(2)?,
					replacement: r.get(3)?,
					permanent: r.get::<_, i64>(4)? == 1,
					created_at: r.get(5)?,
				})
			},
		)
	}

	pub fn delete_service_redirect(&self, service_id: &str, id: &str) -> Result<()> {
		self.exec("DELETE FROM service_redirects WHERE service_id = ? AND id = ?", [service_id, id])?;
		Ok(())
	}

	pub fn create_service_basic_auth(&self, a: &mut ServiceBasicAuth) -> Result<()> {
		a.id = new_id();
		a.created_at = now();
		self.exec(
			"INSERT INTO service_basic_auth (id, service_id, username, password_hash, created_at) VALUES (?, ?, ?, ?, ?)",
			params![a.id, a.service_id, a.username, a.password_hash, a.created_at],
		)?;
		Ok(())
	}

	pub fn service_basic_auths(&self, service_id: &str) -> Result<Vec<ServiceBasicAuth>> {
		self.all(
			"SELECT id, service_id, username, password_hash, created_at FROM service_basic_auth WHERE service_id = ? ORDER BY username",
			[service_id],
			|r| {
				Ok(ServiceBasicAuth {
					id: r.get(0)?,
					service_id: r.get(1)?,
					username: r.get(2)?,
					password_hash: r.get(3)?,
					created_at: r.get(4)?,
				})
			},
		)
	}

	pub fn delete_service_basic_auth(&self, service_id: &str, id: &str) -> Result<()> {
		self.exec("DELETE FROM service_basic_auth WHERE service_id = ? AND id = ?", [service_id, id])?;
		Ok(())
	}

	pub fn create_service_port(&self, p: &mut ServicePort) -> Result<()> {
		p.id = new_id();
		p.created_at = now();
		self.exec(
			"INSERT INTO service_ports (id, service_id, published, target, protocol, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			params![p.id, p.service_id, p.published, p.target, p.protocol, p.created_at],
		)?;
		Ok(())
	}

	pub fn service_ports(&self, service_id: &str) -> Result<Vec<ServicePort>> {
		self.all(
			"SELECT id, service_id, published, target, protocol, created_at FROM service_ports WHERE service_id = ? ORDER BY published, protocol",
			[service_id],
			|r| {
				Ok(ServicePort {
					id: r.get(0)?,
					service_id: r.get(1)?,
					published: r.get(2)?,
					target: r.get(3)?,
					protocol: r.get(4)?,
					created_at: r.get(5)?,
				})
			},
		)
	}

	pub fn delete_service_port(&self, service_id: &str, id: &str) -> Result<()> {
		self.exec("DELETE FROM service_ports WHERE service_id = ? AND id = ?", [service_id, id])?;
		Ok(())
	}
}
