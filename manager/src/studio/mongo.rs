use std::collections::HashMap;
use std::time::Duration;

use anyhow::{Context, Result, bail};
use futures::TryStreamExt;
use mongodb::bson::{Bson, Document, doc};
use mongodb::options::{ClientOptions, Credential, ServerAddress};
use mongodb::results::CollectionType;

use super::{Cell, Changes, Column, MAX_RESULT_ROWS, Namespace, QueryResult, ReadOnly, Rows, RowsQuery, Table, Values, require_key};
use crate::engines::Connection;

/// Shows a collection as a table: its columns are the top-level fields of the
/// documents on the page and every cell is relaxed Extended JSON, so "42"
/// stays a string and 42 a number when it is written back.
pub struct MongoConn {
	client: mongodb::Client,
}

fn mongo_key() -> Vec<String> {
	vec!["_id".into()]
}

impl MongoConn {
	pub(super) async fn open(c: &Connection) -> Result<MongoConn> {
		let mut opts = ClientOptions::default();
		opts.hosts = vec![ServerAddress::Tcp { host: c.host.clone(), port: Some(u16::try_from(c.port)?) }];
		opts.direct_connection = Some(true);
		opts.server_selection_timeout = Some(Duration::from_secs(10));
		if !c.user.is_empty() {
			opts.credential =
				Some(Credential::builder().username(c.user.clone()).password(c.password.clone()).source("admin".to_string()).build());
		}
		let client = mongodb::Client::with_options(opts)?;
		// Connecting is lazy; ping so a wrong password fails here and not on first use.
		client.database("admin").run_command(doc! {"ping": 1}).await?;
		Ok(MongoConn { client })
	}

	pub(super) async fn schema(&self) -> Result<Vec<Namespace>> {
		let mut namespaces = Vec::new();
		for name in self.client.list_database_names().await? {
			if matches!(name.as_str(), "admin" | "config" | "local") {
				continue;
			}
			let specs: Vec<_> = self.client.database(&name).list_collections().await?.try_collect().await?;
			let mut tables: Vec<Table> = specs
				.into_iter()
				.map(|spec| Table { name: spec.name, view: spec.collection_type == CollectionType::View, columns: Vec::new() })
				.collect();
			tables.sort_by(|a, b| a.name.cmp(&b.name));
			namespaces.push(Namespace { name, tables });
		}
		Ok(namespaces)
	}

	pub(super) async fn rows(&self, q: &RowsQuery) -> Result<Rows> {
		let coll = self.client.database(&q.namespace).collection::<Document>(&q.table);
		let filter = mongo_filter(&q.filters)?;
		let total = coll.count_documents(filter.clone()).await? as i64;
		let sort = if q.sort.is_empty() { "_id" } else { &q.sort };
		let order = if q.desc { -1 } else { 1 };
		let docs: Vec<Document> =
			coll.find(filter).sort(doc! {sort: order}).skip(q.offset as u64).limit(q.limit).await?.try_collect().await?;
		let (names, rows) = document_table(&docs);
		let columns = names
			.into_iter()
			.map(|name| Column { primary_key: name == "_id", name, kind: "ejson".into(), nullable: true, read_only: false })
			.collect();
		let key = if self.is_view(&q.namespace, &q.table).await { Vec::new() } else { mongo_key() };
		Ok(Rows { columns, key, rows, total, truncated: false })
	}

	async fn is_view(&self, database: &str, collection: &str) -> bool {
		let Ok(cursor) = self.client.database(database).list_collections().filter(doc! {"name": collection}).await else {
			return false;
		};
		let specs: Vec<_> = cursor.try_collect().await.unwrap_or_default();
		specs.len() == 1 && specs[0].collection_type == CollectionType::View
	}

	/// Writes one document at a time and stops at the first failure.
	// ponytail: no transaction, a standalone mongod has none; the count says how far it got.
	pub(super) async fn apply(&self, changes: &Changes) -> Result<i64> {
		if self.is_view(&changes.namespace, &changes.table).await {
			return Err(ReadOnly.into());
		}
		let coll = self.client.database(&changes.namespace).collection::<Document>(&changes.table);
		let key = mongo_key();
		let mut affected = 0;
		for u in &changes.updates {
			require_key(&key, &u.key)?;
			if u.values.is_empty() {
				continue;
			}
			let res = coll.update_one(doc! {"_id": ejson_value(&u.key["_id"])}, doc! {"$set": mongo_doc(&u.values)}).await?;
			affected += res.modified_count as i64;
		}
		for values in &changes.inserts {
			coll.insert_one(mongo_doc(values)).await?;
			affected += 1;
		}
		for d in &changes.deletes {
			require_key(&key, &d.key)?;
			let res = coll.delete_one(doc! {"_id": ejson_value(&d.key["_id"])}).await?;
			affected += res.deleted_count as i64;
		}
		Ok(affected)
	}

