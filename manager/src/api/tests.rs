use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode, header};
use base64::Engine as _;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use http_body_util::BodyExt;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use tower::ServiceExt;

use super::{Server, router};
use crate::config::Config;
use crate::database::{self, Db, Domain, Environment, Project, ProjectGrant, Service};
use crate::docker::Docker;
use crate::security::{self, Cipher};

struct Harness {
	_dir: tempfile::TempDir,
	server: Arc<Server>,
	router: Router,
}

/// A server on a fresh root with projects p1 and p2, each with service
/// s-<id> and domain d-<id>, and a Docker that answers nothing.
fn harness(public_url: &str) -> Harness {
	let dir = tempfile::tempdir().unwrap();
	let mut cfg = Config::at(dir.path().to_str().unwrap());
	cfg.public_url = public_url.to_string();
	std::fs::create_dir_all(&cfg.data_dir).unwrap();
	let db = Arc::new(Db::open(&cfg.database_path()).unwrap());
	for id in ["p1", "p2"] {
		db.create_project(&mut Project {
			id: id.into(),
			name: id.into(),
			slug: id.into(),
			compose_project_name: id.into(),
			..Default::default()
		})
		.unwrap();
		let mut env = Environment {
			id: id.into(),
			project_id: id.into(),
			name: "Production".into(),
			slug: "production".into(),
			compose_project_name: id.into(),
			is_default: true,
			..Default::default()
		};
		db.create_environment(&mut env).unwrap();
		let mut svc = Service {
			id: format!("s-{id}"),
			project_id: id.into(),
			environment_id: id.into(),
			compose_service_name: "web".into(),
			provider: database::PROVIDER_RAW.into(),
			..Default::default()
		};
		db.create_service(&mut svc).unwrap();
		let mut domain = Domain {
			id: format!("d-{id}"),
			project_id: id.into(),
			environment_id: id.into(),
			service_id: format!("s-{id}"),
			hostname: format!("{id}.example.com"),
			container_port: 80,
			..Default::default()
		};
		db.create_domain(&mut domain).unwrap();
	}
	let cipher = Arc::new(Cipher::new(&[7; 32]).unwrap());
	let server = Server::new(Arc::new(cfg), db, Arc::new(Docker::unreachable()), cipher);
	let router = router(Arc::clone(&server));
	Harness { _dir: dir, server, router }
}

impl Harness {
	fn mint(&self, grants: &[ProjectGrant]) -> String {
		let raw = security::random_token(32);
		self.server.db.create_api_token("u1", "test", &security::hash_token(&raw), &raw[..6], grants).unwrap();
		raw
	}

	async fn send(&self, method: &str, path: &str, headers: &[(&str, &str)], body: &str) -> (StatusCode, HeaderMap, String) {
		let mut req = Request::builder().method(method).uri(path);
		for (name, value) in headers {
			req = req.header(*name, *value);
		}
		let resp = self.router.clone().oneshot(req.body(Body::from(body.to_string())).unwrap()).await.unwrap();
		let (parts, body) = resp.into_parts();
		let bytes = body.collect().await.unwrap().to_bytes();
		(parts.status, parts.headers, String::from_utf8_lossy(&bytes).into_owned())
	}

	async fn call(&self, token: &str, method: &str, path: &str) -> StatusCode {
		self.send(method, path, &[("authorization", &format!("Bearer {token}"))], "").await.0
	}
}

fn grant(project: &str, level: &str) -> ProjectGrant {
	ProjectGrant { project_id: project.into(), level: level.into() }
}

