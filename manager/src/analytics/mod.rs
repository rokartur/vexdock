//! Site analytics. A proxied hostname serves `/_vx/script.js`, which reports
//! pageviews, heartbeats and goals to `/_vx/event`; payments arrive from a
//! site's backend or its payment provider's webhook with the visitor id the
//! script keeps in the vx_vid cookie. This module cleans a hit into a stored
//! event and folds a window of events and payments into the report the panel
//! shows; `insights` adds visitors, live and funnels on the same events.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::database::{AnalyticsEvent, Payment};

pub mod geo;
pub mod insights;
pub mod notify;
pub mod payments;
pub mod social;

pub const SCRIPT: &str = include_str!("script.js");

/// Events and payments older than this are pruned; the `all` range reaches back as far.
pub const RETENTION_DAYS: i64 = 3 * 365;

/// A visitor whose last event is this recent counts as online. The script pings
/// once a minute while its tab is visible.
pub const ONLINE_SECONDS: i64 = 180;

/// A session ends after this long without an event, in the cookie and in cookieless mode.
pub const SESSION_SECONDS: i64 = 1800;

pub const KIND_PAGEVIEW: &str = "pageview";
pub const KIND_PING: &str = "ping";
pub const KIND_GOAL: &str = "goal";

/// Rows per breakdown in a report.
const ROW_LIMIT: usize = 50;

/// What the script posts. Every field is untrusted and bounded in `event`.
#[derive(Deserialize, Default)]
#[serde(default)]
pub struct Hit {
	pub kind: String,
	pub name: String,
	pub visitor: String,
	pub session: String,
	pub path: String,
	pub referrer: String,
	pub utm_source: String,
	pub utm_medium: String,
	pub utm_campaign: String,
	pub timezone: String,
	pub props: serde_json::Map<String, serde_json::Value>,
}

/// Where a hit came from, as far as the IP database knows. All empty without it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Place {
	pub country: String,
	pub region: String,
	pub city: String,
}

/// Cleans a hit into a storable event. None for a bot, a malformed id or an
/// unknown kind: the beacon endpoint drops those without saying why.
pub fn event(hit: Hit, hostname: &str, user_agent: &str, edge_country: &str, place: &Place, at: i64) -> Option<AnalyticsEvent> {
	if is_bot(user_agent) || !is_id(&hit.visitor) || !is_id(&hit.session) {
		return None;
	}
	let (name, props) = match hit.kind.as_str() {
		KIND_PAGEVIEW | KIND_PING => (String::new(), String::new()),
		KIND_GOAL => (goal_name(&hit.name)?, goal_props(&hit.props)),
		_ => return None,
	};
	let client = parse_user_agent(user_agent);
	Some(AnalyticsEvent {
		at,
		visitor: hit.visitor,
		session: hit.session,
		kind: hit.kind,
		name,
		path: clean_path(&hit.path),
		referrer: referrer_host(&hit.referrer, hostname),
		utm_source: truncate(hit.utm_source.trim(), 128),
		utm_medium: truncate(hit.utm_medium.trim(), 128),
		utm_campaign: truncate(hit.utm_campaign.trim(), 128),
		location: location(edge_country, &place.country, &hit.timezone),
		region: truncate(&place.region, 128),
		city: truncate(&place.city, 128),
		device: client.device.into(),
		browser: client.browser.into(),
		os: client.os.into(),
		props,
	})
}

