use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;

use crate::database;

/// The single error shape every endpoint returns, so the frontend can map codes
/// to messages instead of parsing prose.
#[derive(Debug)]
pub struct ApiError {
	pub status: StatusCode,
	pub code: &'static str,
	pub message: String,
	pub details: Option<Value>,
}

pub type ApiResult = Result<Response, ApiError>;

impl ApiError {
	pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> ApiError {
		ApiError { status, code, message: message.into(), details: None }
	}

	pub fn with_details(mut self, details: Value) -> ApiError {
		self.details = Some(details);
		self
	}
}

impl IntoResponse for ApiError {
	fn into_response(self) -> Response {
		let mut error = serde_json::json!({"code": self.code, "message": self.message});
		if let Some(details) = self.details {
			error["details"] = details;
		}
		json(self.status, &serde_json::json!({ "error": error }))
	}
}

/// Anything a handler does not classify is a server error. It never leaks
/// internals beyond the error text the platform itself produced.
impl From<anyhow::Error> for ApiError {
	fn from(err: anyhow::Error) -> ApiError {
		server_error(err)
	}
}

pub fn json(status: StatusCode, payload: &impl Serialize) -> Response {
	match serde_json::to_vec(payload) {
		Ok(mut body) => {
			body.push(b'\n');
			let mut resp = (status, body).into_response();
			resp.headers_mut().insert(header::CONTENT_TYPE, HeaderValue::from_static("application/json"));
			resp
		}
		Err(err) => server_error(err.into()).into_response(),
	}
}

pub fn ok(payload: &impl Serialize) -> ApiResult {
	Ok(json(StatusCode::OK, payload))
}

pub fn created(payload: &impl Serialize) -> ApiResult {
	Ok(json(StatusCode::CREATED, payload))
}

/// {"ok": true}, what an action with nothing to report answers.
pub fn done() -> ApiResult {
	ok(&serde_json::json!({"ok": true}))
}

/// A validation failure with the message the caller can show.
pub fn bad_request(err: impl std::fmt::Display) -> ApiError {
	ApiError::new(StatusCode::BAD_REQUEST, "INVALID_REQUEST", err.to_string())
}

pub fn server_error(err: anyhow::Error) -> ApiError {
	ApiError::new(StatusCode::INTERNAL_SERVER_ERROR, "INTERNAL", format!("{err:#}"))
}

pub fn not_found() -> ApiError {
	ApiError::new(StatusCode::NOT_FOUND, "NOT_FOUND", "Resource not found")
}

/// A failed lookup: a missing row is a 404, anything else a server error.
pub fn lookup(err: anyhow::Error) -> ApiError {
	if database::is_not_found(&err) { not_found() } else { server_error(err) }
}

/// Reads a JSON body. Fields the type does not name are refused, the way the
/// request structs carry #[serde(deny_unknown_fields)]; the size limit is the router's.
pub fn decode<T: DeserializeOwned>(body: &[u8]) -> Result<T, ApiError> {
	serde_json::from_slice(body).map_err(|err| bad_request(format!("invalid request body: {err}")))
}
