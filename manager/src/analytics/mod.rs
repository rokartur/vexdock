//! Site analytics. A proxied hostname serves `/_vx/script.js`, which reports
//! pageviews, heartbeats and goals to `/_vx/event`; a site's backend reports
//! payments through the API with the visitor id the script keeps in the vx_vid
//! cookie. This module cleans a hit into a stored event and folds a window of
//! events and payments into the report the panel shows.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::database::{AnalyticsEvent, Payment};

pub const SCRIPT: &str = include_str!("script.js");

/// Events and payments older than this are pruned; the longest range is the same.
pub const RETENTION_DAYS: i64 = 90;

/// A visitor whose last event is this recent counts as online. The script pings
/// once a minute while its tab is visible.
pub const ONLINE_SECONDS: i64 = 180;

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
}

/// Cleans a hit into a storable event. None for a bot, a malformed id or an
/// unknown kind: the beacon endpoint drops those without saying why.
pub fn event(hit: Hit, hostname: &str, user_agent: &str, edge_country: &str, at: i64) -> Option<AnalyticsEvent> {
	if is_bot(user_agent) || !is_id(&hit.visitor) || !is_id(&hit.session) {
		return None;
	}
	let name = match hit.kind.as_str() {
		KIND_PAGEVIEW | KIND_PING => String::new(),
		KIND_GOAL => goal_name(&hit.name)?,
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
		location: location(edge_country, &hit.timezone),
		device: client.device.into(),
		browser: client.browser.into(),
		os: client.os.into(),
	})
}

/// The ids the script generates: a UUID, or its fallback on plain HTTP.
pub fn is_id(id: &str) -> bool {
	(8..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

/// Goal names are lowercase letters, digits, `_` and `-`, at most 64 long, so
/// `Sign up` and `sign_up` cannot become two rows by accident.
fn goal_name(raw: &str) -> Option<String> {
	let name = raw.trim().to_ascii_lowercase();
	let valid =
		(1..=64).contains(&name.len()) && name.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-');
	valid.then_some(name)
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

const BOT_MARKERS: &[&str] = &[
	"bot",
	"crawl",
	"spider",
	"slurp",
	"curl",
	"wget",
	"headless",
	"monitor",
	"preview",
	"python-requests",
	"go-http-client",
	"lighthouse",
	"pingdom",
];

pub fn is_bot(user_agent: &str) -> bool {
	let ua = user_agent.to_ascii_lowercase();
	ua.is_empty() || BOT_MARKERS.iter().any(|marker| ua.contains(marker))
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
pub fn referrer_host(raw: &str, hostname: &str) -> String {
	let Ok(url) = url::Url::parse(raw.trim()) else { return String::new() };
	let Some(host) = url.host_str() else { return String::new() };
	let host = host.to_ascii_lowercase();
	let host = host.trim_start_matches("www.");
	if host == hostname.trim_start_matches("www.") { String::new() } else { truncate(host, 253) }
}

/// Cloudflare's country code when the site is behind it, otherwise the
/// browser's timezone, which names a region without an IP database.
fn location(edge_country: &str, timezone: &str) -> String {
	let code = edge_country.trim();
	if code.len() == 2 && code.bytes().all(|b| b.is_ascii_uppercase()) && code != "XX" {
		return code.into();
	}
	let timezone = timezone.trim();
	let valid = timezone.len() <= 64 && timezone.bytes().all(|b| b.is_ascii_alphanumeric() || b"/_+-".contains(&b));
	if valid { timezone.into() } else { String::new() }
}

fn truncate(s: &str, max: usize) -> String {
	let mut end = s.len().min(max);
	while !s.is_char_boundary(end) {
		end -= 1;
	}
	s[..end].to_string()
}

/// The channel a session came through, from its first pageview.
pub fn channel(referrer: &str, utm_source: &str, utm_medium: &str) -> &'static str {
	let medium = utm_medium.to_ascii_lowercase();
	let source = if referrer.is_empty() { utm_source.to_ascii_lowercase() } else { referrer.to_string() };
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
	} else if SOCIAL_HOSTS.contains(&source.as_str()) || SOCIAL.iter().any(|stem| labels.contains(stem)) {
		"Social"
	} else {
		"Referral"
	}
}

/// The span a report covers and the size of its chart buckets, in unix seconds.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Window {
	pub since: i64,
	pub now: i64,
	pub bucket: i64,
	/// Seconds east of UTC, so a day bucket starts at the viewer's midnight.
	pub offset: i64,
}

impl Window {
	/// `24h` in hours, `7d`, `30d` and `90d` in days, each ending with the
	/// bucket that holds `now`. None for any other name.
	pub fn new(range: &str, now: i64, offset: i64) -> Option<Window> {
		let (points, bucket) = match range {
			"24h" => (24, 3600),
			"7d" => (7, 86_400),
			"30d" => (30, 86_400),
			"90d" => (RETENTION_DAYS, 86_400),
			_ => return None,
		};
		let mut w = Window { since: 0, now, bucket, offset };
		w.since = w.bucket_of(now) - (points - 1) * bucket;
		Some(w)
	}

	fn bucket_of(&self, at: i64) -> i64 {
		(at + self.offset).div_euclid(self.bucket) * self.bucket - self.offset
	}
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

struct Session<'a> {
	visitor: &'a str,
	first: i64,
	last: i64,
	pageviews: u64,
	goals: u64,
	entry: Option<&'a AnalyticsEvent>,
	exit: &'a str,
}

/// name -> the visitors who had it.
type Tally<'a> = HashMap<String, HashSet<&'a str>>;

fn add<'a>(tally: &mut Tally<'a>, name: &str, visitor: &'a str) {
	if !name.is_empty() {
		tally.entry(name.to_string()).or_default().insert(visitor);
	}
}

