package analytics

import (
	"testing"
	"time"
)

func TestParseUA(t *testing.T) {
	cases := []struct {
		ua   string
		want Client
	}{
		{
			"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
			Client{Device: "mobile", Browser: "Safari", OS: "iOS"},
		},
		{
			// Chrome claims Safari too, and Edge claims both.
			"Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36 Edg/120.0",
			Client{Device: "desktop", Browser: "Edge", OS: "Windows"},
		},
		{
			"Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0 Safari/537.36",
			Client{Device: "desktop", Browser: "Chrome", OS: "Linux"},
		},
		{
			"Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Safari/604.1",
			Client{Device: "tablet", Browser: "Safari", OS: "iOS"},
		},
	}
	for _, c := range cases {
		if got := ParseUA(c.ua); got != c.want {
			t.Errorf("ParseUA(%.30s…) = %+v, want %+v", c.ua, got, c.want)
		}
	}
}

func TestIsBot(t *testing.T) {
	for _, ua := range []string{"", "Googlebot/2.1", "curl/8.4.0", "HeadlessChrome/120"} {
		if !IsBot(ua) {
			t.Errorf("expected %q to be filtered as a bot", ua)
		}
	}
	if IsBot("Mozilla/5.0 (Macintosh) Safari/605.1.15") {
		t.Error("a real browser was filtered as a bot")
	}
}

func TestCleanPathDropsQuery(t *testing.T) {
	cases := map[string]string{
		"/pricing?utm_source=x": "/pricing",
		"":                      "/",
		"docs/install":          "/docs/install",
		"/a#section":            "/a",
	}
	for in, want := range cases {
		if got := CleanPath(in); got != want {
			t.Errorf("CleanPath(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestReferrerHostIgnoresOwnSite(t *testing.T) {
	if got := ReferrerHost("https://news.ycombinator.com/item?id=1", "example.com"); got != "news.ycombinator.com" {
		t.Errorf("external referrer = %q", got)
	}
	if got := ReferrerHost("https://www.example.com/about", "example.com"); got != "" {
		t.Errorf("own-site navigation should not be a referral, got %q", got)
	}
	if got := ReferrerHost("", "example.com"); got != "" {
		t.Errorf("empty referrer = %q", got)
	}
}

func TestCountryPrefersEdgeHeader(t *testing.T) {
	if got := Country("pl", "Europe/Berlin"); got != "PL" {
		t.Errorf("edge header should win, got %q", got)
	}
	if got := Country("", "Europe/Warsaw"); got != "Europe/Warsaw" {
		t.Errorf("timezone fallback = %q", got)
	}
	if got := Country("XX-invalid", "not a zone"); got != "Unknown" {
		t.Errorf("garbage should be Unknown, got %q", got)
	}
}

func TestVisitorIsStableWithinADayAndPerSite(t *testing.T) {
	now := time.Now()
	first := Visitor(now, "example.com", "1.2.3.4", "Firefox")
	if again := Visitor(now.Add(time.Hour), "example.com", "1.2.3.4", "Firefox"); again != first {
		t.Error("the same visitor should hash the same within a day")
	}
	if other := Visitor(now, "other.com", "1.2.3.4", "Firefox"); other == first {
		t.Error("the same person on two sites must not share an identifier")
	}
	if other := Visitor(now, "example.com", "5.6.7.8", "Firefox"); other == first {
		t.Error("different visitors must not collide")
	}
}
