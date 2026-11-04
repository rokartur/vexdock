//! Messages to the webhook URL a site owner sets: one per sale, and a weekly
//! digest. The body carries the text as `text` (Slack) and `content` (Discord),
//! so either accepts the URL as is.

use std::net::{IpAddr, SocketAddr};
use std::time::Duration;

use anyhow::{Context, Result, bail};

use super::Report;
use crate::database::Payment;

/// A digest goes out once this long after the last one.
pub const DIGEST_EVERY: i64 = 7 * 86_400;

/// Checks the shape of a webhook URL when it is saved: https, a host name, no
/// credentials. Where it resolves is checked again on every send.
pub fn validate_url(raw: &str) -> Result<String> {
	let raw = raw.trim();
	let url = url::Url::parse(raw).context("webhook URL is not a URL")?;
	if url.scheme() != "https" {
		bail!("webhook URL must be https");
	}
	if !url.username().is_empty() || url.password().is_some() {
		bail!("webhook URL must not carry credentials");
	}
	let literal = match url.host() {
		None => bail!("webhook URL has no host"),
		Some(url::Host::Domain(_)) => None,
		Some(url::Host::Ipv4(ip)) => Some(IpAddr::V4(ip)),
		Some(url::Host::Ipv6(ip)) => Some(IpAddr::V6(ip)),
	};
	if literal.is_some_and(|ip| !is_public(ip)) {
		bail!("webhook URL must reach a public address");
	}
	Ok(raw.to_string())
}

/// The manager sits next to the panel, the database and every deployed app, so
/// a webhook must never reach one of them.
fn is_public(ip: IpAddr) -> bool {
	match ip {
		IpAddr::V4(v4) => {
			let [a, b, ..] = v4.octets();
			!(v4.is_private()
				|| v4.is_loopback()
				|| v4.is_link_local()
				|| v4.is_unspecified()
				|| v4.is_broadcast()
				|| v4.is_documentation()
				|| a == 0 || (a == 100 && (64..128).contains(&b))
				|| a >= 224)
		}
		IpAddr::V6(v6) => match v6.to_ipv4_mapped() {
			Some(v4) => is_public(IpAddr::V4(v4)),
			None => {
				let first = v6.segments()[0];
				!(v6.is_loopback() || v6.is_unspecified() || v6.is_multicast() || first & 0xfe00 == 0xfc00 || first & 0xffc0 == 0xfe80)
			}
		},
	}
}

pub async fn send(url: &str, text: &str) -> Result<()> {
	let parsed = url::Url::parse(url).context("webhook URL is not a URL")?;
	let host = parsed.host_str().context("webhook URL has no host")?.to_string();
	let port = parsed.port_or_known_default().unwrap_or(443);
	let addrs: Vec<SocketAddr> = tokio::net::lookup_host((host.as_str(), port)).await.context("resolve the webhook host")?.collect();
	let Some(addr) = addrs.iter().copied().find(|a| is_public(a.ip())) else { bail!("webhook host resolves to no public address") };
	if addrs.iter().any(|a| !is_public(a.ip())) {
		bail!("webhook host resolves to a private address");
	}
	// Pinned to the address just checked, and no redirects, so a second lookup or a 30x cannot reach inside.
	let client = reqwest::Client::builder()
		.timeout(Duration::from_secs(15))
		.redirect(reqwest::redirect::Policy::none())
		.resolve(&host, addr)
		.build()?;
	// reqwest errors print the URL, and a Slack or Discord webhook URL is its own secret.
	client
		.post(parsed)
		.json(&serde_json::json!({ "text": escape(text), "content": text, "allowed_mentions": { "parse": [] } }))
		.send()
		.await
		.map_err(reqwest::Error::without_url)
		.context("post to the webhook")?
		.error_for_status()
		.map_err(reqwest::Error::without_url)
		.context("webhook refused the message")?;
	Ok(())
}

/// Slack reads `<!channel>` and `<url|label>` out of `text`; a referrer or UTM
/// source a visitor chose must arrive as plain words.
fn escape(text: &str) -> String {
	text.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// `12.34 USD` from minor units, with the exponent the providers use for the currency.
pub fn money(amount: i64, currency: &str) -> String {
	match currency {
		"JPY" | "KRW" | "VND" | "CLP" => format!("{amount} {currency}"),
		"KWD" | "BHD" | "JOD" | "OMR" | "TND" => format!("{}.{:03} {currency}", amount / 1000, amount % 1000),
		_ => format!("{}.{:02} {currency}", amount / 100, amount % 100),
	}
}

pub fn sale_text(hostname: &str, p: &Payment, source: &str) -> String {
	let from = if source.is_empty() { String::new() } else { format!(" from {source}") };
	format!("New sale on {hostname}: {}{from}", money(p.amount, &p.currency))
}

pub fn digest_text(hostname: &str, this: &Report, last: &Report) -> String {
	let change = |now: f64, before: f64| {
		if before == 0.0 { String::new() } else { format!(" ({:+.0}%)", (now - before) / before * 100.0) }
	};
	let mut text = format!(
		"Last 7 days on {hostname}: {} visitors{}, {} pageviews{}",
		this.visitors,
		change(this.visitors as f64, last.visitors as f64),
		this.pageviews,
		change(this.pageviews as f64, last.pageviews as f64),
	);
	if !this.currency.is_empty() {
		text += &format!(", {} revenue{}", money(this.revenue, &this.currency), change(this.revenue as f64, last.revenue as f64));
	}
	if let Some(top) = this.referrers.first() {
		text += &format!(". Top source: {} ({} visitors)", top.name, top.visitors);
	}
	if let Some(top) = this.pages.first() {
		text += &format!(". Top page: {}", top.name);
	}
	text + "."
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn webhook_urls() {
		assert!(validate_url("https://hooks.slack.com/services/T/B/x").is_ok());
		for bad in [
			"http://hooks.slack.com/x",
			"https://user:pw@example.com/",
			"https://127.0.0.1/",
			"https://10.1.2.3/",
			"https://[::1]/",
			"https://169.254.169.254/",
		] {
			assert!(validate_url(bad).is_err(), "{bad}");
		}
		assert!(!is_public("172.18.0.2".parse().unwrap()), "a docker network address");
		assert!(!is_public("::ffff:192.168.1.1".parse().unwrap()));
		assert!(is_public("1.1.1.1".parse().unwrap()));
	}

	#[test]
	fn texts() {
		assert_eq!(money(4900, "USD"), "49.00 USD");
		assert_eq!(money(500, "JPY"), "500 JPY");
		assert_eq!(money(12_345, "KWD"), "12.345 KWD");
		assert_eq!(money(50_000, "HUF"), "500.00 HUF");
		assert_eq!(escape("<!channel> & co"), "&lt;!channel&gt; &amp; co");
		let this = Report { visitors: 150, pageviews: 300, ..Default::default() };
		let last = Report { visitors: 100, pageviews: 300, ..Default::default() };
		assert_eq!(digest_text("a.com", &this, &last), "Last 7 days on a.com: 150 visitors (+50%), 300 pageviews (+0%).");
	}
}
