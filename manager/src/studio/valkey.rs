use std::collections::{BTreeMap, HashSet};
use std::time::Duration;

use anyhow::{Result, anyhow, bail};
use serde_json::Value;
use tokio::io::{AsyncBufRead, AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};
use tokio::net::TcpStream;

use super::{Cell, Changes, Column, Namespace, QueryResult, Rows, RowsQuery, Table, Values, printable, require_key};
use crate::engines::Connection;

/// A RESP2 client of just the commands Studio sends. The whole keyspace of
/// database 0 is one table, a row per key.
pub struct ValkeyConn {
	stream: BufReader<TcpStream>,
}

/// One RESP2 reply. An error reply is a value so a pipeline stays in step.
#[derive(Clone, Debug, PartialEq)]
pub(super) enum Reply {
	Str(Vec<u8>),
	Int(i64),
	Nil,
	Error(String),
	Array(Vec<Reply>),
}

impl Reply {
	fn text(&self) -> String {
		match self {
			Reply::Str(b) => String::from_utf8_lossy(b).into_owned(),
			Reply::Int(n) => n.to_string(),
			Reply::Nil => String::new(),
			Reply::Error(e) => e.clone(),
			Reply::Array(_) => self.json().to_string(),
		}
	}

	fn json(&self) -> Value {
		match self {
			Reply::Str(b) => Value::String(String::from_utf8_lossy(b).into_owned()),
			Reply::Int(n) => Value::from(*n),
			Reply::Nil => Value::Null,
			Reply::Error(e) => Value::String(e.clone()),
			Reply::Array(items) => Value::Array(items.iter().map(Reply::json).collect()),
		}
	}
}

const NAMESPACE: &str = "db0";
const TABLE: &str = "keys";
// ponytail: a page is cut from at most this many matching keys, sorted; a cursor-paged view if keyspaces outgrow it.
const MAX_SCANNED_KEYS: usize = 10_000;
const PREVIEW_ITEMS: usize = 100;

fn columns() -> Vec<Column> {
	let col = |name: &str, kind: &str| Column { name: name.into(), kind: kind.into(), ..Default::default() };
	vec![
		Column { primary_key: true, ..col("key", "string") },
		Column { read_only: true, ..col("type", "string") },
		Column { nullable: true, ..col("ttl", "integer") },
		Column { nullable: true, ..col("value", "string") },
	]
}

fn valkey_key() -> Vec<String> {
	vec!["key".into()]
}

pub(super) fn schema() -> Vec<Namespace> {
	vec![Namespace { name: NAMESPACE.into(), tables: vec![Table { name: TABLE.into(), view: false, columns: columns() }] }]
}

impl ValkeyConn {
	pub(super) async fn open(c: &Connection) -> Result<ValkeyConn> {
		let port = u16::try_from(c.port)?;
		let stream = tokio::time::timeout(Duration::from_secs(10), TcpStream::connect((c.host.as_str(), port)))
			.await
			.map_err(|_| anyhow!("connect to valkey timed out"))??;
		let mut conn = ValkeyConn { stream: BufReader::new(stream) };
		if !c.password.is_empty() {
			conn.call(&["AUTH", &c.password]).await?;
		}
		Ok(conn)
	}

	pub(super) async fn rows(&mut self, q: &RowsQuery) -> Result<Rows> {
		if q.namespace != NAMESPACE || q.table != TABLE {
			bail!("Valkey has one table, {NAMESPACE}.{TABLE}");
		}
		if !q.sort.is_empty() && q.sort != "key" {
			bail!("Valkey rows sort by key only");
		}
		let pattern = key_pattern(&q.filters)?;
		let (mut keys, truncated) = self.scan(&pattern).await?;
		keys.sort();
		if q.desc {
			keys.reverse();
		}
		let start = (q.offset as usize).min(keys.len());
		let end = (start + q.limit as usize).min(keys.len());
		let page = &keys[start..end];

		let mut meta = Vec::new();
		for key in page {
			meta.push(vec![b"TYPE".to_vec(), key.clone()]);
			meta.push(vec![b"TTL".to_vec(), key.clone()]);
		}
		let meta_replies = self.send(&meta).await?;
		let previews: Vec<Vec<Vec<u8>>> =
			page.iter().enumerate().map(|(i, key)| preview_command(&meta_replies[2 * i].text(), key)).collect();
		let values = self.send(&previews).await?;

		let mut rows = Vec::new();
		for (i, key) in page.iter().enumerate() {
			let kind = meta_replies[2 * i].text();
			let ttl = match meta_replies[2 * i + 1] {
				Reply::Int(seconds) if seconds >= 0 => Some(seconds.to_string()),
				_ => None,
			};
			let value = preview_text(&kind, &values[i])?;
			// ponytail: a key that is not UTF-8 shows as hex and cannot be edited from the grid.
			rows.push(vec![Some(printable(key)), Some(kind), ttl, value]);
		}
		Ok(Rows { columns: columns(), key: valkey_key(), rows, total: keys.len() as i64, truncated })
	}

