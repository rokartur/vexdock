use std::sync::Arc;

use axum::Extension;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::json;

use super::respond::{ApiResult, bad_request, created, decode, lookup, ok};
use super::{Caller, Server};
use crate::analytics::{self, Window};
use crate::database::{self, Payment};

/// Larger than any hit the script sends; anything bigger is not from it.
const HIT_LIMIT: usize = 4096;

pub async fn script() -> Response {
	let mut resp = analytics::SCRIPT.into_response();
	let headers = resp.headers_mut();
	headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/javascript; charset=utf-8"));
	headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=3600"));
	resp
}

/// Records one beacon hit for the hostname it arrived on. Public by nature, so
/// it answers 204 to everything: a visitor's browser can do nothing with an
/// error, and a distinguishable one would tell a prober which hosts exist.
pub async fn collect(State(s): State<Arc<Server>>, headers: HeaderMap, body: Bytes) -> StatusCode {
	let read = |name: &str| headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or_default();
	let hostname = read("host").split(':').next().unwrap_or_default().to_ascii_lowercase();
	if body.len() > HIT_LIMIT {
		return StatusCode::NO_CONTENT;
	}
	let Ok(hit) = serde_json::from_slice::<analytics::Hit>(&body) else { return StatusCode::NO_CONTENT };
	let at = chrono::Utc::now().timestamp();
	let Some(event) = analytics::event(hit, &hostname, read("user-agent"), read("cf-ipcountry"), at) else {
		return StatusCode::NO_CONTENT;
	};
	let domain = match s.db.domain_by_hostname(&hostname) {
		Ok(domain) => domain,
		Err(err) => {
			if !database::is_not_found(&err) {
				tracing::warn!(hostname, error = %format!("{err:#}"), "analytics domain lookup");
			}
			return StatusCode::NO_CONTENT;
		}
	};
	if let Err(err) = s.db.record_analytics_event(&domain.id, &event) {
		tracing::warn!(hostname, error = %format!("{err:#}"), "analytics write");
	}
	StatusCode::NO_CONTENT
}

/// Every domain the caller may read, with its visitors over the last 24 hours.
pub async fn list_sites(State(s): State<Arc<Server>>, Extension(caller): Extension<Caller>) -> ApiResult {
	let now = chrono::Utc::now().timestamp();
	let day = Window::new("24h", now, 0).expect("24h is a range");
	let mut traffic = s.db.site_traffic(day.since)?;
	let mut sites = Vec::new();
	for domain in s.db.list_domains()? {
		if !caller.allows(&domain.project_id, database::ACCESS_READ) {
			continue;
		}
		let t = traffic.remove(&domain.id).unwrap_or_default();
		let mut hourly = vec![0u64; 24];
		for (hour, visitors) in t.hourly {
			if let Some(slot) = hourly.get_mut(((hour - day.since) / 3600) as usize) {
				*slot = visitors;
			}
		}
		sites.push(json!({"domain": domain, "visitors": t.visitors, "hourly": hourly}));
	}
	ok(&sites)
}

#[derive(Deserialize)]
pub struct ReportQuery {
	#[serde(default = "default_range")]
	range: String,
	/// Minutes east of UTC, the browser's `-new Date().getTimezoneOffset()`.
	#[serde(default)]
	tz_offset: i64,
}

fn default_range() -> String {
	"7d".into()
}

pub async fn site_report(State(s): State<Arc<Server>>, Path(id): Path<String>, Query(q): Query<ReportQuery>) -> ApiResult {
	let domain = s.db.domain_by_id(&id).map_err(lookup)?;
	if q.tz_offset.abs() > 14 * 60 {
		return Err(bad_request("tz_offset is minutes east of UTC, at most 840 either way"));
	}
	let now = chrono::Utc::now().timestamp();
	let Some(window) = Window::new(&q.range, now, q.tz_offset * 60) else {
		return Err(bad_request("range must be 24h, 7d, 30d or 90d"));
	};
	let events = s.db.analytics_events(&domain.id, window.since)?;
	let payments = s.db.analytics_payments(&domain.id, window.since)?;
	ok(&json!({"domain": domain, "report": analytics::report(&events, &payments, window)}))
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct RecordPayment {
	payment_id: String,
	amount: i64,
	currency: String,
	visitor_id: String,
}

/// A site's backend reports a payment, usually from its payment provider's
/// webhook, with the vx_vid cookie of the visitor who paid.
pub async fn record_payment(State(s): State<Arc<Server>>, Path(id): Path<String>, body: Bytes) -> ApiResult {
	let domain = s.db.domain_by_id(&id).map_err(lookup)?;
	let req: RecordPayment = decode(&body)?;
	let payment_id = req.payment_id.trim();
	if payment_id.is_empty() || payment_id.len() > 255 {
		return Err(bad_request("payment_id is required, at most 255 characters"));
	}
	if req.amount <= 0 {
		return Err(bad_request("amount is a positive integer in minor units: 4900 for 49.00"));
	}
	if req.currency.len() != 3 || !req.currency.bytes().all(|b| b.is_ascii_alphabetic()) {
		return Err(bad_request("currency is a three-letter ISO 4217 code"));
	}
	if !req.visitor_id.is_empty() && !analytics::is_id(&req.visitor_id) {
		return Err(bad_request("visitor_id is the vx_vid cookie value as the script set it"));
	}
	let payment = Payment {
		payment_id: payment_id.into(),
		at: chrono::Utc::now().timestamp(),
		visitor: req.visitor_id,
		amount: req.amount,
		currency: req.currency.to_ascii_uppercase(),
	};
	let recorded = s.db.record_payment(&domain.id, &payment)?;
	if recorded { created(&json!({"recorded": true})) } else { ok(&json!({"recorded": false})) }
}
