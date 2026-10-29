//! The three SQL engines share everything but how a statement reaches the
//! database: introspection, paging, filters and the grid's writes.

use anyhow::{Result, bail};

use super::{Cell, Changes, Column, MAX_RESULT_ROWS, Namespace, QueryResult, ReadOnly, Rows, RowsQuery, Table, Values};
use super::{find_column, libsql, mysql, postgres};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(super) enum Dialect {
	Postgres,
	Mysql,
	Sqlite,
}

/// A bound parameter: text, or None for NULL.
pub(super) type Arg = Option<String>;

#[derive(Clone, Debug, Default, PartialEq)]
pub(super) struct ResultSet {
	pub columns: Vec<String>,
	pub rows: Vec<Vec<Cell>>,
	pub affected: i64,
	pub truncated: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub(super) struct Statement {
	pub sql: String,
	pub args: Vec<Arg>,
}

/// How a statement reaches the database. Every value it returns is text or None.
pub(super) enum Runner {
	Postgres(postgres::PgRunner),
	Mysql(mysql::MysqlRunner),
	Libsql(libsql::HranaRunner),
}

impl Runner {
	async fn query(&mut self, sql: &str, args: &[Arg], max_rows: usize) -> Result<ResultSet> {
		match self {
			Runner::Postgres(r) => r.query(sql, args, max_rows).await,
			Runner::Mysql(r) => r.query(sql, args, max_rows).await,
			Runner::Libsql(r) => r.query(sql, args, max_rows).await,
		}
	}

	/// Runs every statement in one transaction and sums the rows they touched.
	async fn transact(&mut self, stmts: &[Statement]) -> Result<i64> {
		match self {
			Runner::Postgres(r) => r.transact(stmts).await,
			Runner::Mysql(r) => r.transact(stmts).await,
			Runner::Libsql(r) => r.transact(stmts).await,
		}
	}
}

pub struct SqlConn {
	pub(super) dialect: Dialect,
	pub(super) run: Runner,
}

/// Per column: namespace, table, view, column, type, nullable, primary key,
/// read-only; flags are 1 or 0. The arguments narrow it to one table and are
/// empty for all of them. Postgres casts every output to text, since its
/// runner reads text only.
fn introspection(d: Dialect) -> &'static str {
	match d {
		Dialect::Postgres => {
			"select n.nspname::text, c.relname::text, (c.relkind in ('v', 'm'))::int::text, a.attname::text,
		format_type(a.atttypid, a.atttypmod), (not a.attnotnull)::int::text,
		coalesce(a.attnum = any(i.indkey), false)::int::text, (a.attgenerated <> '')::int::text
	from pg_class c
	join pg_namespace n on n.oid = c.relnamespace
	join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
	left join pg_index i on i.indrelid = c.oid and i.indisprimary
	where c.relkind in ('r', 'p', 'v', 'm', 'f') and n.nspname <> 'information_schema' and n.nspname not like 'pg!_%' escape '!'
		and ($1::text = '' or (n.nspname = $1::text and c.relname = $2::text))
	order by 1, 2, a.attnum"
		}
		Dialect::Mysql => {
			"select c.table_schema, c.table_name, t.table_type <> 'BASE TABLE', c.column_name,
		c.column_type, c.is_nullable = 'YES', c.column_key = 'PRI',
		coalesce(c.generation_expression, '') <> '' or c.data_type like '%blob' or c.data_type in ('binary', 'varbinary', 'bit')
	from information_schema.columns c
	join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
	where c.table_schema = database() and (? = '' or (c.table_schema = ? and c.table_name = ?))
	order by c.table_name, c.ordinal_position"
		}
		Dialect::Sqlite => {
			"select 'main', m.name, m.type = 'view', p.name, p.type, p.\"notnull\" = 0, p.pk > 0,
		p.hidden <> 0 or upper(p.type) like '%BLOB%'
	from sqlite_schema m join pragma_table_xinfo(m.name) p
	where m.type in ('table', 'view') and m.name not like 'sqlite!_%' escape '!'
		and (? = '' or ('main' = ? and m.name = ?))
	order by m.name, p.cid"
		}
	}
}