	/// Runs a database command written as Extended JSON, such as
	/// {"find": "users", "filter": {"age": {"$gt": 30}}}; a cursor's first batch
	/// becomes the rows, any other reply is one row.
	pub(super) async fn query(&self, namespace: &str, query: &str) -> Result<QueryResult> {
		let command = serde_json::from_str::<serde_json::Value>(query)
			.ok()
			.and_then(|v| Bson::try_from(v).ok())
			.and_then(|b| b.as_document().cloned())
			.context("a MongoDB command is one Extended JSON document")?;
		let database = if namespace.is_empty() { "admin" } else { namespace };
		let reply = self.client.database(database).run_command(command).await?;
		let mut docs = match reply.get_document("cursor").and_then(|c| c.get_array("firstBatch")) {
			Ok(batch) => batch.iter().filter_map(|v| v.as_document().cloned()).collect(),
			Err(_) => vec![reply],
		};
		let truncated = docs.len() > MAX_RESULT_ROWS;
		docs.truncate(MAX_RESULT_ROWS);
		let (columns, rows) = document_table(&docs);
		Ok(QueryResult { columns, rows, truncated, ..Default::default() })
	}
}

/// Lays documents out as rows under the union of their fields, _id first and
/// the rest in the order they first appear.
pub(super) fn document_table(docs: &[Document]) -> (Vec<String>, Vec<Vec<Cell>>) {
	let mut columns: Vec<String> = Vec::new();
	let mut parsed: Vec<HashMap<&str, String>> = Vec::new();
	for doc in docs {
		let mut fields = HashMap::new();
		for (key, value) in doc {
			if !columns.contains(key) {
				columns.push(key.clone());
			}
			fields.insert(key.as_str(), ejson_text(value));
		}
		parsed.push(fields);
	}
	if let Some(i) = columns.iter().position(|c| c == "_id") {
		let id = columns.remove(i);
		columns.insert(0, id);
	}
	let rows = parsed.iter().map(|fields| columns.iter().map(|name| fields.get(name.as_str()).cloned()).collect()).collect();
	(columns, rows)
}

pub(super) fn ejson_text(v: &Bson) -> String {
	v.clone().into_relaxed_extjson().to_string()
}

/// Reads a cell back: Extended JSON when it parses as one value, otherwise the
/// text itself as a string. A whole number that fits 32 bits reads as an
/// int32, the way relaxed Extended JSON is meant to round-trip.
pub(super) fn ejson_value(text: &str) -> Bson {
	match serde_json::from_str::<serde_json::Value>(text).ok().and_then(|v| Bson::try_from(v).ok()) {
		Some(value) => narrow_ints(value),
		None => Bson::String(text.into()),
	}
}

fn narrow_ints(value: Bson) -> Bson {
	match value {
		Bson::Int64(n) => i32::try_from(n).map_or(Bson::Int64(n), Bson::Int32),
		Bson::Array(items) => Bson::Array(items.into_iter().map(narrow_ints).collect()),
		Bson::Document(doc) => Bson::Document(doc.into_iter().map(|(k, v)| (k, narrow_ints(v))).collect()),
		other => other,
	}
}

fn mongo_doc(values: &Values) -> Document {
	values.iter().map(|(name, value)| (name.clone(), value.as_deref().map_or(Bson::Null, ejson_value))).collect()
}

fn mongo_filter(filters: &[super::Filter]) -> Result<Document> {
	let mut clauses = Vec::new();
	for f in filters {
		if f.column.is_empty() || f.column.starts_with('$') {
			bail!("filter on a field name");
		}
		let cond = match f.op.as_str() {
			"eq" => ejson_value(&f.value),
			"is_null" => Bson::Null,
			"is_not_null" => Bson::Document(doc! {"$ne": Bson::Null}),
			"contains" => Bson::Document(doc! {"$regex": regex::escape(&f.value), "$options": "i"}),
			"starts_with" => Bson::Document(doc! {"$regex": format!("^{}", regex::escape(&f.value))}),
			op => {
				let comparison = match op {
					"neq" => "$ne",
					"gt" => "$gt",
					"gte" => "$gte",
					"lt" => "$lt",
					"lte" => "$lte",
					other => bail!("unknown filter operator {other:?}"),
				};
				Bson::Document(doc! {comparison: ejson_value(&f.value)})
			}
		};
		let mut clause = Document::new();
		clause.insert(f.column.clone(), cond);
		clauses.push(Bson::Document(clause));
	}
	if clauses.is_empty() {
		return Ok(Document::new());
	}
	Ok(doc! {"$and": clauses})
}