	async fn scan(&mut self, pattern: &str) -> Result<(Vec<Vec<u8>>, bool)> {
		let mut seen = HashSet::new();
		let mut cursor = "0".to_string();
		loop {
			let reply = self.call(&["SCAN", &cursor, "MATCH", pattern, "COUNT", "1000"]).await?;
			let Reply::Array(parts) = &reply else { bail!("unexpected SCAN reply {reply:?}") };
			let [next, Reply::Array(batch)] = parts.as_slice() else { bail!("unexpected SCAN reply {reply:?}") };
			for key in batch {
				if let Reply::Str(b) = key {
					seen.insert(b.clone());
				}
			}
			cursor = next.text();
			if seen.len() >= MAX_SCANNED_KEYS {
				return Ok((seen.into_iter().take(MAX_SCANNED_KEYS).collect(), true));
			}
			if cursor == "0" {
				return Ok((seen.into_iter().collect(), false));
			}
		}
	}

	/// Queues every write in one MULTI/EXEC. Valkey does not roll back a command
	/// that fails inside EXEC, so a type check runs before it for SET.
	pub(super) async fn apply(&mut self, changes: &Changes) -> Result<i64> {
		if changes.namespace != NAMESPACE || changes.table != TABLE {
			bail!("Valkey has one table, {NAMESPACE}.{TABLE}");
		}
		let key_names = valkey_key();
		let mut cmds: Vec<Vec<String>> = Vec::new();
		for u in &changes.updates {
			require_key(&key_names, &u.key)?;
			let key = &u.key["key"];
			if u.values.contains_key("value") {
				let kind = self.call(&["TYPE", key]).await?.text();
				if kind != "string" {
					bail!("only string values are editable here; {key} is a {kind}, change it from the console");
				}
			}
			cmds.extend(key_writes(key, &u.values, &["KEEPTTL"])?);
		}
		for values in &changes.inserts {
			let Some(Some(key)) = values.get("key").filter(|k| k.as_deref().is_some_and(|k| !k.is_empty())) else {
				bail!("a new row needs a key");
			};
			if self.call(&["EXISTS", key]).await? != Reply::Int(0) {
				bail!("key {key} already exists");
			}
			let mut rest = values.clone();
			rest.remove("key");
			rest.entry("value".into()).or_insert_with(|| Some(String::new()));
			cmds.extend(key_writes(key, &rest, &[])?);
		}
		for d in &changes.deletes {
			require_key(&key_names, &d.key)?;
			cmds.push(vec!["UNLINK".into(), d.key["key"].clone()]);
		}
		if cmds.is_empty() {
			return Ok(0);
		}
		let mut batch = vec![vec![b"MULTI".to_vec()]];
		batch.extend(cmds.iter().map(|cmd| cmd.iter().map(|a| a.as_bytes().to_vec()).collect()));
		batch.push(vec![b"EXEC".to_vec()]);
		let replies = self.send(&batch).await?;
		let exec = replies.last().cloned();
		let results = match exec {
			Some(Reply::Array(results)) => results,
			_ => Vec::new(),
		};
		for reply in replies.iter().chain(results.iter()) {
			if let Reply::Error(e) = reply {
				bail!("{e}");
			}
		}
		Ok((changes.updates.len() + changes.inserts.len() + changes.deletes.len()) as i64)
	}

