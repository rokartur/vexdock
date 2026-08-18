package api

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"

	"github.com/vexdock/platform/manager/internal/certificates"
	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/domains"
	"github.com/vexdock/platform/manager/internal/events"
	"github.com/vexdock/platform/manager/internal/metrics"
	"github.com/vexdock/platform/manager/internal/notify"
)

// handleHealth is the unauthenticated liveness/readiness probe used by the
// installer, the updater and Docker's own healthcheck.
func (s *Server) handleHealth(w http.ResponseWriter, r *http.Request) {
	checks := map[string]string{}
	healthy := true

	if err := s.db.PingContext(r.Context()); err != nil {
		checks["database"], healthy = err.Error(), false
	} else {
		checks["database"] = "ok"
	}
	if err := s.docker.Ping(r.Context()); err != nil {
		checks["docker"], healthy = err.Error(), false
	} else {
		checks["docker"] = "ok"
	}
	if err := writable(s.cfg.DataDir); err != nil {
		checks["storage"], healthy = err.Error(), false
	} else {
		checks["storage"] = "ok"
	}
	host := metrics.Read(s.cfg.Root)
	if host.DiskTotal > 0 && host.DiskTotal-host.DiskUsed < 512<<20 {
		checks["disk"], healthy = "less than 512 MB free", false
	} else {
		checks["disk"] = "ok"
	}
	if _, err := s.nginx.Test(r.Context()); err != nil {
		// A failing proxy is reported but does not make the manager unhealthy:
		// the panel must stay reachable precisely so it can be fixed.
		checks["nginx"] = err.Error()
	} else {
		checks["nginx"] = "ok"
	}

	status := "healthy"
	code := http.StatusOK
	if !healthy {
		status, code = "unhealthy", http.StatusServiceUnavailable
	}
	writeJSON(w, code, map[string]any{"status": status, "checks": checks})
}

func writable(dir string) error {
	probe := filepath.Join(dir, ".write-probe")
	if err := os.WriteFile(probe, []byte("ok"), 0o600); err != nil {
		return err
	}
	return os.Remove(probe)
}

func (s *Server) handleVersion(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.updater.Status(r.Context()))
}

// handleSystemInfo powers the dashboard summary.
func (s *Server) handleSystemInfo(w http.ResponseWriter, r *http.Request) {
	info, err := s.docker.Info(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	projects, err := s.db.ListProjects(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	recent, err := s.db.RecentDeployments(r.Context(), 10)
	if err != nil {
		serverError(w, err)
		return
	}
	names := map[string]string{}
	for _, p := range projects {
		names[p.ID] = p.Name
	}
	activity := make([]map[string]any, 0, len(recent))
	for _, d := range recent {
		activity = append(activity, map[string]any{"deployment": d, "project_name": names[d.ProjectID]})
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"host": map[string]any{
			"docker_version": info.ServerVersion,
			"os":             info.OperatingSystem,
			"architecture":   info.Architecture,
			"cpus":           info.NCPU,
			"memory_total":   info.MemTotal,
			"name":           info.Name,
		},
		"projects":           len(projects),
		"containers":         info.Containers,
		"containers_running": info.ContainersRunning,
		"containers_stopped": info.ContainersStopped,
		"images":             info.Images,
		"recent_deployments": activity,
		"version":            s.cfg.Version,
	})
}

// metricsPoints is how many buckets a metrics window is reduced to. A chart is
// a few hundred pixels wide, so anything denser is transferred for nothing.
const metricsPoints = 240

// statsInterval is how often a live stats stream pushes. Usage numbers are read
// at a glance, and a faster stream only spends CPU on both ends.
const statsInterval = time.Minute

// metricsWindows are the ranges the panel may ask for, capped at the retention
// period so a request cannot ask for data that was pruned.
var metricsWindows = map[string]time.Duration{
	"30m": 30 * time.Minute,
	"1h":  time.Hour,
	"6h":  6 * time.Hour,
	"24h": 24 * time.Hour,
	"7d":  7 * 24 * time.Hour,
}

// metricsWindow reads ?window= and returns the start of the range plus the
// bucket size in seconds that reduces it to metricsPoints.
func metricsWindow(r *http.Request) (time.Time, int64) {
	window, ok := metricsWindows[r.URL.Query().Get("window")]
	if !ok {
		window = 30 * time.Minute
	}
	bucket := int64(window.Seconds()) / metricsPoints
	if bucket < int64(metrics.Interval.Seconds()) {
		bucket = int64(metrics.Interval.Seconds())
	}
	return time.Now().Add(-window), bucket
}

// handleSystemMetrics returns recorded host usage for the requested window,
// which seeds the dashboard charts before live samples start arriving.
func (s *Server) handleSystemMetrics(w http.ResponseWriter, r *http.Request) {
	since, bucket := metricsWindow(r)
	points, err := s.db.HostMetrics(r.Context(), since, bucket)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, points)
}

// handleSystemStats streams host CPU/RAM/disk over SSE. The sampler records a
// point every metrics.Interval, so this only has to keep the panel's current
// reading fresh, not draw the chart.
func (s *Server) handleSystemStats(w http.ResponseWriter, r *http.Request) {
	sse, err := newSSE(w)
	if err != nil {
		serverError(w, err)
		return
	}
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for {
		if err := sse.send("stats", metrics.Read(s.cfg.Root)); err != nil {
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
		}
	}
}

// handleSystemEvents streams docker/platform events so the panel updates itself.
func (s *Server) handleSystemEvents(w http.ResponseWriter, r *http.Request) {
	ch, unsubscribe := s.bus.Subscribe(events.TopicSystem)
	defer unsubscribe()
	sse, err := newSSE(w)
	if err != nil {
		serverError(w, err)
		return
	}
	streamBus(r.Context(), sse, ch)
}

