use anyhow::Result;
use futures::{StreamExt, pin_mut};
use tokio_postgres::{Client, NoTls, SimpleQueryMessage};

use super::sql::{Arg, Dialect, ResultSet, Runner, SqlConn, Statement};
use crate::engines::Connection;

/// Talks to Postgres in text: a statement with arguments binds every one as
/// text and casts its output to text (SqlBuilder does both), and a console
/// statement goes over the simple protocol so a script may hold several; the
/// last result wins.
pub(super) struct PgRunner {
	client: Client,
}

pub(super) async fn open(c: &Connection) -> Result<SqlConn> {
	let mut config = tokio_postgres::Config::new();
	config.host(&c.host).port(u16::try_from(c.port)?).user(&c.user).password(&c.password).dbname(&c.database);
	let (client, connection) = config.connect(NoTls).await?;
	tokio::spawn(async move {
		if let Err(err) = connection.await {
			tracing::debug!(error = %err, "studio postgres connection closed");
		}
	});
	Ok(SqlConn { dialect: Dialect::Postgres, run: Runner::Postgres(PgRunner { client }) })
}

impl PgRunner {
	pub(super) fn close(self) {}

	pub(super) async fn query(&mut self, sql: &str, args: &[Arg], max_rows: usize) -> Result<ResultSet> {
		if args.is_empty() {
			return self.simple_query(sql, max_rows).await;
		}
		let stream = self.client.query_raw(sql, args).await?;
		pin_mut!(stream);
		let mut set = ResultSet::default();
		while let Some(row) = stream.next().await {
			let row = row?;
			if set.columns.is_empty() {
				set.columns = row.columns().iter().map(|c| c.name().to_string()).collect();
			}
			if set.rows.len() == max_rows {
				set.truncated = true;
				continue;
			}
			let mut cells = Vec::with_capacity(row.len());
			for i in 0..row.len() {
				cells.push(row.try_get::<_, Option<String>>(i)?);
			}
			set.rows.push(cells);
		}
		set.affected = stream.rows_affected().map_or(0, |n| n as i64);
		Ok(set)
	}

	async fn simple_query(&mut self, sql: &str, max_rows: usize) -> Result<ResultSet> {
		let stream = self.client.simple_query_raw(sql).await?;
		pin_mut!(stream);
		let mut set = ResultSet::default();
		let mut described = false;
		while let Some(message) = stream.next().await {
			match message? {
				SimpleQueryMessage::RowDescription(columns) => {
					set = ResultSet { columns: columns.iter().map(|c| c.name().to_string()).collect(), ..Default::default() };
					described = true;
				}
				SimpleQueryMessage::Row(row) => {
					if set.rows.len() == max_rows {
						set.truncated = true;
						continue;
					}
					set.rows.push((0..row.len()).map(|i| row.get(i).map(String::from)).collect());
				}
				SimpleQueryMessage::CommandComplete(n) => {
					if !described {
						set = ResultSet::default();
					}
					set.affected = n as i64;
					described = false;
				}
				_ => {}
			}
		}
		Ok(set)
	}

	pub(super) async fn transact(&mut self, stmts: &[Statement]) -> Result<i64> {
		let tx = self.client.transaction().await?;
		let mut affected = 0;
		for stmt in stmts {
			let params: Vec<&(dyn tokio_postgres::types::ToSql + Sync)> = stmt.args.iter().map(|a| a as _).collect();
			affected += tx.execute(&stmt.sql, &params).await? as i64;
		}
		tx.commit().await?;
		Ok(affected)
	}
}