/// The ids the script generates: a UUID, or its fallback on plain HTTP.
pub fn is_id(id: &str) -> bool {
	(8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Goal names are lowercase letters, digits, `_` and `-`, at most 64 long, so
/// `Sign up` and `sign_up` cannot become two rows by accident.
pub fn goal_name(raw: &str) -> Option<String> {
	let name = raw.trim().to_ascii_lowercase();
	let valid =
		(1..=64).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-');
	valid.then_some(name)
}

/// A goal's parameters as a JSON object: at most 10, keys in the goal-name
/// alphabet, scalar values as strings of at most 255 bytes. The rest is dropped.
pub fn goal_props(raw: &serde_json::Map<String, serde_json::Value>) -> String {
	let mut props = BTreeMap::new();
	for (key, value) in raw {
		let Some(key) = goal_name(key) else { continue };
		let value = match value {
			serde_json::Value::String(s) => truncate(s.trim(), 255),
			serde_json::Value::Number(n) => n.to_string(),
			serde_json::Value::Bool(b) => b.to_string(),
			_ => continue,
		};
		if props.len() < 10 {
			props.insert(key, value);
		}
	}
	if props.is_empty() { String::new() } else { serde_json::to_string(&props).expect("a map of strings serializes") }
}

pub struct Client {
	pub device: &'static str,
	pub browser: &'static str,
	pub os: &'static str,
}

/// Buckets a user agent coarsely. The specific markers are tested before the
/// generic ones every browser also claims (Edge says Chrome, Chrome says Safari).
pub fn parse_user_agent(ua: &str) -> Client {
	let ua = ua.to_ascii_lowercase();
	let has = |marker: &str| ua.contains(marker);
	let device = if has("ipad") || has("tablet") {
		"Tablet"
	} else if has("mobi") || has("iphone") || has("android") {
		"Mobile"
	} else {
		"Desktop"
	};
	let browser = if has("edg/") {
		"Edge"
	} else if has("opr/") || has("opera") {
		"Opera"
	} else if has("samsungbrowser") {
		"Samsung Internet"
	} else if has("firefox") || has("fxios") {
		"Firefox"
	} else if has("chrome") || has("crios") {
		"Chrome"
	} else if has("safari") {
		"Safari"
	} else {
		"Other"
	};
	let os = if has("iphone") || has("ipad") || has("ios") {
		"iOS"
	} else if has("android") {
		"Android"
	} else if has("windows") {
		"Windows"
	} else if has("mac os") || has("macintosh") {
		"macOS"
	} else if has("linux") || has("x11") {
		"Linux"
	} else {
		"Other"
	};
	Client { device, browser, os }
}

const BOT_MARKERS: &[&str] =
	&["bot", "crawl", "spider", "slurp", "headless", "monitor", "preview", "lighthouse", "pingdom", "gtmetrix", "inspectiontool"];

/// Every browser's user agent starts with `Mozilla/`, so anything else (curl, an HTTP
/// library, a link unfurler) is a script posting to the beacon directly.
pub fn is_bot(user_agent: &str) -> bool {
	let ua = user_agent.to_ascii_lowercase();
	!ua.starts_with("mozilla/") || BOT_MARKERS.iter().any(|marker| ua.contains(marker))
}

/// The path without its query string, which is where session ids and tokens live.
pub fn clean_path(raw: &str) -> String {
	let path = raw.split(['?', '#']).next().unwrap_or_default().trim();
	if path.is_empty() {
		return "/".into();
	}
	let path = if path.starts_with('/') { path.to_string() } else { format!("/{path}") };
	truncate(&path, 512)
}

/// The referrer's host without `www.`; empty for none and for the site itself.
/// A t.co link keeps its path, which is what finds the tweet among the mentions.
pub fn referrer_host(raw: &str, hostname: &str) -> String {
	let Ok(url) = url::Url::parse(raw.trim()) else { return String::new() };
	let Some(host) = url.host_str() else { return String::new() };
	let host = host.to_ascii_lowercase();
	let host = host.trim_start_matches("www.");
	if host == hostname.trim_start_matches("www.") {
		return String::new();
	}
	let code = url.path().trim_matches('/');
	if host == "t.co" && !code.is_empty() && code.bytes().all(|b| b.is_ascii_alphanumeric()) {
		return truncate(&format!("t.co/{code}"), 64);
	}
	truncate(host, 253)
}

/// Cloudflare's country code when the site is behind it, then the IP
/// database's, otherwise the browser's timezone, which names a region.
fn location(edge_country: &str, geo_country: &str, timezone: &str) -> String {
	for code in [edge_country.trim(), geo_country] {
		if code.len() == 2 && code.bytes().all(|b| b.is_ascii_uppercase()) && code != "XX" {
			return code.into();
		}
	}
	let timezone = timezone.trim();
	let valid = timezone.len() <= 64 && timezone.bytes().all(|b| b.is_ascii_alphanumeric() || b"/_+-".contains(&b));
	if valid { timezone.into() } else { String::new() }
}

pub fn truncate(s: &str, max: usize) -> String {
	let mut end = s.len().min(max);
	while !s.is_char_boundary(end) {
		end -= 1;
	}
	s[..end].to_string()
}

/// Where a session came from: its referrer, else its utm_source, else Direct.
pub fn source_of(e: &AnalyticsEvent) -> &str {
	if !e.referrer.is_empty() {
		&e.referrer
	} else if !e.utm_source.is_empty() {
		&e.utm_source
	} else {
		"Direct"
	}
}

/// The channel a session came through, from its first pageview.
pub fn channel(referrer: &str, utm_source: &str, utm_medium: &str) -> &'static str {
	let medium = utm_medium.to_ascii_lowercase();
	let source = if referrer.is_empty() { utm_source.to_ascii_lowercase() } else { referrer.to_string() };
	let source = source.split('/').next().unwrap_or_default();
	if ["cpc", "ppc", "paid", "paidsearch", "paid_social", "paidsocial", "display", "cpm"].contains(&medium.as_str()) {
		return "Paid";
	}
	if medium == "email" || source.contains("newsletter") || source.contains("mail.") {
		return "Email";
	}
	if source.is_empty() {
		return "Direct";
	}
	// Matched by whole label, so microsoft.com is not t.co and a bare
	// utm_source=twitter still reads as Social.
	const SEARCH: &[&str] = &["google", "bing", "duckduckgo", "yahoo", "yandex", "baidu", "ecosia", "brave", "startpage"];
	const SOCIAL: &[&str] = &[
		"facebook",
		"fb",
		"instagram",
		"twitter",
		"linkedin",
		"reddit",
		"youtube",
		"tiktok",
		"pinterest",
		"threads",
		"bsky",
		"mastodon",
		"ycombinator",
	];
	const SOCIAL_HOSTS: &[&str] = &["t.co", "x.com", "lnkd.in"];
	let labels: Vec<&str> = source.split('.').collect();
	if SEARCH.iter().any(|stem| labels.contains(stem)) {
		"Organic search"
	} else if SOCIAL_HOSTS.contains(&source) || SOCIAL.iter().any(|stem| labels.contains(stem)) {
		"Social"
	} else {
		"Referral"
	}
}

/// The span a report covers and the size of its chart buckets, in unix seconds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Window {
	pub since: i64,
	/// Exclusive end.
	pub until: i64,
	pub now: i64,
	pub bucket: i64,
	/// Seconds east of UTC, so a day bucket starts at the viewer's midnight.
	pub offset: i64,
}