/// Folds one site's events and payments since `w.since`, both oldest first,
/// into its report.
pub fn report(events: &[AnalyticsEvent], payments: &[Payment], w: Window) -> Report {
	let mut r = Report::default();
	let mut visitors: HashSet<&str> = HashSet::new();
	let mut online: HashSet<&str> = HashSet::new();
	let mut sessions: HashMap<&str, Session> = HashMap::new();
	let mut buckets: HashMap<i64, (HashSet<&str>, u64, i64)> = HashMap::new();
	let (mut pages, mut goals, mut locations, mut devices, mut browsers, mut systems) =
		(Tally::new(), Tally::new(), Tally::new(), Tally::new(), Tally::new(), Tally::new());

	for e in events {
		let v = e.visitor.as_str();
		visitors.insert(v);
		if e.at >= w.now - ONLINE_SECONDS {
			online.insert(v);
		}
		let bucket = buckets.entry(w.bucket_of(e.at)).or_default();
		bucket.0.insert(v);
		let s = sessions.entry(&e.session).or_insert(Session {
			visitor: v,
			first: e.at,
			last: e.at,
			pageviews: 0,
			goals: 0,
			entry: None,
			exit: "",
		});
		s.last = e.at;
		match e.kind.as_str() {
			KIND_PAGEVIEW => {
				r.pageviews += 1;
				bucket.1 += 1;
				s.pageviews += 1;
				s.entry.get_or_insert(e);
				s.exit = &e.path;
				add(&mut pages, &e.path, v);
				add(&mut locations, &e.location, v);
				add(&mut devices, &e.device, v);
				add(&mut browsers, &e.browser, v);
				add(&mut systems, &e.os, v);
			}
			KIND_GOAL => {
				s.goals += 1;
				add(&mut goals, &e.name, v);
			}
			_ => {}
		}
	}

	let (mut channels, mut referrers, mut campaigns, mut entry_pages, mut exit_pages) =
		(Tally::new(), Tally::new(), Tally::new(), Tally::new(), Tally::new());
	let (mut bounced, mut seconds) = (0u64, 0i64);
	for s in sessions.values() {
		// A session that started before the window has no pageview in it.
		let Some(entry) = s.entry else { continue };
		r.sessions += 1;
		seconds += s.last - s.first;
		if s.pageviews == 1 && s.goals == 0 {
			bounced += 1;
		}
		add(&mut channels, channel(&entry.referrer, &entry.utm_source, &entry.utm_medium), s.visitor);
		let source = if entry.referrer.is_empty() { entry.utm_source.as_str() } else { entry.referrer.as_str() };
		add(&mut referrers, if source.is_empty() { "Direct" } else { source }, s.visitor);
		add(&mut campaigns, &entry.utm_campaign, s.visitor);
		add(&mut entry_pages, &entry.path, s.visitor);
		add(&mut exit_pages, s.exit, s.visitor);
	}
	if r.sessions > 0 {
		r.bounce_rate = bounced as f64 / r.sessions as f64;
		r.session_seconds = seconds as f64 / r.sessions as f64;
	}

	// shortcut: one currency per report, the one most payments use; others are
	// left out. Convert at record time if a site ever sells in two.
	let mut per_currency: HashMap<&str, usize> = HashMap::new();
	for p in payments {
		*per_currency.entry(&p.currency).or_default() += 1;
	}
	r.currency = per_currency.into_iter().max_by(|a, b| a.1.cmp(&b.1).then(b.0.cmp(a.0))).map(|(c, _)| c.to_string()).unwrap_or_default();
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
	while at <= w.now {
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
	r.devices = rows(devices);
	r.browsers = rows(browsers);
	r.systems = rows(systems);
	r.goals = rows(goals);
	r
}

#[cfg(test)]
mod tests;