#[tokio::test]
async fn project_token_scope() {
	let h = harness("");
	let reader = h.mint(&[grant("p1", database::ACCESS_READ)]);
	let writer = h.mint(&[grant("p1", database::ACCESS_WRITE)]);
	let admin = h.mint(&[]);
	let cases = [
		("own project", &reader, "GET", "/api/projects/p1/environments", StatusCode::OK),
		("other project", &reader, "GET", "/api/projects/p2/environments", StatusCode::FORBIDDEN),
		("other project through a service id", &reader, "GET", "/api/services/s-p2/variables", StatusCode::FORBIDDEN),
		("secrets need write", &reader, "GET", "/api/services/s-p1/variables", StatusCode::FORBIDDEN),
		("write passes the write routes", &writer, "GET", "/api/services/s-p1/basic-auth", StatusCode::OK),
		("unknown id looks forbidden", &reader, "GET", "/api/services/nope", StatusCode::FORBIDDEN),
		("instance routes are admin only", &writer, "GET", "/api/tokens", StatusCode::FORBIDDEN),
		("deleting a project is admin only", &writer, "DELETE", "/api/projects/p1", StatusCode::FORBIDDEN),
		("publishing a host port is admin only", &writer, "POST", "/api/services/s-p1/ports", StatusCode::FORBIDDEN),
		("admin token passes", &admin, "GET", "/api/tokens", StatusCode::OK),
		("admin token reaches every project", &admin, "GET", "/api/projects/p2/environments", StatusCode::OK),
	];
	for (name, token, method, path, want) in cases {
		assert_eq!(h.call(token, method, path).await, want, "{name}: {method} {path}");
	}
	// A project token sees only its own rows in the instance-wide lists.
	let (_, _, body) = h.send("GET", "/api/domains", &[("authorization", &format!("Bearer {reader}"))], "").await;
	let domains: Vec<Value> = serde_json::from_str(&body).unwrap();
	assert_eq!(domains.iter().map(|d| d["id"].as_str().unwrap()).collect::<Vec<_>>(), ["d-p1"], "{body}");
}

#[tokio::test]
async fn delete_project_refuses_while_services_remain() {
	let h = harness("");
	let admin = h.mint(&[]);
	assert_eq!(h.call(&admin, "DELETE", "/api/projects/p1").await, StatusCode::CONFLICT);
	assert!(h.server.db.project_by_id("p1").is_ok(), "the project went anyway");
}

#[test]
fn crashed_ignores_stopped_containers() {
	use bollard::models::ContainerState;
	let state = |exit_code: i64, oom_killed: bool| ContainerState {
		exit_code: Some(exit_code),
		oom_killed: Some(oom_killed),
		..Default::default()
	};
	for (exit_code, oom_killed, want) in [(0, false, false), (143, false, false), (137, false, false), (137, true, true), (1, false, true)]
	{
		assert_eq!(super::project_handlers::crashed(&state(exit_code, oom_killed)), want, "exit {exit_code}, oom {oom_killed}");
	}
}

