use std::collections::BTreeMap;

use super::sql::{Dialect, SqlBuilder, Statement, statements};
use super::*;

fn users() -> Table {
	let col = |name: &str, kind: &str| Column { name: name.into(), kind: kind.into(), ..Default::default() };
	Table {
		name: "users".into(),
		view: false,
		columns: vec![
			Column { primary_key: true, ..col("org", "integer") },
			Column { primary_key: true, ..col("id", "integer") },
			Column { nullable: true, ..col("name", "text") },
			Column { read_only: true, ..col("slug", "text") },
		],
	}
}

fn key(pairs: &[(&str, &str)]) -> BTreeMap<String, String> {
	pairs.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect()
}

fn values(pairs: &[(&str, Option<&str>)]) -> Values {
	pairs.iter().map(|(k, v)| (k.to_string(), v.map(String::from))).collect()
}

fn stmt(sql: &str, args: &[Option<&str>]) -> Statement {
	Statement { sql: sql.into(), args: args.iter().map(|a| a.map(String::from)).collect() }
}

#[test]
fn statements_per_dialect() {
	let changes = Changes {
		namespace: "app".into(),
		table: "users".into(),
		updates: vec![Update { key: key(&[("org", "1"), ("id", "2")]), values: values(&[("name", None)]) }],
		inserts: vec![values(&[("id", Some("3")), ("name", Some("o'hara"))])],
		deletes: vec![Delete { key: key(&[("id", "4"), ("org", "1")]) }],
	};
	let want = [
		(
			Dialect::Postgres,
			vec![
				stmt(
					r#"update "app"."users" set "name" = $1::text::text where "id" = $2::text::integer and "org" = $3::text::integer"#,
					&[None, Some("2"), Some("1")],
				),
				stmt(
					r#"insert into "app"."users" ("id", "name") values ($1::text::integer, $2::text::text)"#,
					&[Some("3"), Some("o'hara")],
				),
				stmt(r#"delete from "app"."users" where "id" = $1::text::integer and "org" = $2::text::integer"#, &[Some("4"), Some("1")]),
			],
		),
		(
			Dialect::Mysql,
			vec![
				stmt("update `users` set `name` = ? where `id` = ? and `org` = ?", &[None, Some("2"), Some("1")]),
				stmt("insert into `users` (`id`, `name`) values (?, ?)", &[Some("3"), Some("o'hara")]),
				stmt("delete from `users` where `id` = ? and `org` = ?", &[Some("4"), Some("1")]),
			],
		),
	];
	for (dialect, stmts) in want {
		assert_eq!(statements(dialect, &users(), &changes).unwrap(), stmts, "{dialect:?}");
	}
}

#[test]
fn statements_refuse() {
	let cases = [
		("partial key", Changes { deletes: vec![Delete { key: key(&[("id", "1")]) }], ..Default::default() }),
		("read-only column", Changes { inserts: vec![values(&[("slug", Some("x"))])], ..Default::default() }),
		(
			"unknown column",
			Changes {
				updates: vec![Update { key: key(&[("org", "1"), ("id", "1")]), values: values(&[("nope", None)]) }],
				..Default::default()
			},
		),
	];
	for (name, changes) in cases {
		assert!(statements(Dialect::Postgres, &users(), &changes).is_err(), "{name}: want an error");
	}
	let view = Table { name: "v".into(), view: true, columns: users().columns };
	let err = statements(Dialect::Postgres, &view, &Changes::default()).unwrap_err();
	assert!(err.is::<ReadOnly>(), "view: got {err}");
}

#[test]
fn filter_binds_and_escapes() {
	let mut b = SqlBuilder::new(Dialect::Sqlite);
	let filters = [
		Filter { column: "name".into(), op: "contains".into(), value: "50%_off!".into() },
		Filter { column: "id".into(), op: "gte".into(), value: "7".into() },
		Filter { column: "slug".into(), op: "is_null".into(), value: String::new() },
	];
	let got = b.filter(&users().columns, &filters).unwrap();
	assert_eq!(got, r#" where "name" like ? escape '!' and "id" >= ? and "slug" is null"#);
	assert_eq!(b.args, [Some("%50!%!_off!!%".to_string()), Some("7".to_string())]);
	let injection = [Filter { column: "x\" or 1=1 --".into(), op: "eq".into(), value: String::new() }];
	assert!(b.filter(&users().columns, &injection).is_err(), "an unknown column must be refused, not quoted");
}

// Arguments become hex literals, and a ? inside a quoted name or string is
// never mistaken for a placeholder.
#[test]
fn mysql_interpolates_outside_quotes() {
	let got = super::mysql::interpolate("select `a?` from t where x = ? and y = '?' and z = ?", &[Some("o'h".into()), None]);
	assert_eq!(got, "select `a?` from t where x = _utf8mb4 X'6f2768' and y = '?' and z = NULL");
}

#[test]
fn ejson_round_trip() {
	use mongodb::bson::{Bson, oid::ObjectId};
	for value in [Bson::Int32(42), Bson::String("42".into()), Bson::ObjectId(ObjectId::new())] {
		let cell = super::mongo::ejson_text(&value);
		assert_eq!(super::mongo::ejson_value(&cell), value, "{cell}");
	}
	assert_eq!(super::mongo::ejson_value("plain words"), Bson::String("plain words".into()));
}

#[test]
fn split_command() {
	let got = super::valkey::split_command(r#"SET  "a key" 'it''s' "say \"hi\"""#).unwrap();
	assert_eq!(got, ["SET", "a key", "its", r#"say "hi""#]);
	assert!(super::valkey::split_command(r#"GET "open"#).is_err(), "an unterminated quote must fail");
}

#[tokio::test]
async fn read_reply() {
	use super::valkey::Reply;
	let mut r = tokio::io::BufReader::new(&b"*4\r\n$5\r\na\r\nbc\r\n:-2\r\n$-1\r\n-WRONGTYPE no\r\n"[..]);
	let got = super::valkey::read_reply(&mut r).await.unwrap();
	let want = Reply::Array(vec![Reply::Str(b"a\r\nbc".to_vec()), Reply::Int(-2), Reply::Nil, Reply::Error("WRONGTYPE no".into())]);
	assert_eq!(got, want);
}

#[test]
fn key_pattern() {
	let filter = |column: &str, op: &str, value: &str| Filter { column: column.into(), op: op.into(), value: value.into() };
	assert_eq!(super::valkey::key_pattern(&[filter("key", "starts_with", "user:*[1]")]).unwrap(), r"user:\*\[1\]*");
	assert!(super::valkey::key_pattern(&[filter("value", "eq", "x")]).is_err(), "only the key filters");
}
