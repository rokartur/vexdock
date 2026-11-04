//! Views over the same events as the report: who the visitors were, who is on
//! the site right now, and how far each funnel's visitors got.

use std::collections::HashMap;

use serde::Serialize;

use super::{Filter, KIND_GOAL, KIND_PAGEVIEW, ONLINE_SECONDS, Window, channel, select, select_payments, sessions, source_of};
use crate::database::{AnalyticsEvent, FunnelStep, Payment};

/// Visitors listed per request, most recent first.
const VISITOR_LIMIT: usize = 200;

/// One visitor in the window: where they first came from and what they did.
#[derive(Debug, Default, Serialize, PartialEq)]
pub struct VisitorRow {
	pub visitor: String,
	pub first_seen: i64,
	pub last_seen: i64,
	pub sessions: u64,
	pub pageviews: u64,
	pub goals: u64,
	pub channel: String,
	pub referrer: String,
	pub location: String,
	pub city: String,
	pub device: String,
	pub browser: String,
	pub os: String,
	/// Every payment in the window, in minor units of its own currency.
	pub revenue: i64,
	pub currency: String,
}

#[derive(Debug, Serialize)]
pub struct Visitors {
	/// How many visitors the window holds; `visitors` stops at the newest 200.
	pub total: usize,
	pub visitors: Vec<VisitorRow>,
}

/// The visitors the filters keep in the window, most recently seen first.
pub fn visitors(events: &[AnalyticsEvent], payments: &[Payment], w: &Window, filters: &[Filter]) -> Visitors {
	let events = select(events, w, filters);
	let payments = select_payments(payments, &events, w, filters);
	let mut rows: HashMap<&str, VisitorRow> = HashMap::new();
	for e in &events {
		let row =
			rows.entry(&e.visitor).or_insert_with(|| VisitorRow { visitor: e.visitor.clone(), first_seen: e.at, ..Default::default() });
		row.last_seen = e.at;
		match e.kind.as_str() {
			KIND_PAGEVIEW => {
				row.pageviews += 1;
				if row.pageviews == 1 {
					row.channel = channel(&e.referrer, &e.utm_source, &e.utm_medium).into();
					row.referrer = source_of(e).into();
					row.location = e.location.clone();
					row.city = e.city.clone();
					row.device = e.device.clone();
					row.browser = e.browser.clone();
					row.os = e.os.clone();
				}
			}
			KIND_GOAL => row.goals += 1,
			_ => {}
		}
	}
	for s in sessions(&events).values() {
		if let Some(row) = rows.get_mut(s.visitor) {
			row.sessions += 1;
		}
	}
	for p in payments {
		if let Some(row) = rows.get_mut(p.visitor.as_str()) {
			row.revenue += p.amount;
			row.currency = p.currency.clone();
		}
	}
	let mut rows: Vec<VisitorRow> = rows.into_values().collect();
	rows.sort_by(|a, b| b.last_seen.cmp(&a.last_seen).then(a.visitor.cmp(&b.visitor)));
	let total = rows.len();
	rows.truncate(VISITOR_LIMIT);
	Visitors { total, visitors: rows }
}

/// A visitor on the site right now.
#[derive(Debug, Default, Serialize, PartialEq)]
pub struct LiveVisitor {
	pub visitor: String,
	/// The last page they opened.
	pub path: String,
	pub channel: String,
	pub referrer: String,
	pub location: String,
	pub city: String,
	pub device: String,
	pub browser: String,
	pub os: String,
	pub last_seen: i64,
	/// Pageviews in the current session.
	pub pageviews: u64,
	/// Whether they ever paid, so a returning customer stands out.
	pub customer: bool,
}

/// What happened on the site lately, newest first: a pageview, a goal or a payment.
#[derive(Debug, Default, Serialize, PartialEq)]
pub struct FeedItem {
	pub at: i64,
	pub kind: String,
	pub visitor: String,
	/// The path of a pageview, the goal's name, or the payment's amount in minor units.
	pub detail: String,
	pub currency: String,
	pub location: String,
}

#[derive(Debug, Default, Serialize)]
pub struct Live {
	pub online: Vec<LiveVisitor>,
	pub feed: Vec<FeedItem>,
}

/// Feed items returned at most.
const FEED_LIMIT: usize = 50;

