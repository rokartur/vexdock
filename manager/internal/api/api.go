// Package api exposes the REST surface. Nginx is the only thing in front of
// it; the manager itself never listens on a public interface.
package api

import (
	"bufio"
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"time"

	"github.com/vexdock/platform/manager/internal/auth"
	"github.com/vexdock/platform/manager/internal/backup"
	"github.com/vexdock/platform/manager/internal/certificates"
	"github.com/vexdock/platform/manager/internal/config"
	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/deployments"
	"github.com/vexdock/platform/manager/internal/docker"
	"github.com/vexdock/platform/manager/internal/domains"
	"github.com/vexdock/platform/manager/internal/events"
	"github.com/vexdock/platform/manager/internal/nginx"
	"github.com/vexdock/platform/manager/internal/projects"
	"github.com/vexdock/platform/manager/internal/security"
	"github.com/vexdock/platform/manager/internal/updater"
)

// Deps is everything the API needs. Embedding it in Server means a new
// subsystem is one field, not a field plus a copy that is easy to forget.
type Deps struct {
	Config      *config.Config
	DB          *database.DB
	Auth        *auth.Service
	Projects    *projects.Service
	Domains     *domains.Service
	Deployments *deployments.Engine
	Docker      *docker.Client
	Nginx       *nginx.Manager
	Certs       *certificates.Issuer
	Bus         *events.Bus
	Updater     *updater.Service
	Backups     *backup.Service
	Cipher      *security.Cipher
	Log         *slog.Logger
}

// Server wires every subsystem into one HTTP handler.
type Server struct {
	Deps
}

func New(d Deps) *Server {
	return &Server{Deps: d}
}

