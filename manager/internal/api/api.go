// Package api is the REST API. Nginx is the only thing in front of
// it; the manager itself never listens on a public interface.
package api

import (
	"bufio"
	"context"
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
	"github.com/vexdock/platform/manager/internal/schedule"
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
	Tasks       *schedule.Runner
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

// Handler builds the router. The three routes registered straight on the mux
// are public; the rest go through signedIn, admin or project (access.go) and need a
// session cookie or a bearer API token.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()

	mux.HandleFunc("GET /api/health", s.handleHealth)
	mux.HandleFunc("GET /api/system/version", s.handleVersion)
	// One deploy endpoint per provider, because each signs its payload its own
	// way and names the repository in its own shape.
	mux.HandleFunc("POST /api/deploy/{provider}", s.handleProviderWebhook)

	mux.Handle("GET /api/me", s.signedIn(s.handleMe))

	mux.Handle("GET /api/projects", s.signedIn(s.handleListProjects))
	mux.Handle("POST /api/projects", s.admin(s.handleCreateProject))
	mux.Handle("GET /api/projects/{id}", s.project(database.AccessRead, projectByPath, s.handleGetProject))
	mux.Handle("PATCH /api/projects/{id}", s.project(database.AccessWrite, projectByPath, s.handleUpdateProject))
	mux.Handle("DELETE /api/projects/{id}", s.admin(s.handleDeleteProject))
	mux.Handle("POST /api/projects/{id}/deploy", s.project(database.AccessWrite, projectByPath, s.handleDeploy))
	mux.Handle("POST /api/projects/{id}/redeploy", s.project(database.AccessWrite, projectByPath, s.handleDeploy))
	mux.Handle("POST /api/projects/{id}/stop", s.project(database.AccessWrite, projectByPath, s.handleStopProject))
	mux.Handle("GET /api/projects/{id}/variables", s.project(database.AccessWrite, projectByPath, s.handleGetProjectVariables))
	mux.Handle("PUT /api/projects/{id}/variables", s.project(database.AccessWrite, projectByPath, s.handlePutProjectVariables))
	mux.Handle("GET /api/projects/{id}/environments", s.project(database.AccessRead, projectByPath, s.handleListEnvironments))
	mux.Handle("POST /api/projects/{id}/environments", s.project(database.AccessWrite, projectByPath, s.handleCreateEnvironment))
	mux.Handle("GET /api/projects/{id}/services", s.project(database.AccessRead, projectByPath, s.handleListServices))
	mux.Handle("POST /api/projects/{id}/services", s.project(database.AccessWrite, projectByPath, s.handleCreateService))
	mux.Handle("POST /api/projects/{id}/services/template", s.project(database.AccessWrite, projectByPath, s.handleCreateFromTemplate))
	mux.Handle("GET /api/projects/{id}/services/export", s.project(database.AccessWrite, projectByPath, s.handleExportServices))
	mux.Handle("GET /api/projects/{id}/deployments", s.project(database.AccessRead, projectByPath, s.handleListDeployments))
	mux.Handle("GET /api/projects/{id}/domains", s.project(database.AccessRead, projectByPath, s.handleListProjectDomains))

	mux.Handle("GET /api/services/{id}", s.project(database.AccessRead, projectOfService, s.handleGetService))
	mux.Handle("PATCH /api/services/{id}", s.project(database.AccessWrite, projectOfService, s.handleUpdateService))
	mux.Handle("DELETE /api/services/{id}", s.project(database.AccessWrite, projectOfService, s.handleDeleteService))
	mux.Handle("POST /api/services/{id}/duplicate", s.project(database.AccessWrite, projectOfService, s.handleDuplicateService))
	mux.Handle("POST /api/services/{id}/move", s.project(database.AccessWrite, projectOfService, s.handleMoveService))
	mux.Handle("GET /api/services/{id}/database", s.project(database.AccessWrite, projectOfService, s.handleServiceDatabase))
	mux.Handle("GET /api/services/{id}/studio", s.project(database.AccessWrite, projectOfService, s.handleStudioSchema))
	mux.Handle("GET /api/services/{id}/studio/rows", s.project(database.AccessWrite, projectOfService, s.handleStudioRows))
	mux.Handle("POST /api/services/{id}/studio/changes", s.project(database.AccessWrite, projectOfService, s.handleStudioChanges))
	mux.Handle("POST /api/services/{id}/studio/query", s.project(database.AccessWrite, projectOfService, s.handleStudioQuery))
	mux.Handle("GET /api/services/{id}/variables", s.project(database.AccessWrite, projectOfService, s.handleGetServiceEnvironment))
	mux.Handle("PUT /api/services/{id}/variables", s.project(database.AccessWrite, projectOfService, s.handlePutServiceEnvironment))
	mux.Handle("POST /api/services/{id}/deploy", s.project(database.AccessWrite, projectOfService, s.handleDeployService))
	mux.Handle("POST /api/services/{id}/start", s.project(database.AccessWrite, projectOfService, s.handleServiceAction))
	mux.Handle("POST /api/services/{id}/stop", s.project(database.AccessWrite, projectOfService, s.handleServiceAction))
	mux.Handle("POST /api/services/{id}/restart", s.project(database.AccessWrite, projectOfService, s.handleServiceAction))
	mux.Handle("GET /api/services/{id}/logs", s.project(database.AccessRead, projectOfService, s.handleServiceLogs))
	mux.Handle("GET /api/services/{id}/stats", s.project(database.AccessRead, projectOfService, s.handleServiceStats))
	mux.Handle("GET /api/services/{id}/metrics", s.project(database.AccessRead, projectOfService, s.handleServiceMetrics))
	mux.Handle("GET /api/services/{id}/terminal", s.project(database.AccessWrite, projectOfService, s.handleTerminal))
	mux.Handle("POST /api/services/{id}/exec", s.project(database.AccessWrite, projectOfService, s.handleExec))
	mux.Handle("GET /api/services/{id}/tasks", s.project(database.AccessRead, projectOfService, s.handleListServiceTasks))
	mux.Handle("POST /api/services/{id}/tasks", s.project(database.AccessWrite, projectOfService, s.handleCreateServiceTask))
	mux.Handle("GET /api/services/{id}/redirects", s.project(database.AccessRead, projectOfService, s.handleListServiceRedirects))
	mux.Handle("POST /api/services/{id}/redirects", s.project(database.AccessWrite, projectOfService, s.handleCreateServiceRedirect))
	mux.Handle("DELETE /api/services/{id}/redirects/{redirectId}", s.project(database.AccessWrite, projectOfService, s.handleDeleteServiceRedirect))
	mux.Handle("GET /api/services/{id}/basic-auth", s.project(database.AccessWrite, projectOfService, s.handleListServiceBasicAuth))
	mux.Handle("POST /api/services/{id}/basic-auth", s.project(database.AccessWrite, projectOfService, s.handleCreateServiceBasicAuth))
	mux.Handle("DELETE /api/services/{id}/basic-auth/{userId}", s.project(database.AccessWrite, projectOfService, s.handleDeleteServiceBasicAuth))
	mux.Handle("GET /api/services/{id}/ports", s.project(database.AccessRead, projectOfService, s.handleListServicePorts))
	mux.Handle("POST /api/services/{id}/ports", s.project(database.AccessWrite, projectOfService, s.handleCreateServicePort))
	mux.Handle("DELETE /api/services/{id}/ports/{portId}", s.project(database.AccessWrite, projectOfService, s.handleDeleteServicePort))

	mux.Handle("GET /api/tasks", s.signedIn(s.handleListAllTasks))
	mux.Handle("PATCH /api/tasks/{id}", s.project(database.AccessWrite, projectOfTask, s.handleUpdateTask))
	mux.Handle("DELETE /api/tasks/{id}", s.project(database.AccessWrite, projectOfTask, s.handleDeleteTask))
	mux.Handle("POST /api/tasks/{id}/run", s.project(database.AccessWrite, projectOfTask, s.handleRunTask))
	mux.Handle("GET /api/tasks/{id}/runs", s.project(database.AccessRead, projectOfTask, s.handleTaskRuns))

	mux.Handle("GET /api/environments/{id}", s.project(database.AccessRead, projectOfEnvironment, s.handleGetEnvironment))
	mux.Handle("PATCH /api/environments/{id}", s.project(database.AccessWrite, projectOfEnvironment, s.handleUpdateEnvironment))
	mux.Handle("DELETE /api/environments/{id}", s.project(database.AccessWrite, projectOfEnvironment, s.handleDeleteEnvironment))
	mux.Handle("GET /api/environments/{id}/variables", s.project(database.AccessWrite, projectOfEnvironment, s.handleGetEnvironmentVariables))
	mux.Handle("PUT /api/environments/{id}/variables", s.project(database.AccessWrite, projectOfEnvironment, s.handlePutEnvironmentVariables))

	mux.Handle("GET /api/domains", s.signedIn(s.handleListDomains))
	mux.Handle("POST /api/domains", s.project(database.AccessWrite, projectInBody, s.handleCreateDomain))
	mux.Handle("PATCH /api/domains/{id}", s.project(database.AccessWrite, projectOfDomain, s.handleUpdateDomain))
	mux.Handle("DELETE /api/domains/{id}", s.project(database.AccessWrite, projectOfDomain, s.handleDeleteDomain))
	mux.Handle("POST /api/domains/{id}/certificate", s.project(database.AccessWrite, projectOfDomain, s.handleIssueCertificate))

	mux.Handle("GET /api/deployments/{id}", s.project(database.AccessRead, projectOfDeployment, s.handleGetDeployment))
	mux.Handle("GET /api/deployments/{id}/events", s.project(database.AccessRead, projectOfDeployment, s.handleDeploymentEvents))
	mux.Handle("POST /api/deployments/{id}/cancel", s.project(database.AccessWrite, projectOfDeployment, s.handleCancelDeployment))
	mux.Handle("POST /api/deployments/{id}/rollback", s.project(database.AccessWrite, projectOfDeployment, s.handleRollback))

	mux.Handle("GET /api/docker/containers", s.admin(s.handleListContainers))
	mux.Handle("POST /api/docker/containers/{id}/{action}", s.admin(s.handleContainerAction))
	mux.Handle("GET /api/docker/containers/{id}/logs", s.admin(s.handleContainerLogs))
	mux.Handle("GET /api/docker/images", s.admin(s.handleListImages))
	mux.Handle("POST /api/docker/images/pull", s.admin(s.handlePullImage))
	mux.Handle("DELETE /api/docker/images/{id}", s.admin(s.handleRemoveImage))
	mux.Handle("GET /api/docker/volumes", s.admin(s.handleListVolumes))
	mux.Handle("DELETE /api/docker/volumes/{name}", s.admin(s.handleRemoveVolume))
	mux.Handle("GET /api/docker/networks", s.admin(s.handleListNetworks))
	mux.Handle("GET /api/docker/cleanup", s.admin(s.handleCleanupPreview))
	mux.Handle("POST /api/docker/cleanup/{kind}", s.admin(s.handleCleanup))

	mux.Handle("GET /api/registries", s.admin(s.handleListRegistries))
	mux.Handle("POST /api/registries", s.admin(s.handleCreateRegistry))
	mux.Handle("DELETE /api/registries/{id}", s.admin(s.handleDeleteRegistry))

	mux.Handle("GET /api/git-providers", s.admin(s.handleListGitProviders))
	mux.Handle("GET /api/git-providers/{id}", s.admin(s.handleGetGitProvider))
	mux.Handle("PATCH /api/git-providers/{id}", s.admin(s.handleRenameGitProvider))
	mux.Handle("DELETE /api/git-providers/{id}", s.admin(s.handleDeleteGitProvider))
	mux.Handle("GET /api/git-providers/{id}/repositories", s.admin(s.handleGitProviderRepositories))
	mux.Handle("GET /api/git-providers/{id}/branches", s.admin(s.handleGitProviderBranches))
	// Creating and re-registering a connection. The same handler serves both,
	// because re-entering an app's credentials is the fix for a revoked grant.
	mux.Handle("POST /api/git-providers/github", s.admin(s.handleCreateGitHubProvider))
	mux.Handle("POST /api/git-providers/gitlab", s.admin(s.handleSaveGitLabProvider))
	mux.Handle("PUT /api/git-providers/{id}/gitlab", s.admin(s.handleSaveGitLabProvider))
	mux.Handle("POST /api/git-providers/bitbucket", s.admin(s.handleSaveBitbucketProvider))
	mux.Handle("PUT /api/git-providers/{id}/bitbucket", s.admin(s.handleSaveBitbucketProvider))
	mux.Handle("POST /api/git-providers/gitea", s.admin(s.handleSaveGiteaProvider))
	mux.Handle("PUT /api/git-providers/{id}/gitea", s.admin(s.handleSaveGiteaProvider))
	// Where the hosts return once the owner has approved. These are reached by
	// top-level navigation from the provider, so they carry the session cookie
	// and answer with a redirect rather than JSON.
	mux.Handle("GET /api/providers/github/callback", s.admin(s.handleGitHubCallback))
	mux.Handle("GET /api/providers/github/installed", s.admin(s.handleGitHubInstalled))
	mux.Handle("GET /api/providers/{provider}/callback", s.admin(s.handleOAuthCallback))

	mux.Handle("GET /api/tokens", s.admin(s.handleListTokens))
	mux.Handle("POST /api/tokens", s.admin(s.handleCreateToken))
	mux.Handle("DELETE /api/tokens/{id}", s.admin(s.handleDeleteToken))

	mux.Handle("GET /api/templates", s.signedIn(s.handleListTemplates))

	mux.Handle("GET /api/engines", s.signedIn(s.handleListEngines))
	mux.Handle("GET /api/engines/{slug}/versions", s.signedIn(s.handleEngineVersions))

	mux.Handle("GET /api/system/info", s.admin(s.handleSystemInfo))
	mux.Handle("GET /api/system/stats", s.admin(s.handleSystemStats))
	mux.Handle("GET /api/system/metrics", s.admin(s.handleSystemMetrics))
	mux.Handle("GET /api/system/events", s.admin(s.handleSystemEvents))
	mux.Handle("GET /api/system/settings", s.admin(s.handleGetSettings))
	mux.Handle("PUT /api/system/settings", s.admin(s.handlePutSettings))
	mux.Handle("GET /api/system/certificates", s.admin(s.handleListCertificates))
	mux.Handle("POST /api/system/backup", s.admin(s.handleBackup))
	mux.Handle("GET /api/system/backups", s.admin(s.handleListBackups))
	mux.Handle("DELETE /api/system/backups/{name}", s.admin(s.handleDeleteBackup))
	mux.Handle("PUT /api/system/version", s.admin(s.handlePutVersionSettings))
	mux.Handle("POST /api/system/version/check", s.admin(s.handleVersionCheck))
	mux.Handle("POST /api/system/update", s.admin(s.handleUpdate))
	mux.Handle("GET /api/system/update/status", s.admin(s.handleUpdateStatus))

	return s.recoverPanics(s.requestLogger(mux))
}

// authenticated requires authentication and, for cookie sessions, that the request
// came from the dashboard itself.
func (s *Server) authenticated(h http.HandlerFunc) http.Handler {
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

		if !isMutation(r.Method) && !writesCredentials(r.URL.Path) {
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

// actor names the authenticated caller for a deployment record, or "" when
// the request carried no user.
func actor(ctx context.Context) string {
	if user, ok := auth.UserFrom(ctx); ok {
		return user.Email
	}
	return ""
}

// audit records a mutation. A failed write is logged and swallowed: losing an
// audit line must never turn a successful action into an error for the user.
func (s *Server) audit(r *http.Request, user *auth.User, status int, viaCookie bool) {
	credential := "api-token"
	if viaCookie {
		credential = "session"
	}
	actor := "unknown"
	if user.Email != "" {
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

// writesCredentials names the GET endpoints that store a git provider's access
// token when the host redirects the owner back. They change state, so they are
// audited like a mutation; the cross-origin check stays off them because the
// redirect legitimately arrives from the provider.
func writesCredentials(path string) bool {
	return strings.HasSuffix(path, "/callback") || path == "/api/providers/github/installed"
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
