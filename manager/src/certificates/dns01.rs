use std::time::{Duration, Instant};

use anyhow::{Context, Result, anyhow, bail};
use serde::Deserialize;
use serde_json::{Value, json};

use super::Issuer;

const CLOUDFLARE_API: &str = "https://api.cloudflare.com/client/v4";

/// The system_settings key holding the encrypted Cloudflare API token. An empty
/// value means HTTP-01.
pub const SETTING_CLOUDFLARE_TOKEN: &str = "cloudflare_api_token";

/// Bounds the wait for a fresh TXT record to become visible. Cloudflare usually
/// publishes within seconds; anything slower is a misconfigured zone.
const PROPAGATION_TIMEOUT: Duration = Duration::from_secs(120);

impl Issuer {
	/// Switches the issuer to DNS-01; an empty token restores HTTP-01. Safe to
	/// call while a renewal is running.
	pub fn set_cloudflare_token(&self, token: &str) {
		*self.cloudflare_token.write().unwrap_or_else(|poisoned| poisoned.into_inner()) = token.to_string();
	}

	/// Whether wildcard hostnames can be issued.
	pub fn dns01_enabled(&self) -> bool {
		!self.token().is_empty()
	}

	pub(super) fn token(&self) -> String {
		self.cloudflare_token.read().unwrap_or_else(|poisoned| poisoned.into_inner()).clone()
	}
}

/// A published challenge record, removed once the order is decided so stale
/// records do not pile up in the zone.
pub(super) struct Record {
	zone_id: String,
	id: String,
	name: String,
}

impl Record {
	pub(super) async fn remove(self, token: &str) {
		let cf = Cloudflare::new(token);
		let path = format!("/zones/{}/dns_records/{}", self.zone_id, self.id);
		if let Err(err) = cf.call(reqwest::Method::DELETE, &path, None).await {
			tracing::warn!(record = %self.name, error = %format!("{err:#}"), "could not remove acme challenge record");
		}
	}
}

/// Publishes the challenge TXT record and waits until it is visible. The only
/// path that can answer a wildcard order.
pub(super) async fn publish(token: &str, identifier: &str, value: &str) -> Result<Record> {
	// For a wildcard order the identifier is already the bare domain, which is
	// exactly the name _acme-challenge hangs off.
	let domain = identifier.trim_start_matches("*.");
	let name = format!("_acme-challenge.{domain}");
	let cf = Cloudflare::new(token);
	let zone_id = cf.zone_id(domain).await?;
	let created = cf
		.call(
			reqwest::Method::POST,
			&format!("/zones/{zone_id}/dns_records"),
			Some(json!({"type": "TXT", "name": name, "content": value, "ttl": 60})),
		)
		.await?;
	let id = created["id"].as_str().ok_or_else(|| anyhow!("cloudflare record create: no id"))?.to_string();
	let record = Record { zone_id, id, name: name.clone() };
	if let Err(err) = wait_for_txt(&name, value).await {
		record.remove(token).await;
		return Err(err);
	}
	Ok(record)
}

/// Polls a public resolver until the record is visible. Let's Encrypt queries
/// the authoritative servers, so a real answer here is a better signal than
/// trusting the API write.
///
/// ponytail: Cloudflare's resolver over DNS-over-HTTPS, because it sees the
/// zone first and needs no DNS client. Make it configurable only if a host
/// turns out to block it.
async fn wait_for_txt(record: &str, value: &str) -> Result<()> {
	#[derive(Deserialize)]
	struct Answer {
		data: String,
	}
	#[derive(Deserialize)]
	struct Response {
		#[serde(rename = "Answer", default)]
		answer: Vec<Answer>,
	}
	let client = reqwest::Client::builder().timeout(Duration::from_secs(5)).build()?;
	let deadline = Instant::now() + PROPAGATION_TIMEOUT;
	loop {
		let response = client
			.get("https://cloudflare-dns.com/dns-query")
			.query(&[("name", record), ("type", "TXT")])
			.header("accept", "application/dns-json")
			.send()
			.await;
		if let Ok(response) = response
			&& let Ok(body) = response.json::<Response>().await
			&& body.answer.iter().any(|a| a.data.trim_matches('"') == value)
		{
			return Ok(());
		}
		if Instant::now() > deadline {
			bail!("{record} did not become visible within {}m0s", PROPAGATION_TIMEOUT.as_secs() / 60);
		}
		tokio::time::sleep(Duration::from_secs(5)).await;
	}
}

