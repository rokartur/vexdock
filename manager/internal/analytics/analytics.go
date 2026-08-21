// Package analytics turns a raw beacon hit into a storable event: who (an
// unlinkable daily hash), from where, on what. No cookies, no persistent
// identifier, no third party.
package analytics

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Retention is how long raw events are kept before the scheduler drops them.
const Retention = 90 * 24 * time.Hour

// Event kinds the beacon sends on its own. Anything else is a custom event.
const (
	KindPageview = "pageview"
	KindPing     = "ping"
)

// OnlineWindow is how recently a visitor must have been seen to count as
// online. The beacon pings once a minute while its tab is visible.
const OnlineWindow = 5 * time.Minute

// Field limits. The ingest endpoint is public, so everything it accepts is
// bounded before it reaches SQLite.
const (
	MaxPath     = 512
	MaxReferrer = 512
	MaxKind     = 64
	MaxProps    = 1024
)

// visitorSalt rotates daily so a hash cannot be correlated across days, and
// lives only in memory so a database copy cannot re-identify anyone either.
var visitorSalt struct {
	sync.Mutex
	day   string
	value []byte
}

func saltFor(now time.Time) []byte {
	day := now.UTC().Format("2006-01-02")
	visitorSalt.Lock()
	defer visitorSalt.Unlock()
	if visitorSalt.day != day {
		fresh := make([]byte, 32)
		// crypto/rand.Read never fails on the platforms this runs on.
		_, _ = rand.Read(fresh)
		visitorSalt.day, visitorSalt.value = day, fresh
	}
	return visitorSalt.value
}

// Visitor identifies a browser for one site for one day, and nothing beyond it.
func Visitor(now time.Time, hostname, ip, userAgent string) string {
	sum := sha256.New()
	sum.Write(saltFor(now))
	sum.Write([]byte(hostname + "|" + ip + "|" + userAgent))
	return hex.EncodeToString(sum.Sum(nil))[:16]
}

// Client is the coarse device breakdown the panel shows. Coarse is the point:
// exact versions would be a fingerprint.
type Client struct {
	Device  string
	Browser string
	OS      string
}

// ParseUA buckets a user agent. Order matters: the specific strings have to be
// tested before the generic ones every browser also claims.
func ParseUA(ua string) Client {
	lower := strings.ToLower(ua)
	c := Client{Device: "desktop", Browser: "Other", OS: "Other"}

	switch {
	case strings.Contains(lower, "ipad"), strings.Contains(lower, "tablet"):
		c.Device = "tablet"
	case strings.Contains(lower, "mobi"), strings.Contains(lower, "iphone"), strings.Contains(lower, "android"):
		c.Device = "mobile"
	}

	switch {
	case strings.Contains(lower, "edg/"):
		c.Browser = "Edge"
	case strings.Contains(lower, "opr/"), strings.Contains(lower, "opera"):
		c.Browser = "Opera"
	case strings.Contains(lower, "firefox"):
		c.Browser = "Firefox"
	case strings.Contains(lower, "chrome"), strings.Contains(lower, "crios"):
		c.Browser = "Chrome"
	case strings.Contains(lower, "safari"):
		c.Browser = "Safari"
	}

	switch {
	case strings.Contains(lower, "iphone"), strings.Contains(lower, "ipad"), strings.Contains(lower, "ios"):
		c.OS = "iOS"
	case strings.Contains(lower, "android"):
		c.OS = "Android"
	case strings.Contains(lower, "windows"):
		c.OS = "Windows"
	case strings.Contains(lower, "mac os"), strings.Contains(lower, "macintosh"):
		c.OS = "macOS"
	case strings.Contains(lower, "linux"), strings.Contains(lower, "x11"):
		c.OS = "Linux"
	}
	return c
}

var botMarkers = []string{
	"bot", "crawl", "spider", "slurp", "curl", "wget", "headless", "monitor",
	"preview", "python-requests", "go-http-client", "lighthouse", "pingdom",
}

// IsBot drops the obvious automated traffic before it can inflate a number
// someone makes a decision on.
func IsBot(userAgent string) bool {
	lower := strings.ToLower(userAgent)
	if lower == "" {
		return true
	}
	for _, marker := range botMarkers {
		if strings.Contains(lower, marker) {
			return true
		}
	}
	return false
}

// CleanPath keeps the path and drops the query string, which is where session
// ids and tracking parameters live.
func CleanPath(raw string) string {
	path := raw
	if i := strings.IndexAny(path, "?#"); i >= 0 {
		path = path[:i]
	}
	path = strings.TrimSpace(path)
	if path == "" {
		return "/"
	}
	if !strings.HasPrefix(path, "/") {
		path = "/" + path
	}
	return truncate(path, MaxPath)
}

// ReferrerHost reduces a referrer to its host. Own-site navigation is not a
// referral, so it reports empty.
func ReferrerHost(raw, hostname string) string {
	raw = truncate(strings.TrimSpace(raw), MaxReferrer)
	if raw == "" {
		return ""
	}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Host == "" {
		return ""
	}
	host := strings.TrimPrefix(strings.ToLower(parsed.Host), "www.")
	if host == strings.TrimPrefix(strings.ToLower(hostname), "www.") {
		return ""
	}
	return host
}

// Country prefers an ISO code from an edge that already resolved the IP, and
// otherwise falls back to the timezone the browser reports, which is a region
// rather than a country but needs no IP database and no lookup.
// ponytail: drop in a MaxMind reader here if country-exact numbers ever matter.
func Country(header, timezone string) string {
	if code := strings.ToUpper(strings.TrimSpace(header)); len(code) == 2 {
		return code
	}
	timezone = strings.TrimSpace(timezone)
	if timezone == "" || len(timezone) > 64 || strings.ContainsAny(timezone, " \t\n") {
		return "Unknown"
	}
	return timezone
}

func truncate(s string, max int) string {
	if len(s) <= max {
		return s
	}
	return s[:max]
}
