use anyhow::{Result, anyhow, bail};
use base64::Engine as _;
use serde::Deserialize;
use serde_json::{Value, json};

use super::sql::{Arg, Dialect, ResultSet, Runner, SqlConn, Statement};
use crate::engines::Connection;

/// Speaks sqld's Hrana-over-HTTP: every call is one pipeline that opens a
/// stream, runs and closes it, so nothing stays open between requests.
// ponytail: default namespace only; a namespaced sqld picks one from the Host header.
pub(super) struct HranaRunner {
	url: String,
	user: String,
	password: String,
	http: reqwest::Client,
}

pub(super) fn open(c: &Connection) -> SqlConn {
	SqlConn {
		dialect: Dialect::Sqlite,
		run: Runner::Libsql(HranaRunner {
			url: format!("http://{}/v2/pipeline", host_port(&c.host, c.port)),
			user: c.user.clone(),
			password: c.password.clone(),
			http: reqwest::Client::new(),
		}),
	}
}

fn host_port(host: &str, port: i64) -> String {
	if host.contains(':') { format!("[{host}]:{port}") } else { format!("{host}:{port}") }
}

#[derive(Debug, Default, Deserialize)]
struct HranaValue {
	#[serde(rename = "type")]
	kind: String,
	#[serde(default)]
	value: Value,
	#[serde(default)]
	base64: String,
}

#[derive(Debug, Deserialize)]
struct HranaError {
	message: String,
}

#[derive(Debug, Default, Deserialize)]
struct HranaColumn {
	#[serde(default)]
	name: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct HranaStmtResult {
	#[serde(default)]
	cols: Vec<HranaColumn>,
	#[serde(default)]
	rows: Vec<Vec<HranaValue>>,
	#[serde(default)]
	affected_row_count: i64,
}

impl HranaRunner {
	pub(super) async fn query(&mut self, sql: &str, args: &[Arg], max_rows: usize) -> Result<ResultSet> {
		let stmt = json!({"sql": sql, "args": hrana_args(args), "want_rows": true});
		let result: HranaStmtResult = self.pipeline(json!({"type": "execute", "stmt": stmt})).await?;
		let mut set = ResultSet {
			columns: result.cols.into_iter().map(|c| c.name.unwrap_or_default()).collect(),
			affected: result.affected_row_count,
			..Default::default()
		};
		for row in result.rows {
			if set.rows.len() == max_rows {
				set.truncated = true;
				break;
			}
			set.rows.push(row.iter().map(text).collect::<Result<_>>()?);
		}
		Ok(set)
	}

	/// Runs a batch in which every step waits for the one before it to succeed;
	/// if any fails, commit is skipped and rollback runs instead.
	pub(super) async fn transact(&mut self, stmts: &[Statement]) -> Result<i64> {
		let mut steps = vec![json!({"stmt": {"sql": "begin", "want_rows": false}})];
		for stmt in stmts {
			let previous = steps.len() - 1;
			steps.push(json!({
				"stmt": {"sql": stmt.sql, "args": hrana_args(&stmt.args), "want_rows": false},
				"condition": {"type": "ok", "step": previous},
			}));
		}
		let commit = steps.len();
		steps.push(json!({"stmt": {"sql": "commit", "want_rows": false}, "condition": {"type": "ok", "step": commit - 1}}));
		steps.push(
			json!({"stmt": {"sql": "rollback", "want_rows": false}, "condition": {"type": "not", "cond": {"type": "ok", "step": commit}}}),
		);

		#[derive(Deserialize)]
		struct BatchResult {
			#[serde(default)]
			step_results: Vec<Option<HranaStmtResult>>,
			#[serde(default)]
			step_errors: Vec<Option<HranaError>>,
		}
		let result: BatchResult = self.pipeline(json!({"type": "batch", "batch": {"steps": steps}})).await?;
		if let Some(err) = result.step_errors.into_iter().flatten().next() {
			bail!("{}", err.message);
		}
		Ok(result.step_results.iter().take(commit).skip(1).flatten().map(|r| r.affected_row_count).sum())
	}

	/// Sends one request followed by a close and decodes that request's result.
	async fn pipeline<T: serde::de::DeserializeOwned>(&self, request: Value) -> Result<T> {
		let body = json!({"baton": null, "requests": [request, {"type": "close"}]});
		let mut req = self.http.post(&self.url).json(&body);
		if !self.password.is_empty() {
			req = req.basic_auth(&self.user, Some(&self.password));
		}
		let resp = req.send().await?;
		let status = resp.status();
		if !status.is_success() {
			let message = resp.text().await.unwrap_or_default();
			bail!("sqld answered {status}: {}", message.chars().take(4096).collect::<String>().trim());
		}
		#[derive(Deserialize)]
		struct Pipeline {
			#[serde(default)]
			results: Vec<PipelineResult>,
		}
		#[derive(Deserialize)]
		struct PipelineResult {
			#[serde(rename = "type")]
			kind: String,
			error: Option<HranaError>,
			#[serde(default)]
			response: PipelineResponse,
		}
		#[derive(Default, Deserialize)]
		struct PipelineResponse {
			#[serde(default)]
			result: Value,
		}
		let decoded: Pipeline = resp.json().await?;
		let first = decoded.results.into_iter().next().ok_or_else(|| anyhow!("sqld sent no result"))?;
		if first.kind == "error" {
			bail!("{}", first.error.map(|e| e.message).unwrap_or_default());
		}
		Ok(serde_json::from_value(first.response.result)?)
	}
}

fn hrana_args(args: &[Arg]) -> Vec<Value> {
	args.iter()
		.map(|arg| match arg {
			Some(s) => json!({"type": "text", "value": s}),
			None => json!({"type": "null"}),
		})
		.collect()
}

/// A Hrana value the way the grid shows it: blobs as hex, since SQLite lets
/// any column hold one whatever its declared type.
fn text(v: &HranaValue) -> Result<Option<String>> {
	Ok(Some(match v.kind.as_str() {
		"null" => return Ok(None),
		"float" => v.value.to_string(),
		"blob" => {
			let bytes = base64::engine::general_purpose::STANDARD_NO_PAD.decode(v.base64.trim_end_matches('='))?;
			format!("\\x{}", hex::encode(bytes))
		}
		_ => match &v.value {
			Value::String(s) => s.clone(),
			other => bail!("unexpected hrana value {other}"),
		},
	}))
}
