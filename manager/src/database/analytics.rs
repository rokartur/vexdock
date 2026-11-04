use std::collections::HashMap;

use anyhow::Result;
use rusqlite::{OptionalExtension, Row, params};
use serde::{Deserialize, Serialize};

use super::{Db, new_id};

/// One beacon hit, already cleaned by the analytics module. `at` is unix seconds.
#[derive(Clone, Debug, Default, PartialEq, Serialize)]
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
	pub region: String,
	pub city: String,
	pub device: String,
	pub browser: String,
	pub os: String,
	/// A goal's parameters as a JSON object; empty for the other kinds.
	pub props: String,
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

/// A site's analytics settings. The `*_enc` fields are sealed with the master
/// key and never leave the manager; a site with no row reads as the default.
#[derive(Clone, Debug, Default)]
pub struct SiteSettings {
	pub domain_id: String,
	pub share_token_hash: String,
	pub share_token_enc: String,
	pub notify_url_enc: String,
	pub digest_sent_at: i64,
	pub excluded_ips: String,
	pub x_token_enc: String,
	pub reddit: bool,
	pub stripe_secret_enc: String,
	pub lemonsqueezy_secret_enc: String,
	pub paddle_secret_enc: String,
	pub polar_secret_enc: String,
}

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct FunnelStep {
	/// page, goal or payment.
	pub kind: String,
	/// A path (a trailing `*` matches the prefix), a goal name, or empty for a payment.
	#[serde(default)]
	pub value: String,
}

#[derive(Clone, Debug, Default, Serialize)]
pub struct Funnel {
	pub id: String,
	pub name: String,
	pub steps: Vec<FunnelStep>,
}

pub const ANNOTATION_NOTE: &str = "note";
pub const ANNOTATION_X: &str = "x";
pub const ANNOTATION_REDDIT: &str = "reddit";

#[derive(Clone, Debug, Default, Serialize)]
pub struct Annotation {
	pub id: String,
	pub at: i64,
	pub source: String,
	pub text: String,
	pub url: String,
	pub author: String,
	/// t.co links the tweet carries; empty for the other sources.
	pub links: Vec<String>,
	#[serde(skip)]
	pub external_id: String,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
pub struct ShortLink {
	pub slug: String,
	pub target: String,
	#[serde(default)]
	pub utm_source: String,
	#[serde(default)]
	pub utm_medium: String,
	#[serde(default)]
	pub utm_campaign: String,
	#[serde(default)]
	pub created_at: i64,
}

const EVENT_COLUMNS: &str = "at, visitor, session, kind, name, path, referrer, utm_source, utm_medium, utm_campaign, location, region, city, device, browser, os, props";

const SITE_COLUMNS: &str = "domain_id, share_token_hash, share_token_enc, notify_url_enc, digest_sent_at, excluded_ips, x_token_enc, reddit, stripe_secret_enc, lemonsqueezy_secret_enc, paddle_secret_enc, polar_secret_enc";

impl Db {
	pub fn record_analytics_event(&self, domain_id: &str, e: &AnalyticsEvent) -> Result<()> {
		self.exec(
			&format!(
				"INSERT INTO analytics_events (domain_id, {EVENT_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
			),
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
				e.region,
				e.city,
				e.device,
				e.browser,
				e.os,
				e.props
			],
		)?;
		Ok(())
	}

	/// Every event of one site in `[since, until)`, oldest first.
	pub fn analytics_events(&self, domain_id: &str, since: i64, until: i64) -> Result<Vec<AnalyticsEvent>> {
		self.all(
			&format!("SELECT {EVENT_COLUMNS} FROM analytics_events WHERE domain_id = ? AND at >= ? AND at < ? ORDER BY at, rowid"),
			params![domain_id, since, until],
			scan_event,
		)
	}

	/// One visitor's pageviews and goals, oldest first, at most the last `limit`.
	pub fn visitor_events(&self, domain_id: &str, visitor: &str, limit: i64) -> Result<Vec<AnalyticsEvent>> {
		let mut events = self.all(
			&format!(
				"SELECT {EVENT_COLUMNS} FROM analytics_events WHERE domain_id = ? AND visitor = ? AND kind != 'ping'
				 ORDER BY at DESC, rowid DESC LIMIT ?"
			),
			params![domain_id, visitor, limit],
			scan_event,
		)?;
		events.reverse();
		Ok(events)
	}

	pub fn visitor_payments(&self, domain_id: &str, visitor: &str) -> Result<Vec<Payment>> {
		self.all(
			"SELECT payment_id, at, visitor, amount, currency FROM analytics_payments WHERE domain_id = ? AND visitor = ? ORDER BY at",
			params![domain_id, visitor],
			scan_payment,
		)
	}

