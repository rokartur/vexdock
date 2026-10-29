use anyhow::Result;
use mysql_async::prelude::Queryable;
use mysql_async::{OptsBuilder, TxOpts, Value};

use super::printable;
use super::sql::{Arg, Dialect, ResultSet, Runner, SqlConn, Statement};
use crate::engines::Connection;

/// One connection, so a console statement and the count it reports run in
/// the same session. Arguments are written into the statement as hex string
/// literals, which keeps every statement on the text protocol (dates and
/// decimals arrive as the server prints them) with nothing left to escape.
pub(super) struct MysqlRunner {
	conn: mysql_async::Conn,
}

pub(super) async fn open(c: &Connection) -> Result<SqlConn> {
	let opts = OptsBuilder::default()
		.ip_or_hostname(c.host.clone())
		.tcp_port(u16::try_from(c.port)?)
		.user(Some(c.user.clone()))
		.pass(Some(c.password.clone()))
		.db_name(Some(c.database.clone()));
	let conn = mysql_async::Conn::new(opts).await?;
	Ok(SqlConn { dialect: Dialect::Mysql, run: Runner::Mysql(MysqlRunner { conn }) })
}

impl MysqlRunner {
	pub(super) async fn close(self) {
		let _ = self.conn.disconnect().await;
	}

	pub(super) async fn query(&mut self, sql: &str, args: &[Arg], max_rows: usize) -> Result<ResultSet> {
		let mut result = self.conn.query_iter(interpolate(sql, args)).await?;
		let mut set = ResultSet {
			columns: result.columns().map(|cols| cols.iter().map(|c| c.name_str().into_owned()).collect()).unwrap_or_default(),
			..Default::default()
		};
		while let Some(row) = result.next().await? {
			if set.rows.len() == max_rows {
				set.truncated = true;
				continue;
			}
			set.rows.push((0..row.len()).map(|i| cell(row.as_ref(i))).collect());
		}
		set.affected = result.affected_rows() as i64;
		result.drop_result().await?;
		Ok(set)
	}

	pub(super) async fn transact(&mut self, stmts: &[Statement]) -> Result<i64> {
		let mut tx = self.conn.start_transaction(TxOpts::default()).await?;
		let mut affected = 0;
		for stmt in stmts {
			tx.query_drop(interpolate(&stmt.sql, &stmt.args)).await?;
			affected += tx.affected_rows() as i64;
		}
		tx.commit().await?;
		Ok(affected)
	}
}

fn cell(value: Option<&Value>) -> Option<String> {
	match value? {
		Value::NULL => None,
		Value::Bytes(b) => Some(printable(b)),
		other => Some(other.as_sql(true)),
	}
}

/// Replaces each ? outside a quoted string or identifier with its argument.
pub(super) fn interpolate(sql: &str, args: &[Arg]) -> String {
	let mut out = String::with_capacity(sql.len());
	let mut args = args.iter();
	let mut quote = None;
	let mut escaped = false;
	for c in sql.chars() {
		match quote {
			Some(q) => {
				out.push(c);
				if escaped {
					escaped = false;
				} else if c == '\\' && q != '`' {
					escaped = true;
				} else if c == q {
					quote = None;
				}
			}
			None if matches!(c, '\'' | '"' | '`') => {
				quote = Some(c);
				out.push(c);
			}
			None if c == '?' => match args.next() {
				Some(Some(value)) => out.push_str(&format!("_utf8mb4 X'{}'", hex::encode(value))),
				Some(None) => out.push_str("NULL"),
				None => out.push('?'),
			},
			None => out.push(c),
		}
	}
	out
}
