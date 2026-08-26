package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// Cookie sessions are attached by the browser to cross-site requests too, so
// SameOrigin is the only thing standing between a malicious page and a
// state-changing call.
func TestSameOrigin(t *testing.T) {
	// proto is what Nginx forwards as X-Forwarded-Proto; empty means the manager
	// was reached directly on its published port, which is plain http.
	cases := []struct {
		name   string
		host   string
		proto  string
		origin string
		want   bool
	}{
		{"no origin header", "panel.example.com", "https", "", true},
		{"same host behind tls", "panel.example.com", "https", "https://panel.example.com", true},
		{"direct on a published port", "panel.example.com:3000", "", "http://panel.example.com:3000", true},
		{"trailing slash", "panel.example.com", "https", "https://panel.example.com/", true},
		{"default port spelled out", "panel.example.com:443", "https", "https://panel.example.com", true},
		{"proto list from a chain of proxies", "panel.example.com", "https, http", "https://panel.example.com", true},
		{"uppercase host", "Panel.Example.com", "https", "https://panel.example.com", true},
		// A deployed project publishing a port on the dashboard's hostname is an
		// ordinary thing to do here, and its pages must not count as the panel.
		{"another port on the same host", "panel.example.com", "https", "http://panel.example.com:8080", false},
		{"panel port omitted by the origin", "panel.example.com:3000", "", "http://panel.example.com", false},
		// Nothing sets HSTS, so port 80 is interceptable. Without the scheme in the
		// comparison this page would pass: both sides reduce to the bare hostname.
		{"plaintext page on the panel hostname", "panel.example.com", "https", "http://panel.example.com", false},
		{"different host", "panel.example.com", "https", "https://evil.example.com", false},
		{"host as a prefix of the origin", "panel.example.com", "https", "https://panel.example.com.evil.net", false},
		{"credentials in the origin", "panel.example.com", "https", "https://panel.example.com@evil.net", false},
		{"unsupported scheme", "panel.example.com", "https", "chrome-extension://abcdef", false},
		{"null origin", "panel.example.com", "https", "null", false},
		{"scheme with no host", "panel.example.com", "https", "https://", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/api/projects", nil)
			r.Host = tc.host
			if tc.proto != "" {
				r.Header.Set("X-Forwarded-Proto", tc.proto)
			}
			if tc.origin != "" {
				r.Header.Set("Origin", tc.origin)
			}
			if got := SameOrigin(r); got != tc.want {
				t.Fatalf("SameOrigin(host=%q, origin=%q) = %v, want %v", tc.host, tc.origin, got, tc.want)
			}
		})
	}
}

// better-auth stores the bare token; the cookie carries token.signature.
func TestSessionTokenStripsSignature(t *testing.T) {
	if got := sessionToken("abc123.SIGNATURE"); got != "abc123" {
		t.Fatalf("sessionToken = %q, want abc123", got)
	}
	if got := sessionToken("abc123"); got != "abc123" {
		t.Fatalf("an unsigned value must pass through, got %q", got)
	}
	if got := sessionToken(""); got != "" {
		t.Fatalf("empty cookie must stay empty, got %q", got)
	}
}