/// The namespaces that exist even with no table in them.
fn namespace_list(d: Dialect) -> &'static str {
	match d {
		Dialect::Postgres => {
			"select nspname::text from pg_namespace where nspname <> 'information_schema' and nspname not like 'pg!_%' escape '!' order by 1"
		}
		Dialect::Mysql => "select database()",
		Dialect::Sqlite => "select 'main'",
	}
}

struct NamespacedTable {
	namespace: String,
	table: Table,
}

impl SqlConn {
	pub(super) async fn close(self) {
		if let Runner::Postgres(r) = self.run {
			r.close();
		} else if let Runner::Mysql(r) = self.run {
			r.close().await;
		}
	}

	pub(super) async fn schema(&mut self) -> Result<Vec<Namespace>> {
		let names = self.run.query(namespace_list(self.dialect), &[], 10_000).await?;
		let tables = self.introspect("", "").await?;
		let mut namespaces = Vec::new();
		for row in names.rows {
			let name = text(&row[0]);
			let tables = tables.iter().filter(|t| t.namespace == name).map(|t| t.table.clone()).collect();
			namespaces.push(Namespace { name, tables });
		}
		Ok(namespaces)
	}

	/// Reads every table, or just the one named, with its columns.
	async fn introspect(&mut self, namespace: &str, table: &str) -> Result<Vec<NamespacedTable>> {
		let args: Vec<Arg> = if self.dialect == Dialect::Postgres {
			vec![Some(namespace.into()), Some(table.into())]
		} else {
			vec![Some(namespace.into()), Some(namespace.into()), Some(table.into())]
		};
		let set = self.run.query(introspection(self.dialect), &args, 1_000_000).await?;
		let mut tables: Vec<NamespacedTable> = Vec::new();
		for row in set.rows {
			let (ns, name) = (text(&row[0]), text(&row[1]));
			if tables.last().is_none_or(|last| last.namespace != ns || last.table.name != name) {
				tables.push(NamespacedTable { namespace: ns, table: Table { name, view: flag(&row[2]), columns: Vec::new() } });
			}
			let last = tables.last_mut().expect("pushed above");
			last.table.columns.push(Column {
				name: text(&row[3]),
				kind: text(&row[4]),
				nullable: flag(&row[5]),
				primary_key: flag(&row[6]),
				read_only: flag(&row[7]),
			});
		}
		Ok(tables)
	}

	async fn table(&mut self, namespace: &str, name: &str) -> Result<Table> {
		match self.introspect(namespace, name).await?.into_iter().next() {
			Some(t) => Ok(t.table),
			None => bail!("no table {namespace}.{name}"),
		}
	}

	pub(super) async fn rows(&mut self, q: &RowsQuery) -> Result<Rows> {
		let table = self.table(&q.namespace, &q.table).await?;
		let mut b = SqlBuilder::new(self.dialect);
		let filter = b.filter(&table.columns, &q.filters)?;
		let from = format!(" from {}{filter}", b.reference(&q.namespace, &q.table));

		// ponytail: exact count(*), slow on huge tables; pg reltuples estimate if it hurts.
		let count = self.run.query(&format!("select {}{from}", b.as_text("count(*)")), &b.args, 1).await?;
		let total: i64 = text(&count.rows[0][0]).parse()?;

		let key = key_of(&table);
		let (order, desc) = if q.sort.is_empty() {
			(key.clone(), false)
		} else {
			find_column(&table.columns, &q.sort)?;
			(vec![q.sort.clone()], q.desc)
		};
		let names: Vec<String> = table.columns.iter().map(|col| b.as_text(&b.quote(&col.name))).collect();
		let sql = format!("select {}{from}{} limit {} offset {}", names.join(", "), b.order_by(&order, desc), q.limit, q.offset);
		let set = self.run.query(&sql, &b.args, q.limit as usize).await?;
		Ok(Rows { columns: table.columns, key, rows: set.rows, total, truncated: false })
	}

