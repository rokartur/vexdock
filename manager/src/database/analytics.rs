use std::collections::HashMap;

use anyhow::Result;
use rusqlite::{Row, params};
use serde::Serialize;

use super::Db;

/// One beacon hit, already cleaned by the analytics module. `at` is unix seconds.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct AnalyticsEvent {
	pub at: i64,
	pub visitor: String,
	pub session: String,
	pub kind: String,
	pub name: String,
	pub path: String,
	pub referrer: String,
	pub utm_source: String,
	pub utm_medium: String,
	pub utm_campaign: String,
	pub location: String,
	pub device: String,
	pub browser: String,
	pub os: String,
}

/// Revenue a site's backend attributed to a visitor. `amount` is in minor units.
#[derive(Clone, Debug, Default, Serialize)]
pub struct Payment {
	pub payment_id: String,
	pub at: i64,
	pub visitor: String,
	pub amount: i64,
	pub currency: String,
}

/// What the sites list shows for one domain: distinct visitors since the cutoff
/// and per hour.
#[derive(Clone, Debug, Default, Serialize)]
pub struct SiteTraffic {
	pub visitors: u64,
	/// (hour start in unix seconds, distinct visitors), oldest first, hours with
	/// no visitor omitted.
	pub hourly: Vec<(i64, u64)>,
}

const EVENT_COLUMNS: &str =
	"at, visitor, session, kind, name, path, referrer, utm_source, utm_medium, utm_campaign, location, device, browser, os";

impl Db {
	pub fn record_analytics_event(&self, domain_id: &str, e: &AnalyticsEvent) -> Result<()> {
		self.exec(
			&format!("INSERT INTO analytics_events (domain_id, {EVENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
			params![
				domain_id,
				e.at,
				e.visitor,
				e.session,
				e.kind,
				e.name,
				e.path,
				e.referrer,
				e.utm_source,
				e.utm_medium,
				e.utm_campaign,
				e.location,
				e.device,
				e.browser,
				e.os
			],
		)?;
		Ok(())
	}

	/// Every event of one site since `since`, oldest first.
	pub fn analytics_events(&self, domain_id: &str, since: i64) -> Result<Vec<AnalyticsEvent>> {
		self.all(
			&format!("SELECT {EVENT_COLUMNS} FROM analytics_events WHERE domain_id = ? AND at >= ? ORDER BY at, rowid"),
			params![domain_id, since],
			scan_event,
		)
	}

	/// Records a payment once: false when this site already has `payment_id`.
	pub fn record_payment(&self, domain_id: &str, p: &Payment) -> Result<bool> {
		let inserted = self.exec(
			"INSERT OR IGNORE INTO analytics_payments (domain_id, payment_id, at, visitor, amount, currency) VALUES (?, ?, ?, ?, ?, ?)",
			params![domain_id, p.payment_id, p.at, p.visitor, p.amount, p.currency],
		)?;
		Ok(inserted == 1)
	}

	pub fn analytics_payments(&self, domain_id: &str, since: i64) -> Result<Vec<Payment>> {
		self.all(
			"SELECT payment_id, at, visitor, amount, currency FROM analytics_payments WHERE domain_id = ? AND at >= ? ORDER BY at",
			params![domain_id, since],
			|r| Ok(Payment { payment_id: r.get(0)?, at: r.get(1)?, visitor: r.get(2)?, amount: r.get(3)?, currency: r.get(4)? }),
		)
	}

	/// Visitors per site since `since`, for every site that had one.
	pub fn site_traffic(&self, since: i64) -> Result<HashMap<String, SiteTraffic>> {
		let totals =
			self.all("SELECT domain_id, COUNT(DISTINCT visitor) FROM analytics_events WHERE at >= ? GROUP BY domain_id", [since], |r| {
				Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?))
			})?;
		let hours = self.all(
			"SELECT domain_id, (at / 3600) * 3600 AS hour, COUNT(DISTINCT visitor) FROM analytics_events
			 WHERE at >= ? GROUP BY domain_id, hour ORDER BY domain_id, hour",
			[since],
			|r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?, r.get::<_, i64>(2)?)),
		)?;
		let mut out: HashMap<String, SiteTraffic> = HashMap::new();
		for (domain_id, visitors) in totals {
			out.entry(domain_id).or_default().visitors = visitors as u64;
		}
		for (domain_id, hour, visitors) in hours {
			out.entry(domain_id).or_default().hourly.push((hour, visitors as u64));
		}
		Ok(out)
	}

	/// Drops events and payments older than `before` (unix seconds).
	pub fn prune_analytics(&self, before: i64) -> Result<()> {
		self.exec("DELETE FROM analytics_events WHERE at < ?", [before])?;
		self.exec("DELETE FROM analytics_payments WHERE at < ?", [before])?;
		Ok(())
	}
}

fn scan_event(r: &Row) -> rusqlite::Result<AnalyticsEvent> {
	Ok(AnalyticsEvent {
		at: r.get(0)?,
		visitor: r.get(1)?,
		session: r.get(2)?,
		kind: r.get(3)?,
		name: r.get(4)?,
		path: r.get(5)?,
		referrer: r.get(6)?,
		utm_source: r.get(7)?,
		utm_medium: r.get(8)?,
		utm_campaign: r.get(9)?,
		location: r.get(10)?,
		device: r.get(11)?,
		browser: r.get(12)?,
		os: r.get(13)?,
	})
}