const HOUR: i64 = 3600;
const DAY: i64 = 86_400;
const WEEK: i64 = 7 * DAY;

pub const RANGES: &[&str] = &["today", "yesterday", "24h", "7d", "30d", "90d", "12m", "all"];

impl Window {
	/// One of `RANGES`. `first` is the site's oldest event, which `all` starts
	/// from. None for any other name.
	pub fn new(range: &str, now: i64, offset: i64, first: Option<i64>) -> Option<Window> {
		let today = Window { since: 0, until: 0, now, bucket: DAY, offset }.bucket_of(now);
		let days = |n: i64| (today - (n - 1) * DAY, today + DAY, DAY);
		let (since, until, bucket) = match range {
			"today" => (today, today + DAY, HOUR),
			"yesterday" => (today - DAY, today, HOUR),
			"24h" => {
				let hour = Window { since: 0, until: 0, now, bucket: HOUR, offset }.bucket_of(now);
				(hour - 23 * HOUR, hour + HOUR, HOUR)
			}
			"7d" => days(7),
			"30d" => days(30),
			"90d" => days(90),
			"12m" => days(365),
			"all" => {
				let first = first.unwrap_or(now).max(now - RETENTION_DAYS * DAY);
				let bucket = if now - first > 400 * DAY { WEEK } else { DAY };
				(first, today + DAY, bucket)
			}
			_ => return None,
		};
		Some(Window { since, until, now, bucket, offset }.aligned())
	}

