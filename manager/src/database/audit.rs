use anyhow::Result;
use serde::Serialize;

use super::{Db, new_id, now};

/// One recorded state-changing request.
#[derive(Clone, Debug, Default, Serialize)]
pub struct AuditEntry {
	pub id: String,
	pub at: String,
	pub actor: String,
	pub method: String,
	pub path: String,
	pub status: i64,
	pub client_ip: String,
	pub credential: String,
}

impl Db {
	/// Appends an entry. Failures are the caller's to log: an audit write must
	/// never break the request it describes.
	pub fn record_audit(&self, e: &AuditEntry) -> Result<()> {
		self.exec(
			"INSERT INTO audit_log (id, at, actor, method, path, status, client_ip, credential) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
			(new_id(), now(), &e.actor, &e.method, &e.path, e.status, &e.client_ip, &e.credential),
		)?;
		Ok(())
	}

	/// Keeps the newest n entries so the table cannot grow without bound.
	pub fn prune_audit(&self, keep: i64) -> Result<()> {
		self.exec("DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY at DESC LIMIT ?)", [keep])?;
		Ok(())
	}
}
