// Package api exposes the REST surface. Nginx is the only thing in front of
// it; the manager itself never listens on a public interface.
package api

import (
	"bufio"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
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

// Server wires every subsystem into one HTTP handler.
type Server struct {
	cfg         *config.Config
	db          *database.DB
	auth        *auth.Service
	projects    *projects.Service
	domains     *domains.Service
	deployments *deployments.Engine
	docker      *docker.Client
	nginx       *nginx.Manager
	certs       *certificates.Issuer
	bus         *events.Bus
	updater     *updater.Service
	backups     *backup.Service
	cipher      *security.Cipher
	log         *slog.Logger
}

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

func New(d Deps) *Server {
	return &Server{
		cfg: d.Config, db: d.DB, auth: d.Auth, projects: d.Projects, domains: d.Domains,
		deployments: d.Deployments, docker: d.Docker, nginx: d.Nginx, certs: d.Certs,
		bus: d.Bus, updater: d.Updater, backups: d.Backups, cipher: d.Cipher, log: d.Log,
	}
}

// Handler builds the router. Public routes are listed explicitly; everything
// else requires a session cookie or a bearer API token.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	// Public.
	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("GET /api/system/version", s.handleVersion)
	mux.HandleFunc("GET /api/auth/status", s.handleAuthStatus)
	mux.HandleFunc("POST /api/auth/setup", s.handleSetup)
	mux.HandleFunc("POST /api/auth/login", s.handleLogin)
	mux.HandleFunc("POST /api/webhooks/projects/{token}", s.handleWebhook)
	mux.HandleFunc("GET /api/openapi.json", s.handleOpenAPI)

	// Authenticated.
	mux.Handle("POST /api/auth/logout", s.protected(s.handleLogout))
	mux.Handle("GET /api/auth/me", s.protected(s.handleMe))

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
	mux.Handle("GET /api/projects/{id}/environment", s.protected(s.handleGetEnvironment))
	mux.Handle("PUT /api/projects/{id}/environment", s.protected(s.handlePutEnvironment))
	mux.Handle("GET /api/projects/{id}/services", s.protected(s.handleListServices))
	mux.Handle("GET /api/projects/{id}/deployments", s.protected(s.handleListDeployments))
	mux.Handle("GET /api/projects/{id}/domains", s.protected(s.handleListProjectDomains))

	mux.Handle("GET /api/services/{id}", s.protected(s.handleGetService))
	mux.Handle("POST /api/services/{id}/start", s.protected(s.handleServiceAction))
	mux.Handle("POST /api/services/{id}/stop", s.protected(s.handleServiceAction))
	mux.Handle("POST /api/services/{id}/restart", s.protected(s.handleServiceAction))
	mux.Handle("GET /api/services/{id}/logs", s.protected(s.handleServiceLogs))
	mux.Handle("GET /api/services/{id}/stats", s.protected(s.handleServiceStats))
	mux.Handle("GET /api/services/{id}/terminal", s.protected(s.handleTerminal))

	mux.Handle("GET /api/domains", s.protected(s.handleListDomains))
	mux.Handle("POST /api/domains", s.protected(s.handleCreateDomain))
	mux.Handle("PATCH /api/domains/{id}", s.protected(s.handleUpdateDomain))
	mux.Handle("DELETE /api/domains/{id}", s.protected(s.handleDeleteDomain))
	mux.Handle("POST /api/domains/{id}/certificate", s.protected(s.handleIssueCertificate))

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

	mux.Handle("GET /api/templates", s.protected(s.handleListTemplates))

	mux.Handle("GET /api/system/info", s.protected(s.handleSystemInfo))
	mux.Handle("GET /api/system/stats", s.protected(s.handleSystemStats))
	mux.Handle("GET /api/system/events", s.protected(s.handleSystemEvents))
	mux.Handle("GET /api/system/settings", s.protected(s.handleGetSettings))
	mux.Handle("PUT /api/system/settings", s.protected(s.handlePutSettings))
	mux.Handle("GET /api/system/certificates", s.protected(s.handleListCertificates))
	mux.Handle("POST /api/system/backup", s.protected(s.handleBackup))
	mux.Handle("GET /api/system/backups", s.protected(s.handleListBackups))
	mux.Handle("POST /api/system/update", s.protected(s.handleUpdate))

	return s.recoverPanics(s.requestLogger(mux))
}

// protected requires authentication and, for mutations, a valid CSRF token.
func (s *Server) protected(h http.HandlerFunc) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, session, err := s.authenticate(r)
		if err != nil {
			writeError(w, http.StatusUnauthorized, "UNAUTHORIZED", "Authentication required", nil)
			return
		}
		// Cookie sessions need CSRF protection; bearer tokens are not sent
		// automatically by browsers and therefore do not.
		if session != nil && isMutation(r.Method) {
			if !security.ConstantTimeEqual(r.Header.Get(auth.CSRFHeader), session.CSRFToken) {
				writeError(w, http.StatusForbidden, "CSRF_INVALID", "Missing or invalid CSRF token", nil)
				return
			}
		}
		h(w, r.WithContext(auth.WithUser(r.Context(), user, session)))
	})
}

// authenticate accepts either the session cookie or a bearer API token.
func (s *Server) authenticate(r *http.Request) (*database.User, *database.Session, error) {
	if header := r.Header.Get("Authorization"); strings.HasPrefix(header, "Bearer ") {
		token := strings.TrimSpace(strings.TrimPrefix(header, "Bearer "))
		user, err := s.db.UserByAPIToken(r.Context(), security.HashToken(token))
		if err != nil {
			return nil, nil, err
		}
		return user, nil, nil
	}
	return s.auth.Authenticate(r)
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
		s.log.Info("request",
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
				s.log.Error("panic recovered", "path", r.URL.Path, "panic", rec)
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
