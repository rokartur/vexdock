//! Payment provider webhooks. Each provider signs its webhook with a secret the
//! site owner pastes into the panel; a verified payment event becomes a
//! `Payment` on the visitor id the checkout carried in its metadata as
//! `vx_visitor_id`. Everything else a provider sends is acknowledged and ignored.

use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::Value;
use sha2::Sha256;

use super::is_id;
use crate::database::Payment;

pub const PROVIDERS: &[&str] = &["stripe", "lemonsqueezy", "paddle", "polar"];

/// The metadata key a checkout carries the vx_vid cookie in.
pub const VISITOR_KEY: &str = "vx_visitor_id";

/// Signed timestamps older or newer than this are a replay.
const TOLERANCE_SECONDS: i64 = 300;

/// Verifies one webhook delivery and reads the payment it reports. Ok(None) for
/// a verified event that is not a payment; Err for a bad signature or body.
/// `header` returns a request header's value, empty when absent.
pub fn parse(provider: &str, secret: &str, header: impl Fn(&str) -> String, body: &[u8], now: i64) -> Result<Option<Payment>, String> {
	match provider {
		"stripe" => stripe(secret, &header("stripe-signature"), body, now),
		"lemonsqueezy" => lemonsqueezy(secret, &header("x-signature"), body, now),
		"paddle" => paddle(secret, &header("paddle-signature"), body, now),
		"polar" => polar(secret, &header("webhook-id"), &header("webhook-timestamp"), &header("webhook-signature"), body, now),
		_ => Err(format!("unknown provider {provider:?}")),
	}
}

fn mac(key: &[u8], parts: &[&[u8]]) -> Hmac<Sha256> {
	let mut mac = Hmac::<Sha256>::new_from_slice(key).expect("HMAC takes a key of any length");
	for part in parts {
		mac.update(part);
	}
	mac
}

/// Constant-time check of a hex signature against HMAC-SHA256 over `parts`.
fn hex_matches(key: &[u8], parts: &[&[u8]], signature: &str) -> bool {
	let Ok(signature) = hex::decode(signature.trim()) else { return false };
	mac(key, parts).verify_slice(&signature).is_ok()
}

fn fresh(timestamp: &str, now: i64) -> Result<(), String> {
	let at: i64 = timestamp.trim().parse().map_err(|_| "signature timestamp is not a number".to_string())?;
	if (now - at).abs() > TOLERANCE_SECONDS {
		return Err("signature timestamp is outside the five minute tolerance".into());
	}
	Ok(())
}

fn json(body: &[u8]) -> Result<Value, String> {
	serde_json::from_slice(body).map_err(|_| "body is not JSON".to_string())
}

/// A JSON value as a string: a string as is, a number in decimal.
fn text(v: &Value) -> String {
	match v {
		Value::String(s) => s.clone(),
		Value::Number(n) => n.to_string(),
		_ => String::new(),
	}
}

/// An amount in minor units, sent as a number or a numeric string.
fn amount(v: &Value) -> i64 {
	v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())).unwrap_or(0)
}

fn payment(provider: &str, id: &Value, amount: i64, currency: &Value, visitor: &Value, now: i64) -> Option<Payment> {
	let id = text(id);
	let currency = text(currency).to_ascii_uppercase();
	if id.is_empty() || amount <= 0 || currency.len() != 3 || !currency.bytes().all(|b| b.is_ascii_uppercase()) {
		return None;
	}
	let visitor = text(visitor);
	Some(Payment {
		payment_id: format!("{provider}:{id}"),
		at: now,
		visitor: if is_id(&visitor) { visitor } else { String::new() },
		amount,
		currency,
	})
}

