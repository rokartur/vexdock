//! The SQLite connection, schema migrations and every query in the management
//! plane. Business modules depend on it; it depends on nothing but the driver.

mod audit;
mod deployments;
mod environments;
mod git_providers;
mod infra;
mod metrics;
mod models;
mod projects;
mod service_routing;
mod tasks;
mod tokens;

pub use audit::*;
pub use metrics::*;
pub use models::*;
pub use projects::*;
pub use service_routing::*;
pub use tasks::*;
pub use tokens::*;

use std::sync::{Mutex, MutexGuard};

use anyhow::{Context, Result, bail};
use chrono::{DateTime, Timelike, Utc};
use rusqlite::{Connection, OptionalExtension, Params, Row};

pub struct Db {
	// SQLite handles one writer; a single connection removes lock contention
	// entirely and is plenty for a single-node management plane.
	conn: Mutex<Connection>,
}

/// Returned by every lookup helper when no row matches.
#[derive(Debug, thiserror::Error)]
#[error("not found")]
pub struct NotFound;

pub fn is_not_found(err: &anyhow::Error) -> bool {
	err.is::<NotFound>()
}

/// Applied in filename order on boot. A shipped migration is immutable.
const MIGRATIONS: &[(&str, &str)] = &[
	("0001_init.sql", include_str!("../../migrations/0001_init.sql")),
	("0002_api_tokens.sql", include_str!("../../migrations/0002_api_tokens.sql")),
	("0003_betterauth.sql", include_str!("../../migrations/0003_betterauth.sql")),
	("0004_audit_log.sql", include_str!("../../migrations/0004_audit_log.sql")),
	("0005_certificate_source.sql", include_str!("../../migrations/0005_certificate_source.sql")),
	("0006_metrics.sql", include_str!("../../migrations/0006_metrics.sql")),
	("0007_project_tags.sql", include_str!("../../migrations/0007_project_tags.sql")),
	("0008_managed_services.sql", include_str!("../../migrations/0008_managed_services.sql")),
	("0009_deployment_service.sql", include_str!("../../migrations/0009_deployment_service.sql")),
	("0010_environments.sql", include_str!("../../migrations/0010_environments.sql")),
	("0011_analytics.sql", include_str!("../../migrations/0011_analytics.sql")),
	("0012_scheduled_tasks.sql", include_str!("../../migrations/0012_scheduled_tasks.sql")),
	("0013_task_options.sql", include_str!("../../migrations/0013_task_options.sql")),
	("0014_service_provider.sql", include_str!("../../migrations/0014_service_provider.sql")),
	("0015_git_accounts.sql", include_str!("../../migrations/0015_git_accounts.sql")),
	("0016_github_app.sql", include_str!("../../migrations/0016_github_app.sql")),
	("0017_git_providers.sql", include_str!("../../migrations/0017_git_providers.sql")),
	("0018_drop_analytics.sql", include_str!("../../migrations/0018_drop_analytics.sql")),
	("0019_container_name.sql", include_str!("../../migrations/0019_container_name.sql")),
	("0020_deployment_number_per_service.sql", include_str!("../../migrations/0020_deployment_number_per_service.sql")),
	("0021_service_auto_deploy.sql", include_str!("../../migrations/0021_service_auto_deploy.sql")),
	("0022_service_prune_build_cache.sql", include_str!("../../migrations/0022_service_prune_build_cache.sql")),
	("0023_git_provider_webhook_secret.sql", include_str!("../../migrations/0023_git_provider_webhook_secret.sql")),
	("0024_service_build_type.sql", include_str!("../../migrations/0024_service_build_type.sql")),
	("0025_service_routing.sql", include_str!("../../migrations/0025_service_routing.sql")),
	("0026_service_mounts.sql", include_str!("../../migrations/0026_service_mounts.sql")),
	("0027_service_output_dir.sql", include_str!("../../migrations/0027_service_output_dir.sql")),
	("0028_token_scopes.sql", include_str!("../../migrations/0028_token_scopes.sql")),
	("0029_oauth.sql", include_str!("../../migrations/0029_oauth.sql")),
];

// Opts a migration out of foreign key enforcement while it runs. A table
// rebuild with foreign keys on cascade-deletes every child row it exists to
// preserve, and the pragma only takes effect outside a transaction.
const REBUILD_MARKER: &str = "-- vexdock:rebuild";

impl Db {
	/// Connects with the pragmas recommended for an embedded management database
	/// and applies pending migrations.
	pub fn open(path: &str) -> Result<Db> {
		let conn = Connection::open(path).context("open sqlite")?;
		conn.execute_batch("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000; PRAGMA synchronous = NORMAL;")
			.context("configure sqlite")?;
		let db = Db { conn: Mutex::new(conn) };
		db.migrate()?;
		Ok(db)
	}