	/// From the start of `from` to the end of `to`, both `YYYY-MM-DD` in the
	/// viewer's timezone. None for a malformed date, a reversed span or one
	/// longer than the retention.
	pub fn custom(from: &str, to: &str, now: i64, offset: i64) -> Option<Window> {
		let midnight = |date: &str| {
			let day = chrono::NaiveDate::parse_from_str(date, "%Y-%m-%d").ok()?;
			Some(day.and_hms_opt(0, 0, 0)?.and_utc().timestamp() - offset)
		};
		let since = midnight(from)?;
		let until = midnight(to)? + DAY;
		if until <= since || until - since > RETENTION_DAYS * DAY {
			return None;
		}
		let bucket = match until - since {
			span if span <= DAY => HOUR,
			span if span <= 400 * DAY => DAY,
			_ => WEEK,
		};
		Some(Window { since, until, now, bucket, offset }.aligned())
	}

	/// The span of the same length just before this one, for the comparison.
	pub fn previous(&self) -> Window {
		Window { since: self.since - (self.until - self.since), until: self.since, ..*self }
	}

	pub fn contains(&self, at: i64) -> bool {
		at >= self.since && at < self.until
	}

	fn aligned(mut self) -> Window {
		self.since = self.bucket_of(self.since);
		self
	}

	fn bucket_of(&self, at: i64) -> i64 {
		(at + self.offset).div_euclid(self.bucket) * self.bucket - self.offset
	}
}

/// What a breakdown row filters on; the names are the report's breakdowns.
pub const DIMENSIONS: &[&str] = &[
	"channel",
	"referrer",
	"campaign",
	"page",
	"entry_page",
	"exit_page",
	"location",
	"region",
	"city",
	"device",
	"browser",
	"os",
	"goal",
];

/// `(dimension, value)`: keep the sessions that had the value. Every filter must match.
pub type Filter = (String, String);

/// Parses the `filters` query parameter, a JSON array of `[dimension, value]` pairs.
pub fn parse_filters(raw: &str) -> Result<Vec<Filter>, String> {
	if raw.trim().is_empty() {
		return Ok(Vec::new());
	}
	let filters: Vec<Filter> = serde_json::from_str(raw).map_err(|_| "filters is a JSON array of [dimension, value] pairs".to_string())?;
	if filters.len() > 10 {
		return Err("at most 10 filters".into());
	}
	if let Some((dimension, _)) = filters.iter().find(|(d, _)| !DIMENSIONS.contains(&d.as_str())) {
		return Err(format!("unknown filter dimension {dimension:?}, expected one of {}", DIMENSIONS.join(", ")));
	}
	Ok(filters)
}

/// One session folded from its events: what it entered on and everything it saw.
pub(crate) struct Session<'a> {
	pub visitor: &'a str,
	pub first: i64,
	pub last: i64,
	pub pageviews: u64,
	pub entry: Option<&'a AnalyticsEvent>,
	pub exit: &'a str,
	pub pages: HashSet<&'a str>,
	pub goals: HashSet<&'a str>,
}