type settingsPayload struct {
	DashboardDomain  string `json:"dashboard_domain"`
	DashboardHTTPS   bool   `json:"dashboard_https"`
	ACMEEmail        string `json:"acme_email"`
	NotifyWebhookURL string `json:"notify_webhook_url"`

	// CloudflareAPIToken is write-only: nil leaves the stored token alone, ""
	// clears it. Reads report only whether one is present.
	CloudflareAPIToken *string `json:"cloudflare_api_token,omitempty"`
	CloudflareTokenSet bool    `json:"cloudflare_token_set"`
}

func (s *Server) handleGetSettings(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, settingsPayload{
		DashboardDomain:    s.setting(r.Context(), domains.SettingDashboardDomain),
		DashboardHTTPS:     s.setting(r.Context(), domains.SettingDashboardHTTPS) == "true",
		ACMEEmail:          s.cfg.ACMEEmail,
		NotifyWebhookURL:   s.setting(r.Context(), notify.SettingWebhookURL),
		CloudflareTokenSet: s.certs.DNS01Enabled(),
	})
}

func (s *Server) setting(ctx context.Context, key string) string {
	v, err := s.db.Setting(ctx, key)
	if err != nil {
		return ""
	}
	return v
}

func (s *Server) handlePutSettings(w http.ResponseWriter, r *http.Request) {
	var req settingsPayload
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	if err := notify.ValidateURL(req.NotifyWebhookURL); err != nil {
		badRequest(w, err)
		return
	}
	if err := s.domains.SetDashboardDomain(r.Context(), req.DashboardDomain, req.DashboardHTTPS); err != nil {
		badRequest(w, err)
		return
	}
	if err := s.db.SetSetting(r.Context(), notify.SettingWebhookURL, req.NotifyWebhookURL); err != nil {
		serverError(w, err)
		return
	}
	if req.CloudflareAPIToken != nil {
		if err := s.setCloudflareToken(r.Context(), *req.CloudflareAPIToken); err != nil {
			serverError(w, err)
			return
		}
	}
	s.handleGetSettings(w, r)
}

// setCloudflareToken persists the DNS-01 credential encrypted and applies it to
// the live issuer, so the next renewal uses it without a restart.
func (s *Server) setCloudflareToken(ctx context.Context, token string) error {
	stored := ""
	if token != "" {
		encrypted, err := s.cipher.Encrypt(token)
		if err != nil {
			return err
		}
		stored = encrypted
	}
	if err := s.db.SetSetting(ctx, certificates.SettingCloudflareToken, stored); err != nil {
		return err
	}
	s.certs.SetCloudflareToken(token)
	return nil
}

func (s *Server) handleBackup(w http.ResponseWriter, r *http.Request) {
	// Volume archives can take minutes and grow to many gigabytes, so the caller
	// asks for them explicitly.
	snapshot, err := s.backups.Create(r.Context(), r.URL.Query().Get("volumes") == "true")
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, snapshot)
}

func (s *Server) handleListBackups(w http.ResponseWriter, r *http.Request) {
	list, err := s.backups.List()
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// handleUpdate hands the swap to a detached updater container.
func (s *Server) handleUpdate(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Version string `json:"version"`
	}
	if err := decode(r, &req); err != nil && !errors.Is(err, http.ErrBodyNotAllowed) {
		// An empty body means "update to latest".
		req.Version = ""
	}
	if err := s.updater.Start(r.Context(), req.Version); err != nil {
		badRequest(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]string{
		"status":  "started",
		"message": "The platform is updating. The dashboard will reconnect automatically.",
	})
}

// handleAudit lists recent state-changing calls.
func (s *Server) handleAudit(w http.ResponseWriter, r *http.Request) {
	entries, err := s.db.ListAudit(r.Context(), 100)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, entries)
}

func (s *Server) handleListRegistries(w http.ResponseWriter, r *http.Request) {
	list, err := s.db.ListRegistries(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// handleCreateRegistry stores credentials encrypted and verifies them by
// logging in, so a typo is caught here rather than during a deployment.
func (s *Server) handleCreateRegistry(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name     string `json:"name"`
		URL      string `json:"url"`
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	if req.Name == "" || req.URL == "" || req.Username == "" || req.Password == "" {
		badRequest(w, errors.New("name, url, username and token are all required"))
		return
	}
	encrypted, err := s.cipher.Encrypt(req.Password)
	if err != nil {
		serverError(w, err)
		return
	}
	registry := &database.Registry{Name: req.Name, URL: req.URL, Username: req.Username, EncryptedPassword: encrypted}
	if err := s.db.CreateRegistry(r.Context(), registry); err != nil {
		badRequest(w, err)
		return
	}
	if err := s.dockerLogin(r.Context(), req.URL, req.Username, req.Password); err != nil {
		_ = s.db.DeleteRegistry(r.Context(), registry.ID)
		badRequest(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, registry)
}

func (s *Server) handleDeleteRegistry(w http.ResponseWriter, r *http.Request) {
	if err := s.db.DeleteRegistry(r.Context(), r.PathValue("id")); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// dockerLogin authenticates the daemon against a registry. The token is piped
// on stdin so it never appears in the process arguments.
func (s *Server) dockerLogin(ctx context.Context, registryURL, username, password string) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	cmd := exec.CommandContext(ctx, "docker", "login", "--username", username, "--password-stdin", registryURL)
	cmd.Stdin = strings.NewReader(password)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("registry login failed: %s", strings.TrimSpace(string(out)))
	}
	return nil
}
