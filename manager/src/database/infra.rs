use anyhow::Result;
use rusqlite::{Row, params};

use super::{Certificate, Db, Domain, Registry, bool_to_int, new_id, now};

const DOMAIN_COLUMNS: &str = "id, project_id, environment_id, service_id, hostname, container_port, https_enabled, redirect_https,
	certificate_source, created_at, updated_at";

const CERT_COLUMNS: &str = "id, domain_id, hostname, issuer, issued_at, expires_at, last_renewed_at, status, last_error, source";

impl Db {
	pub fn create_domain(&self, d: &mut Domain) -> Result<()> {
		d.created_at = now();
		d.updated_at = now();
		self.exec(
			&format!("INSERT INTO domains ({DOMAIN_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
			params![
				d.id,
				d.project_id,
				d.environment_id,
				d.service_id,
				d.hostname,
				d.container_port,
				bool_to_int(d.https_enabled),
				bool_to_int(d.redirect_https),
				d.certificate_source,
				d.created_at,
				d.updated_at
			],
		)?;
		Ok(())
	}

	pub fn update_domain(&self, d: &mut Domain) -> Result<()> {
		d.updated_at = now();
		self.exec(
			"UPDATE domains SET service_id=?, hostname=?, container_port=?, https_enabled=?, redirect_https=?,
			 certificate_source=?, updated_at=? WHERE id=?",
			params![
				d.service_id,
				d.hostname,
				d.container_port,
				bool_to_int(d.https_enabled),
				bool_to_int(d.redirect_https),
				d.certificate_source,
				d.updated_at,
				d.id
			],
		)?;
		Ok(())
	}

	pub fn delete_domain(&self, id: &str) -> Result<()> {
		self.exec("DELETE FROM domains WHERE id = ?", [id])?;
		Ok(())
	}

	pub fn domain_by_id(&self, id: &str) -> Result<Domain> {
		self.one(&format!("SELECT {DOMAIN_COLUMNS} FROM domains WHERE id = ?"), [id], scan_domain)
	}

	pub fn list_domains(&self) -> Result<Vec<Domain>> {
		self.all(&format!("SELECT {DOMAIN_COLUMNS} FROM domains ORDER BY hostname"), [], scan_domain)
	}

	pub fn list_project_domains(&self, project_id: &str) -> Result<Vec<Domain>> {
		self.all(&format!("SELECT {DOMAIN_COLUMNS} FROM domains WHERE project_id = ? ORDER BY hostname"), [project_id], scan_domain)
	}

	/// Records the outcome of an ACME issuance or renewal.
	pub fn upsert_certificate(&self, c: &mut Certificate) -> Result<()> {
		if c.id.is_empty() {
			c.id = new_id();
		}
		self.exec(
			&format!(
				"INSERT INTO certificates ({CERT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
				 ON CONFLICT (domain_id) DO UPDATE SET hostname=excluded.hostname, issuer=excluded.issuer,
				   issued_at=excluded.issued_at, expires_at=excluded.expires_at, last_renewed_at=excluded.last_renewed_at,
				   status=excluded.status, last_error=excluded.last_error, source=excluded.source"
			),
			params![
				c.id,
				c.domain_id,
				c.hostname,
				c.issuer,
				c.issued_at,
				c.expires_at,
				c.last_renewed_at,
				c.status,
				c.last_error,
				c.source
			],
		)?;
		Ok(())
	}

	pub fn certificate_by_domain(&self, domain_id: &str) -> Result<Certificate> {
		self.one(&format!("SELECT {CERT_COLUMNS} FROM certificates WHERE domain_id = ?"), [domain_id], scan_certificate)
	}

	pub fn list_certificates(&self) -> Result<Vec<Certificate>> {
		self.all(&format!("SELECT {CERT_COLUMNS} FROM certificates ORDER BY hostname"), [], scan_certificate)
	}

	pub fn create_registry(&self, r: &mut Registry) -> Result<()> {
		r.id = new_id();
		r.created_at = now();
		self.exec(
			"INSERT INTO registries (id, name, url, username, encrypted_password, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			params![r.id, r.name, r.url, r.username, r.encrypted_password, r.created_at],
		)?;
		Ok(())
	}

	pub fn delete_registry(&self, id: &str) -> Result<()> {
		self.exec("DELETE FROM registries WHERE id = ?", [id])?;
		Ok(())
	}

	pub fn list_registries(&self) -> Result<Vec<Registry>> {
		self.all("SELECT id, name, url, username, encrypted_password, created_at FROM registries ORDER BY name", [], |r| {
			Ok(Registry {
				id: r.get(0)?,
				name: r.get(1)?,
				url: r.get(2)?,
				username: r.get(3)?,
				encrypted_password: r.get(4)?,
				created_at: r.get(5)?,
			})
		})
	}

	pub fn setting(&self, key: &str) -> Result<String> {
		self.one("SELECT value FROM system_settings WHERE key = ?", [key], |r| r.get(0))
	}

	pub fn set_setting(&self, key: &str, value: &str) -> Result<()> {
		self.exec(
			"INSERT INTO system_settings (key, value, updated_at) VALUES (?, ?, ?)
			 ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
			params![key, value, now()],
		)?;
		Ok(())
	}
}

fn scan_domain(r: &Row) -> rusqlite::Result<Domain> {
	Ok(Domain {
		id: r.get(0)?,
		project_id: r.get(1)?,
		environment_id: r.get(2)?,
		service_id: r.get(3)?,
		hostname: r.get(4)?,
		container_port: r.get(5)?,
		https_enabled: r.get::<_, i64>(6)? != 0,
		redirect_https: r.get::<_, i64>(7)? != 0,
		certificate_source: r.get(8)?,
		created_at: r.get(9)?,
		updated_at: r.get(10)?,
	})
}

fn scan_certificate(r: &Row) -> rusqlite::Result<Certificate> {
	Ok(Certificate {
		id: r.get(0)?,
		domain_id: r.get(1)?,
		hostname: r.get(2)?,
		issuer: r.get(3)?,
		issued_at: r.get(4)?,
		expires_at: r.get(5)?,
		last_renewed_at: r.get(6)?,
		status: r.get(7)?,
		last_error: r.get(8)?,
		source: r.get(9)?,
	})
}