impl Session<'_> {
	fn matches(&self, (dimension, value): &Filter) -> bool {
		let Some(entry) = self.entry else { return false };
		let value = value.as_str();
		match dimension.as_str() {
			"channel" => channel(&entry.referrer, &entry.utm_source, &entry.utm_medium) == value,
			"referrer" => source_of(entry) == value,
			"campaign" => entry.utm_campaign == value,
			"page" => self.pages.contains(value),
			"entry_page" => entry.path == value,
			"exit_page" => self.exit == value,
			"location" => entry.location == value,
			"region" => entry.region == value,
			"city" => entry.city == value,
			"device" => entry.device == value,
			"browser" => entry.browser == value,
			"os" => entry.os == value,
			"goal" => self.goals.contains(value),
			_ => false,
		}
	}
}

/// Folds events, oldest first, into their sessions.
pub(crate) fn sessions<'a>(events: &[&'a AnalyticsEvent]) -> HashMap<&'a str, Session<'a>> {
	let mut sessions: HashMap<&str, Session> = HashMap::new();
	for e in events {
		let s = sessions.entry(&e.session).or_insert(Session {
			visitor: &e.visitor,
			first: e.at,
			last: e.at,
			pageviews: 0,
			entry: None,
			exit: "",
			pages: HashSet::new(),
			goals: HashSet::new(),
		});
		s.last = e.at;
		match e.kind.as_str() {
			KIND_PAGEVIEW => {
				s.pageviews += 1;
				s.entry.get_or_insert(e);
				s.exit = &e.path;
				s.pages.insert(&e.path);
			}
			KIND_GOAL => {
				s.goals.insert(&e.name);
			}
			_ => {}
		}
	}
	sessions
}

/// The events inside the window whose session passes every filter, oldest first.
pub(crate) fn select<'a>(events: &'a [AnalyticsEvent], w: &Window, filters: &[Filter]) -> Vec<&'a AnalyticsEvent> {
	let inside: Vec<&AnalyticsEvent> = events.iter().filter(|e| w.contains(e.at)).collect();
	if filters.is_empty() {
		return inside;
	}
	let sessions = sessions(&inside);
	let kept: HashSet<&str> = sessions.iter().filter(|(_, s)| filters.iter().all(|f| s.matches(f))).map(|(id, _)| *id).collect();
	inside.into_iter().filter(|e| kept.contains(e.session.as_str())).collect()
}

/// Payments inside the window; with filters, only those of a visitor the filters kept.
pub(crate) fn select_payments<'a>(payments: &'a [Payment], events: &[&AnalyticsEvent], w: &Window, filters: &[Filter]) -> Vec<&'a Payment> {
	let visitors: HashSet<&str> = events.iter().map(|e| e.visitor.as_str()).collect();
	payments.iter().filter(|p| w.contains(p.at) && (filters.is_empty() || visitors.contains(p.visitor.as_str()))).collect()
}

#[derive(Debug, Default, Serialize)]
pub struct Report {
	pub visitors: u64,
	pub pageviews: u64,
	pub sessions: u64,
	/// Share of sessions with one pageview and no goal, 0 to 1.
	pub bounce_rate: f64,
	/// Mean time from a session's first event to its last.
	pub session_seconds: f64,
	pub online: u64,
	/// In minor units of `currency`; empty currency when there is no payment.
	pub revenue: i64,
	pub currency: String,
	/// Visitors in the window with at least one payment.
	pub customers: u64,
	pub series: Vec<Point>,
	pub channels: Vec<Row>,
	pub referrers: Vec<Row>,
	pub campaigns: Vec<Row>,
	pub pages: Vec<Row>,
	pub entry_pages: Vec<Row>,
	pub exit_pages: Vec<Row>,
	pub locations: Vec<Row>,
	pub regions: Vec<Row>,
	pub cities: Vec<Row>,
	pub devices: Vec<Row>,
	pub browsers: Vec<Row>,
	pub systems: Vec<Row>,
	pub goals: Vec<Row>,
}