	/// Runs one command typed the way valkey-cli takes it, quotes and all.
	pub(super) async fn query(&mut self, query: &str) -> Result<QueryResult> {
		let args = split_command(query)?;
		let args: Vec<&str> = args.iter().map(String::as_str).collect();
		let cell = match self.call(&args).await? {
			Reply::Nil => None,
			Reply::Str(b) => Some(printable(&b)),
			Reply::Int(n) => Some(n.to_string()),
			other => Some(other.json().to_string()),
		};
		Ok(QueryResult { columns: vec!["reply".into()], rows: vec![vec![cell]], ..Default::default() })
	}

	/// Sends one command and turns an error reply into an error.
	async fn call(&mut self, args: &[&str]) -> Result<Reply> {
		let cmd = args.iter().map(|a| a.as_bytes().to_vec()).collect();
		match self.send(&[cmd]).await?.remove(0) {
			Reply::Error(e) => bail!("{e}"),
			reply => Ok(reply),
		}
	}

	/// Pipelines commands: all are written, then one reply read per command.
	async fn send(&mut self, cmds: &[Vec<Vec<u8>>]) -> Result<Vec<Reply>> {
		if cmds.is_empty() {
			return Ok(Vec::new());
		}
		let mut out = Vec::new();
		for cmd in cmds {
			out.extend_from_slice(format!("*{}\r\n", cmd.len()).as_bytes());
			for arg in cmd {
				out.extend_from_slice(format!("${}\r\n", arg.len()).as_bytes());
				out.extend_from_slice(arg);
				out.extend_from_slice(b"\r\n");
			}
		}
		self.stream.get_mut().write_all(&out).await?;
		let mut replies = Vec::with_capacity(cmds.len());
		for _ in cmds {
			replies.push(read_reply(&mut self.stream).await?);
		}
		Ok(replies)
	}
}

/// Decodes one RESP2 reply.
pub(super) async fn read_reply<R: AsyncBufRead + Unpin + Send>(r: &mut R) -> Result<Reply> {
	let mut line = Vec::new();
	if r.read_until(b'\n', &mut line).await? == 0 {
		bail!("valkey closed the connection");
	}
	let line = line.strip_suffix(b"\r\n").unwrap_or(&line);
	let Some((&kind, body)) = line.split_first() else { bail!("empty reply from Valkey") };
	let body = String::from_utf8_lossy(body).into_owned();
	match kind {
		b'+' => Ok(Reply::Str(body.into_bytes())),
		b'-' => Ok(Reply::Error(body)),
		b':' => Ok(Reply::Int(body.parse()?)),
		b'$' => {
			let n: i64 = body.parse()?;
			if n < 0 {
				return Ok(Reply::Nil);
			}
			let mut buf = vec![0; n as usize + 2];
			r.read_exact(&mut buf).await?;
			buf.truncate(n as usize);
			Ok(Reply::Str(buf))
		}
		b'*' => {
			let n: i64 = body.parse()?;
			if n < 0 {
				return Ok(Reply::Nil);
			}
			let mut items = Vec::with_capacity(n as usize);
			for _ in 0..n {
				items.push(Box::pin(read_reply(r)).await?);
			}
			Ok(Reply::Array(items))
		}
		_ => bail!("unexpected reply from Valkey: {:?}", String::from_utf8_lossy(line)),
	}
}

/// Turns a row's edited cells into commands, SET before the TTL so a new key
/// exists by the time EXPIRE reaches it; set_flags ride on SET.
fn key_writes(key: &str, values: &Values, set_flags: &[&str]) -> Result<Vec<Vec<String>>> {
	if let Some(name) = values.keys().find(|name| *name != "value" && *name != "ttl") {
		bail!("column {name:?} is read-only");
	}
	let mut cmds = Vec::new();
	if let Some(value) = values.get("value") {
		let Some(value) = value else { bail!("a Valkey value cannot be null; delete the key instead") };
		let mut cmd = vec!["SET".to_string(), key.to_string(), value.clone()];
		cmd.extend(set_flags.iter().map(|f| f.to_string()));
		cmds.push(cmd);
	}
	if let Some(ttl) = values.get("ttl") {
		match ttl.as_deref() {
			None | Some("") => cmds.push(vec!["PERSIST".into(), key.into()]),
			Some(ttl) => {
				if !ttl.parse::<i64>().is_ok_and(|seconds| seconds > 0) {
					bail!("ttl must be a positive number of seconds, got {ttl:?}");
				}
				cmds.push(vec!["EXPIRE".into(), key.into(), ttl.into()]);
			}
		}
	}
	Ok(cmds)
}