/// `Stripe-Signature: t=<unix>,v1=<hex>[,v1=...]` over `t.body`. Counts a paid
/// Checkout session and every later subscription invoice; the first invoice of
/// a subscription is the Checkout session already counted.
fn stripe(secret: &str, signature: &str, body: &[u8], now: i64) -> Result<Option<Payment>, String> {
	let mut timestamp = "";
	let mut candidates = Vec::new();
	for part in signature.split(',') {
		match part.trim().split_once('=') {
			Some(("t", v)) => timestamp = v,
			Some(("v1", v)) => candidates.push(v),
			_ => {}
		}
	}
	fresh(timestamp, now)?;
	if !candidates.iter().any(|s| hex_matches(secret.as_bytes(), &[timestamp.as_bytes(), b".", body], s)) {
		return Err("signature does not match".into());
	}
	let event = json(body)?;
	let o = &event["data"]["object"];
	Ok(match event["type"].as_str() {
		// Bank debits and transfers complete unpaid and pay later in an async_payment_succeeded.
		Some("checkout.session.completed" | "checkout.session.async_payment_succeeded") if o["payment_status"] == "paid" => {
			let visitor = if o["metadata"][VISITOR_KEY].is_null() { &o["client_reference_id"] } else { &o["metadata"][VISITOR_KEY] };
			payment("stripe", &o["id"], amount(&o["amount_total"]), &o["currency"], visitor, now)
		}
		Some("invoice.paid") if o["billing_reason"] == "subscription_cycle" => {
			let legacy = &o["subscription_details"]["metadata"][VISITOR_KEY];
			let visitor = if legacy.is_null() { &o["parent"]["subscription_details"]["metadata"][VISITOR_KEY] } else { legacy };
			payment("stripe", &o["id"], amount(&o["amount_paid"]), &o["currency"], visitor, now)
		}
		_ => None,
	})
}

/// `X-Signature: <hex>` over the body. Counts an order and each renewal.
fn lemonsqueezy(secret: &str, signature: &str, body: &[u8], now: i64) -> Result<Option<Payment>, String> {
	if !hex_matches(secret.as_bytes(), &[body], signature) {
		return Err("signature does not match".into());
	}
	let event = json(body)?;
	let data = &event["data"];
	let attributes = &data["attributes"];
	let visitor = &event["meta"]["custom_data"][VISITOR_KEY];
	let paid = match event["meta"]["event_name"].as_str() {
		Some("order_created") => attributes["status"] == "paid",
		Some("subscription_payment_success") => attributes["billing_reason"] == "renewal",
		_ => false,
	};
	Ok(paid.then(|| payment("lemonsqueezy", &data["id"], amount(&attributes["total"]), &attributes["currency"], visitor, now)).flatten())
}

/// `Paddle-Signature: ts=<unix>;h1=<hex>` over `ts:body`. Counts a completed transaction.
fn paddle(secret: &str, signature: &str, body: &[u8], now: i64) -> Result<Option<Payment>, String> {
	let mut timestamp = "";
	let mut candidates = Vec::new();
	for part in signature.split(';') {
		match part.trim().split_once('=') {
			Some(("ts", v)) => timestamp = v,
			Some(("h1", v)) => candidates.push(v),
			_ => {}
		}
	}
	fresh(timestamp, now)?;
	if !candidates.iter().any(|s| hex_matches(secret.as_bytes(), &[timestamp.as_bytes(), b":", body], s)) {
		return Err("signature does not match".into());
	}
	let event = json(body)?;
	let data = &event["data"];
	if event["event_type"] != "transaction.completed" {
		return Ok(None);
	}
	let total = amount(&data["details"]["totals"]["grand_total"]);
	Ok(payment("paddle", &data["id"], total, &data["currency_code"], &data["custom_data"][VISITOR_KEY], now))
}