// Handler builds the router. Public routes are listed explicitly; everything
// else requires a session cookie or a bearer API token.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Public.
	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("GET /api/system/version", s.handleVersion)
	mux.HandleFunc("POST /api/webhooks/projects/{token}", s.handleWebhook)
	// The beacon and its hits come from visitors of tracked sites, not from the
	// panel, so they cannot carry a session. Nginx only routes them for a
	// hostname whose domain has analytics enabled.
	mux.HandleFunc("GET /api/collect.js", s.handleBeaconScript)
	mux.HandleFunc("POST /api/collect", s.handleCollect)

	// Authenticated.
	mux.Handle("GET /api/me", s.protected(s.handleMe))

	mux.Handle("GET /api/projects", s.protected(s.handleListProjects))
	mux.Handle("POST /api/projects", s.protected(s.handleCreateProject))
	mux.Handle("GET /api/projects/{id}", s.protected(s.handleGetProject))
	mux.Handle("PATCH /api/projects/{id}", s.protected(s.handleUpdateProject))
	mux.Handle("DELETE /api/projects/{id}", s.protected(s.handleDeleteProject))
	mux.Handle("POST /api/projects/{id}/deploy", s.protected(s.handleDeploy))
	mux.Handle("POST /api/projects/{id}/redeploy", s.protected(s.handleDeploy))
	mux.Handle("POST /api/projects/{id}/stop", s.protected(s.handleStopProject))
	mux.Handle("GET /api/projects/{id}/compose", s.protected(s.handleGetCompose))
	mux.Handle("PUT /api/projects/{id}/compose", s.protected(s.handlePutCompose))
	mux.Handle("GET /api/projects/{id}/variables", s.protected(s.handleGetProjectVariables))
	mux.Handle("PUT /api/projects/{id}/variables", s.protected(s.handlePutProjectVariables))
	mux.Handle("GET /api/projects/{id}/environments", s.protected(s.handleListEnvironments))
	mux.Handle("POST /api/projects/{id}/environments", s.protected(s.handleCreateEnvironment))
	mux.Handle("GET /api/projects/{id}/services", s.protected(s.handleListServices))
	mux.Handle("POST /api/projects/{id}/services", s.protected(s.handleCreateService))
	mux.Handle("GET /api/projects/{id}/services/export", s.protected(s.handleExportServices))
	mux.Handle("GET /api/projects/{id}/deployments", s.protected(s.handleListDeployments))
	mux.Handle("GET /api/projects/{id}/domains", s.protected(s.handleListProjectDomains))

	mux.Handle("GET /api/services/{id}", s.protected(s.handleGetService))
	mux.Handle("PATCH /api/services/{id}", s.protected(s.handleUpdateService))
	mux.Handle("DELETE /api/services/{id}", s.protected(s.handleDeleteService))
	mux.Handle("GET /api/services/{id}/database", s.protected(s.handleServiceDatabase))
	mux.Handle("GET /api/services/{id}/variables", s.protected(s.handleGetServiceEnvironment))
	mux.Handle("PUT /api/services/{id}/variables", s.protected(s.handlePutServiceEnvironment))
	mux.Handle("POST /api/services/{id}/deploy", s.protected(s.handleDeployService))
	mux.Handle("POST /api/services/{id}/start", s.protected(s.handleServiceAction))
	mux.Handle("POST /api/services/{id}/stop", s.protected(s.handleServiceAction))
	mux.Handle("POST /api/services/{id}/restart", s.protected(s.handleServiceAction))
	mux.Handle("GET /api/services/{id}/logs", s.protected(s.handleServiceLogs))
	mux.Handle("GET /api/services/{id}/stats", s.protected(s.handleServiceStats))
	mux.Handle("GET /api/services/{id}/metrics", s.protected(s.handleServiceMetrics))
	mux.Handle("GET /api/services/{id}/terminal", s.protected(s.handleTerminal))

	mux.Handle("GET /api/environments/{id}", s.protected(s.handleGetEnvironment))
	mux.Handle("PATCH /api/environments/{id}", s.protected(s.handleUpdateEnvironment))
	mux.Handle("DELETE /api/environments/{id}", s.protected(s.handleDeleteEnvironment))
	mux.Handle("GET /api/environments/{id}/variables", s.protected(s.handleGetEnvironmentVariables))
	mux.Handle("PUT /api/environments/{id}/variables", s.protected(s.handlePutEnvironmentVariables))

	mux.Handle("GET /api/domains", s.protected(s.handleListDomains))
	mux.Handle("POST /api/domains", s.protected(s.handleCreateDomain))
	mux.Handle("PATCH /api/domains/{id}", s.protected(s.handleUpdateDomain))
	mux.Handle("DELETE /api/domains/{id}", s.protected(s.handleDeleteDomain))
	mux.Handle("POST /api/domains/{id}/certificate", s.protected(s.handleIssueCertificate))
	mux.Handle("GET /api/analytics/{hostname}", s.protected(s.handleAnalytics))
	mux.Handle("GET /api/analytics/{hostname}/activity", s.protected(s.handleAnalyticsActivity))
	mux.Handle("DELETE /api/analytics/{hostname}", s.protected(s.handleClearAnalytics))

	mux.Handle("GET /api/deployments/{id}", s.protected(s.handleGetDeployment))
	mux.Handle("GET /api/deployments/{id}/events", s.protected(s.handleDeploymentEvents))
	mux.Handle("POST /api/deployments/{id}/cancel", s.protected(s.handleCancelDeployment))
	mux.Handle("POST /api/deployments/{id}/rollback", s.protected(s.handleRollback))

	mux.Handle("GET /api/docker/containers", s.protected(s.handleListContainers))
	mux.Handle("POST /api/docker/containers/{id}/{action}", s.protected(s.handleContainerAction))
	mux.Handle("GET /api/docker/containers/{id}/logs", s.protected(s.handleContainerLogs))
	mux.Handle("GET /api/docker/images", s.protected(s.handleListImages))
	mux.Handle("POST /api/docker/images/pull", s.protected(s.handlePullImage))
	mux.Handle("DELETE /api/docker/images/{id}", s.protected(s.handleRemoveImage))
	mux.Handle("GET /api/docker/volumes", s.protected(s.handleListVolumes))
	mux.Handle("DELETE /api/docker/volumes/{name}", s.protected(s.handleRemoveVolume))
	mux.Handle("GET /api/docker/networks", s.protected(s.handleListNetworks))
	mux.Handle("GET /api/docker/cleanup", s.protected(s.handleCleanupPreview))
	mux.Handle("POST /api/docker/cleanup/{kind}", s.protected(s.handleCleanup))

	mux.Handle("GET /api/registries", s.protected(s.handleListRegistries))
	mux.Handle("POST /api/registries", s.protected(s.handleCreateRegistry))
	mux.Handle("DELETE /api/registries/{id}", s.protected(s.handleDeleteRegistry))

	mux.Handle("GET /api/tokens", s.protected(s.handleListTokens))
	mux.Handle("POST /api/tokens", s.protected(s.handleCreateToken))
	mux.Handle("DELETE /api/tokens/{id}", s.protected(s.handleDeleteToken))

	mux.Handle("GET /api/engines", s.protected(s.handleListEngines))
	mux.Handle("GET /api/engines/{slug}/versions", s.protected(s.handleEngineVersions))

	mux.Handle("GET /api/system/info", s.protected(s.handleSystemInfo))
	mux.Handle("GET /api/system/stats", s.protected(s.handleSystemStats))
	mux.Handle("GET /api/system/metrics", s.protected(s.handleSystemMetrics))
	mux.Handle("GET /api/system/events", s.protected(s.handleSystemEvents))
	mux.Handle("GET /api/system/settings", s.protected(s.handleGetSettings))
	mux.Handle("PUT /api/system/settings", s.protected(s.handlePutSettings))
	mux.Handle("GET /api/system/certificates", s.protected(s.handleListCertificates))
	mux.Handle("GET /api/system/audit", s.protected(s.handleAudit))
	mux.Handle("POST /api/system/backup", s.protected(s.handleBackup))
	mux.Handle("GET /api/system/backups", s.protected(s.handleListBackups))
	mux.Handle("PUT /api/system/version", s.protected(s.handlePutVersionSettings))
	mux.Handle("POST /api/system/update", s.protected(s.handleUpdate))

	return s.recoverPanics(s.requestLogger(mux))
}

