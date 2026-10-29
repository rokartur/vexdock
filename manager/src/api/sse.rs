//! Server-Sent Events carry every read-only realtime stream in the platform;
//! WebSocket is reserved for the interactive terminal.

use std::convert::Infallible;
use std::time::Duration;

use axum::body::{Body, Bytes};
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::Response;
use futures::Stream;
use serde::Serialize;

use crate::events::Subscription;

/// One event frame.
pub fn event(name: &str, data: &impl Serialize) -> Bytes {
	let payload = serde_json::to_string(data).unwrap_or_else(|_| "null".into());
	Bytes::from(format!("event: {name}\ndata: {payload}\n\n"))
}

/// Stops idle proxies from closing a quiet stream.
pub fn keep_alive() -> Bytes {
	Bytes::from_static(b": ping\n\n")
}

pub const KEEP_ALIVE_EVERY: Duration = Duration::from_secs(20);

/// A streaming response; dropping it, which a disconnecting client does, drops
/// the stream and whatever subscription it holds.
pub fn response(stream: impl Stream<Item = Bytes> + Send + 'static) -> Response {
	use futures::StreamExt;
	let mut resp = Response::new(Body::from_stream(stream.map(Ok::<_, Infallible>)));
	*resp.status_mut() = StatusCode::OK;
	let headers = resp.headers_mut();
	headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/event-stream"));
	headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache, no-transform"));
	headers.insert(header::CONNECTION, HeaderValue::from_static("keep-alive"));
	// Belt and braces: Nginx buffering is already disabled in the vhost.
	headers.insert("x-accel-buffering", HeaderValue::from_static("no"));
	resp
}

/// Pumps a bus subscription to the client until either side stops, with a
/// keep-alive whenever it is quiet.
pub fn bus(sub: Subscription) -> impl Stream<Item = Bytes> + Send + 'static {
	let ticker = tokio::time::interval_at(tokio::time::Instant::now() + KEEP_ALIVE_EVERY, KEEP_ALIVE_EVERY);
	futures::stream::unfold((sub, ticker), |(mut sub, mut ticker)| async move {
		tokio::select! {
			msg = sub.events.recv() => msg.map(|msg| (event(&msg.kind, &msg.data), (sub, ticker))),
			_ = ticker.tick() => Some((keep_alive(), (sub, ticker))),
		}
	})
}