	pub fn has_paid(&self, domain_id: &str, visitor: &str) -> Result<bool> {
		self.one("SELECT EXISTS(SELECT 1 FROM analytics_payments WHERE domain_id = ? AND visitor = ?)", params![domain_id, visitor], |r| {
			r.get(0)
		})
	}

	/// The session and time of a visitor's last event, for cookieless hits.
	pub fn last_session(&self, domain_id: &str, visitor: &str) -> Result<Option<(String, i64)>> {
		Ok(self
			.conn()
			.query_row(
				"SELECT session, at FROM analytics_events WHERE domain_id = ? AND visitor = ? ORDER BY at DESC LIMIT 1",
				params![domain_id, visitor],
				|r| Ok((r.get(0)?, r.get(1)?)),
			)
			.optional()?)
	}

	pub fn first_event_at(&self, domain_id: &str) -> Result<Option<i64>> {
		Ok(self.conn().query_row("SELECT MIN(at) FROM analytics_events WHERE domain_id = ?", [domain_id], |r| r.get(0))?)
	}

	/// Records a payment once: false when this site already has `payment_id`.
	pub fn record_payment(&self, domain_id: &str, p: &Payment) -> Result<bool> {
		let inserted = self.exec(
			"INSERT OR IGNORE INTO analytics_payments (domain_id, payment_id, at, visitor, amount, currency) VALUES (?, ?, ?, ?, ?, ?)",
			params![domain_id, p.payment_id, p.at, p.visitor, p.amount, p.currency],
		)?;
		Ok(inserted == 1)
	}

