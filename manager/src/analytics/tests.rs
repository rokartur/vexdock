use super::*;

const CHROME_MAC: &str =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const SAFARI_IPHONE: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";

fn hit(kind: &str) -> Hit {
	Hit { kind: kind.into(), visitor: "visitor-0001".into(), session: "session-0001".into(), path: "/".into(), ..Default::default() }
}

#[test]
fn event_cleans_what_the_beacon_sends() {
	let mut h = hit(KIND_PAGEVIEW);
	h.path = "/pricing?token=secret#plans".into();
	h.referrer = "https://www.Google.com/search?q=x".into();
	h.timezone = "Europe/Warsaw".into();
	let e = event(h, "app.example.com", CHROME_MAC, "", 100).unwrap();
	assert_eq!(e.path, "/pricing");
	assert_eq!(e.referrer, "google.com");
	assert_eq!(e.location, "Europe/Warsaw");
	assert_eq!((e.device.as_str(), e.browser.as_str(), e.os.as_str()), ("Desktop", "Chrome", "macOS"));

	let e = event(hit(KIND_PAGEVIEW), "app.example.com", SAFARI_IPHONE, "PL", 100).unwrap();
	assert_eq!(e.location, "PL", "Cloudflare's country wins over the timezone");
	assert_eq!((e.device.as_str(), e.browser.as_str(), e.os.as_str()), ("Mobile", "Safari", "iOS"));
}

#[test]
fn event_drops_what_it_cannot_trust() {
	assert!(event(hit(KIND_PAGEVIEW), "a.com", "Googlebot/2.1", "", 1).is_none(), "bot");
	assert!(event(hit(KIND_PAGEVIEW), "a.com", "", "", 1).is_none(), "no user agent");
	assert!(event(hit("delete"), "a.com", CHROME_MAC, "", 1).is_none(), "unknown kind");
	let mut h = hit(KIND_PAGEVIEW);
	h.visitor = "x'; DROP".into();
	assert!(event(h, "a.com", CHROME_MAC, "", 1).is_none(), "malformed id");
	let mut h = hit(KIND_GOAL);
	h.name = "Sign Up!".into();
	assert!(event(h, "a.com", CHROME_MAC, "", 1).is_none(), "goal name outside a-z0-9_-");
	let mut h = hit(KIND_GOAL);
	h.name = " Signup ".into();
	assert_eq!(event(h, "a.com", CHROME_MAC, "", 1).unwrap().name, "signup");
}

#[test]
fn referrer_of_the_site_itself_is_no_referrer() {
	assert_eq!(referrer_host("https://www.app.example.com/a", "app.example.com"), "");
	assert_eq!(referrer_host("not a url", "app.example.com"), "");
	assert_eq!(referrer_host("https://news.ycombinator.com/item", "app.example.com"), "news.ycombinator.com");
}

#[test]
fn truncation_never_splits_a_character() {
	let long = format!("/{}", "ż".repeat(400));
	let path = clean_path(&long);
	assert!(path.len() <= 512 && path.ends_with('ż'));
}

#[test]
fn channels() {
	assert_eq!(channel("", "", ""), "Direct");
	assert_eq!(channel("google.com", "", ""), "Organic search");
	assert_eq!(channel("t.co", "", ""), "Social");
	assert_eq!(channel("", "twitter", ""), "Social");
	assert_eq!(channel("microsoft.com", "", ""), "Referral", "t.co must not match inside a longer host");
	assert_eq!(channel("google.com", "google", "cpc"), "Paid");
	assert_eq!(channel("", "newsletter", ""), "Email");
}

#[test]
fn window_ends_with_the_bucket_holding_now() {
	let now = 1_700_000_000;
	let w = Window::new("24h", now, 0).unwrap();
	assert_eq!(w.since, (now / 3600) * 3600 - 23 * 3600);
	// Two hours east of UTC, a day starts at 22:00 UTC.
	let w = Window::new("7d", now, 7200).unwrap();
	assert_eq!((w.since + 7200) % 86_400, 0);
	assert!(Window::new("1y", now, 0).is_none());
}

fn ev(at: i64, visitor: &str, session: &str, kind: &str, path: &str) -> AnalyticsEvent {
	AnalyticsEvent {
		at,
		visitor: visitor.into(),
		session: session.into(),
		kind: kind.into(),
		path: path.into(),
		device: "Desktop".into(),
		..Default::default()
	}
}

#[test]
fn report_attributes_revenue_to_where_the_visitor_came_from() {
	let w = Window::new("24h", 100_000, 0).unwrap();
	let t = w.since;
	let mut from_google = ev(t, "alice", "s1", KIND_PAGEVIEW, "/");
	from_google.referrer = "google.com".into();
	let mut signup = ev(t + 60, "alice", "s1", KIND_GOAL, "/pricing");
	signup.name = "signup".into();
	let events = vec![
		from_google,
		ev(t + 30, "alice", "s1", KIND_PAGEVIEW, "/pricing"),
		signup,
		// Bob bounces: one pageview, no goal.
		ev(t + 10, "bob", "s2", KIND_PAGEVIEW, "/"),
		// Carol is still reading, so she is online.
		ev(w.now - 30, "carol", "s3", KIND_PAGEVIEW, "/blog"),
		ev(w.now - 10, "carol", "s3", KIND_PING, "/blog"),
	];
	let payments = vec![
		Payment { payment_id: "p1".into(), at: t + 90, visitor: "alice".into(), amount: 4900, currency: "USD".into() },
		Payment { payment_id: "p2".into(), at: t + 95, visitor: "".into(), amount: 1000, currency: "USD".into() },
		Payment { payment_id: "p3".into(), at: t + 99, visitor: "bob".into(), amount: 999, currency: "EUR".into() },
	];
	let r = report(&events, &payments, w);

	assert_eq!((r.visitors, r.pageviews, r.sessions, r.online), (3, 4, 3, 1));
	assert_eq!(r.currency, "USD", "the currency most payments use");
	assert_eq!(r.revenue, 5900, "a payment without a visitor still counts in the total");
	assert_eq!(r.customers, 1);
	assert!((r.bounce_rate - 2.0 / 3.0).abs() < 1e-9, "bob and carol each saw one page");
	assert_eq!(r.series.len(), 24);
	assert_eq!(r.series[0], Point { at: t, visitors: 2, pageviews: 3, revenue: 5900 });

	let row = |rows: &[Row], name: &str| rows.iter().find(|r| r.name == name).map(|r| (r.visitors, r.revenue));
	assert_eq!(row(&r.channels, "Organic search"), Some((1, 4900)));
	assert_eq!(row(&r.channels, "Direct"), Some((2, 0)));
	assert_eq!(row(&r.referrers, "google.com"), Some((1, 4900)));
	assert_eq!(row(&r.pages, "/pricing"), Some((1, 4900)));
	assert_eq!(row(&r.entry_pages, "/"), Some((2, 4900)));
	assert_eq!(row(&r.exit_pages, "/pricing"), Some((1, 4900)));
	assert_eq!(row(&r.goals, "signup"), Some((1, 4900)));
	assert_eq!(r.pages[0].name, "/", "rows sort by visitors");
}