	pub(super) async fn apply(&mut self, changes: &Changes) -> Result<i64> {
		let table = self.table(&changes.namespace, &changes.table).await?;
		let stmts = statements(self.dialect, &table, changes)?;
		self.run.transact(&stmts).await
	}

	pub(super) async fn query(&mut self, namespace: &str, query: &str) -> Result<QueryResult> {
		if self.dialect == Dialect::Postgres && !namespace.is_empty() {
			let search = SqlBuilder::new(Dialect::Postgres).quote(namespace);
			self.run.query("select set_config('search_path', $1::text, false)", &[Some(search)], 1).await?;
		}
		let set = self.run.query(query, &[], MAX_RESULT_ROWS).await?;
		Ok(QueryResult { columns: set.columns, rows: set.rows, affected: set.affected, duration_ms: 0, truncated: set.truncated })
	}
}

/// Turns the grid's edits into SQL, refusing anything that could touch a row
/// the user did not pick or a column they cannot write.
pub(super) fn statements(d: Dialect, table: &Table, changes: &Changes) -> Result<Vec<Statement>> {
	let key = key_of(table);
	if key.is_empty() {
		return Err(ReadOnly.into());
	}
	let reference = SqlBuilder::new(d).reference(&changes.namespace, &changes.table);
	let mut stmts = Vec::new();
	for u in &changes.updates {
		super::require_key(&key, &u.key)?;
		if u.values.is_empty() {
			continue;
		}
		let mut b = SqlBuilder::new(d);
		let mut sets = Vec::new();
		for (name, value) in &u.values {
			let col = writable_column(&table.columns, name)?;
			let param = b.bind(value.clone(), &col.kind);
			sets.push(format!("{} = {param}", b.quote(name)));
		}
		let filter = b.key_filter(&table.columns, &u.key);
		stmts.push(Statement { sql: format!("update {reference} set {}{filter}", sets.join(", ")), args: b.args });
	}
	for values in &changes.inserts {
		let mut b = SqlBuilder::new(d);
		let sql = b.insert(&reference, &table.columns, values)?;
		stmts.push(Statement { sql, args: b.args });
	}
	for del in &changes.deletes {
		super::require_key(&key, &del.key)?;
		let mut b = SqlBuilder::new(d);
		let filter = b.key_filter(&table.columns, &del.key);
		stmts.push(Statement { sql: format!("delete from {reference}{filter}"), args: b.args });
	}
	Ok(stmts)
}

/// The primary key, or nothing for a view or a table without one.
fn key_of(table: &Table) -> Vec<String> {
	if table.view {
		return Vec::new();
	}
	table.columns.iter().filter(|c| c.primary_key).map(|c| c.name.clone()).collect()
}

fn writable_column<'a>(columns: &'a [Column], name: &str) -> Result<&'a Column> {
	let col = find_column(columns, name)?;
	if col.read_only {
		bail!("column {name:?} is read-only");
	}
	Ok(col)
}

/// Writes one statement: identifiers are quoted, values always bound.
pub(super) struct SqlBuilder {
	dialect: Dialect,
	pub(super) args: Vec<Arg>,
}

impl SqlBuilder {
	pub(super) fn new(dialect: Dialect) -> SqlBuilder {
		SqlBuilder { dialect, args: Vec::new() }
	}

	pub(super) fn quote(&self, name: &str) -> String {
		if self.dialect == Dialect::Mysql {
			return format!("`{}`", name.replace('`', "``"));
		}
		format!("\"{}\"", name.replace('"', "\"\""))
	}

	/// The table's name in SQL; MySQL and SQLite only ever see one namespace.
	fn reference(&self, namespace: &str, table: &str) -> String {
		if self.dialect == Dialect::Postgres {
			return format!("{}.{}", self.quote(namespace), self.quote(table));
		}
		self.quote(table)
	}