	/// Payments in `[since, until)`, oldest first.
	pub fn analytics_payments(&self, domain_id: &str, since: i64, until: i64) -> Result<Vec<Payment>> {
		self.all(
			"SELECT payment_id, at, visitor, amount, currency FROM analytics_payments WHERE domain_id = ? AND at >= ? AND at < ? ORDER BY at",
			params![domain_id, since, until],
			scan_payment,
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

	pub fn site_settings(&self, domain_id: &str) -> Result<SiteSettings> {
		let found = self
			.conn()
			.query_row(&format!("SELECT {SITE_COLUMNS} FROM analytics_sites WHERE domain_id = ?"), [domain_id], scan_site)
			.optional()?;
		Ok(found.unwrap_or_else(|| SiteSettings { domain_id: domain_id.into(), ..Default::default() }))
	}

	/// Every site that has a settings row, for the scheduler's digests and mentions.
	pub fn all_site_settings(&self) -> Result<Vec<SiteSettings>> {
		self.all(&format!("SELECT {SITE_COLUMNS} FROM analytics_sites"), [], scan_site)
	}

	pub fn site_by_share_hash(&self, hash: &str) -> Result<String> {
		self.one("SELECT domain_id FROM analytics_sites WHERE share_token_hash = ? AND share_token_hash != ''", [hash], |r| r.get(0))
	}

	/// Only the stamp, so a settings save made while the digest was sending survives.
	pub fn mark_digest_sent(&self, domain_id: &str, at: i64) -> Result<()> {
		self.exec("UPDATE analytics_sites SET digest_sent_at = ? WHERE domain_id = ?", params![at, domain_id])?;
		Ok(())
	}

	pub fn save_site_settings(&self, s: &SiteSettings) -> Result<()> {
		self.exec(
			&format!("INSERT OR REPLACE INTO analytics_sites ({SITE_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"),
			params![
				s.domain_id,
				s.share_token_hash,
				s.share_token_enc,
				s.notify_url_enc,
				s.digest_sent_at,
				s.excluded_ips,
				s.x_token_enc,
				s.reddit,
				s.stripe_secret_enc,
				s.lemonsqueezy_secret_enc,
				s.paddle_secret_enc,
				s.polar_secret_enc
			],
		)?;
		Ok(())
	}

	pub fn list_funnels(&self, domain_id: &str) -> Result<Vec<Funnel>> {
		let rows = self.all("SELECT id, name, steps FROM analytics_funnels WHERE domain_id = ? ORDER BY id", [domain_id], |r| {
			Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
		})?;
		let mut funnels = Vec::new();
		for (id, name, steps) in rows {
			funnels.push(Funnel { id, name, steps: serde_json::from_str(&steps)? });
		}
		Ok(funnels)
	}

	pub fn create_funnel(&self, domain_id: &str, name: &str, steps: &[FunnelStep]) -> Result<Funnel> {
		let funnel = Funnel { id: new_id(), name: name.into(), steps: steps.to_vec() };
		self.exec(
			"INSERT INTO analytics_funnels (id, domain_id, name, steps) VALUES (?, ?, ?, ?)",
			params![funnel.id, domain_id, funnel.name, serde_json::to_string(steps)?],
		)?;
		Ok(funnel)
	}

	/// False when this site has no such funnel.
	pub fn delete_funnel(&self, domain_id: &str, id: &str) -> Result<bool> {
		Ok(self.exec("DELETE FROM analytics_funnels WHERE domain_id = ? AND id = ?", [domain_id, id])? == 1)
	}

	/// Annotations in `[since, until)`, oldest first.
	pub fn annotations(&self, domain_id: &str, since: i64, until: i64) -> Result<Vec<Annotation>> {
		self.all(
			"SELECT id, at, source, text, url, author, links, external_id FROM analytics_annotations
			 WHERE domain_id = ? AND at >= ? AND at < ? ORDER BY at",
			params![domain_id, since, until],
			|r| {
				Ok(Annotation {
					id: r.get(0)?,
					at: r.get(1)?,
					source: r.get(2)?,
					text: r.get(3)?,
					url: r.get(4)?,
					author: r.get(5)?,
					links: r.get::<_, String>(6)?.split_whitespace().map(String::from).collect(),
					external_id: r.get(7)?,
				})
			},
		)
	}

	/// Adds an annotation once per external id: false when a mention is already there.
	pub fn add_annotation(&self, domain_id: &str, a: &Annotation) -> Result<bool> {
		let inserted = self.exec(
			"INSERT OR IGNORE INTO analytics_annotations (id, domain_id, at, source, text, url, author, links, external_id)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
			params![a.id, domain_id, a.at, a.source, a.text, a.url, a.author, a.links.join(" "), a.external_id],
		)?;
		Ok(inserted == 1)
	}

	pub fn delete_annotation(&self, domain_id: &str, id: &str) -> Result<bool> {
		Ok(self.exec("DELETE FROM analytics_annotations WHERE domain_id = ? AND id = ?", [domain_id, id])? == 1)
	}

	pub fn list_links(&self, domain_id: &str) -> Result<Vec<ShortLink>> {
		self.all(
			"SELECT slug, target, utm_source, utm_medium, utm_campaign, created_at FROM analytics_links WHERE domain_id = ? ORDER BY created_at DESC",
			[domain_id],
			scan_link,
		)
	}

	pub fn short_link(&self, domain_id: &str, slug: &str) -> Result<ShortLink> {
		self.one(
			"SELECT slug, target, utm_source, utm_medium, utm_campaign, created_at FROM analytics_links WHERE domain_id = ? AND slug = ?",
			[domain_id, slug],
			scan_link,
		)
	}

	/// False when this site already has the slug.
	pub fn create_link(&self, domain_id: &str, l: &ShortLink) -> Result<bool> {
		let inserted = self.exec(
			"INSERT OR IGNORE INTO analytics_links (domain_id, slug, target, utm_source, utm_medium, utm_campaign, created_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)",
			params![domain_id, l.slug, l.target, l.utm_source, l.utm_medium, l.utm_campaign, l.created_at],
		)?;
		Ok(inserted == 1)
	}

	pub fn delete_link(&self, domain_id: &str, slug: &str) -> Result<bool> {
		Ok(self.exec("DELETE FROM analytics_links WHERE domain_id = ? AND slug = ?", [domain_id, slug])? == 1)
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
		region: r.get(11)?,
		city: r.get(12)?,
		device: r.get(13)?,
		browser: r.get(14)?,
		os: r.get(15)?,
		props: r.get(16)?,
	})
}

fn scan_payment(r: &Row) -> rusqlite::Result<Payment> {
	Ok(Payment { payment_id: r.get(0)?, at: r.get(1)?, visitor: r.get(2)?, amount: r.get(3)?, currency: r.get(4)? })
}

fn scan_site(r: &Row) -> rusqlite::Result<SiteSettings> {
	Ok(SiteSettings {
		domain_id: r.get(0)?,
		share_token_hash: r.get(1)?,
		share_token_enc: r.get(2)?,
		notify_url_enc: r.get(3)?,
		digest_sent_at: r.get(4)?,
		excluded_ips: r.get(5)?,
		x_token_enc: r.get(6)?,
		reddit: r.get(7)?,
		stripe_secret_enc: r.get(8)?,
		lemonsqueezy_secret_enc: r.get(9)?,
		paddle_secret_enc: r.get(10)?,
		polar_secret_enc: r.get(11)?,
	})
}

fn scan_link(r: &Row) -> rusqlite::Result<ShortLink> {
	Ok(ShortLink {
		slug: r.get(0)?,
		target: r.get(1)?,
		utm_source: r.get(2)?,
		utm_medium: r.get(3)?,
		utm_campaign: r.get(4)?,
		created_at: r.get(5)?,
	})
}
