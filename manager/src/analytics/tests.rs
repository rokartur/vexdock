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
	let e = event(h, "app.example.com", CHROME_MAC, "", &Place::default(), 100).unwrap();
	assert_eq!(e.path, "/pricing");
	assert_eq!(e.referrer, "google.com");
	assert_eq!(e.location, "Europe/Warsaw");
	assert_eq!((e.device.as_str(), e.browser.as_str(), e.os.as_str()), ("Desktop", "Chrome", "macOS"));

	let e = event(hit(KIND_PAGEVIEW), "app.example.com", SAFARI_IPHONE, "PL", &Place::default(), 100).unwrap();
	assert_eq!(e.location, "PL", "Cloudflare's country wins over the timezone");
	assert_eq!((e.device.as_str(), e.browser.as_str(), e.os.as_str()), ("Mobile", "Safari", "iOS"));
}

#[test]
fn event_drops_what_it_cannot_trust() {
	assert!(event(hit(KIND_PAGEVIEW), "a.com", "Googlebot/2.1", "", &Place::default(), 1).is_none(), "bot");
	assert!(event(hit(KIND_PAGEVIEW), "a.com", "", "", &Place::default(), 1).is_none(), "no user agent");
	assert!(event(hit("delete"), "a.com", CHROME_MAC, "", &Place::default(), 1).is_none(), "unknown kind");
	let mut h = hit(KIND_PAGEVIEW);
	h.visitor = "x'; DROP".into();
	assert!(event(h, "a.com", CHROME_MAC, "", &Place::default(), 1).is_none(), "malformed id");
	let mut h = hit(KIND_GOAL);
	h.name = "Sign Up!".into();
	assert!(event(h, "a.com", CHROME_MAC, "", &Place::default(), 1).is_none(), "goal name outside a-z0-9_-");
	let mut h = hit(KIND_GOAL);
	h.name = " Signup ".into();
	assert_eq!(event(h, "a.com", CHROME_MAC, "", &Place::default(), 1).unwrap().name, "signup");
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
	let w = Window::new("24h", now, 0, None).unwrap();
	assert_eq!(w.since, (now / 3600) * 3600 - 23 * 3600);
	// Two hours east of UTC, a day starts at 22:00 UTC.
	let w = Window::new("7d", now, 7200, None).unwrap();
	assert_eq!((w.since + 7200) % 86_400, 0);
	assert!(Window::new("1y", now, 0, None).is_none());
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
	let w = Window::new("24h", 100_000, 0, None).unwrap();
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
	let r = report(&events, &payments, w, &[]);

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

	let only_google = report(&events, &payments, w, &[("referrer".into(), "google.com".into())]);
	assert_eq!((only_google.visitors, only_google.revenue), (1, 4900), "a filter keeps alice and her payment only");
	let none = report(&events, &payments, w, &[("referrer".into(), "google.com".into()), ("device".into(), "Mobile".into())]);
	assert_eq!(none.visitors, 0, "every filter must match");
}

#[test]
fn place_fills_in_where_cloudflare_is_silent() {
	let place = Place { country: "DE".into(), region: "Bavaria".into(), city: "Munich".into() };
	let e = event(hit(KIND_PAGEVIEW), "a.com", CHROME_MAC, "", &place, 1).unwrap();
	assert_eq!((e.location.as_str(), e.region.as_str(), e.city.as_str()), ("DE", "Bavaria", "Munich"));
	let e = event(hit(KIND_PAGEVIEW), "a.com", CHROME_MAC, "PL", &place, 1).unwrap();
	assert_eq!(e.location, "PL", "Cloudflare's country wins over the database");
}

