package api

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/vexdock/platform/manager/internal/analytics"
	"github.com/vexdock/platform/manager/internal/database"
)

// handleBeaconScript serves the tracking script. It is public by definition:
// every visitor of every tracked site loads it.
func (s *Server) handleBeaconScript(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/javascript; charset=utf-8")
	w.Header().Set("Cache-Control", "public, max-age=3600")
	_, _ = io.WriteString(w, analytics.Beacon)
}

// beaconHit is the body the script sends. Short names keep the request small.
type beaconHit struct {
	Kind     string          `json:"k"`
	Path     string          `json:"p"`
	Referrer string          `json:"r"`
	Timezone string          `json:"tz"`
	Props    json.RawMessage `json:"props"`
}

// handleCollect records one hit. The endpoint is public, so it answers 204 to
// everything: a visitor's browser has nothing to do with a failure, and a
// distinguishable error would tell a prober which hostnames are tracked.
func (s *Server) handleCollect(w http.ResponseWriter, r *http.Request) {
	defer func() { w.WriteHeader(http.StatusNoContent) }()

	hostname := hostOnly(r.Host)
	domain, err := s.DB.DomainByHostname(r.Context(), hostname)
	if err != nil || !domain.Analytics {
		if err != nil && !errors.Is(err, database.ErrNotFound) {
			s.Log.Warn("analytics domain lookup failed", "hostname", hostname, "error", err)
		}
		return
	}

	userAgent := r.Header.Get("User-Agent")
	if analytics.IsBot(userAgent) {
		return
	}

	var hit beaconHit
	if err := json.NewDecoder(io.LimitReader(r.Body, 8<<10)).Decode(&hit); err != nil {
		return
	}
	kind := strings.TrimSpace(hit.Kind)
	if kind == "" || len(kind) > analytics.MaxKind {
		return
	}

	now := time.Now()
	client := analytics.ParseUA(userAgent)
	event := database.AnalyticsEvent{
		Hostname: hostname,
		Visitor:  analytics.Visitor(now, hostname, visitorIP(r), client),
		Kind:     kind,
		Path:     analytics.CleanPath(hit.Path),
		Referrer: analytics.ReferrerHost(hit.Referrer, hostname),
		Country:  analytics.Country(r.Header.Get("CF-IPCountry"), hit.Timezone),
		Device:   client.Device,
		Browser:  client.Browser,
		OS:       client.OS,
		Props:    boundedProps(hit.Props),
	}
	if err := s.DB.RecordAnalyticsEvent(r.Context(), now, event); err != nil {
		s.Log.Warn("analytics write failed", "hostname", hostname, "error", err)
	}
}

// visitorIP prefers the address a CDN in front of Nginx already resolved.
// Behind Cloudflare $remote_addr is an edge node, so two tabs can arrive from
// two different addresses and count as two people. Unlike the audit log's
// clientIP this trusts a header the client could forge, which is acceptable
// here: a forged one only skews that site's own visitor count.
func visitorIP(r *http.Request) string {
	if edge := strings.TrimSpace(r.Header.Get("CF-Connecting-IP")); edge != "" {
		return edge
	}
	return clientIP(r)
}

// handleAnalytics returns every section the analytics page shows for one
// hostname, so the page loads in a single request.
func (s *Server) handleAnalytics(w http.ResponseWriter, r *http.Request) {
	domain, err := s.DB.DomainByHostname(r.Context(), r.PathValue("hostname"))
	if handleLookupError(w, err) {
		return
	}

	window, bucket := analyticsRange(r.URL.Query().Get("range"))
	summary, err := s.DB.TrafficFor(r.Context(), domain.Hostname, time.Now(), window, analytics.OnlineWindow, bucket, 20)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"domain": domain, "traffic": summary})
}

// activityWindow is how far back the weekday heatmap looks. Four weeks give
// every weekday four samples, which is enough for a pattern to show.
const activityWindow = 28 * 24 * time.Hour

// handleAnalyticsActivity returns four weeks of hourly counts. The dashboard
// folds them into a weekday grid itself, because only the browser knows which
// hour of which day these seconds are in.
func (s *Server) handleAnalyticsActivity(w http.ResponseWriter, r *http.Request) {
	domain, err := s.DB.DomainByHostname(r.Context(), r.PathValue("hostname"))
	if handleLookupError(w, err) {
		return
	}
	series, err := s.DB.TrafficSeries(r.Context(), domain.Hostname, time.Now().Add(-activityWindow), 3600)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"series": series})
}

// handleClearAnalytics deletes every event of one site. There is no undo and
// no export, so the dashboard asks twice before calling it.
func (s *Server) handleClearAnalytics(w http.ResponseWriter, r *http.Request) {
	domain, err := s.DB.DomainByHostname(r.Context(), r.PathValue("hostname"))
	if handleLookupError(w, err) {
		return
	}
	deleted, err := s.DB.ClearAnalytics(r.Context(), domain.Hostname)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deleted": deleted})
}

// analyticsRange maps the requested window to a bucket size that keeps the
// chart around a hundred points. Anything unknown is a day.
func analyticsRange(name string) (window time.Duration, bucket int64) {
	switch name {
	case "7d":
		return 7 * 24 * time.Hour, 3600
	case "30d":
		return 30 * 24 * time.Hour, 6 * 3600
	default:
		return 24 * time.Hour, 900
	}
}

func hostOnly(host string) string {
	if i := strings.LastIndex(host, ":"); i > 0 && !strings.Contains(host[i:], "]") {
		host = host[:i]
	}
	return strings.ToLower(strings.TrimSpace(host))
}

// boundedProps keeps custom event payloads small enough that a public endpoint
// cannot be used to write arbitrary blobs into the database.
func boundedProps(raw json.RawMessage) string {
	if len(raw) == 0 || len(raw) > analytics.MaxProps || string(raw) == "null" {
		return ""
	}
	return string(raw)
}