/// Turns the grid's filter into a SCAN glob; only the key column filters.
pub(super) fn key_pattern(filters: &[super::Filter]) -> Result<String> {
	let Some(f) = filters.first() else { return Ok("*".into()) };
	if filters.len() > 1 || f.column != "key" {
		bail!("Valkey rows filter by one condition on the key");
	}
	let mut literal = String::new();
	for c in f.value.chars() {
		if matches!(c, '\\' | '*' | '?' | '[' | ']') {
			literal.push('\\');
		}
		literal.push(c);
	}
	match f.op.as_str() {
		"eq" => Ok(literal),
		"starts_with" => Ok(format!("{literal}*")),
		"contains" => Ok(format!("*{literal}*")),
		op => bail!("Valkey keys filter by eq, starts_with or contains, not {op}"),
	}
}

fn preview_command(kind: &str, key: &[u8]) -> Vec<Vec<u8>> {
	let n = (PREVIEW_ITEMS - 1).to_string();
	let count = PREVIEW_ITEMS.to_string();
	let args: Vec<&str> = match kind {
		"string" => vec!["GET", "\0"],
		"list" => vec!["LRANGE", "\0", "0", &n],
		"set" => vec!["SSCAN", "\0", "0", "COUNT", &count],
		"zset" => vec!["ZRANGE", "\0", "0", &n, "WITHSCORES"],
		"hash" => vec!["HSCAN", "\0", "0", "COUNT", &count],
		"stream" => vec!["XRANGE", "\0", "-", "+", "COUNT", &count],
		_ => vec!["TYPE", "\0"],
	};
	// "\0" stands for the key, which may not be UTF-8.
	args.into_iter().map(|a| if a == "\0" { key.to_vec() } else { a.as_bytes().to_vec() }).collect()
}

/// A string as itself and anything else as JSON of its first items.
fn preview_text(kind: &str, reply: &Reply) -> Result<Cell> {
	if let Reply::Error(e) = reply {
		bail!("{e}");
	}
	let items = match (kind, reply) {
		("string", Reply::Str(b)) => return Ok(Some(printable(b))),
		("set" | "hash", Reply::Array(scan)) if scan.len() == 2 => match &scan[1] {
			Reply::Array(items) => Some(items.as_slice()),
			_ => None,
		},
		("list" | "zset" | "stream", Reply::Array(items)) => Some(items.as_slice()),
		("list" | "zset" | "stream", _) => None,
		_ => return Ok(None),
	};
	if kind == "hash" {
		let items = items.unwrap_or_default();
		let fields: BTreeMap<String, Value> = items.as_chunks::<2>().0.iter().map(|pair| (pair[0].text(), pair[1].json())).collect();
		return Ok(Some(serde_json::to_string(&fields)?));
	}
	let Some(items) = items else { return Ok(Some("null".into())) };
	let shown: Vec<Value> = items.iter().take(PREVIEW_ITEMS).map(Reply::json).collect();
	Ok(Some(serde_json::to_string(&shown)?))
}

/// Splits a line into arguments; quotes group, and a backslash inside double
/// quotes takes the next character as is.
pub(super) fn split_command(line: &str) -> Result<Vec<String>> {
	let mut args = Vec::new();
	let mut arg = String::new();
	let mut quote = None;
	let (mut in_arg, mut escaped) = (false, false);
	for c in line.chars() {
		if escaped {
			arg.push(c);
			escaped = false;
		} else if quote == Some(c) {
			quote = None;
		} else if quote == Some('"') && c == '\\' {
			escaped = true;
		} else if quote.is_some() {
			arg.push(c);
		} else if c == '"' || c == '\'' {
			quote = Some(c);
			in_arg = true;
		} else if c.is_whitespace() {
			if in_arg {
				args.push(std::mem::take(&mut arg));
				in_arg = false;
			}
		} else {
			arg.push(c);
			in_arg = true;
		}
	}
	if quote.is_some() {
		bail!("unterminated quote");
	}
	if in_arg {
		args.push(arg);
	}
	if args.is_empty() {
		bail!("type a command, such as GET key");
	}
	Ok(args)
}