	pub(crate) fn conn(&self) -> MutexGuard<'_, Connection> {
		self.conn.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
	}

	pub(crate) fn exec(&self, sql: &str, params: impl Params) -> Result<usize> {
		Ok(self.conn().execute(sql, params)?)
	}

	/// One row or NotFound.
	pub(crate) fn one<T>(&self, sql: &str, params: impl Params, map: impl FnOnce(&Row) -> rusqlite::Result<T>) -> Result<T> {
		self.conn().query_row(sql, params, map).optional()?.ok_or_else(|| NotFound.into())
	}

	pub(crate) fn all<T>(&self, sql: &str, params: impl Params, map: impl FnMut(&Row) -> rusqlite::Result<T>) -> Result<Vec<T>> {
		let conn = self.conn();
		let mut stmt = conn.prepare(sql)?;
		let rows = stmt.query_map(params, map)?;
		Ok(rows.collect::<rusqlite::Result<Vec<T>>>()?)
	}

	fn migrate(&self) -> Result<()> {
		self.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)", [])
			.context("create schema_migrations")?;
		for (name, body) in MIGRATIONS {
			let applied: i64 = self.conn().query_row("SELECT COUNT(*) FROM schema_migrations WHERE version = ?", [name], |r| r.get(0))?;
			if applied == 0 {
				self.apply(name, body)?;
			}
		}
		Ok(())
	}

	fn apply(&self, name: &str, body: &str) -> Result<()> {
		let mut conn = self.conn();
		let rebuild = body.starts_with(REBUILD_MARKER);
		if rebuild {
			conn.execute_batch("PRAGMA foreign_keys = OFF").with_context(|| format!("disable foreign keys for {name}"))?;
		}
		let applied = apply_in_transaction(&mut conn, name, body, rebuild);
		if rebuild {
			// The one connection keeps the pragma for the rest of the process, so
			// failing to restore it would run the whole platform without foreign keys.
			let restored = conn.execute_batch("PRAGMA foreign_keys = ON");
			applied?;
			restored.with_context(|| format!("restore foreign keys after {name}"))?;
			return Ok(());
		}
		applied
	}
}

fn apply_in_transaction(conn: &mut Connection, name: &str, body: &str, rebuild: bool) -> Result<()> {
	let tx = conn.transaction()?;
	tx.execute_batch(body).with_context(|| format!("apply migration {name}"))?;
	if rebuild {
		// Enforcement was off, so the rows it would have rejected are still here.
		// Find them while a rollback can still undo the damage.
		dangling_references(&tx).with_context(|| format!("apply migration {name}"))?;
	}
	tx.execute("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)", (name, now()))?;
	tx.commit()?;
	Ok(())
}

fn dangling_references(conn: &Connection) -> Result<()> {
	let mut stmt = conn.prepare("PRAGMA foreign_key_check").context("foreign key check")?;
	let rows = stmt.query_map([], |r| Ok(format!("{} -> {}", r.get::<_, String>(0)?, r.get::<_, String>(2)?)))?;
	let mut broken: Vec<String> = Vec::new();
	let mut count = 0;
	for row in rows {
		let row = row.context("foreign key check")?;
		count += 1;
		if !broken.contains(&row) {
			broken.push(row);
		}
	}
	if count > 0 {
		bail!("left {count} dangling reference(s): {}", broken.join(", "));
	}
	Ok(())
}

/// The single timestamp format across every table: Go's RFC3339Nano in UTC
/// (trailing zeros of the fraction trimmed), which the rows written before the
/// Rust port already use.
pub fn now() -> String {
	format_time(Utc::now())
}

pub fn format_time(t: DateTime<Utc>) -> String {
	let base = t.format("%Y-%m-%dT%H:%M:%S").to_string();
	let nanos = t.nanosecond() % 1_000_000_000;
	if nanos == 0 {
		return format!("{base}Z");
	}
	let fraction = format!("{nanos:09}");
	format!("{base}.{}Z", fraction.trim_end_matches('0'))
}

/// Reads a stored timestamp; None means "unset" or unreadable.
pub fn parse_time(s: &str) -> Option<DateTime<Utc>> {
	DateTime::parse_from_rfc3339(s).ok().map(|t| t.with_timezone(&Utc))
}

impl Db {
	/// Whether the database answers a query, for the health check.
	pub fn ping(&self) -> Result<()> {
		self.conn().execute_batch("SELECT 1")?;
		Ok(())
	}
}

pub(crate) fn bool_to_int(b: bool) -> i64 {
	b as i64
}

#[cfg(test)]
impl Db {
	pub fn open_temp() -> (tempfile::TempDir, Db) {
		let dir = tempfile::tempdir().unwrap();
		let db = Db::open(dir.path().join("app.db").to_str().unwrap()).unwrap();
		(dir, db)
	}
}

#[cfg(test)]
mod tests;