// protected requires authentication and, for cookie sessions, that the request
// came from the dashboard itself.
func (s *Server) protected(h http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, viaCookie, err := s.Auth.Authenticate(r)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Authentication required", nil)
			return
		}
		// A cookie is attached by the browser to cross-site requests too, so
		// mutations must prove they originate from the panel. Bearer tokens are
		// never sent automatically and need no such check.
		if viaCookie && isMutation(r.Method) && !auth.SameOrigin(r) {
			// A rejected mutation from an authenticated session is worth more in
			// the audit log than a successful one.
			s.audit(r, user, http.StatusForbidden, viaCookie)
			writeError(w, http.StatusForbidden, "CROSS_ORIGIN", "Cross-origin request rejected", nil)
			return
		}

		if !isMutation(r.Method) {
			h(w, r.WithContext(auth.WithUser(r.Context(), user)))
			return
		}
		// Every state-changing call is recorded, whoever made it and however
		// they authenticated.
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		h(rec, r.WithContext(auth.WithUser(r.Context(), user)))
		s.audit(r, user, rec.status, viaCookie)
	})
}

// clientIP identifies the caller for audit entries, honouring the header Nginx
// sets.
func clientIP(r *http.Request) string {
	if forwarded := r.Header.Get("X-Real-IP"); forwarded != "" {
		return forwarded
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// audit records a mutation. A failed write is logged and swallowed: losing an
// audit line must never turn a successful action into an error for the user.
func (s *Server) audit(r *http.Request, user *auth.User, status int, viaCookie bool) {
	credential := "api-token"
	if viaCookie {
		credential = "session"
	}
	actor := "unknown"
	if user != nil && user.Email != "" {
		actor = user.Email
	}
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), 5*time.Second)
	defer cancel()
	if err := s.DB.RecordAudit(ctx, database.AuditEntry{
		Actor:      actor,
		Method:     r.Method,
		Path:       r.URL.Path,
		Status:     status,
		ClientIP:   clientIP(r),
		Credential: credential,
	}); err != nil {
		s.Log.Warn("audit write failed", "path", r.URL.Path, "error", err)
	}
}

func isMutation(method string) bool {
	switch method {
	case http.MethodGet, http.MethodHead, http.MethodOptions:
		return false
	default:
		return true
	}
}

// requestLogger emits one structured line per request with a request id.
func (s *Server) requestLogger(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		requestID := security.RandomToken(8)
		w.Header().Set("X-Request-Id", requestID)
		rec := &statusRecorder{ResponseWriter: w, status: http.StatusOK}
		next.ServeHTTP(rec, r)
		s.Log.Info("request",
			"request_id", requestID,
			"method", r.Method,
			"path", r.URL.Path,
			"status", rec.status,
			"duration_ms", time.Since(start).Milliseconds(),
		)
	})
}

// recoverPanics keeps one bad handler from taking the manager down.
func (s *Server) recoverPanics(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		defer func() {
			if rec := recover(); rec != nil {
				s.Log.Error("panic recovered", "path", r.URL.Path, "panic", rec)
				writeError(w, http.StatusInternalServerError, "INTERNAL", "Internal server error", nil)
			}
		}()
		next.ServeHTTP(w, r)
	})
}

type statusRecorder struct {
	http.ResponseWriter
	status  int
	written bool
}

func (r *statusRecorder) WriteHeader(code int) {
	if !r.written {
		r.status = code
		r.written = true
	}
	r.ResponseWriter.WriteHeader(code)
}

// Flush, Hijack and Unwrap pass through so SSE streams and the WebSocket
// terminal keep working behind the logging wrapper. Without these a handler's
// `w.(http.Flusher)` assertion would fail against the wrapper.
func (r *statusRecorder) Unwrap() http.ResponseWriter { return r.ResponseWriter }

func (r *statusRecorder) Flush() {
	if flusher, ok := r.ResponseWriter.(http.Flusher); ok {
		flusher.Flush()
	}
}

func (r *statusRecorder) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	hijacker, ok := r.ResponseWriter.(http.Hijacker)
	if !ok {
		return nil, nil, errors.New("connection does not support hijacking")
	}
	return hijacker.Hijack()
}