/// The whole OAuth flow an MCP client walks, through the real router:
/// register, consent, exchange, use, refresh, and a replayed refresh token
/// revoking the grant.
#[tokio::test]
async fn oauth_flow() {
	let h = harness("https://panel.example.com");
	let admin = format!("Bearer {}", h.mint(&[]));
	let json_body = [("content-type", "application/json"), ("authorization", admin.as_str())];
	let parse = |body: &str| -> Value { serde_json::from_str(body).unwrap_or_else(|err| panic!("{body}: {err}")) };

	let (_, _, meta) = h.send("GET", "/.well-known/oauth-authorization-server", &[], "").await;
	assert_eq!(parse(&meta)["token_endpoint"], "https://panel.example.com/api/oauth/token");

	let (status, headers, _) = h.send("OPTIONS", "/api/oauth/register", &[], "").await;
	assert_eq!(status, StatusCode::NO_CONTENT, "a browser client's preflight");
	assert_eq!(headers["access-control-allow-origin"], "*");
	let (status, _, _) = h
		.send("POST", "/api/oauth/register", &[("content-type", "application/json")], r#"{"redirect_uris":["javascript:alert(1)"]}"#)
		.await;
	assert_eq!(status, StatusCode::BAD_REQUEST, "a javascript: redirect registered");

	let callback = "http://127.0.0.1:33418/callback";
	let registration = json!({"client_name": "Claude", "redirect_uris": [callback]}).to_string();
	let (_, _, client) = h.send("POST", "/api/oauth/register", &[("content-type", "application/json")], &registration).await;
	let client_id = parse(&client)["client_id"].as_str().unwrap().to_string();

	let verifier = security::random_token(48);
	let mut authorize = json!({
		"client_id": client_id, "redirect_uri": callback, "response_type": "code", "state": "xyz",
		"code_challenge": URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes())), "code_challenge_method": "S256",
		"resource": "https://panel.example.com/mcp",
	});
	let query: String = url::form_urlencoded::Serializer::new(String::new())
		.extend_pairs(authorize.as_object().unwrap().iter().map(|(k, v)| (k.as_str(), v.as_str().unwrap())))
		.finish();
	let (status, _, body) = h.send("GET", &format!("/api/oauth/authorize?{query}"), &[("authorization", &admin)], "").await;
	assert_eq!(status, StatusCode::OK, "authorize check: {body}");
	assert_eq!(parse(&body)["client_name"], "Claude");

	let mut other = authorize.clone();
	other["redirect_uri"] = json!("https://evil.example.com/callback");
	let (status, _, _) = h.send("POST", "/api/oauth/authorize", &json_body, &other.to_string()).await;
	assert_eq!(status, StatusCode::BAD_REQUEST, "an unregistered redirect_uri was approved");

	authorize["projects"] = json!([{"project_id": "p1", "level": database::ACCESS_READ}]);
	let approve = async || {
		let (_, _, body) = h.send("POST", "/api/oauth/authorize", &json_body, &authorize.to_string()).await;
		let redirect = url::Url::parse(parse(&body)["redirect"].as_str().unwrap()).unwrap();
		assert!(redirect.as_str().starts_with(&format!("{callback}?")), "redirect = {redirect}");
		let pairs: std::collections::HashMap<_, _> = redirect.query_pairs().into_owned().collect();
		assert_eq!(pairs["state"], "xyz");
		pairs["code"].clone()
	};
	let exchange = async |pairs: &[(&str, &str)], basic: Option<&str>| -> (StatusCode, Value) {
		let mut form = url::form_urlencoded::Serializer::new(String::new());
		form.extend_pairs(pairs.iter().copied());
		let basic_header = basic.map(|id| format!("Basic {}", STANDARD.encode(format!("{id}:"))));
		let mut headers = vec![("content-type", "application/x-www-form-urlencoded")];
		match &basic_header {
			Some(value) => headers.push(("authorization", value)),
			None => {
				form.append_pair("client_id", &client_id);
			}
		}
		let (status, _, body) = h.send("POST", "/api/oauth/token", &headers, &form.finish()).await;
		(status, parse(&body))
	};

	let code = approve().await;
	let wrong = security::random_token(48);
	let (status, _) =
		exchange(&[("grant_type", "authorization_code"), ("code", &code), ("redirect_uri", callback), ("code_verifier", &wrong)], None)
			.await;
	assert_eq!(status, StatusCode::BAD_REQUEST, "a wrong verifier exchanged the code");
	// The failed attempt burned the code, so approve again.
	let code = approve().await;
	let code_form =
		[("grant_type", "authorization_code"), ("code", code.as_str()), ("redirect_uri", callback), ("code_verifier", verifier.as_str())];
	let (status, first) = exchange(&code_form, None).await;
	assert_eq!(status, StatusCode::OK, "exchange: {first}");
	let (first_access, first_refresh) = (first["access_token"].as_str().unwrap(), first["refresh_token"].as_str().unwrap());
	assert_eq!(exchange(&code_form, None).await.0, StatusCode::BAD_REQUEST, "a code was exchanged twice");

	assert_eq!(h.call(first_access, "GET", "/api/projects/p1/environments").await, StatusCode::OK, "granted project");
	assert_eq!(h.call(first_access, "GET", "/api/projects/p2/environments").await, StatusCode::FORBIDDEN, "project outside the grant");

	// This refresh names the client the Basic way, with no client_id in the form.
	let (status, second) = exchange(&[("grant_type", "refresh_token"), ("refresh_token", first_refresh)], Some(&client_id)).await;
	assert_eq!(status, StatusCode::OK, "refresh: {second}");
	assert_ne!(second["access_token"], first["access_token"]);
	assert_eq!(h.call(first_access, "GET", "/api/me").await, StatusCode::UNAUTHORIZED, "a rotated-out access token still works");
	let (status, replay) = exchange(&[("grant_type", "refresh_token"), ("refresh_token", first_refresh)], None).await;
	assert_eq!((status, replay["error"].as_str()), (StatusCode::BAD_REQUEST, Some("invalid_grant")), "a replayed refresh token");
	assert_eq!(
		h.call(second["access_token"].as_str().unwrap(), "GET", "/api/me").await,
		StatusCode::UNAUTHORIZED,
		"the replay did not revoke the grant"
	);
}

