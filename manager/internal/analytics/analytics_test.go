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
	chrome := Client{Device: "desktop", Browser: "Chrome", OS: "macOS"}
	first := Visitor(now, "example.com", "1.2.3.4", chrome)
	if again := Visitor(now.Add(time.Hour), "example.com", "1.2.3.4", chrome); again != first {
		t.Error("the same visitor should hash the same within a day")
	}
	if other := Visitor(now, "other.com", "1.2.3.4", chrome); other == first {
		t.Error("the same person on two sites must not share an identifier")
	}
	if other := Visitor(now, "example.com", "5.6.7.8", chrome); other == first {
		t.Error("different visitors must not collide")
	}
	phone := Client{Device: "mobile", Browser: "Chrome", OS: "Android"}
	if other := Visitor(now, "example.com", "1.2.3.4", phone); other == first {
		t.Error("two devices behind one address should still be two visitors")
	}
}

// A private window and a version bump both change the user agent string but
// not the device, and an operating system rotates the low half of its IPv6
// address on its own. Neither may produce a second visitor.
func TestVisitorSurvivesTheSameDeviceLookingDifferent(t *testing.T) {
	now := time.Now()
	stable := Visitor(now, "example.com", "2a01:110:8012:1010:1111:2222:3333:4444", ParseUA(chromeUA("142.0.0.0")))
	rotated := Visitor(now, "example.com", "2a01:110:8012:1010:9999:8888:7777:6666", ParseUA(chromeUA("143.0.0.0")))
	if rotated != stable {
		t.Error("same device, new IPv6 suffix and browser version, should be one visitor")
	}
	if other := Visitor(now, "example.com", "2a01:110:8012:2020::1", ParseUA(chromeUA("142.0.0.0"))); other == stable {
		t.Error("a different /64 is a different visitor")
	}
}

func chromeUA(version string) string {
	return "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/" + version + " Safari/537.36"
}

func TestNormalizeIP(t *testing.T) {
	cases := map[string]string{
		"1.2.3.4":                    "1.2.3.4",
		"::ffff:1.2.3.4":             "1.2.3.4",
		"2a01:110:8012:1010:1:2:3:4": "2a01:110:8012:1010::/64",
		"fe80::1%en0":                "fe80::/64",
		"not an address":             "not an address",
	}
	for in, want := range cases {
		if got := NormalizeIP(in); got != want {
			t.Errorf("NormalizeIP(%q) = %q, want %q", in, got, want)
		}
	}
}