#[test]
fn goal_props_are_bounded() {
	let mut h = hit(KIND_GOAL);
	h.name = "checkout".into();
	let mut props = serde_json::Map::new();
	props.insert("Plan".into(), "pro".into());
	props.insert("seats".into(), 3.into());
	props.insert("nested".into(), serde_json::json!({"a": 1}));
	props.insert("bad key!".into(), "x".into());
	h.props = props;
	let e = event(h, "a.com", CHROME_MAC, "", &Place::default(), 1).unwrap();
	assert_eq!(e.props, r#"{"plan":"pro","seats":"3"}"#);
	assert_eq!(event(hit(KIND_PAGEVIEW), "a.com", CHROME_MAC, "", &Place::default(), 1).unwrap().props, "");
}

#[test]
fn tco_referrer_keeps_its_code() {
	assert_eq!(referrer_host("https://t.co/AbC123", "a.com"), "t.co/AbC123");
	assert_eq!(channel("t.co/AbC123", "", ""), "Social");
}

#[test]
fn ranges() {
	let now = 1_700_000_000;
	let today = Window::new("today", now, 0, None).unwrap();
	assert_eq!((today.since % 86_400, today.until - today.since, today.bucket), (0, 86_400, 3600));
	let yesterday = Window::new("yesterday", now, 0, None).unwrap();
	assert_eq!(yesterday.until, today.since);
	let all = Window::new("all", now, 0, Some(now - 10 * 86_400)).unwrap();
	assert!(all.since <= now - 10 * 86_400 && all.bucket == 86_400);
	let all = Window::new("all", now, 0, Some(0)).unwrap();
	assert!(all.since >= now - (RETENTION_DAYS + 7) * 86_400, "all stops at the retention");
	assert_eq!(all.bucket, 7 * 86_400);

	let custom = Window::custom("2024-01-01", "2024-01-31", now, 3600).unwrap();
	assert_eq!(custom.since, 1_704_067_200 - 3600, "midnight in the viewer's timezone");
	assert_eq!(custom.until - custom.since, 31 * 86_400);
	assert!(Window::custom("2024-02-01", "2024-01-01", now, 0).is_none(), "reversed");
	assert!(Window::custom("2024-1-1", "x", now, 0).is_none());

	let w = Window::new("7d", now, 0, None).unwrap();
	assert_eq!((w.previous().until, w.previous().until - w.previous().since), (w.since, w.until - w.since));
}

#[test]
fn filters_parse() {
	assert_eq!(parse_filters("").unwrap(), vec![]);
	assert_eq!(parse_filters(r#"[["page","/a"]]"#).unwrap(), vec![("page".to_string(), "/a".to_string())]);
	assert!(parse_filters(r#"[["password","x"]]"#).is_err());
	assert!(parse_filters("{}").is_err());
}

#[test]
fn cookieless_ids() {
	let a = cookieless_visitor("salt", "d1", "1.2.3.4", CHROME_MAC);
	assert!(is_id(&a));
	assert_eq!(a, cookieless_visitor("salt", "d1", "1.2.3.4", CHROME_MAC));
	assert_ne!(a, cookieless_visitor("other day", "d1", "1.2.3.4", CHROME_MAC), "the salt rotates daily");
	assert_ne!(a, cookieless_visitor("salt", "d2", "1.2.3.4", CHROME_MAC), "one site cannot follow a visitor to another");
	assert_eq!(cookieless_session(&a, Some(("s1".into(), 100)), 100 + SESSION_SECONDS - 1), "s1");
	let fresh = cookieless_session(&a, Some(("s1".into(), 100)), 100 + SESSION_SECONDS);
	assert!(fresh != "s1" && is_id(&fresh));
}

#[test]
fn visitors_live_and_funnels() {
	use crate::database::FunnelStep;

	let w = Window::new("24h", 100_000, 0, None).unwrap();
	let t = w.since;
	let mut signup = ev(t + 60, "alice", "s1", KIND_GOAL, "/pricing");
	signup.name = "signup".into();
	let events = vec![
		ev(t, "alice", "s1", KIND_PAGEVIEW, "/"),
		ev(t + 30, "alice", "s1", KIND_PAGEVIEW, "/pricing"),
		signup,
		ev(t + 10, "bob", "s2", KIND_PAGEVIEW, "/"),
		ev(t + 20, "bob", "s2", KIND_PAGEVIEW, "/pricing"),
		ev(w.now - 30, "carol", "s3", KIND_PAGEVIEW, "/blog"),
	];
	let payments = vec![Payment { payment_id: "p1".into(), at: t + 90, visitor: "alice".into(), amount: 4900, currency: "USD".into() }];

	let listed = insights::visitors(&events, &payments, &w, &[]);
	assert_eq!(listed.total, 3);
	let rows = listed.visitors;
	assert_eq!(rows.iter().map(|r| r.visitor.as_str()).collect::<Vec<_>>(), ["carol", "alice", "bob"], "most recent first");
	let alice = rows.iter().find(|r| r.visitor == "alice").unwrap();
	assert_eq!((alice.pageviews, alice.goals, alice.sessions, alice.revenue), (2, 1, 1, 4900));

	let live = insights::live(&events, &payments, w.now);
	assert_eq!(live.online.len(), 1);
	assert!(live.online[0].path == "/blog");
	assert_eq!(live.feed[0].detail, "/blog", "newest first");
	let mut backend_goal = ev(w.now - 5, "erin", "s5", KIND_GOAL, "");
	backend_goal.name = "invoice".into();
	let pinging = [ev(w.now - 60, "dave", "s4", KIND_PING, "/docs"), backend_goal];
	let live = insights::live(&pinging, &[], w.now);
	assert_eq!(live.online.len(), 1, "a tab whose pageview is older than the window still pings, a backend goal is no tab");
	assert_eq!(live.online[0].path, "/docs");
	assert_eq!(report(&pinging, &[], w, &[]).online, 1, "the report counts the same visitors online");

	let step = |kind: &str, value: &str| FunnelStep { kind: kind.into(), value: value.into() };
	let steps = vec![step("page", "/"), step("page", "/pri*"), step("goal", "signup"), step("payment", "")];
	assert_eq!(insights::funnel(&events, &payments, &w, &[], &steps), vec![2, 2, 1, 1], "carol never opened /");
	assert!(insights::validate_steps(&steps).is_ok());
	assert!(insights::validate_steps(&steps[..1]).is_err(), "one step is no funnel");
	assert!(insights::validate_steps(&[step("page", "pricing"), step("goal", "x")]).is_err(), "a path starts with /");
}
