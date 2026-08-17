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
	cases := []struct {
		name   string
		host   string
		origin string
		want   bool
	}{
		{"no origin header", "panel.example.com", "", true},
		{"same host", "panel.example.com", "https://panel.example.com", true},
		{"same host with port", "panel.example.com:3000", "http://panel.example.com:3000", true},
		{"port differs from host header", "panel.example.com", "http://panel.example.com:3000", true},
		{"different host", "panel.example.com", "https://evil.example.com", false},
		{"host as a prefix of the origin", "panel.example.com", "https://panel.example.com.evil.net", false},
		{"unsupported scheme", "panel.example.com", "chrome-extension://abcdef", false},
		{"null origin", "panel.example.com", "null", false},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/api/projects", nil)
			r.Host = tc.host
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