/// Folds the last half hour of events and payments, oldest first. `customer`
/// is left for the caller, which asks the database about the online visitors only.
pub fn live(events: &[AnalyticsEvent], payments: &[Payment], now: i64) -> Live {
	let refs: Vec<&AnalyticsEvent> = events.iter().collect();
	let sessions = sessions(&refs);
	// A tab open longer than the window has only pings in it, so the latest event describes the visit.
	// A goal sent from a site's backend is not a tab, so it alone does not put a visitor online.
	let latest: HashMap<&str, &AnalyticsEvent> = events.iter().filter(|e| e.kind != KIND_GOAL).map(|e| (e.session.as_str(), e)).collect();
	let mut online: HashMap<&str, LiveVisitor> = HashMap::new();
	for (id, s) in &sessions {
		let Some(&last) = latest.get(id) else { continue };
		if last.at < now - ONLINE_SECONDS {
			continue;
		}
		let newer = online.get(s.visitor).is_none_or(|seen| seen.last_seen < last.at);
		if !newer {
			continue;
		}
		let entry = s.entry.unwrap_or(last);
		online.insert(
			s.visitor,
			LiveVisitor {
				visitor: s.visitor.into(),
				path: if s.exit.is_empty() { last.path.clone() } else { s.exit.into() },
				channel: channel(&entry.referrer, &entry.utm_source, &entry.utm_medium).into(),
				referrer: source_of(entry).into(),
				location: entry.location.clone(),
				city: entry.city.clone(),
				device: entry.device.clone(),
				browser: entry.browser.clone(),
				os: entry.os.clone(),
				last_seen: last.at,
				pageviews: s.pageviews,
				customer: false,
			},
		);
	}
	let mut online: Vec<LiveVisitor> = online.into_values().collect();
	online.sort_by(|a, b| b.last_seen.cmp(&a.last_seen).then(a.visitor.cmp(&b.visitor)));

	let mut feed = Vec::new();
	for e in events.iter().filter(|e| e.kind == KIND_PAGEVIEW || e.kind == KIND_GOAL) {
		let detail = if e.kind == KIND_GOAL { e.name.clone() } else { e.path.clone() };
		feed.push(FeedItem {
			at: e.at,
			kind: e.kind.clone(),
			visitor: e.visitor.clone(),
			detail,
			currency: String::new(),
			location: e.location.clone(),
		});
	}
	for p in payments {
		feed.push(FeedItem {
			at: p.at,
			kind: "payment".into(),
			visitor: p.visitor.clone(),
			detail: p.amount.to_string(),
			currency: p.currency.clone(),
			location: String::new(),
		});
	}
	// Stable, so a payment recorded in the same second stays after its pageview.
	feed.sort_by_key(|item| std::cmp::Reverse(item.at));
	feed.truncate(FEED_LIMIT);
	Live { online, feed }
}

pub const STEP_PAGE: &str = "page";
pub const STEP_GOAL: &str = "goal";
pub const STEP_PAYMENT: &str = "payment";

/// Checks a funnel's steps as the API accepts them: two to eight, each a known
/// kind with a value (a path for page, a goal name for goal, none for payment).
pub fn validate_steps(steps: &[FunnelStep]) -> Result<Vec<FunnelStep>, String> {
	if !(2..=8).contains(&steps.len()) {
		return Err("a funnel has two to eight steps".into());
	}
	let mut clean = Vec::new();
	for step in steps {
		let value = match step.kind.as_str() {
			STEP_PAGE => {
				let path = step.value.trim();
				if !path.starts_with('/') || path.len() > 512 {
					return Err(format!("page step {path:?} must be a path starting with /"));
				}
				path.to_string()
			}
			STEP_GOAL => super::goal_name(&step.value).ok_or_else(|| format!("goal step {:?} is not a goal name", step.value))?,
			STEP_PAYMENT => String::new(),
			kind => return Err(format!("unknown step kind {kind:?}, expected page, goal or payment")),
		};
		clean.push(FunnelStep { kind: step.kind.clone(), value });
	}
	Ok(clean)
}

fn page_matches(pattern: &str, path: &str) -> bool {
	match pattern.strip_suffix('*') {
		Some(prefix) => path.starts_with(prefix),
		None => pattern == path,
	}
}

/// How many of the kept visitors reached each step, in order: a visitor counts
/// at step n only after doing steps 1 to n-1 earlier in the window.
pub fn funnel(events: &[AnalyticsEvent], payments: &[Payment], w: &Window, filters: &[Filter], steps: &[FunnelStep]) -> Vec<u64> {
	let events = select(events, w, filters);
	let payments = select_payments(payments, &events, w, filters);
	// (at, kind, value) per visitor, merged and in time order.
	let mut timelines: HashMap<&str, Vec<(i64, &str, &str)>> = HashMap::new();
	for e in &events {
		let value = if e.kind == KIND_GOAL { e.name.as_str() } else { e.path.as_str() };
		if e.kind == KIND_PAGEVIEW || e.kind == KIND_GOAL {
			timelines.entry(&e.visitor).or_default().push((e.at, e.kind.as_str(), value));
		}
	}
	for p in &payments {
		if let Some(timeline) = timelines.get_mut(p.visitor.as_str()) {
			timeline.push((p.at, STEP_PAYMENT, ""));
		}
	}
	let mut reached = vec![0u64; steps.len()];
	for timeline in timelines.values_mut() {
		timeline.sort_by_key(|(at, _, _)| *at);
		let mut next = 0;
		for (_, kind, value) in timeline.iter() {
			let Some(step) = steps.get(next) else { break };
			let hit = match step.kind.as_str() {
				STEP_PAGE => *kind == KIND_PAGEVIEW && page_matches(&step.value, value),
				STEP_GOAL => *kind == KIND_GOAL && step.value == *value,
				_ => *kind == STEP_PAYMENT,
			};
			if hit {
				reached[next] += 1;
				next += 1;
			}
		}
	}
	reached
}
