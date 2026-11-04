use std::sync::Arc;

use axum::Extension;
use axum::body::Bytes;
use axum::extract::{Path, Query, State};
use axum::http::{HeaderMap, HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use serde::Deserialize;
use serde_json::{Value, json};

use super::respond::{ApiError, ApiResult, bad_request, created, decode, done, lookup, not_found, ok};
use super::{Caller, Server};
use crate::analytics::{self, KIND_GOAL, KIND_PAGEVIEW, Window, insights, notify, payments, social};
use crate::database::{self, ANNOTATION_NOTE, AnalyticsEvent, Annotation, Domain, FunnelStep, Payment, ShortLink, SiteSettings};
use crate::{domains, security};

/// Larger than any hit the script sends; anything bigger is not from it.
const HIT_LIMIT: usize = 4096;

/// Events a visitor's journey shows, the most recent ones.
const JOURNEY_LIMIT: i64 = 1000;

pub async fn script() -> Response {
	let mut resp = analytics::SCRIPT.into_response();
	let headers = resp.headers_mut();
	headers.insert(header::CONTENT_TYPE, HeaderValue::from_static("text/javascript; charset=utf-8"));
	headers.insert(header::CACHE_CONTROL, HeaderValue::from_static("public, max-age=3600"));
	resp
}

fn header_of(headers: &HeaderMap, name: &str) -> String {
	headers.get(name).and_then(|v| v.to_str().ok()).unwrap_or_default().to_string()
}

/// The hostname a request arrived on, without its port.
fn host_of(headers: &HeaderMap) -> String {
	header_of(headers, "host").split(':').next().unwrap_or_default().to_ascii_lowercase()
}

/// Records one beacon hit for the hostname it arrived on. Public by nature, so
/// it answers 204 to everything: a visitor's browser can do nothing with an
/// error, and a distinguishable one would tell a prober which hosts exist.
pub async fn collect(State(s): State<Arc<Server>>, headers: HeaderMap, body: Bytes) -> StatusCode {
	if body.len() > HIT_LIMIT {
		return StatusCode::NO_CONTENT;
	}
	let Ok(mut hit) = serde_json::from_slice::<analytics::Hit>(&body) else { return StatusCode::NO_CONTENT };
	let hostname = host_of(&headers);
	if let Err(err) = record_hit(&s, &hostname, &headers, &mut hit)
		&& !database::is_not_found(&err)
	{
		tracing::warn!(hostname, error = %format!("{err:#}"), "analytics write");
	}
	StatusCode::NO_CONTENT
}

fn record_hit(s: &Server, hostname: &str, headers: &HeaderMap, hit: &mut analytics::Hit) -> anyhow::Result<()> {
	let domain = s.db.domain_by_hostname(hostname)?;
	// Nginx sets X-Real-IP from the connection, replacing whatever the client sent.
	let ip = header_of(headers, "x-real-ip");
	let user_agent = header_of(headers, "user-agent");
	let settings = s.db.site_settings(&domain.id)?;
	if !ip.is_empty() && settings.excluded_ips.lines().any(|line| line.trim() == ip) {
		return Ok(());
	}
	let at = chrono::Utc::now().timestamp();
	if hit.visitor.is_empty() {
		hit.visitor = analytics::cookieless_visitor(&s.salt.today(at), &domain.id, &ip, &user_agent);
		hit.session = analytics::cookieless_session(&hit.visitor, s.db.last_session(&domain.id, &hit.visitor)?, at);
	}
	let place = s.geo.lookup(&ip);
	let hit = std::mem::take(hit);
	let Some(event) = analytics::event(hit, hostname, &user_agent, &header_of(headers, "cf-ipcountry"), &place, at) else {
		return Ok(());
	};
	s.db.record_analytics_event(&domain.id, &event)
}

/// Every domain the caller may read, with its visitors over the last 24 hours.
pub async fn list_sites(State(s): State<Arc<Server>>, Extension(caller): Extension<Caller>) -> ApiResult {
	let now = chrono::Utc::now().timestamp();
	let day = Window::new("24h", now, 0, None).expect("24h is a range");
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

#[derive(Deserialize, Default)]
#[serde(default)]
pub struct ReportQuery {
	/// One of `analytics::RANGES`; ignored when `from` and `to` are set.
	range: String,
	from: String,
	to: String,
	/// Minutes east of UTC, the browser's `-new Date().getTimezoneOffset()`.
	tz_offset: i64,
	/// A JSON array of `[dimension, value]` pairs.
	filters: String,
	/// Adds the same report for the span just before.
	compare: bool,
}

fn window(s: &Server, domain_id: &str, q: &ReportQuery) -> Result<Window, ApiError> {
	if q.tz_offset.abs() > 14 * 60 {
		return Err(bad_request("tz_offset is minutes east of UTC, at most 840 either way"));
	}
	let now = chrono::Utc::now().timestamp();
	let offset = q.tz_offset * 60;
	if !q.from.is_empty() || !q.to.is_empty() {
		return Window::custom(&q.from, &q.to, now, offset)
			.ok_or_else(|| bad_request("from and to are YYYY-MM-DD dates, from not after to, at most three years apart"));
	}
	let range = if q.range.is_empty() { "7d" } else { q.range.as_str() };
	let first = if range == "all" { s.db.first_event_at(domain_id)? } else { None };
	Window::new(range, now, offset, first).ok_or_else(|| bad_request(format!("range is one of {}", analytics::RANGES.join(", "))))
}

/// The window, its filters, and every event and payment the window (and its
/// previous span when comparing) needs.
struct Loaded {
	w: Window,
	filters: Vec<analytics::Filter>,
	events: Vec<AnalyticsEvent>,
	payments: Vec<Payment>,
}

fn load(s: &Server, domain_id: &str, q: &ReportQuery) -> Result<Loaded, ApiError> {
	let w = window(s, domain_id, q)?;
	let filters = analytics::parse_filters(&q.filters).map_err(bad_request)?;
	let since = if q.compare { w.previous().since } else { w.since };
	let events = s.db.analytics_events(domain_id, since, w.until)?;
	let payments = s.db.analytics_payments(domain_id, since, w.until)?;
	Ok(Loaded { w, filters, events, payments })
}

fn report_json(s: &Server, domain_id: &str, q: &ReportQuery) -> Result<Value, ApiError> {
	let Loaded { w, filters, events, payments } = load(s, domain_id, q)?;
	let previous = q.compare.then(|| analytics::report(&events, &payments, w.previous(), &filters));
	Ok(json!({
		"report": analytics::report(&events, &payments, w, &filters),
		"previous": previous,
		"annotations": s.db.annotations(domain_id, w.since, w.until)?,
		"since": w.since,
		"until": w.until,
	}))
}

pub async fn site_report(State(s): State<Arc<Server>>, Path(id): Path<String>, Query(q): Query<ReportQuery>) -> ApiResult {
	let domain = s.db.domain_by_id(&id).map_err(lookup)?;
	let mut body = report_json(&s, &domain.id, &q)?;
	body["domain"] = json!(domain);
	ok(&body)
}

/// The report behind a public share link: the hostname and the aggregates,
/// never the visitor list, the live feed or any setting.
pub async fn shared_report(State(s): State<Arc<Server>>, Path(token): Path<String>, Query(q): Query<ReportQuery>) -> ApiResult {
	let id = s.db.site_by_share_hash(&security::hash_token(&token)).map_err(lookup)?;
	// Anyone holding the link can ask, so it reads at most a year (two with compare), never `all` or a custom span.
	if !q.from.is_empty() || !q.to.is_empty() || q.range == "all" {
		return Err(bad_request("a shared report takes a range up to 12m"));
	}
	let domain = s.db.domain_by_id(&id).map_err(lookup)?;
	let mut body = report_json(&s, &domain.id, &q)?;
	body["domain"] = json!({"hostname": domain.hostname});
	ok(&body)
}

pub async fn site_visitors(State(s): State<Arc<Server>>, Path(id): Path<String>, Query(q): Query<ReportQuery>) -> ApiResult {
	let domain = s.db.domain_by_id(&id).map_err(lookup)?;
	let Loaded { w, filters, events, payments } = load(&s, &domain.id, &q)?;
	ok(&insights::visitors(&events, &payments, &w, &filters))
}

/// One visitor's journey: their pageviews and goals, oldest first, and every payment.
pub async fn site_visitor(State(s): State<Arc<Server>>, Path((id, visitor)): Path<(String, String)>) -> ApiResult {
	let domain = s.db.domain_by_id(&id).map_err(lookup)?;
	if !analytics::is_id(&visitor) {
		return Err(not_found());
	}
	let events = s.db.visitor_events(&domain.id, &visitor, JOURNEY_LIMIT)?;
	if events.is_empty() {
		return Err(not_found());
	}
	ok(&json!({"visitor": visitor, "events": events, "payments": s.db.visitor_payments(&domain.id, &visitor)?}))
}

pub async fn site_live(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	let domain = s.db.domain_by_id(&id).map_err(lookup)?;
	let now = chrono::Utc::now().timestamp();
	let since = now - analytics::SESSION_SECONDS;
	let events = s.db.analytics_events(&domain.id, since, now + 1)?;
	let payments = s.db.analytics_payments(&domain.id, since, now + 1)?;
	let mut live = insights::live(&events, &payments, now);
	for visitor in &mut live.online {
		visitor.customer = s.db.has_paid(&domain.id, &visitor.visitor)?;
	}
	ok(&live)
}

/// Records a goal from a site's backend, for what happens off the page: a
/// confirmed email, an API call. It joins the visitor's live session if any.
#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct ServerGoal {
	name: String,
	visitor_id: String,
	props: serde_json::Map<String, Value>,
}

pub async fn record_goal(State(s): State<Arc<Server>>, Path(id): Path<String>, body: Bytes) -> ApiResult {
	let domain = s.db.domain_by_id(&id).map_err(lookup)?;
	let req: ServerGoal = decode(&body)?;
	let Some(name) = analytics::goal_name(&req.name) else {
		return Err(bad_request("name is 1 to 64 lowercase letters, digits, _ or -"));
	};
	if !analytics::is_id(&req.visitor_id) {
		return Err(bad_request("visitor_id is the vx_vid cookie value as the script set it"));
	}
	let at = chrono::Utc::now().timestamp();
	let session = analytics::cookieless_session(&req.visitor_id, s.db.last_session(&domain.id, &req.visitor_id)?, at);
	let event = AnalyticsEvent {
		at,
		visitor: req.visitor_id,
		session,
		kind: KIND_GOAL.into(),
		name,
		props: analytics::goal_props(&req.props),
		..Default::default()
	};
	s.db.record_analytics_event(&domain.id, &event)?;
	created(&json!({"recorded": true}))
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
	if !recorded {
		return ok(&json!({"recorded": false}));
	}
	announce_sale(Arc::clone(&s), domain, payment);
	created(&json!({"recorded": true}))
}

/// A payment provider's webhook, authenticated by its signature with the
/// secret the site owner saved for that provider.
pub async fn payment_webhook(
	State(s): State<Arc<Server>>,
	Path((provider, id)): Path<(String, String)>,
	headers: HeaderMap,
	body: Bytes,
) -> ApiResult {
	let domain = s.db.domain_by_id(&id).map_err(lookup)?;
	let settings = s.db.site_settings(&domain.id)?;
	let sealed = match provider.as_str() {
		"stripe" => &settings.stripe_secret_enc,
		"lemonsqueezy" => &settings.lemonsqueezy_secret_enc,
		"paddle" => &settings.paddle_secret_enc,
		"polar" => &settings.polar_secret_enc,
		_ => return Err(not_found()),
	};
	if sealed.is_empty() {
		return Err(not_found());
	}
	let secret = s.cipher.decrypt(sealed)?;
	let now = chrono::Utc::now().timestamp();
	let parsed = payments::parse(&provider, &secret, |name| header_of(&headers, name), &body, now);
	let payment = match parsed {
		Ok(Some(payment)) => payment,
		Ok(None) => return done(),
		Err(reason) => {
			tracing::warn!(provider, domain = domain.hostname, reason, "payment webhook refused");
			return Err(ApiError::new(StatusCode::UNAUTHORIZED, "SIGNATURE_INVALID", reason));
		}
	};
	if s.db.record_payment(&domain.id, &payment)? {
		announce_sale(Arc::clone(&s), domain, payment);
	}
	done()
}

fn announce_sale(s: Arc<Server>, domain: Domain, payment: Payment) {
	tokio::spawn(async move {
		if let Err(err) = send_sale(&s, &domain, &payment).await {
			tracing::warn!(domain = domain.hostname, error = %format!("{err:#}"), "sale notification");
		}
	});
}

async fn send_sale(s: &Server, domain: &Domain, payment: &Payment) -> anyhow::Result<()> {
	let url = unseal(s, &s.db.site_settings(&domain.id)?.notify_url_enc)?;
	if url.is_empty() {
		return Ok(());
	}
	let mut source = String::new();
	if !payment.visitor.is_empty() {
		let events = s.db.visitor_events(&domain.id, &payment.visitor, JOURNEY_LIMIT)?;
		if let Some(first) = events.iter().find(|e| e.kind == KIND_PAGEVIEW) {
			source = analytics::source_of(first).to_string();
		}
	}
	notify::send(&url, &notify::sale_text(&domain.hostname, payment, &source)).await
}

fn seal(s: &Server, plaintext: &str) -> anyhow::Result<String> {
	if plaintext.is_empty() { Ok(String::new()) } else { s.cipher.encrypt(plaintext) }
}

fn unseal(s: &Server, sealed: &str) -> anyhow::Result<String> {
	if sealed.is_empty() { Ok(String::new()) } else { s.cipher.decrypt(sealed) }
}

pub async fn list_funnels(State(s): State<Arc<Server>>, Path(id): Path<String>, Query(q): Query<ReportQuery>) -> ApiResult {
	let domain = s.db.domain_by_id(&id).map_err(lookup)?;
	let Loaded { w, filters, events, payments } = load(&s, &domain.id, &q)?;
	let mut out = Vec::new();
	for f in s.db.list_funnels(&domain.id)? {
		let reached = insights::funnel(&events, &payments, &w, &filters, &f.steps);
		out.push(json!({"id": f.id, "name": f.name, "steps": f.steps, "reached": reached}));
	}
	ok(&out)
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct CreateFunnel {
	name: String,
	steps: Vec<FunnelStep>,
}

pub async fn create_funnel(State(s): State<Arc<Server>>, Path(id): Path<String>, body: Bytes) -> ApiResult {
	let domain = s.db.domain_by_id(&id).map_err(lookup)?;
	let req: CreateFunnel = decode(&body)?;
	let name = req.name.trim();
	if name.is_empty() || name.len() > 64 {
		return Err(bad_request("name is required, at most 64 characters"));
	}
	let steps = insights::validate_steps(&req.steps).map_err(bad_request)?;
	created(&s.db.create_funnel(&domain.id, name, &steps)?)
}

pub async fn delete_funnel(State(s): State<Arc<Server>>, Path((id, funnel)): Path<(String, String)>) -> ApiResult {
	let domain = s.db.domain_by_id(&id).map_err(lookup)?;
	if !s.db.delete_funnel(&domain.id, &funnel)? {
		return Err(not_found());
	}
	done()
}

#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct CreateAnnotation {
	/// Unix seconds; now when absent.
	at: i64,
	text: String,
}

pub async fn create_annotation(State(s): State<Arc<Server>>, Path(id): Path<String>, body: Bytes) -> ApiResult {
	let domain = s.db.domain_by_id(&id).map_err(lookup)?;
	let req: CreateAnnotation = decode(&body)?;
	let text = req.text.trim();
	if text.is_empty() || text.len() > 500 {
		return Err(bad_request("text is required, at most 500 characters"));
	}
	let annotation = Annotation {
		id: database::new_id(),
		at: if req.at > 0 { req.at } else { chrono::Utc::now().timestamp() },
		source: ANNOTATION_NOTE.into(),
		text: text.into(),
		..Default::default()
	};
	s.db.add_annotation(&domain.id, &annotation)?;
	created(&annotation)
}

pub async fn delete_annotation(State(s): State<Arc<Server>>, Path((id, annotation)): Path<(String, String)>) -> ApiResult {
	let domain = s.db.domain_by_id(&id).map_err(lookup)?;
	if !s.db.delete_annotation(&domain.id, &annotation)? {
		return Err(not_found());
	}
	done()
}

pub async fn list_links(State(s): State<Arc<Server>>, Path(id): Path<String>) -> ApiResult {
	let domain = s.db.domain_by_id(&id).map_err(lookup)?;
	ok(&s.db.list_links(&domain.id)?)
}

fn valid_slug(slug: &str) -> bool {
	(1..=64).contains(&slug.len()) && slug.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub async fn create_link(State(s): State<Arc<Server>>, Path(id): Path<String>, body: Bytes) -> ApiResult {
	let domain = s.db.domain_by_id(&id).map_err(lookup)?;
	let mut link: ShortLink = decode(&body)?;
	link.slug = link.slug.trim().to_string();
	if link.slug.is_empty() {
		link.slug = security::random_token(4);
	}
	if !valid_slug(&link.slug) {
		return Err(bad_request("slug is 1 to 64 letters, digits, - or _"));
	}
	let target = url::Url::parse(link.target.trim()).map_err(|_| bad_request("target is a full http or https URL"))?;
	if !matches!(target.scheme(), "http" | "https") {
		return Err(bad_request("target is a full http or https URL"));
	}
	link.target = target.to_string();
	for utm in [&mut link.utm_source, &mut link.utm_medium, &mut link.utm_campaign] {
		*utm = analytics::truncate(utm.trim(), 128);
	}
	link.created_at = chrono::Utc::now().timestamp();
	if !s.db.create_link(&domain.id, &link)? {
		return Err(ApiError::new(StatusCode::CONFLICT, "CONFLICT", "this site already has that slug"));
	}
	created(&link)
}

pub async fn delete_link(State(s): State<Arc<Server>>, Path((id, slug)): Path<(String, String)>) -> ApiResult {
	let domain = s.db.domain_by_id(&id).map_err(lookup)?;
	if !s.db.delete_link(&domain.id, &slug)? {
		return Err(not_found());
	}
	done()
}

/// `/_vx/l/{slug}` on a site's hostname: a redirect to the link's target with
/// its UTM parameters, so the landing page's script files the visit under them.
pub async fn follow_link(State(s): State<Arc<Server>>, Path(slug): Path<String>, headers: HeaderMap) -> Response {
	let found = s.db.domain_by_hostname(&host_of(&headers)).and_then(|domain| s.db.short_link(&domain.id, &slug));
	let link = match found {
		Ok(link) => link,
		Err(err) => {
			if !database::is_not_found(&err) {
				tracing::warn!(slug, error = %format!("{err:#}"), "short link lookup");
			}
			return StatusCode::NOT_FOUND.into_response();
		}
	};
	let mut target = url::Url::parse(&link.target).expect("targets are parsed before they are stored");
	let kept: Vec<(String, String)> =
		target.query_pairs().filter(|(k, _)| !k.starts_with("utm_")).map(|(k, v)| (k.into(), v.into())).collect();
	{
		let mut query = target.query_pairs_mut();
		query.clear().extend_pairs(&kept);
		for (key, value) in [("utm_source", &link.utm_source), ("utm_medium", &link.utm_medium), ("utm_campaign", &link.utm_campaign)] {
			if !value.is_empty() {
				query.append_pair(key, value);
			}
		}
	}
	if target.query() == Some("") {
		target.set_query(None);
	}
	(StatusCode::FOUND, [(header::LOCATION, target.to_string()), (header::CACHE_CONTROL, "no-store".into())]).into_response()
}

/// Secrets come back as whether they are set, except the two the owner needs
/// to read again: the share token (it is the link) and the notification URL.
fn settings_json(s: &Server, headers: &HeaderMap, settings: &SiteSettings) -> anyhow::Result<Value> {
	Ok(json!({
		"webhook_origin": webhook_origin(s, headers),
		"share_token": unseal(s, &settings.share_token_enc)?,
		"notify_url": unseal(s, &settings.notify_url_enc)?,
		"excluded_ips": settings.excluded_ips,
		"reddit": settings.reddit,
		"x_token": !settings.x_token_enc.is_empty(),
		"providers": {
			"stripe": !settings.stripe_secret_enc.is_empty(),
			"lemonsqueezy": !settings.lemonsqueezy_secret_enc.is_empty(),
			"paddle": !settings.paddle_secret_enc.is_empty(),
			"polar": !settings.polar_secret_enc.is_empty(),
		},
	}))
}

/// Where a payment provider reaches the webhook routes: PUBLIC_URL, else the
/// panel's own domain, else the address this request came in on, which behind
/// an SSH tunnel is localhost and only good for a test.
fn webhook_origin(s: &Server, headers: &HeaderMap) -> String {
	let domain = s.setting(domains::SETTING_DASHBOARD_DOMAIN);
	if !s.cfg.public_url.is_empty() || domain.is_empty() {
		return s.public_origin(headers);
	}
	let https = s.setting(domains::SETTING_DASHBOARD_HTTPS) == "true" && s.certs.exists(&domain);
	format!("{}://{domain}", if https { "https" } else { "http" })
}

pub async fn get_settings(State(s): State<Arc<Server>>, Path(id): Path<String>, headers: HeaderMap) -> ApiResult {
	let domain = s.db.domain_by_id(&id).map_err(lookup)?;
	ok(&settings_json(&s, &headers, &s.db.site_settings(&domain.id)?)?)
}

/// Every field is optional: an absent one keeps its value, an empty string
/// clears it. `share: true` makes a link when there is none, `false` revokes it.
#[derive(Deserialize, Default)]
#[serde(default, deny_unknown_fields)]
struct UpdateSettings {
	share: Option<bool>,
	notify_url: Option<String>,
	excluded_ips: Option<String>,
	reddit: Option<bool>,
	x_token: Option<String>,
	stripe_secret: Option<String>,
	lemonsqueezy_secret: Option<String>,
	paddle_secret: Option<String>,
	polar_secret: Option<String>,
}

pub async fn update_settings(State(s): State<Arc<Server>>, Path(id): Path<String>, headers: HeaderMap, body: Bytes) -> ApiResult {
	let domain = s.db.domain_by_id(&id).map_err(lookup)?;
	let req: UpdateSettings = decode(&body)?;
	let mut settings = s.db.site_settings(&domain.id)?;
	match req.share {
		Some(true) if settings.share_token_hash.is_empty() => {
			let token = security::random_token(24);
			settings.share_token_hash = security::hash_token(&token);
			settings.share_token_enc = s.cipher.encrypt(&token)?;
		}
		Some(false) => {
			settings.share_token_hash.clear();
			settings.share_token_enc.clear();
		}
		_ => {}
	}
	if let Some(url) = req.notify_url {
		let url = if url.trim().is_empty() { String::new() } else { notify::validate_url(&url).map_err(bad_request)? };
		if settings.notify_url_enc.is_empty() && !url.is_empty() {
			// The first digest goes out a week after the URL is set, not on the next scheduler run.
			settings.digest_sent_at = chrono::Utc::now().timestamp();
		}
		settings.notify_url_enc = seal(&s, &url)?;
	}
	if let Some(ips) = req.excluded_ips {
		let mut kept = Vec::new();
		for line in ips.lines().map(str::trim).filter(|l| !l.is_empty()) {
			if line.parse::<std::net::IpAddr>().is_err() {
				return Err(bad_request(format!("{line:?} is not an IP address")));
			}
			kept.push(line);
		}
		if kept.len() > 100 {
			return Err(bad_request("at most 100 excluded addresses"));
		}
		settings.excluded_ips = kept.join("\n");
	}
	if let Some(reddit) = req.reddit {
		settings.reddit = reddit;
	}
	let secrets = [
		(req.x_token, &mut settings.x_token_enc),
		(req.stripe_secret, &mut settings.stripe_secret_enc),
		(req.lemonsqueezy_secret, &mut settings.lemonsqueezy_secret_enc),
		(req.paddle_secret, &mut settings.paddle_secret_enc),
		(req.polar_secret, &mut settings.polar_secret_enc),
	];
	for (value, sealed) in secrets {
		if let Some(value) = value {
			if value.len() > 4096 {
				return Err(bad_request("a secret is at most 4096 characters"));
			}
			*sealed = seal(&s, value.trim())?;
		}
	}
	settings.domain_id = domain.id.clone();
	s.db.save_site_settings(&settings)?;
	ok(&settings_json(&s, &headers, &settings)?)
}

impl Server {
	/// The scheduler's analytics work: the geo database, weekly digests and mentions.
	pub async fn run_analytics_jobs(&self) {
		if let Err(err) = self.geo.refresh().await {
			tracing::warn!(error = %format!("{err:#}"), "geo database download");
		}
		let sites = match self.db.all_site_settings() {
			Ok(sites) => sites,
			Err(err) => {
				tracing::warn!(error = %format!("{err:#}"), "analytics settings");
				return;
			}
		};
		let client = social::client();
		for site in sites {
			let Ok(domain) = self.db.domain_by_id(&site.domain_id) else { continue };
			if let Err(err) = self.send_digest(&domain, &site).await {
				tracing::warn!(domain = domain.hostname, error = %format!("{err:#}"), "weekly digest");
			}
			if let Err(err) = self.poll_mentions(&client, &domain, &site).await {
				tracing::warn!(domain = domain.hostname, error = %format!("{err:#}"), "mentions");
			}
		}
	}

	async fn send_digest(&self, domain: &Domain, site: &SiteSettings) -> anyhow::Result<()> {
		let now = chrono::Utc::now().timestamp();
		if site.notify_url_enc.is_empty() || now - site.digest_sent_at < notify::DIGEST_EVERY {
			return Ok(());
		}
		let url = unseal(self, &site.notify_url_enc)?;
		let w = Window::new("7d", now, 0, None).expect("7d is a range");
		let events = self.db.analytics_events(&domain.id, w.previous().since, w.until)?;
		let payments = self.db.analytics_payments(&domain.id, w.previous().since, w.until)?;
		let this = analytics::report(&events, &payments, w, &[]);
		let last = analytics::report(&events, &payments, w.previous(), &[]);
		notify::send(&url, &notify::digest_text(&domain.hostname, &this, &last)).await?;
		self.db.mark_digest_sent(&domain.id, now)
	}

	async fn poll_mentions(&self, client: &reqwest::Client, domain: &Domain, site: &SiteSettings) -> anyhow::Result<()> {
		let mut found = Vec::new();
		if !site.x_token_enc.is_empty() {
			found.extend(social::x_mentions(client, &unseal(self, &site.x_token_enc)?, &domain.hostname).await?);
		}
		if site.reddit {
			found.extend(social::reddit_mentions(client, &domain.hostname).await?);
		}
		for mention in found {
			self.db.add_annotation(&domain.id, &mention)?;
		}
		Ok(())
	}
}
