use std::fmt;

use futures::StreamExt;
use reqwest::{Method, StatusCode};
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

/// The longest server-sent event line read from the manager.
const MAX_EVENT_LINE: usize = 4 << 20;

/// Calls the manager's REST API with the MCP client's own bearer token, so the
/// manager alone decides what the caller may do.
#[derive(Clone)]
pub struct Manager {
	pub base: String,
	pub http: reqwest::Client,
	/// The caller's Authorization header, forwarded as is.
	pub auth: String,
	pub client_ip: String,
}

/// The manager's error envelope, kept whole so the agent sees the code it can
/// act on (FORBIDDEN, NOT_FOUND, CONFIRMATION_REQUIRED, ...).
#[derive(Debug, Deserialize, Default)]
#[serde(default)]
pub struct ApiError {
	#[serde(skip)]
	pub status: u16,
	pub code: String,
	pub message: String,
}

impl fmt::Display for ApiError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{} {}: {}", self.status, self.code, self.message)
	}
}

impl std::error::Error for ApiError {}

pub type Query<'a> = &'a [(&'a str, String)];

impl Manager {
	async fn send(&self, method: Method, path: &str, query: Query<'_>, body: Option<&Value>) -> anyhow::Result<reqwest::Response> {
		let mut req = self.http.request(method, format!("{}{path}", self.base)).header("Authorization", &self.auth);
		if !query.is_empty() {
			req = req.query(query);
		}
		if let Some(body) = body {
			req = req.json(body);
		}
		// The manager's audit log names the caller by this header.
		if !self.client_ip.is_empty() {
			req = req.header("X-Real-IP", &self.client_ip);
		}
		let res = req.send().await?;
		if res.status().as_u16() < 400 {
			return Ok(res);
		}
		let status = res.status().as_u16();
		let raw = res.bytes().await.unwrap_or_default();
		let raw = &raw[..raw.len().min(64 << 10)];
		#[derive(Deserialize)]
		struct Envelope {
			error: ApiError,
		}
		let mut err = match serde_json::from_slice::<Envelope>(raw) {
			Ok(envelope) if !envelope.error.code.is_empty() => envelope.error,
			_ => ApiError { code: "HTTP_ERROR".into(), message: String::from_utf8_lossy(raw).trim().to_string(), ..Default::default() },
		};
		err.status = status;
		Err(err.into())
	}

	/// The response body as JSON.
	pub async fn call(&self, method: Method, path: &str, query: Query<'_>, body: Option<&Value>) -> anyhow::Result<Value> {
		let raw = self.send(method, path, query, body).await?.bytes().await?;
		if raw.is_empty() {
			return Ok(Value::Null);
		}
		Ok(serde_json::from_slice(&raw)?)
	}

	/// The response body decoded into T.
	pub async fn decode<T: DeserializeOwned>(
		&self,
		method: Method,
		path: &str,
		query: Query<'_>,
		body: Option<&Value>,
	) -> anyhow::Result<T> {
		Ok(serde_json::from_value(self.call(method, path, query, body).await?)?)
	}

	/// Reads a server-sent event stream and collects the data of every event
	/// named name, stopping after limit of them (0: no limit) or when the
	/// stream ends.
	pub async fn events(&self, path: &str, query: Query<'_>, name: &str, limit: usize) -> anyhow::Result<Vec<Value>> {
		let mut body = self.send(Method::GET, path, query, None).await?.bytes_stream();
		let (mut out, mut event, mut pending) = (Vec::new(), String::new(), Vec::<u8>::new());
		while let Some(chunk) = body.next().await {
			pending.extend_from_slice(&chunk?);
			while let Some(end) = pending.iter().position(|&b| b == b'\n') {
				let line: Vec<u8> = pending.drain(..=end).collect();
				let line = String::from_utf8_lossy(&line);
				let line = line.trim_end_matches(['\n', '\r']);
				if let Some(after) = line.strip_prefix("event: ") {
					event = after.to_string();
				} else if let Some(after) = line.strip_prefix("data: ").filter(|_| event == name) {
					out.push(serde_json::from_str(after)?);
					if out.len() == limit {
						return Ok(out);
					}
				}
			}
			if pending.len() > MAX_EVENT_LINE {
				anyhow::bail!("an event from the manager is longer than {} MiB", MAX_EVENT_LINE >> 20);
			}
		}
		Ok(out)
	}
}

/// Whether the manager refused the token itself.
pub fn unauthorized(err: &anyhow::Error) -> bool {
	err.downcast_ref::<ApiError>().is_some_and(|e| e.status == StatusCode::UNAUTHORIZED.as_u16())
}