#[derive(Debug, Default, Serialize, PartialEq)]
pub struct Point {
	pub at: i64,
	pub visitors: u64,
	pub pageviews: u64,
	pub revenue: i64,
}

/// One value of a breakdown: the visitors who had it and their revenue. A
/// visitor in two rows (two pages, two channels) counts in both.
#[derive(Debug, Default, Serialize, PartialEq)]
pub struct Row {
	pub name: String,
	pub visitors: u64,
	pub revenue: i64,
}

/// name -> the visitors who had it.
type Tally<'a> = HashMap<String, HashSet<&'a str>>;

fn add<'a>(tally: &mut Tally<'a>, name: &str, visitor: &'a str) {
	if !name.is_empty() {
		tally.entry(name.to_string()).or_default().insert(visitor);
	}
}

/// The currency most payments use; others are left out of a report.
/// shortcut: one currency per report; convert at record time if a site ever sells in two.
pub fn main_currency(payments: &[&Payment]) -> String {
	let mut per_currency: HashMap<&str, usize> = HashMap::new();
	for p in payments {
		*per_currency.entry(&p.currency).or_default() += 1;
	}
	per_currency.into_iter().max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(a.0))).map(|(c, _)| c.to_string()).unwrap_or_default()
}

/// Folds one site's events and payments, both oldest first, into the report
/// for the window, counting only the sessions that pass every filter.
/// shortcut: folds every event of the window in memory; past a few million
/// events a range, pre-aggregate per day instead.
pub fn report(events: &[AnalyticsEvent], payments: &[Payment], w: Window, filters: &[Filter]) -> Report {
	let events = select(events, &w, filters);
	let payments = select_payments(payments, &events, &w, filters);
	let mut r = Report::default();
	let mut visitors: HashSet<&str> = HashSet::new();
	let mut online: HashSet<&str> = HashSet::new();
	let mut buckets: HashMap<i64, (HashSet<&str>, u64, i64)> = HashMap::new();
	let (mut pages, mut goals, mut locations, mut regions, mut cities) =
		(Tally::new(), Tally::new(), Tally::new(), Tally::new(), Tally::new());
	let (mut devices, mut browsers, mut systems) = (Tally::new(), Tally::new(), Tally::new());

	for e in &events {
		let v = e.visitor.as_str();
		visitors.insert(v);
		// A goal from a site's backend is not an open tab.
		if e.kind != KIND_GOAL && e.at >= w.now - ONLINE_SECONDS {
			online.insert(v);
		}
		let bucket = buckets.entry(w.bucket_of(e.at)).or_default();
		bucket.0.insert(v);
		match e.kind.as_str() {
			KIND_PAGEVIEW => {
				r.pageviews += 1;
				bucket.1 += 1;
				add(&mut pages, &e.path, v);
				add(&mut locations, &e.location, v);
				add(&mut regions, &e.region, v);
				add(&mut cities, &e.city, v);
				add(&mut devices, &e.device, v);
				add(&mut browsers, &e.browser, v);
				add(&mut systems, &e.os, v);
			}
			KIND_GOAL => add(&mut goals, &e.name, v),
			_ => {}
		}
	}

	let (mut channels, mut referrers, mut campaigns, mut entry_pages, mut exit_pages) =
		(Tally::new(), Tally::new(), Tally::new(), Tally::new(), Tally::new());
	let (mut bounced, mut seconds) = (0u64, 0i64);
	for s in sessions(&events).values() {
		// A session that started before the window has no pageview in it.
		let Some(entry) = s.entry else { continue };
		r.sessions += 1;
		seconds += s.last - s.first;
		if s.pageviews == 1 && s.goals.is_empty() {
			bounced += 1;
		}
		add(&mut channels, channel(&entry.referrer, &entry.utm_source, &entry.utm_medium), s.visitor);
		add(&mut referrers, source_of(entry), s.visitor);
		add(&mut campaigns, &entry.utm_campaign, s.visitor);
		add(&mut entry_pages, &entry.path, s.visitor);
		add(&mut exit_pages, s.exit, s.visitor);
	}
	if r.sessions > 0 {
		r.bounce_rate = bounced as f64 / r.sessions as f64;
		r.session_seconds = seconds as f64 / r.sessions as f64;
	}

	r.currency = main_currency(&payments);
	let mut revenue_of: HashMap<&str, i64> = HashMap::new();
	for p in payments.iter().filter(|p| p.currency == r.currency) {
		r.revenue += p.amount;
		buckets.entry(w.bucket_of(p.at)).or_default().2 += p.amount;
		*revenue_of.entry(&p.visitor).or_default() += p.amount;
	}
	r.customers = visitors.iter().filter(|v| revenue_of.contains_key(*v)).count() as u64;
	r.visitors = visitors.len() as u64;
	r.online = online.len() as u64;

	let mut at = w.since;
	while at < w.until {
		let (seen, pageviews, revenue) = buckets.remove(&at).unwrap_or_default();
		r.series.push(Point { at, visitors: seen.len() as u64, pageviews, revenue });
		at += w.bucket;
	}

	let rows = |tally: Tally| -> Vec<Row> {
		let mut rows: Vec<Row> = tally
			.into_iter()
			.map(|(name, seen)| Row {
				name,
				visitors: seen.len() as u64,
				revenue: seen.iter().map(|v| revenue_of.get(v).copied().unwrap_or(0)).sum(),
			})
			.collect();
		rows.sort_by(|a, b| b.visitors.cmp(&a.visitors).then(b.revenue.cmp(&a.revenue)).then(a.name.cmp(&b.name)));
		rows.truncate(ROW_LIMIT);
		rows
	};
	r.channels = rows(channels);
	r.referrers = rows(referrers);
	r.campaigns = rows(campaigns);
	r.pages = rows(pages);
	r.entry_pages = rows(entry_pages);
	r.exit_pages = rows(exit_pages);
	r.locations = rows(locations);
	r.regions = rows(regions);
	r.cities = rows(cities);
	r.devices = rows(devices);
	r.browsers = rows(browsers);
	r.systems = rows(systems);
	r.goals = rows(goals);
	r
}