	/// An expression read back as text. Only Postgres needs the cast: its
	/// runner binds and reads text, the others print every value themselves.
	fn as_text(&self, expr: &str) -> String {
		if self.dialect == Dialect::Postgres { format!("{expr}::text") } else { expr.to_string() }
	}

	/// Adds a parameter. Postgres gets every value as text and casts it to the
	/// column's type, so the grid's text form of any type round-trips.
	fn bind(&mut self, value: Arg, column_type: &str) -> String {
		self.args.push(value);
		if self.dialect == Dialect::Postgres {
			return format!("${}::text::{column_type}", self.args.len());
		}
		"?".into()
	}

	pub(super) fn filter(&mut self, columns: &[Column], filters: &[super::Filter]) -> Result<String> {
		let mut parts = Vec::new();
		for f in filters {
			let col = find_column(columns, &f.column)?;
			let name = self.quote(&col.name);
			match f.op.as_str() {
				"is_null" => parts.push(format!("{name} is null")),
				"is_not_null" => parts.push(format!("{name} is not null")),
				"contains" | "starts_with" => {
					let mut pattern = format!("{}%", escape_like(&f.value));
					if f.op == "contains" {
						pattern = format!("%{pattern}");
					}
					let like = if self.dialect == Dialect::Postgres { format!("{name}::text ilike ") } else { format!("{name} like ") };
					let param = self.bind(Some(pattern), "text");
					parts.push(format!("{like}{param} escape '!'"));
				}
				op => {
					let comparison = match op {
						"eq" => "=",
						"neq" => "<>",
						"gt" => ">",
						"gte" => ">=",
						"lt" => "<",
						"lte" => "<=",
						other => bail!("unknown filter operator {other:?}"),
					};
					let param = self.bind(Some(f.value.clone()), &col.kind);
					parts.push(format!("{name} {comparison} {param}"));
				}
			}
		}
		if parts.is_empty() {
			return Ok(String::new());
		}
		Ok(format!(" where {}", parts.join(" and ")))
	}

	fn key_filter(&mut self, columns: &[Column], key: &std::collections::BTreeMap<String, String>) -> String {
		let mut parts = Vec::new();
		for (name, value) in key {
			// require_key already matched every name to the key.
			let kind = columns.iter().find(|c| &c.name == name).map(|c| c.kind.clone()).unwrap_or_default();
			let param = self.bind(Some(value.clone()), &kind);
			parts.push(format!("{} = {param}", self.quote(name)));
		}
		format!(" where {}", parts.join(" and "))
	}

	fn insert(&mut self, reference: &str, columns: &[Column], values: &Values) -> Result<String> {
		if values.is_empty() {
			if self.dialect == Dialect::Mysql {
				return Ok(format!("insert into {reference} () values ()"));
			}
			return Ok(format!("insert into {reference} default values"));
		}
		let (mut names, mut params) = (Vec::new(), Vec::new());
		for (name, value) in values {
			let col = writable_column(columns, name)?;
			names.push(self.quote(name));
			params.push(self.bind(value.clone(), &col.kind));
		}
		Ok(format!("insert into {reference} ({}) values ({})", names.join(", "), params.join(", ")))
	}

	fn order_by(&self, columns: &[String], desc: bool) -> String {
		if columns.is_empty() {
			return String::new();
		}
		let direction = if desc { " desc" } else { " asc" };
		let parts: Vec<String> = columns.iter().map(|name| format!("{}{direction}", self.quote(name))).collect();
		format!(" order by {}", parts.join(", "))
	}
}

/// Makes a user's text match literally under `escape '!'`, the one escape
/// clause all three dialects read the same way.
fn escape_like(s: &str) -> String {
	s.replace('!', "!!").replace('%', "!%").replace('_', "!_")
}

fn text(v: &Cell) -> String {
	v.clone().unwrap_or_default()
}

fn flag(v: &Cell) -> bool {
	v.as_deref() == Some("1")
}
