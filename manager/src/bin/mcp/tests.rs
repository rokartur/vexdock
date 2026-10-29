use std::sync::{Arc, Mutex};

use axum::Json;
use axum::http::HeaderMap;
use axum::routing::get;
use serde_json::{Value, json};

use super::*;
use crate::tools::EnvVar;

type Recorded = Arc<Mutex<Vec<EnvVar>>>;

/// Answers the routes the test drives and records the variables PUT, so the
/// merge can be checked against what reached the manager.
async fn fake_manager(put: Recorded) -> String {
	fn authorized(headers: &HeaderMap) -> Result<(), (StatusCode, &'static str)> {
		if headers.get("authorization").is_some_and(|v| v == "Bearer good") {
			return Ok(());
		}
		Err((StatusCode::UNAUTHORIZED, r#"{"error":{"code":"UNAUTHORIZED","message":"Authentication required"}}"#))
	}
	let app = Router::new()
		.route(
			"/api/me",
			get(|headers: HeaderMap| async move {
				authorized(&headers)?;
				Ok::<_, (StatusCode, &'static str)>(Json(json!({"user": {"id": "u1"}, "access": {"admin": false, "projects": []}})))
			}),
		)
		.route(
			"/api/services/s1/variables",
			get(|headers: HeaderMap| async move {
				authorized(&headers)?;
				Ok::<_, (StatusCode, &'static str)>(Json(json!([
					{"key": "KEEP", "value": "1", "is_secret": false},
					{"key": "CHANGE", "value": "old", "is_secret": true},
					{"key": "DROP", "value": "x", "is_secret": false},
				])))
			})
			.put(move |headers: HeaderMap, Json(body): Json<Value>| async move {
				authorized(&headers)?;
				let vars: Vec<EnvVar> = serde_json::from_value(body["variables"].clone()).unwrap();
				*put.lock().unwrap() = vars.clone();
				Ok::<_, (StatusCode, &'static str)>(Json(vars))
			}),
		);
	serve(app).await
}

async fn serve(app: Router) -> String {
	let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
	let addr = listener.local_addr().unwrap();
	tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
	format!("http://{addr}")
}

async fn rpc(endpoint: &str, token: &str, method: &str, params: Value) -> reqwest::Response {
	reqwest::Client::new()
		.post(endpoint)
		.header("authorization", format!("Bearer {token}"))
		.header("accept", "application/json, text/event-stream")
		.json(&json!({"jsonrpc": "2.0", "id": 1, "method": method, "params": params}))
		.send()
		.await
		.unwrap()
}

async fn result(endpoint: &str, method: &str, params: Value) -> Value {
	let resp = rpc(endpoint, "good", method, params).await;
	assert_eq!(resp.status(), StatusCode::OK);
	let body: Value = resp.json().await.unwrap();
	body["result"].clone()
}

#[tokio::test]
async fn server() {
	let put = Recorded::default();
	let manager_url = fake_manager(Arc::clone(&put)).await;
	let app = App {
		manager_url,
		http: reqwest::Client::new(),
		version: "test".into(),
		resource_metadata: resource_metadata_url("https://panel.example.com/"),
	};
	let endpoint = format!("{}/mcp", serve(router(Arc::new(app))).await);

	let refused = rpc(&endpoint, "bad", "initialize", json!({})).await;
	assert_eq!(refused.status(), StatusCode::UNAUTHORIZED, "a token the manager rejects connected");
	// An OAuth client starts from the 401's pointer to the resource metadata.
	let anonymous = reqwest::Client::new().post(&endpoint).header("content-type", "application/json").send().await.unwrap();
	assert_eq!(
		anonymous.headers()["www-authenticate"],
		r#"Bearer resource_metadata="https://panel.example.com/.well-known/oauth-protected-resource/mcp""#
	);

	let init = result(
		&endpoint,
		"initialize",
		json!({"protocolVersion": "2025-06-18", "capabilities": {}, "clientInfo": {"name": "test", "version": "0"}}),
	)
	.await;
	assert_eq!(init["protocolVersion"], "2025-06-18");
	assert_eq!(init["serverInfo"]["name"], "vexdock");

	let list = result(&endpoint, "tools/list", json!({})).await;
	let tools = list["tools"].as_array().unwrap();
	assert_eq!(tools.len(), 23);
	// Every listed tool is one run knows: an empty call fails on its arguments
	// or on the fake manager, never as an unknown tool.
	for tool in tools {
		let name = tool["name"].as_str().unwrap();
		let called = result(&endpoint, "tools/call", json!({"name": name, "arguments": {}})).await;
		let text = called["content"][0]["text"].as_str().unwrap();
		assert!(!text.starts_with("unknown tool"), "{name} is listed but not run");
	}

	let called = result(
		&endpoint,
		"tools/call",
		json!({"name": "set_variables", "arguments": {"scope": "service", "id": "s1", "set": {"CHANGE": "new", "ADD": "2"}, "remove": ["DROP"]}}),
	)
	.await;
	assert!(called["isError"].is_null(), "set_variables: {called}");
	let want = [("KEEP", "1", false), ("CHANGE", "new", true), ("ADD", "2", false)].map(|(key, value, is_secret)| EnvVar {
		key: key.into(),
		value: value.into(),
		is_secret,
	});
	assert_eq!(*put.lock().unwrap(), want);

	let called =
		result(&endpoint, "tools/call", json!({"name": "service_action", "arguments": {"service_id": "s1", "action": "explode"}})).await;
	assert_eq!(called["isError"], true, "an unknown action was not a tool error: {called}");

	// With a progress token the answer is an event stream ending in the result.
	let streamed = rpc(&endpoint, "good", "tools/call", json!({"name": "whoami", "arguments": {}, "_meta": {"progressToken": "p"}})).await;
	assert!(streamed.headers()["content-type"].to_str().unwrap().starts_with("text/event-stream"));
	let body = streamed.text().await.unwrap();
	assert!(body.contains(r#""id":1"#) && body.contains("u1"), "{body}");
}
