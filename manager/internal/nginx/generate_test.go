package nginx

import (
	"strings"
	"testing"
)

func TestRenderHTTPOnly(t *testing.T) {
	conf := Render(Upstream{
		Hostname: "app.example.com",
		Alias:    "p_01jabc_web",
		Port:     3000,
	})
	mustContain(t, conf, "server_name app.example.com;")
	mustContain(t, conf, "set $upstream http://p_01jabc_web:3000;")
	mustContain(t, conf, "proxy_pass $upstream;")
	mustContain(t, conf, "proxy_set_header Upgrade $http_upgrade;")
	mustContain(t, conf, "location ^~ /.well-known/acme-challenge/")
	if strings.Contains(conf, "listen 443") {
		t.Fatal("HTTPS block rendered for a plain HTTP domain")
	}
	if strings.Contains(conf, "return 301") {
		t.Fatal("redirect rendered without HTTPS enabled")
	}
}

func TestRenderHTTPSRedirects(t *testing.T) {
	conf := Render(Upstream{
		Hostname:      "app.example.com",
		Alias:         "p_01jabc_web",
		Port:          8080,
		HTTPS:         true,
		RedirectHTTPS: true,
		CertDir:       "/certificates/app.example.com",
	})
	mustContain(t, conf, "return 301 https://$host$request_uri;")
	mustContain(t, conf, "listen 443 ssl;")
	mustContain(t, conf, "ssl_certificate     /certificates/app.example.com/fullchain.pem;")
	mustContain(t, conf, "ssl_certificate_key /certificates/app.example.com/privkey.pem;")
	// The challenge location must survive on port 80 or renewals break.
	if strings.Count(conf, "acme-challenge") < 2 {
		t.Fatal("ACME challenge location missing from one of the server blocks")
	}
}

func TestRenderHTTPSWithoutRedirect(t *testing.T) {
	conf := Render(Upstream{
		Hostname: "app.example.com", Alias: "a", Port: 80,
		HTTPS: true, RedirectHTTPS: false, CertDir: "/c",
	})
	if strings.Contains(conf, "return 301") {
		t.Fatal("redirect rendered although it is disabled")
	}
	if strings.Count(conf, "proxy_pass $upstream;") != 2 {
		t.Fatal("both HTTP and HTTPS blocks should proxy when redirect is off")
	}
}

func TestRenderCustomDirectives(t *testing.T) {
	conf := Render(Upstream{
		Hostname: "a.example.com", Alias: "a", Port: 80,
		Custom: "client_max_body_size 100M;\nproxy_request_buffering off;",
	})
	mustContain(t, conf, "        client_max_body_size 100M;")
	mustContain(t, conf, "        proxy_request_buffering off;")
}

func TestAliasIsStableAndSafe(t *testing.T) {
	got := Alias("01JABCXYZ", "Web App")
	if got != "p_01jabcxyz_web-app" {
		t.Fatalf("unexpected alias %q", got)
	}
	if Alias("01JABCXYZ", "web") != Alias("01JABCXYZ", "web") {
		t.Fatal("alias is not deterministic")
	}
	// Anything that could break an Nginx upstream name must be normalised away.
	if strings.ContainsAny(Alias("01J", "we$b/../x"), "$/.") {
		t.Fatal("alias leaked unsafe characters")
	}
}

// The panel on its own domain must keep the throttling that the built-in
// :3000 vhost applies, or moving it there silently opens sign-in to brute force.
func TestRenderDashboardThrottlesCredentials(t *testing.T) {
	conf := RenderDashboard("panel.example.com", "manager:8080", "/usr/share/nginx/html", false, "")
	if !strings.Contains(conf, "limit_req zone=login_limit") {
		t.Error("the dashboard vhost does not rate limit credential endpoints")
	}
	if !strings.Contains(conf, "limit_req zone=api_limit") {
		t.Error("the dashboard vhost does not rate limit the API")
	}
}

func TestRenderDashboard(t *testing.T) {
	conf := RenderDashboard("panel.example.com", "manager:8080", "/usr/share/nginx/html", false, "")
	mustContain(t, conf, "proxy_pass http://manager:8080;")
	// Authentication lives in its own service and must not reach the manager.
	mustContain(t, conf, "location /api/auth/ {")
	mustContain(t, conf, "proxy_pass http://"+AuthUpstream+";")
	mustContain(t, conf, "try_files $uri $uri/ /index.html;")
	mustContain(t, conf, "root /usr/share/nginx/html;")

	secure := RenderDashboard("panel.example.com", "manager:8080", "/usr/share/nginx/html", true, "/certificates/panel.example.com")
	mustContain(t, secure, "listen 443 ssl;")
	mustContain(t, secure, "return 301 https://$host$request_uri;")
}

func TestSortedFileNames(t *testing.T) {
	got := SortedFileNames(map[string]string{"b.conf": "", "a.conf": "", "c.conf": ""})
	if strings.Join(got, ",") != "a.conf,b.conf,c.conf" {
		t.Fatalf("file names not sorted: %v", got)
	}
}

func mustContain(t *testing.T, haystack, needle string) {
	t.Helper()
	if !strings.Contains(haystack, needle) {
		t.Fatalf("generated config is missing %q\n---\n%s", needle, haystack)
	}
}
