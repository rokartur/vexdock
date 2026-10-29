use std::sync::Arc;

use axum::Router;
use axum::body::Body;
use axum::http::{HeaderMap, Request, StatusCode};
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
