//! Vexdock's Model Context Protocol server. It holds no state and no secret:
//! every tool call becomes REST calls to the manager, made with the caller's
//! own bearer token, so the manager's token scopes are the only permission
//! model. The transport is MCP's streamable HTTP in its stateless form: one
//! JSON-RPC message per POST, answered with JSON, or with an event stream when
//! the client asked for progress.

mod manager;
mod tools;

use std::convert::Infallible;
use std::sync::Arc;

use axum::Router;
use axum::body::Bytes;
use axum::extract::State;
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::sse::{Event, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::post;
use serde::Deserialize;
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_stream::StreamExt;
use tokio_stream::wrappers::UnboundedReceiverStream;

use crate::manager::Manager;

/// Newest first; an initialize asking for anything else gets the first.
const PROTOCOL_VERSIONS: [&str; 4] = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];

struct App {
	manager_url: String,
	http: reqwest::Client,
	version: String,
	/// Where a 401 sends an OAuth client to discover the manager's
	/// authorization server (RFC 9728). Empty without a public URL.
	resource_metadata: String,
}

#[tokio::main]
async fn main() -> anyhow::Result<()> {
	tracing_subscriber::fmt().with_writer(std::io::stderr).init();
	let manager_url = env_or("VEXDOCK_MANAGER_URL", "http://manager:8080");
	let listen = env_or("MCP_LISTEN", ":8090");
	let app = Arc::new(App {
		// No client timeout: deploy waits up to its own limit.
		http: reqwest::Client::new(),
		version: env_or("PLATFORM_VERSION", "dev"),
		resource_metadata: resource_metadata_url(&std::env::var("PLATFORM_PUBLIC_URL").unwrap_or_default()),
		manager_url: manager_url.clone(),
	});
	let addr = if listen.starts_with(':') { format!("0.0.0.0{listen}") } else { listen };
	let listener = tokio::net::TcpListener::bind(&addr).await?;
	tracing::info!(addr, manager = manager_url, "mcp listening");
	axum::serve(listener, router(app)).await?;
	Ok(())
}

fn router(app: Arc<App>) -> Router {
	// Stateless: there is no server-initiated stream to GET and no session to DELETE.
	Router::new().route("/mcp", post(handle).get(method_not_allowed).delete(method_not_allowed)).with_state(app)
}

async fn method_not_allowed() -> StatusCode {
	StatusCode::METHOD_NOT_ALLOWED
}

fn resource_metadata_url(public_url: &str) -> String {
	if public_url.is_empty() {
		return String::new();
	}
	format!("{}/.well-known/oauth-protected-resource/mcp", public_url.trim_end_matches('/'))
}

fn env_or(key: &str, fallback: &str) -> String {
	std::env::var(key).ok().filter(|v| !v.is_empty()).unwrap_or_else(|| fallback.to_string())
}

#[derive(Deserialize)]
struct Message {
	#[serde(default)]
	id: Option<Value>,
	method: Option<String>,
	#[serde(default)]
	params: Value,
}

async fn handle(State(app): State<Arc<App>>, headers: HeaderMap, body: Bytes) -> Response {
	let manager = Manager {
		base: app.manager_url.clone(),
		http: app.http.clone(),
		auth: header_value(&headers, "authorization"),
		client_ip: header_value(&headers, "x-real-ip"),
	};
	if let Some(refused) = verify(&app, &manager).await {
		return refused;
	}
	let Ok(message) = serde_json::from_slice::<Message>(&body) else {
		return rpc_json(
			&json!({"jsonrpc": "2.0", "id": null, "error": {"code": -32700, "message": "a JSON-RPC message object is required"}}),
		);
	};
	let (Some(id), Some(method)) = (message.id, message.method) else {
		// A notification or a response: nothing to answer.
		return StatusCode::ACCEPTED.into_response();
	};
	let result = match method.as_str() {
		"initialize" => initialize(&app, &message.params),
		"ping" => json!({}),
		"tools/list" => json!({"tools": tools::list()}),
		"tools/call" => return call_tool(manager, id, message.params).await,
		_ => {
			return rpc_json(
				&json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32601, "message": format!("method {method:?} not found")}}),
			);
		}
	};
	rpc_json(&json!({"jsonrpc": "2.0", "id": id, "result": result}))
}

