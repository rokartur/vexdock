package auth

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/vexdock/platform/manager/internal/config"
)

// A fresh install is reached over plain HTTP by IP. A Secure cookie is silently
// discarded there, so marking it Secure unconditionally would make login
// impossible until the user attaches a domain.
func TestSessionCookieSecureFollowsScheme(t *testing.T) {
	service := &Service{cfg: &config.Config{SessionTTL: time.Hour}}

	cases := []struct {
		name       string
		prepare    func(*http.Request)
		wantSecure bool
	}{
		{
			name:       "plain http by ip",
			prepare:    func(*http.Request) {},
			wantSecure: false,
		},
		{
			name:       "behind nginx with tls",
			prepare:    func(r *http.Request) { r.Header.Set("X-Forwarded-Proto", "https") },
			wantSecure: true,
		},
		{
			name:       "forwarded proto is case insensitive",
			prepare:    func(r *http.Request) { r.Header.Set("X-Forwarded-Proto", "HTTPS") },
			wantSecure: true,
		},
		{
			name:       "forwarded plain http",
			prepare:    func(r *http.Request) { r.Header.Set("X-Forwarded-Proto", "http") },
			wantSecure: false,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			r := httptest.NewRequest(http.MethodPost, "/api/auth/login", nil)
			tc.prepare(r)
			w := httptest.NewRecorder()

			service.SetSessionCookie(w, r, "token-value")

			cookie := findCookie(t, w.Result().Cookies(), SessionCookie)
			if cookie.Secure != tc.wantSecure {
				t.Fatalf("Secure = %v, want %v", cookie.Secure, tc.wantSecure)
			}
			if !cookie.HttpOnly {
				t.Fatal("the session cookie must be HttpOnly")
			}
			if cookie.SameSite != http.SameSiteLaxMode {
				t.Fatalf("SameSite = %v, want Lax", cookie.SameSite)
			}
			if cookie.Value != "token-value" {
				t.Fatalf("unexpected cookie value %q", cookie.Value)
			}
		})
	}
}

func TestClearSessionCookieExpiresIt(t *testing.T) {
	service := &Service{cfg: &config.Config{SessionTTL: time.Hour}}
	r := httptest.NewRequest(http.MethodPost, "/api/auth/logout", nil)
	w := httptest.NewRecorder()

	service.ClearSessionCookie(w, r)

	cookie := findCookie(t, w.Result().Cookies(), SessionCookie)
	if cookie.MaxAge >= 0 {
		t.Fatalf("MaxAge = %d, want a negative value so the browser drops it", cookie.MaxAge)
	}
	if cookie.Value != "" {
		t.Fatalf("cookie value = %q, want empty", cookie.Value)
	}
}

// The limiter protects bcrypt from a login flood.
func TestRateLimiterWindow(t *testing.T) {
	limiter := newRateLimiter(3, time.Minute)
	for i := range 3 {
		if !limiter.allow("10.0.0.1") {
			t.Fatalf("attempt %d was rejected inside the limit", i+1)
		}
	}
	if limiter.allow("10.0.0.1") {
		t.Fatal("the fourth attempt should have been rejected")
	}
	if !limiter.allow("10.0.0.2") {
		t.Fatal("a different client must not inherit another client's limit")
	}
	// A successful login clears the counter.
	limiter.reset("10.0.0.1")
	if !limiter.allow("10.0.0.1") {
		t.Fatal("reset did not clear the counter")
	}
}

func findCookie(t *testing.T, cookies []*http.Cookie, name string) *http.Cookie {
	t.Helper()
	for _, c := range cookies {
		if c.Name == name {
			return c
		}
	}
	t.Fatalf("no %s cookie was set", name)
	return nil
}