/// A cookieless visitor id: the same browser on the same site for one UTC day.
/// The salt rotates daily and is never stored with the events, so yesterday's
/// ids cannot be recomputed from an address.
pub fn cookieless_visitor(salt: &str, domain_id: &str, ip: &str, user_agent: &str) -> String {
	use sha2::{Digest, Sha256};
	let digest = Sha256::digest(format!("{salt}\n{domain_id}\n{ip}\n{user_agent}"));
	hex::encode(&digest[..16])
}

/// The day's cookieless salt, random per UTC day and kept in memory only. A
/// restart mid-day starts a new salt, so a cookieless visitor counts twice that day.
#[derive(Default)]
pub struct Salt(std::sync::Mutex<(i64, String)>);

impl Salt {
	pub fn today(&self, now: i64) -> String {
		let mut salt = self.0.lock().unwrap_or_else(|p| p.into_inner());
		let day = now.div_euclid(86_400);
		if salt.0 != day || salt.1.is_empty() {
			*salt = (day, crate::security::random_token(32));
		}
		salt.1.clone()
	}
}

/// The session a cookieless hit belongs to: the visitor's last one while it is
/// still live, otherwise a new one named after the visitor and the time.
pub fn cookieless_session(visitor: &str, last: Option<(String, i64)>, at: i64) -> String {
	match last {
		Some((session, last_at)) if at - last_at < SESSION_SECONDS => session,
		_ => format!("{visitor}-{at}"),
	}
}

#[cfg(test)]
mod tests;
