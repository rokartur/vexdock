use axum::http::HeaderMap;

use super::*;

/// Cookie sessions ride along on cross-site requests too, so same_origin is
/// the only thing between a malicious page and a state-changing call.
#[test]
fn same_origin_cases() {
	let cases = [
		("no origin header", "panel.example.com", "https", "", true),
		("same host behind tls", "panel.example.com", "https", "https://panel.example.com", true),
		("direct on published port", "panel.example.com:3000", "", "http://panel.example.com:3000", true),
		("trailing slash", "panel.example.com", "https", "https://panel.example.com/", true),
		("default port spelled out", "panel.example.com:443", "https", "https://panel.example.com", true),
		("proto list from chained proxies", "panel.example.com", "https, http", "https://panel.example.com", true),
		("uppercase host", "Panel.Example.com", "https", "https://panel.example.com", true),
		// A deployed project publishing a port on the dashboard's hostname is ordinary.
		("another port on same host", "panel.example.com", "https", "http://panel.example.com:8080", false),
		("panel port omitted by origin", "panel.example.com:3000", "", "http://panel.example.com", false),
		// Nothing sets HSTS, so port 80 is interceptable.
		("plaintext page on panel hostname", "panel.example.com", "https", "http://panel.example.com", false),
		("different host", "panel.example.com", "https", "https://evil.example.com", false),
		("suffix attack", "panel.example.com", "https", "https://panel.example.com.evil.net", false),
		("credentials in the origin", "panel.example.com", "https", "https://panel.example.com@evil.net", false),
		("unsupported scheme", "panel.example.com", "https", "chrome-extension://abcdef", false),
		("null origin", "panel.example.com", "https", "null", false),
		("scheme with no host", "panel.example.com", "https", "https://", false),
	];
	for (name, host, proto, origin, want) in cases {
		let mut headers = HeaderMap::new();
		headers.insert("host", host.parse().unwrap());
		if !proto.is_empty() {
			headers.insert("x-forwarded-proto", proto.parse().unwrap());
		}
		if !origin.is_empty() {
			headers.insert("origin", origin.parse().unwrap());
		}
		assert_eq!(same_origin(&headers), want, "{name}");
	}
}

#[test]
fn session_token_strips_signature() {
	assert_eq!(session_token("abc123.SIGNATURE"), "abc123");
	assert_eq!(session_token("abc123"), "abc123");
	assert_eq!(session_token(""), "");
}

#[test]
fn session_expiry_reads_text_and_millis() {
	assert!(session_expiry(&Value::Text("2020-01-01T00:00:00.000Z".into())).unwrap() < Utc::now());
	assert!(session_expiry(&Value::Integer(4_102_444_800_000)).unwrap() > Utc::now());
}

#[test]
fn cookie_picks_the_named_one() {
	let mut headers = HeaderMap::new();
	headers.insert("cookie", "a=1; better-auth.session_token=tok.sig; b=2".parse().unwrap());
	assert_eq!(cookie(&headers, SESSION_COOKIE).as_deref(), Some("tok.sig"));
	assert_eq!(cookie(&headers, "missing"), None);
}