/// Asks the manager whether the token is good, so a bad one is a 401 at the
/// transport where MCP clients expect it, not an error inside a tool.
async fn verify(app: &App, manager: &Manager) -> Option<Response> {
	let fields: Vec<&str> = manager.auth.split_whitespace().collect();
	let bearer = fields.len() == 2 && fields[0].eq_ignore_ascii_case("bearer");
	let refused = if !bearer {
		"no bearer token".to_string()
	} else {
		match manager.call(reqwest::Method::GET, "/api/me", &[], None).await {
			Ok(_) => return None,
			Err(err) if manager::unauthorized(&err) => "invalid token".to_string(),
			Err(err) => return Some((StatusCode::INTERNAL_SERVER_ERROR, format!("{err:#}")).into_response()),
		}
	};
	let mut resp = (StatusCode::UNAUTHORIZED, refused).into_response();
	if !app.resource_metadata.is_empty()
		&& let Ok(value) = HeaderValue::from_str(&format!("Bearer resource_metadata={:?}", app.resource_metadata))
	{
		resp.headers_mut().insert(header::WWW_AUTHENTICATE, value);
	}
	Some(resp)
}

fn initialize(app: &App, params: &Value) -> Value {
	let asked = params["protocolVersion"].as_str().unwrap_or_default();
	let version = PROTOCOL_VERSIONS.iter().find(|v| **v == asked).unwrap_or(&PROTOCOL_VERSIONS[0]);
	json!({
		"protocolVersion": version,
		"capabilities": {"tools": {}},
		"serverInfo": {"name": "vexdock", "version": app.version},
		"instructions": tools::INSTRUCTIONS,
	})
}

/// Progress notifications for one tools/call, sent only when the client asked
/// for them with a progress token.
pub struct Progress {
	token: Value,
	events: Option<mpsc::UnboundedSender<Value>>,
}

impl Progress {
	pub fn notify(&self, progress: u64, message: String) {
		if let Some(events) = &self.events {
			let params = json!({"progressToken": self.token, "progress": progress, "message": message});
			let _ = events.send(json!({"jsonrpc": "2.0", "method": "notifications/progress", "params": params}));
		}
	}
}

async fn call_tool(manager: Manager, id: Value, params: Value) -> Response {
	let name = params["name"].as_str().unwrap_or_default().to_string();
	let args = params["arguments"].clone();
	let token = params["_meta"]["progressToken"].clone();
	if token.is_null() {
		let result = tool_result(tools::run(&name, args, &manager, &Progress { token, events: None }).await);
		return rpc_json(&json!({"jsonrpc": "2.0", "id": id, "result": result}));
	}
	let (events, received) = mpsc::unbounded_channel();
	tokio::spawn(async move {
		let progress = Progress { token, events: Some(events.clone()) };
		// A client that hangs up ends the call with it.
		tokio::select! {
			outcome = tools::run(&name, args, &manager, &progress) => {
				let _ = events.send(json!({"jsonrpc": "2.0", "id": id, "result": tool_result(outcome)}));
			}
			() = events.closed() => {}
		}
	});
	let stream = UnboundedReceiverStream::new(received)
		.map(|message| Ok::<_, Infallible>(Event::default().event("message").data(message.to_string())));
	Sse::new(stream).into_response()
}

fn tool_result(outcome: anyhow::Result<Value>) -> Value {
	match outcome {
		Ok(Value::String(text)) => json!({"content": [{"type": "text", "text": text}]}),
		Ok(value) => json!({"content": [{"type": "text", "text": serde_json::to_string_pretty(&value).unwrap_or_default()}]}),
		Err(err) => json!({"content": [{"type": "text", "text": format!("{err:#}")}], "isError": true}),
	}
}

fn rpc_json(message: &Value) -> Response {
	([(header::CONTENT_TYPE, "application/json")], message.to_string()).into_response()
}

fn header_value(headers: &HeaderMap, name: &str) -> String {
	headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string()
}

#[cfg(test)]
mod tests;