/// Standard Webhooks: `webhook-signature: v1,<base64>[ v1,...]` over
/// `id.timestamp.body`. Polar's secret is the raw key; a `whsec_` secret is base64.
fn polar(secret: &str, id: &str, timestamp: &str, signature: &str, body: &[u8], now: i64) -> Result<Option<Payment>, String> {
	fresh(timestamp, now)?;
	let key = match secret.strip_prefix("whsec_") {
		Some(encoded) => base64::engine::general_purpose::STANDARD.decode(encoded).map_err(|_| "secret is not valid base64".to_string())?,
		None => secret.as_bytes().to_vec(),
	};
	let expected = mac(&key, &[id.as_bytes(), b".", timestamp.as_bytes(), b".", body]).finalize().into_bytes();
	let expected = base64::engine::general_purpose::STANDARD.encode(expected);
	let matches = signature.split_whitespace().filter_map(|s| s.strip_prefix("v1,")).any(|s| {
		use subtle::ConstantTimeEq;
		s.as_bytes().ct_eq(expected.as_bytes()).into()
	});
	if !matches {
		return Err("signature does not match".into());
	}
	let event = json(body)?;
	let data = &event["data"];
	if event["type"] != "order.paid" {
		return Ok(None);
	}
	let total = if data["total_amount"].is_null() { amount(&data["amount"]) } else { amount(&data["total_amount"]) };
	Ok(payment("polar", &data["id"], total, &data["currency"], &data["metadata"][VISITOR_KEY], now))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn hex_sig(key: &[u8], parts: &[&[u8]]) -> String {
		hex::encode(mac(key, parts).finalize().into_bytes())
	}

	const NOW: i64 = 1_800_000_000;

	#[test]
	fn stripe_checkout_and_renewal() {
		let body = br#"{"type":"checkout.session.completed","data":{"object":{"id":"cs_1","payment_status":"paid","amount_total":4900,"currency":"usd","metadata":{"vx_visitor_id":"visitor-0001"}}}}"#;
		let header = format!("t={NOW},v1={}", hex_sig(b"whsec_x", &[NOW.to_string().as_bytes(), b".", body]));
		let p = parse("stripe", "whsec_x", |_| header.clone(), body, NOW).unwrap().unwrap();
		assert_eq!(
			(p.payment_id.as_str(), p.amount, p.currency.as_str(), p.visitor.as_str()),
			("stripe:cs_1", 4900, "USD", "visitor-0001")
		);

		assert!(parse("stripe", "other", |_| header.clone(), body, NOW).is_err(), "wrong secret");
		assert!(parse("stripe", "whsec_x", |_| header.clone(), body, NOW + 600).is_err(), "replayed later");

		let first = br#"{"type":"invoice.paid","data":{"object":{"id":"in_1","billing_reason":"subscription_create","amount_paid":900,"currency":"usd"}}}"#;
		let header = format!("t={NOW},v1={}", hex_sig(b"k", &[NOW.to_string().as_bytes(), b".", first]));
		assert!(parse("stripe", "k", |_| header.clone(), first, NOW).unwrap().is_none(), "the first invoice is the checkout");

		let later = br#"{"type":"checkout.session.async_payment_succeeded","data":{"object":{"id":"cs_2","payment_status":"paid","amount_total":4900,"currency":"eur"}}}"#;
		let header = format!("t={NOW},v1={}", hex_sig(b"k", &[NOW.to_string().as_bytes(), b".", later]));
		let p = parse("stripe", "k", |_| header.clone(), later, NOW).unwrap().unwrap();
		assert_eq!(p.payment_id, "stripe:cs_2", "a SEPA checkout counts when the money arrives");
	}

	#[test]
	fn lemonsqueezy_order() {
		let body = br#"{"meta":{"event_name":"order_created","custom_data":{"vx_visitor_id":"visitor-0001"}},"data":{"id":"42","attributes":{"status":"paid","total":1999,"currency":"EUR"}}}"#;
		let sig = hex_sig(b"s", &[body]);
		let p =
			parse("lemonsqueezy", "s", |name| if name == "x-signature" { sig.clone() } else { String::new() }, body, NOW).unwrap().unwrap();
		assert_eq!((p.payment_id.as_str(), p.amount, p.currency.as_str()), ("lemonsqueezy:42", 1999, "EUR"));
		assert!(parse("lemonsqueezy", "s", |_| "00".into(), body, NOW).is_err());
	}

	#[test]
	fn paddle_transaction() {
		let body = br#"{"event_type":"transaction.completed","data":{"id":"txn_1","currency_code":"USD","details":{"totals":{"grand_total":"2500"}},"custom_data":{"vx_visitor_id":"bad id"}}}"#;
		let header = format!("ts={NOW};h1={}", hex_sig(b"pdl", &[NOW.to_string().as_bytes(), b":", body]));
		let p = parse("paddle", "pdl", |_| header.clone(), body, NOW).unwrap().unwrap();
		assert_eq!((p.amount, p.visitor.as_str()), (2500, ""), "a malformed visitor id is dropped, the revenue kept");
	}

	#[test]
	fn polar_order() {
		let body = br#"{"type":"order.paid","data":{"id":"ord_1","total_amount":1500,"currency":"usd","metadata":{"vx_visitor_id":"visitor-0001"}}}"#;
		let ts = NOW.to_string();
		let sig = base64::engine::general_purpose::STANDARD
			.encode(mac(b"polar", &[b"msg_1", b".", ts.as_bytes(), b".", body]).finalize().into_bytes());
		let header = |name: &str| match name {
			"webhook-id" => "msg_1".to_string(),
			"webhook-timestamp" => ts.clone(),
			_ => format!("v1,{sig}"),
		};
		let p = parse("polar", "polar", header, body, NOW).unwrap().unwrap();
		assert_eq!((p.payment_id.as_str(), p.amount, p.currency.as_str()), ("polar:ord_1", 1500, "USD"));
	}
}