#[tokio::test]
async fn project_domain_cannot_take_the_panel_hostname() {
	let h = harness("");
	h.server.db.set_setting(crate::domains::SETTING_DASHBOARD_DOMAIN, "panel.example.com").unwrap();
	let writer = format!("Bearer {}", h.mint(&[grant("p1", database::ACCESS_WRITE)]));
	let headers = [("content-type", "application/json"), ("authorization", writer.as_str())];
	let create = json!({"project_id": "p1", "service": "web", "hostname": "panel.example.com", "container_port": 80}).to_string();
	let (status, _, body) = h.send("POST", "/api/domains", &headers, &create).await;
	assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
	assert!(body.contains("panel's own hostname"), "{body}");
	let (status, _, body) = h.send("PATCH", "/api/domains/d-p1", &headers, r#"{"hostname":"panel.example.com"}"#).await;
	assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
	assert_eq!(h.server.db.domain_by_id("d-p1").unwrap().hostname, "p1.example.com");
	let err = h.server.domains.set_dashboard_domain("p2.example.com", false).await.unwrap_err();
	assert!(format!("{err:#}").contains("already a project domain"), "{err:#}");
}

#[tokio::test]
async fn domain_is_not_kept_when_the_proxy_rejects_it() {
	let h = harness("");
	let admin = format!("Bearer {}", h.mint(&[]));
	let headers = [("content-type", "application/json"), ("authorization", admin.as_str())];
	let create = json!({"project_id": "p1", "service": "web", "hostname": "new.example.com", "container_port": 80}).to_string();
	let (status, _, body) = h.send("POST", "/api/domains", &headers, &create).await;
	assert_eq!(status, StatusCode::BAD_REQUEST, "{body}");
	assert!(h.server.db.list_domains().unwrap().iter().all(|d| d.hostname != "new.example.com"), "the rejected domain stayed");
}

#[tokio::test]
async fn deleting_a_service_removes_its_domain_certificates() {
	let h = harness("");
	let admin = h.mint(&[]);
	let dir = h.server.certs.dir("p1.example.com");
	std::fs::create_dir_all(&dir).unwrap();
	for file in ["fullchain.pem", "privkey.pem"] {
		std::fs::write(format!("{dir}/{file}"), "x").unwrap();
	}
	assert_eq!(h.call(&admin, "DELETE", "/api/services/s-p1").await, StatusCode::NO_CONTENT);
	assert!(!h.server.certs.exists("p1.example.com"), "the certificate outlived its domain");
}

#[tokio::test]
async fn git_callbacks_refuse_a_bare_connection_id() {
	let h = harness("https://panel.example.com");
	let admin = h.mint(&[]);
	let bearer = format!("Bearer {admin}");
	let (status, _, body) = h.send("POST", "/api/git-providers/github", &[("authorization", &bearer)], r#"{"name":"gh"}"#).await;
	assert_eq!(status, StatusCode::CREATED, "{body}");
	let created: Value = serde_json::from_str(&body).unwrap();
	let id = created["git_provider_id"].as_str().unwrap();
	let manifest_url = created["manifest_url"].as_str().unwrap();
	let state = manifest_url.split_once("state=").unwrap().1;

	let forged = format!("/api/providers/github/installed?installation_id=42&state={id}");
	// A project token can read the bare id; the refusal goes back to the settings page, not to JSON.
	let (status, headers, _) = h.send("GET", &forged, &[("authorization", &bearer)], "").await;
	assert_eq!(status, StatusCode::FOUND);
	assert!(headers[header::LOCATION].to_str().unwrap().starts_with("/system/settings/git?error="));
	let provider = h.server.db.git_provider_by_id(id).unwrap();
	assert_eq!(provider.github.unwrap().installation_id, "");

	let sealed = format!("/api/providers/github/installed?installation_id=42&state={state}");
	assert_eq!(h.call(&admin, "GET", &sealed).await, StatusCode::FOUND);
	let provider = h.server.db.git_provider_by_id(id).unwrap();
	assert_eq!(provider.github.unwrap().installation_id, "42");
}

/// The beacon through the real router, then the payment a backend reports and
/// the report and sites list that read both back, each under a project token.
#[tokio::test]
async fn site_analytics_flow() {
	let h = harness("");
	let reader = format!("Bearer {}", h.mint(&[grant("p1", database::ACCESS_READ)]));
	let writer = format!("Bearer {}", h.mint(&[grant("p1", database::ACCESS_WRITE)]));
	let chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";
	let hit = json!({"kind": "pageview", "visitor": "visitor-0001", "session": "session-0001", "path": "/pricing",
		"referrer": "https://news.ycombinator.com/item"})
	.to_string();

	let (status, headers, script) = h.send("GET", "/api/analytics/script.js", &[], "").await;
	assert_eq!(status, StatusCode::OK);
	assert!(headers["content-type"].to_str().unwrap().starts_with("text/javascript"));
	assert!(script.contains("/_vx/event"));

	for (id, hostname) in [("d-p1-www", "www.p1.example.com"), ("d-p2-www", "www.p2.example.com")] {
		let mut www = Domain { id: id.into(), hostname: hostname.into(), ..h.server.db.domain_by_id("d-p1").unwrap() };
		h.server.db.create_domain(&mut www).unwrap();
	}
	for host in ["p1.example.com:443", "www.p1.example.com", "www.p2.example.com", "unknown.example.com"] {
		let (status, _, _) = h.send("POST", "/api/analytics/event", &[("host", host), ("user-agent", chrome)], &hit).await;
		assert_eq!(status, StatusCode::NO_CONTENT, "{host}");
	}
	assert_eq!(h.server.db.analytics_events("d-p1", 0, i64::MAX).unwrap().len(), 2, "the known hosts' hits, www folded into the bare one");
	assert_eq!(h.server.db.analytics_events("d-p2", 0, i64::MAX).unwrap().len(), 0, "never folded into another project's domain");

	let payment = json!({"payment_id": "pi_1", "amount": 4900, "currency": "usd", "visitor_id": "visitor-0001"}).to_string();
	let as_reader = [("authorization", reader.as_str()), ("content-type", "application/json")];
	let as_writer = [("authorization", writer.as_str()), ("content-type", "application/json")];
	assert_eq!(h.send("POST", "/api/domains/d-p1/payments", &as_reader, &payment).await.0, StatusCode::FORBIDDEN);
	assert_eq!(h.send("POST", "/api/domains/d-p2/payments", &as_writer, &payment).await.0, StatusCode::FORBIDDEN);
	assert_eq!(h.send("POST", "/api/domains/d-p1/payments", &as_writer, &payment).await.0, StatusCode::CREATED);
	let (status, _, body) = h.send("POST", "/api/domains/d-p1/payments", &as_writer, &payment).await;
	assert_eq!((status, body.trim()), (StatusCode::OK, r#"{"recorded":false}"#), "a retried webhook records once");

	let (status, _, body) = h.send("GET", "/api/domains/d-p1/analytics?range=24h", &[("authorization", &reader)], "").await;
	assert_eq!(status, StatusCode::OK, "{body}");
	let report = &serde_json::from_str::<Value>(&body).unwrap()["report"];
	assert_eq!((report["visitors"].as_u64(), report["revenue"].as_i64()), (Some(1), Some(4900)), "{report}");
	assert_eq!(report["currency"], "USD");
	assert_eq!(report["channels"][0], json!({"name": "Social", "visitors": 1, "revenue": 4900}));
	assert_eq!(h.call(&reader[7..], "GET", "/api/domains/d-p2/analytics").await, StatusCode::FORBIDDEN);
	assert_eq!(h.call(&reader[7..], "GET", "/api/domains/d-p1/analytics?range=1y").await, StatusCode::BAD_REQUEST);

	let (_, _, body) = h.send("GET", "/api/analytics", &[("authorization", &reader)], "").await;
	let sites: Vec<Value> = serde_json::from_str(&body).unwrap();
	let ids: Vec<_> = sites.iter().map(|site| site["domain"]["id"].as_str().unwrap()).collect();
	assert_eq!(ids, ["d-p1", "d-p2-www"], "its own sites only, a folded www left out: {body}");
	assert_eq!((sites[0]["domain"]["id"].as_str(), sites[0]["visitors"].as_u64()), (Some("d-p1"), Some(1)));
	assert_eq!(sites[0]["hourly"].as_array().unwrap().len(), 24);

	let (_, _, body) = h.send("GET", "/api/domains/d-p1/analytics/visitors?range=24h", &[("authorization", &reader)], "").await;
	let listed: Value = serde_json::from_str(&body).unwrap();
	assert_eq!((listed["total"].as_u64(), &listed["visitors"][0]["revenue"]), (Some(1), &json!(4900)), "{body}");
	let (status, _, body) = h.send("GET", "/api/domains/d-p1/analytics/visitors/visitor-0001", &[("authorization", &reader)], "").await;
	assert_eq!(status, StatusCode::OK, "{body}");
	assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["events"][0]["path"], "/pricing");
	let (status, _, body) = h.send("GET", "/api/domains/d-p1/analytics/live", &[("authorization", &reader)], "").await;
	assert_eq!(status, StatusCode::OK);
	assert_eq!(serde_json::from_str::<Value>(&body).unwrap()["online"][0]["customer"], true, "{body}");
}

/// Settings, the share link, cookieless hits, excluded addresses, a signed
/// Stripe webhook and a short link, through the real router.
#[tokio::test]
async fn site_analytics_settings_flow() {
	let h = harness("");
	let reader = format!("Bearer {}", h.mint(&[grant("p1", database::ACCESS_READ)]));
	let writer = format!("Bearer {}", h.mint(&[grant("p1", database::ACCESS_WRITE)]));
	let as_writer = [("authorization", writer.as_str()), ("content-type", "application/json")];
	let chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36";

	assert_eq!(h.call(&reader[7..], "GET", "/api/domains/d-p1/analytics/settings").await, StatusCode::FORBIDDEN, "settings hold secrets");
	let update = json!({"share": true, "excluded_ips": "203.0.113.9", "stripe_secret": "whsec_test"}).to_string();
	let (status, _, body) = h.send("PUT", "/api/domains/d-p1/analytics/settings", &as_writer, &update).await;
	assert_eq!(status, StatusCode::OK, "{body}");
	let settings: Value = serde_json::from_str(&body).unwrap();
	assert_eq!(settings["providers"]["stripe"], true);
	assert!(!body.contains("whsec_test"), "a provider secret never comes back");
	h.server.db.set_setting(crate::domains::SETTING_DASHBOARD_DOMAIN, "panel.example.com").unwrap();
	let (_, _, body) = h.send("GET", "/api/domains/d-p1/analytics/settings", &as_writer, "").await;
	let origin = serde_json::from_str::<Value>(&body).unwrap()["webhook_origin"].clone();
	assert_eq!(origin, "http://panel.example.com", "providers are pointed at the panel's domain, not the tunnel the owner used");
	let bad = json!({"notify_url": "https://10.0.0.1/hook"}).to_string();
	assert_eq!(h.send("PUT", "/api/domains/d-p1/analytics/settings", &as_writer, &bad).await.0, StatusCode::BAD_REQUEST);

	let cookieless = json!({"kind": "pageview", "path": "/"}).to_string();
	for ip in ["198.51.100.1", "198.51.100.1", "203.0.113.9"] {
		let headers = [("host", "p1.example.com"), ("user-agent", chrome), ("x-real-ip", ip)];
		assert_eq!(h.send("POST", "/api/analytics/event", &headers, &cookieless).await.0, StatusCode::NO_CONTENT);
	}
	let events = h.server.db.analytics_events("d-p1", 0, i64::MAX).unwrap();
	assert_eq!(events.len(), 2, "the excluded address is dropped");
	assert_eq!(
		(events[0].visitor == events[1].visitor, events[0].session == events[1].session),
		(true, true),
		"one cookieless visitor, one session"
	);

	let token = settings["share_token"].as_str().unwrap();
	let (status, _, body) = h.send("GET", &format!("/api/analytics/shared/{token}?range=24h"), &[], "").await;
	assert_eq!(status, StatusCode::OK, "{body}");
	let shared: Value = serde_json::from_str(&body).unwrap();
	assert_eq!((shared["report"]["visitors"].as_u64(), shared["domain"]["project_id"].is_null()), (Some(1), true), "{body}");
	assert_eq!(h.send("GET", "/api/analytics/shared/wrong", &[], "").await.0, StatusCode::NOT_FOUND);
	for wide in ["range=all", "from=2020-01-01&to=2022-12-31"] {
		let status = h.send("GET", &format!("/api/analytics/shared/{token}?{wide}"), &[], "").await.0;
		assert_eq!(status, StatusCode::BAD_REQUEST, "a public link reads at most a year: {wide}");
	}

	let stripe = json!({"type": "checkout.session.completed", "data": {"object": {"id": "cs_1", "payment_status": "paid",
		"amount_total": 1900, "currency": "eur", "metadata": {"vx_visitor_id": events[0].visitor}}}})
	.to_string();
	let now = chrono::Utc::now().timestamp().to_string();
	let mut mac = <hmac::Hmac<sha2::Sha256> as hmac::Mac>::new_from_slice(b"whsec_test").unwrap();
	hmac::Mac::update(&mut mac, format!("{now}.{stripe}").as_bytes());
	let signature = format!("t={now},v1={}", hex::encode(hmac::Mac::finalize(mac).into_bytes()));
	let webhook = "/api/analytics/webhooks/stripe/d-p1";
	let (status, _, body) = h.send("POST", webhook, &[("stripe-signature", "t=1,v1=00")], &stripe).await;
	assert_eq!(status, StatusCode::UNAUTHORIZED);
	assert!(body.contains("SIGNATURE_INVALID"), "the code docs/api.md lists: {body}");
	let (status, _, body) = h.send("POST", webhook, &[("stripe-signature", &signature)], &stripe).await;
	assert_eq!(status, StatusCode::OK, "{body}");
	assert_eq!(
		h.send("POST", "/api/analytics/webhooks/paddle/d-p1", &[], &stripe).await.0,
		StatusCode::NOT_FOUND,
		"no paddle secret saved"
	);
	let payments = h.server.db.analytics_payments("d-p1", 0, i64::MAX).unwrap();
	assert_eq!((payments.len(), payments[0].amount, payments[0].visitor == events[0].visitor), (1, 1900, true));

	let link = json!({"slug": "launch", "target": "https://p1.example.com/pricing?ref=1&utm_source=old", "utm_source": "x"}).to_string();
	assert_eq!(h.send("POST", "/api/domains/d-p1/analytics/links", &as_writer, &link).await.0, StatusCode::CREATED);
	assert_eq!(h.send("POST", "/api/domains/d-p1/analytics/links", &as_writer, &link).await.0, StatusCode::CONFLICT);
	let (status, headers, _) = h.send("GET", "/api/analytics/l/launch", &[("host", "p1.example.com")], "").await;
	assert_eq!(status, StatusCode::FOUND);
	assert_eq!(headers["location"], "https://p1.example.com/pricing?ref=1&utm_source=x");
	assert_eq!(h.send("GET", "/api/analytics/l/launch", &[("host", "p2.example.com")], "").await.0, StatusCode::NOT_FOUND);

	let funnel = json!({"name": "Checkout", "steps": [{"kind": "page", "value": "/"}, {"kind": "payment"}]}).to_string();
	assert_eq!(h.send("POST", "/api/domains/d-p1/analytics/funnels", &as_writer, &funnel).await.0, StatusCode::CREATED);
	let (_, _, body) = h.send("GET", "/api/domains/d-p1/analytics/funnels?range=24h", &[("authorization", &reader)], "").await;
	assert_eq!(serde_json::from_str::<Value>(&body).unwrap()[0]["reached"], json!([1, 1]), "{body}");

	let goal = json!({"name": "activated", "visitor_id": events[0].visitor, "props": {"plan": "pro"}}).to_string();
	assert_eq!(h.send("POST", "/api/domains/d-p1/goals", &as_writer, &goal).await.0, StatusCode::CREATED);
	let last = h.server.db.analytics_events("d-p1", 0, i64::MAX).unwrap().pop().unwrap();
	assert_eq!((last.name.as_str(), last.session == events[0].session), ("activated", true), "joins the live session");
}
