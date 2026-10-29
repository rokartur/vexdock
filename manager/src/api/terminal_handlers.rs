use std::sync::Arc;
use std::time::Duration;

use axum::body::Bytes;
use axum::extract::ws::{Message, WebSocket, WebSocketUpgrade};
use axum::extract::{Path, State};
use axum::http::{HeaderMap, StatusCode};
use axum::response::IntoResponse;
use futures::{SinkExt, StreamExt};
use serde::Deserialize;
use serde_json::json;
use tokio::io::AsyncWriteExt;

use super::Server;
use super::respond::{ApiError, ApiResult, bad_request, decode, ok};
use crate::auth;
use crate::docker::ExecSession;
use crate::security;

/// Bounds a one-shot command so a hung process cannot hold the request open;
/// well inside the hour Nginx allows the API.
const EXEC_TIMEOUT: Duration = Duration::from_secs(10 * 60);

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct ExecRequest {
	command: String,
	shell: String,
}

/// Runs one shell line inside the service's container and answers with its
/// output: the non-interactive twin of the terminal, for scripts and agents
/// with a bearer token. A non-zero exit is still a 200: the command ran.
pub async fn exec(State(s): State<Arc<Server>>, Path(id): Path<String>, body: Bytes) -> ApiResult {
	let req: ExecRequest = decode(&body)?;
	let command = security::validate_task_command(&req.command).map_err(bad_request)?;
	let shell = security::validate_task_shell(&req.shell).map_err(bad_request)?;
	let container_id = s.resolve_service_container(&id).await.map_err(bad_request)?;
	let argv = [format!("/bin/{shell}"), "-c".to_string(), command];
	let (output, exit_code) = tokio::time::timeout(EXEC_TIMEOUT, s.docker.exec_output(&container_id, &argv))
		.await
		.map_err(|_| anyhow::anyhow!("the command ran longer than {} minutes", EXEC_TIMEOUT.as_secs() / 60))??;
	ok(&json!({"exit_code": exit_code, "output": output}))
}

/// The framing between xterm.js and the container exec: input carries
/// keystrokes, resize the new viewport.
#[derive(Deserialize, Default)]
#[serde(default)]
struct TerminalMessage {
	#[serde(rename = "type")]
	kind: String,
	data: String,
	cols: u16,
	rows: u16,
}

/// Upgrades to a WebSocket and attaches an interactive shell, the one endpoint
/// that is not SSE: a terminal needs a duplex channel.
pub async fn terminal(State(s): State<Arc<Server>>, Path(id): Path<String>, headers: HeaderMap, upgrade: WebSocketUpgrade) -> ApiResult {
	let container_id = s.resolve_service_container(&id).await.map_err(bad_request)?;
	// A GET, so the guard skipped the CSRF check; a shell is worth more than
	// any mutation, so it runs here.
	if !auth::same_origin(&headers) {
		return Err(ApiError::new(StatusCode::FORBIDDEN, "CROSS_ORIGIN", "Cross-origin request rejected"));
	}
	Ok(upgrade.on_upgrade(move |socket| attach(s, container_id, socket)).into_response())
}

async fn attach(s: Arc<Server>, container_id: String, mut socket: WebSocket) {
	let session = match s.docker.exec(&container_id, &[], 120, 30).await {
		Ok(session) => session,
		Err(err) => {
			let _ = socket.send(Message::Text(format!("{err:#}").into())).await;
			let _ = socket.send(Message::Close(None)).await;
			return;
		}
	};
	let ExecSession { id: exec_id, mut output, mut input } = session;
	let (mut to_browser, mut from_browser) = socket.split();

	let pump_output = async {
		while let Some(chunk) = output.next().await {
			let chunk = match chunk {
				Ok(chunk) => chunk,
				Err(err) => {
					tracing::debug!(error = %err, "terminal read ended");
					return;
				}
			};
			if to_browser.send(Message::Binary(chunk.into_bytes())).await.is_err() {
				return;
			}
		}
	};
	let pump_input = async {
		while let Some(Ok(message)) = from_browser.next().await {
			let keystrokes = match message {
				Message::Binary(data) => data,
				Message::Text(text) => {
					let Ok(msg) = serde_json::from_str::<TerminalMessage>(&text) else {
						continue;
					};
					match msg.kind.as_str() {
						"input" => Bytes::from(msg.data),
						"resize" => {
							match tokio::time::timeout(Duration::from_secs(5), s.docker.resize_exec(&exec_id, msg.cols, msg.rows)).await {
								Ok(Ok(())) => {}
								Ok(Err(err)) => tracing::debug!(error = %err, "terminal resize failed"),
								Err(_) => tracing::debug!("terminal resize timed out"),
							}
							continue;
						}
						_ => continue,
					}
				}
				Message::Close(_) => return,
				Message::Ping(_) | Message::Pong(_) => continue,
			};
			if input.write_all(&keystrokes).await.is_err() {
				return;
			}
		}
	};
	// Either side ending closes the other: dropping the session ends the exec.
	tokio::select! {
		() = pump_output => {}
		() = pump_input => {}
	}
}