/// The single supported DNS-01 provider, with a token scoped to Zone:Read and
/// DNS:Edit. One provider covers the wildcard case for most self-hosters.
pub(super) struct Cloudflare {
	token: String,
	client: reqwest::Client,
	/// The real API unless a test points it at a stub.
	base_url: String,
}

impl Cloudflare {
	fn new(token: &str) -> Cloudflare {
		Cloudflare {
			token: token.to_string(),
			client: reqwest::Client::builder().timeout(Duration::from_secs(30)).build().expect("static client config"),
			base_url: CLOUDFLARE_API.to_string(),
		}
	}

	/// Walks up the labels of name: the zone may be example.com while the record
	/// lives under a.b.example.com.
	pub(super) async fn zone_id(&self, name: &str) -> Result<String> {
		let labels: Vec<&str> = name.trim_end_matches('.').split('.').collect();
		for i in 0..labels.len().saturating_sub(1) {
			let candidate = labels[i..].join(".");
			let path = format!("/zones?name={}", url::form_urlencoded::byte_serialize(candidate.as_bytes()).collect::<String>());
			let zones = self.call(reqwest::Method::GET, &path, None).await?;
			let zones = zones.as_array().ok_or_else(|| anyhow!("cloudflare zone list: not a list"))?;
			if let Some(id) = zones.first().and_then(|z| z["id"].as_str()) {
				return Ok(id.to_string());
			}
		}
		bail!("no Cloudflare zone found for {name} (is the token scoped to this zone?)")
	}

	async fn call(&self, method: reqwest::Method, path: &str, body: Option<Value>) -> Result<Value> {
		#[derive(Deserialize)]
		struct ApiError {
			message: String,
		}
		#[derive(Deserialize)]
		struct Envelope {
			success: bool,
			#[serde(default)]
			errors: Vec<ApiError>,
			#[serde(default)]
			result: Value,
		}
		let mut request = self.client.request(method, format!("{}{path}", self.base_url)).bearer_auth(&self.token);
		if let Some(body) = body {
			request = request.json(&body);
		}
		let response = request.send().await.context("cloudflare api")?;
		let status = response.status();
		let envelope: Envelope = response.json().await.map_err(|_| anyhow!("cloudflare api returned {status}"))?;
		if !envelope.success {
			let mut messages: Vec<String> = envelope.errors.into_iter().map(|e| e.message).collect();
			if messages.is_empty() {
				messages.push(status.to_string());
			}
			bail!("cloudflare api: {}", messages.join("; "));
		}
		Ok(envelope.result)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn dir_name_escapes_wildcard() {
		assert_eq!(super::super::dir_name("*.example.com"), "_wildcard.example.com");
		assert_eq!(super::super::dir_name("app.example.com"), "app.example.com");
	}

	#[tokio::test]
	async fn issue_refuses_wildcard_without_dns01() {
		let issuer = Issuer::new("/tmp/x".into(), "/tmp/y".into(), "http://127.0.0.1:1/directory".into(), String::new());
		let err = issuer.issue("*.example.com").await.unwrap_err();
		assert!(err.to_string().contains("DNS-01"), "{err}");
	}

	#[tokio::test]
	async fn zone_id_walks_up_to_the_registered_domain() {
		use axum::{Json, Router, extract::Query, routing::get};
		use std::collections::HashMap;
		use std::sync::{Arc, Mutex};
		let asked = Arc::new(Mutex::new(Vec::<String>::new()));
		let seen = asked.clone();
		let app = Router::new().route(
			"/zones",
			get(move |Query(q): Query<HashMap<String, String>>| {
				let seen = seen.clone();
				async move {
					let name = q["name"].clone();
					seen.lock().unwrap().push(name.clone());
					let result = if name == "example.com" { json!([{"id": "zone-1"}]) } else { json!([]) };
					Json(json!({"success": true, "errors": [], "result": result}))
				}
			}),
		);
		let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
		let addr = listener.local_addr().unwrap();
		tokio::spawn(async move { axum::serve(listener, app).await.unwrap() });
		let cf = Cloudflare { base_url: format!("http://{addr}"), ..Cloudflare::new("t") };
		assert_eq!(cf.zone_id("a.b.example.com").await.unwrap(), "zone-1");
		assert_eq!(*asked.lock().unwrap(), ["a.b.example.com", "b.example.com", "example.com"]);
	}
}
