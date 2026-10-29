//! Reads and edits the data inside a database service. Every engine is reached
//! over the network with the service's own credentials, and every cell crosses
//! the API as text or null so the grid never guesses a type.

mod libsql;
mod mongo;
mod mysql;
mod postgres;
mod sql;
mod valkey;

use std::collections::BTreeMap;

use anyhow::{Result, bail};
use serde::{Deserialize, Serialize};

use crate::engines::{self, Connection};

/// An engine Studio cannot open. Every other error is the database's or the
/// request's fault and its message is meant for the user.
#[derive(Debug, thiserror::Error)]
#[error("studio does not support this engine")]
pub struct Unsupported;

/// The table is a view or has no primary key.
#[derive(Debug, thiserror::Error)]
#[error("the table is read-only: it is a view or has no primary key")]
pub struct ReadOnly;

pub const MAX_PAGE_SIZE: i64 = 500;
pub const MAX_RESULT_ROWS: usize = 1000;
const DEFAULT_PAGE_LEN: i64 = 50;

/// One cell: text, or None for NULL.
pub type Cell = Option<String>;

/// An open connection to one database service.
pub enum Conn {
	Sql(sql::SqlConn),
	Mongo(mongo::MongoConn),
	Valkey(valkey::ValkeyConn),
}

/// A Postgres schema, a MySQL or MongoDB database, SQLite's main or a Valkey
/// logical database.
#[derive(Clone, Debug, Serialize)]
pub struct Namespace {
	pub name: String,
	pub tables: Vec<Table>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Table {
	pub name: String,
	/// Anything that cannot be written: a view, a materialized view.
	pub view: bool,
	pub columns: Vec<Column>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Column {
	pub name: String,
	#[serde(rename = "type")]
	pub kind: String,
	pub nullable: bool,
	pub primary_key: bool,
	/// Shows a lossy text form: binary data, generated values.
	pub read_only: bool,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct Filter {
	pub column: String,
	pub op: String,
	#[serde(default)]
	pub value: String,
}

const FILTER_OPS: [&str; 10] = ["eq", "neq", "gt", "gte", "lt", "lte", "contains", "starts_with", "is_null", "is_not_null"];

#[derive(Clone, Debug, Default)]
pub struct RowsQuery {
	pub namespace: String,
	pub table: String,
	pub limit: i64,
	pub offset: i64,
	pub sort: String,
	pub desc: bool,
	pub filters: Vec<Filter>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Rows {
	pub columns: Vec<Column>,
	/// The columns that identify a row; empty means the table is read-only.
	pub key: Vec<String>,
	pub rows: Vec<Vec<Cell>>,
	pub total: i64,
	pub truncated: bool,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Changes {
	#[serde(rename = "schema", default)]
	pub namespace: String,
	#[serde(default)]
	pub table: String,
	#[serde(default)]
	pub updates: Vec<Update>,
	#[serde(default)]
	pub inserts: Vec<Values>,
	#[serde(default)]
	pub deletes: Vec<Delete>,
}

/// A column's new text, None for NULL. Sorted, so statements come out in a stable order.
pub type Values = BTreeMap<String, Option<String>>;

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Update {
	pub key: BTreeMap<String, String>,
	pub values: Values,
}

#[derive(Clone, Debug, Default, Deserialize)]
pub struct Delete {
	pub key: BTreeMap<String, String>,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct QueryResult {
	pub columns: Vec<String>,
	pub rows: Vec<Vec<Cell>>,
	pub affected: i64,
	pub duration_ms: i64,
	pub truncated: bool,
}

/// Connects to a database service; conn.host must be an address the manager
/// can dial, not the compose alias.
pub async fn open(conn: &Connection) -> Result<Conn> {
	Ok(match conn.engine.as_str() {
		"postgres" => Conn::Sql(postgres::open(conn).await?),
		"mysql" | "mariadb" => Conn::Sql(mysql::open(conn).await?),
		engines::LIBSQL => Conn::Sql(libsql::open(conn)),
		"mongodb" => Conn::Mongo(mongo::MongoConn::open(conn).await?),
		"valkey" => Conn::Valkey(valkey::ValkeyConn::open(conn).await?),
		_ => return Err(Unsupported.into()),
	})
}

impl Conn {
	pub async fn schema(&mut self) -> Result<Vec<Namespace>> {
		match self {
			Conn::Sql(c) => c.schema().await,
			Conn::Mongo(c) => c.schema().await,
			Conn::Valkey(_) => Ok(valkey::schema()),
		}
	}

	pub async fn rows(&mut self, q: &RowsQuery) -> Result<Rows> {
		match self {
			Conn::Sql(c) => c.rows(q).await,
			Conn::Mongo(c) => c.rows(q).await,
			Conn::Valkey(c) => c.rows(q).await,
		}
	}

	pub async fn apply(&mut self, changes: &Changes) -> Result<i64> {
		match self {
			Conn::Sql(c) => c.apply(changes).await,
			Conn::Mongo(c) => c.apply(changes).await,
			Conn::Valkey(c) => c.apply(changes).await,
		}
	}

	pub async fn query(&mut self, namespace: &str, query: &str) -> Result<QueryResult> {
		match self {
			Conn::Sql(c) => c.query(namespace, query).await,
			Conn::Mongo(c) => c.query(namespace, query).await,
			Conn::Valkey(c) => c.query(query).await,
		}
	}

	pub async fn close(self) {
		if let Conn::Sql(c) = self {
			c.close().await;
		}
	}
}

impl RowsQuery {
	/// Clamps paging and rejects filters the engines do not know.
	pub fn normalize(mut self) -> Result<RowsQuery> {
		if self.limit <= 0 {
			self.limit = DEFAULT_PAGE_LEN;
		}
		self.limit = self.limit.min(MAX_PAGE_SIZE);
		if self.offset < 0 {
			bail!("offset must not be negative");
		}
		for f in &self.filters {
			if !FILTER_OPS.contains(&f.op.as_str()) {
				bail!("unknown filter operator {:?}", f.op);
			}
		}
		Ok(self)
	}
}

/// Fails on a name that is not a column of the table, before it reaches a query.
fn find_column<'a>(columns: &'a [Column], name: &str) -> Result<&'a Column> {
	match columns.iter().find(|c| c.name == name) {
		Some(col) => Ok(col),
		None => bail!("unknown column {name:?}"),
	}
}

/// Insists on the whole key, so a write can never match more than one row.
fn require_key(key: &[String], got: &BTreeMap<String, String>) -> Result<()> {
	if key.is_empty() {
		return Err(ReadOnly.into());
	}
	if got.len() != key.len() || !key.iter().all(|name| got.contains_key(name)) {
		bail!("a row is identified by {key:?}");
	}
	Ok(())
}

/// Keeps a cell intact through JSON: bytes that are not UTF-8 become Postgres-style hex.
fn printable(b: &[u8]) -> String {
	match std::str::from_utf8(b) {
		Ok(s) => s.to_string(),
		Err(_) => format!("\\x{}", hex::encode(b)),
	}
}

#[cfg(test)]
mod tests;
