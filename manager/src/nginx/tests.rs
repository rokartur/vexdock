use super::*;

fn must_contain(haystack: &str, needle: &str) {
	assert!(haystack.contains(needle), "generated config is missing {needle:?}\n---\n{haystack}");
}

fn upstream(https: bool, redirect_https: bool) -> Upstream {
	Upstream {
		hostname: "app.example.com".into(),
		alias: "p_01jabc_web".into(),
		port: 3000,
		https,
		redirect_https,
		cert_dir: "/certificates/app.example.com".into(),
		..Default::default()
	}
}

#[test]
fn render_http_only() {
	let conf = render(&upstream(false, false));
	must_contain(&conf, "server_name app.example.com;");
	must_contain(&conf, "set $upstream http://p_01jabc_web:3000;");
	must_contain(&conf, "proxy_pass $upstream;");
	must_contain(&conf, "proxy_set_header Upgrade $http_upgrade;");
	must_contain(&conf, "location ^~ /.well-known/acme-challenge/");
	// Every line inside a location keeps the location's indentation.
	must_contain(&conf, "\n        proxy_set_header X-Forwarded-Proto $scheme;\n");
	assert!(!conf.contains("listen 443"), "HTTPS block rendered for a plain HTTP domain");
	assert!(!conf.contains("return 301"), "redirect rendered without HTTPS enabled");
}

#[test]
fn render_https_redirects() {
	let conf = render(&upstream(true, true));
	must_contain(&conf, "return 301 https://$host$request_uri;");
	must_contain(&conf, "listen 443 ssl;");
	must_contain(&conf, "ssl_certificate     /certificates/app.example.com/fullchain.pem;");
	must_contain(&conf, "ssl_certificate_key /certificates/app.example.com/privkey.pem;");
	// The challenge location must survive on port 80 or renewals break.
	assert!(conf.matches("acme-challenge").count() >= 2);
}

#[test]
fn render_https_without_redirect() {
	let conf = render(&upstream(true, false));
	assert!(!conf.contains("return 301"));
	assert_eq!(conf.matches("proxy_pass $upstream;").count(), 2, "both blocks proxy when redirect is off");
}

#[test]
fn alias_is_stable_and_safe() {
	assert_eq!(alias("01JABCXYZ", "Web App"), "p_01jabcxyz_web-app");
	assert!(!alias("01J", "we$b/../x").contains(['$', '/', '.']));
}

/// The panel on its own domain keeps the throttling the built-in :3000 vhost applies.
#[test]
fn render_dashboard_throttles_credentials() {
	let conf = render_dashboard("panel.example.com", "manager:8080", "/usr/share/nginx/html", false, "");
	must_contain(&conf, "limit_req zone=login_limit");
	must_contain(&conf, "limit_req zone=api_limit");
}

#[test]
fn render_dashboard_routes() {
	let conf = render_dashboard("panel.example.com", "manager:8080", "/usr/share/nginx/html", false, "");
	must_contain(&conf, "proxy_pass http://manager:8080;");
	must_contain(&conf, "location /api/auth/ {");
	must_contain(&conf, &format!("proxy_pass http://{AUTH_UPSTREAM};"));
	must_contain(&conf, "location = /mcp {");
	must_contain(&conf, &format!("proxy_pass http://{MCP_UPSTREAM};"));
	must_contain(&conf, "try_files $uri $uri/ /index.html;");
	must_contain(&conf, "root /usr/share/nginx/html;");
	let secure = render_dashboard("panel.example.com", "manager:8080", "/usr/share/nginx/html", true, "/certificates/panel.example.com");
	must_contain(&secure, "listen 443 ssl;");
	must_contain(&secure, "return 301 https://$host$request_uri;");
}

#[test]
fn access_rules_stay_out_of_the_challenge() {
	let conf = render(&Upstream {
		basic_auth: true,
		redirects: vec![Redirect { regex: r"^https?://(?:www\.)?(.+)".into(), replacement: "https://www.$1".into(), permanent: true }],
		..upstream(false, false)
	});
	must_contain(&conf, "auth_basic_user_file /etc/nginx/generated/app.example.com.htpasswd;");
	must_contain(&conf, r#"if ($redirect_url ~ "^https?://(?:www\.)?(.+)") { set $redirect_to "https://www.$1"; }"#);
	must_contain(&conf, "if ($redirect_to = $redirect_url) { set $redirect_to \"\"; }");
	must_contain(&conf, "if ($redirect_to) { return 301 $redirect_to; }");
	let challenge = &conf[conf.find("acme-challenge").unwrap()..conf.find("location / {").unwrap()];
	assert!(!challenge.contains("auth_basic") && !challenge.contains("redirect_to"));
}

#[test]
fn hash_password_is_salted_ssha() {
	let (a, b) = (hash_password("secret"), hash_password("secret"));
	assert!(a.starts_with("{SSHA}") && a != b);
}
