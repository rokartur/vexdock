package api

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"time"

	"github.com/vexdock/platform/manager/internal/auth"
	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/deployments"
	"github.com/vexdock/platform/manager/internal/docker"
	"github.com/vexdock/platform/manager/internal/metrics"
	"github.com/vexdock/platform/manager/internal/projects"
)

// projectView enriches the stored project with live state for the UI.
type projectView struct {
	database.Project
	// Environments ships with the project so the dashboard's picker does not
	// need a second request per card.
	Environments []database.Environment `json:"environments"`
	ServiceCount int                    `json:"service_count"`
	RunningCount int                    `json:"running_count"`
	// ErroredCount is containers Docker gave up on or keeps restarting. What is
	// neither running nor errored is idle: created, paused, or never deployed.
	ErroredCount int `json:"errored_count"`
	// DatabaseCount and ComposeCount split ServiceCount by what the service is:
	// a curated database image, a service the project's own compose file
	// declares, and by subtraction the applications vexdock builds or pulls.
	DatabaseCount    int                  `json:"database_count"`
	ComposeCount     int                  `json:"compose_count"`
	Domains          []database.Domain    `json:"domains"`
	LatestDeployment *database.Deployment `json:"latest_deployment"`
	WebhookURL       string               `json:"webhook_url"`
	// WebhookSecretSet reports whether HMAC verification is on; the secret
	// itself is never returned.
	WebhookSecretSet bool `json:"webhook_secret_set"`
}

func (s *Server) handleListProjects(w http.ResponseWriter, r *http.Request) {
	list, err := s.DB.ListProjects(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	out := make([]projectView, 0, len(list))
	for i := range list {
		view, err := s.projectView(r.Context(), &list[i])
		if err != nil {
			serverError(w, err)
			return
		}
		out = append(out, *view)
	}
	writeJSON(w, http.StatusOK, out)
}

// projectView is the card on the projects list, so it counts across every
// environment: a project with a running staging is not a stopped project.
func (s *Server) projectView(ctx context.Context, p *database.Project) (*projectView, error) {
	services, err := s.DB.ListProjectServices(ctx, p.ID)
	if err != nil {
		return nil, err
	}
	domainList, err := s.DB.ListProjectDomains(ctx, p.ID)
	if err != nil {
		return nil, err
	}
	envs, err := s.DB.ListEnvironments(ctx, p.ID)
	if err != nil {
		return nil, err
	}
	view := &projectView{
		Project:          *p,
		Environments:     envs,
		ServiceCount:     len(services),
		Domains:          domainList,
		WebhookURL:       s.Projects.WebhookURL(p),
		WebhookSecretSet: s.setting(ctx, webhookSecretKey(p.ID)) != "",
	}
	for _, svc := range services {
		switch {
		case svc.Type == database.ServiceDatabase:
			view.DatabaseCount++
		case svc.SourceType == database.ServiceCompose || svc.SourceType == database.ServiceDerived:
			view.ComposeCount++
		}
	}
	for _, env := range envs {
		containers, err := s.Docker.ListContainers(ctx, env.ComposeProjectName)
		if err != nil {
			continue
		}
		for _, c := range containers {
			switch c.State {
			case "running":
				view.RunningCount++
			case "exited", "dead", "restarting":
				view.ErroredCount++
			}
		}
	}
	if recent, err := s.DB.ListProjectDeployments(ctx, p.ID, 1); err == nil && len(recent) > 0 {
		view.LatestDeployment = &recent[0]
	}
	return view, nil
}

type createProjectRequest struct {
	Name             string   `json:"name"`
	SourceType       string   `json:"source_type"`
	RepositoryURL    string   `json:"repository_url"`
	Branch           string   `json:"branch"`
	ComposePath      string   `json:"compose_path"`
	ComposeContent   string   `json:"compose_content"`
	AutoDeploy       bool     `json:"auto_deploy"`
	Tags             []string `json:"tags"`
	CredentialKind   string   `json:"credential_kind"`
	CredentialSecret string   `json:"credential_secret"`
}

func (s *Server) handleCreateProject(w http.ResponseWriter, r *http.Request) {
	var req createProjectRequest
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	project, err := s.Projects.Create(r.Context(), projects.CreateInput{
		Name:             req.Name,
		SourceType:       req.SourceType,
		RepositoryURL:    req.RepositoryURL,
		Branch:           req.Branch,
		ComposePath:      req.ComposePath,
		ComposeContent:   req.ComposeContent,
		AutoDeploy:       req.AutoDeploy,
		Tags:             req.Tags,
		CredentialKind:   req.CredentialKind,
		CredentialSecret: req.CredentialSecret,
	})
	if err != nil {
		badRequest(w, err)
		return
	}
	view, err := s.projectView(r.Context(), project)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, view)
}

func (s *Server) handleGetProject(w http.ResponseWriter, r *http.Request) {
	project, err := s.DB.ProjectByID(r.Context(), r.PathValue("id"))
	if handleLookupError(w, err) {
		return
	}
	view, err := s.projectView(r.Context(), project)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

func (s *Server) handleUpdateProject(w http.ResponseWriter, r *http.Request) {
	project, err := s.DB.ProjectByID(r.Context(), r.PathValue("id"))
	if handleLookupError(w, err) {
		return
	}
	var req struct {
		Name             *string   `json:"name"`
		SourceType       *string   `json:"source_type"`
		Branch           *string   `json:"branch"`
		ComposePath      *string   `json:"compose_path"`
		RepositoryURL    *string   `json:"repository_url"`
		AutoDeploy       *bool     `json:"auto_deploy"`
		Tags             *[]string `json:"tags"`
		CredentialKind   *string   `json:"credential_kind"`
		CredentialSecret *string   `json:"credential_secret"`
		// WebhookSecret enables HMAC verification of incoming webhooks.
		// An empty string turns verification off again.
		WebhookSecret *string `json:"webhook_secret"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	previousSource := project.SourceType
	if req.Name != nil {
		project.Name = *req.Name
		project.Slug = projects.Slugify(*req.Name)
	}
	if req.SourceType != nil && *req.SourceType != project.SourceType {
		project.SourceType = *req.SourceType
	}
	if req.Branch != nil {
		project.Branch = *req.Branch
	}
	if req.ComposePath != nil {
		project.ComposePath = *req.ComposePath
	}
	if req.RepositoryURL != nil {
		project.RepositoryURL = *req.RepositoryURL
	}
	if req.Tags != nil {
		project.Tags = *req.Tags
	}
	if req.AutoDeploy != nil {
		project.AutoDeploy = *req.AutoDeploy
	}
	if err := s.Projects.Validate(project); err != nil {
		badRequest(w, err)
		return
	}
	// Only once the new source validates, so a rejected switch leaves the
	// current checkout untouched.
	if project.SourceType != previousSource {
		if err := s.Projects.ResetCheckout(r.Context(), project); err != nil {
			serverError(w, err)
			return
		}
	}
	if req.WebhookSecret != nil {
		// Trimming makes a whitespace-only value mean "turn verification off",
		// which is the only way to clear it from a password field.
		secret := strings.TrimSpace(*req.WebhookSecret)
		if err := s.DB.SetSetting(r.Context(), webhookSecretKey(project.ID), secret); err != nil {
			serverError(w, err)
			return
		}
	}
	if req.CredentialKind != nil {
		secret := ""
		if req.CredentialSecret != nil {
			secret = *req.CredentialSecret
		}
		if err := s.Projects.SetCredential(r.Context(), project, *req.CredentialKind, secret); err != nil {
			badRequest(w, err)
			return
		}
	} else if err := s.DB.UpdateProject(r.Context(), project); err != nil {
		serverError(w, err)
		return
	}
	view, err := s.projectView(r.Context(), project)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, view)
}

// handleDeleteProject tears every environment's stack down before removing any
// record of it. Missing one would leave containers running under a namespace
// nothing points at any more.
func (s *Server) handleDeleteProject(w http.ResponseWriter, r *http.Request) {
	project, err := s.DB.ProjectByID(r.Context(), r.PathValue("id"))
	if handleLookupError(w, err) {
		return
	}
	envs, err := s.DB.ListEnvironments(r.Context(), project.ID)
	if err != nil {
		serverError(w, err)
		return
	}
	removeVolumes := r.URL.Query().Get("volumes") == "true"
	for i := range envs {
		env := &envs[i]
		if composeProject, err := s.Projects.ComposeProject(r.Context(), project, env); err == nil {
			if err := composeProject.Down(r.Context(), logWriter{s.Log}, removeVolumes); err != nil {
				s.Log.Warn("compose down during delete", "environment", env.ID, "error", err)
			}
		}
	}
	if err := s.DB.DeleteProject(r.Context(), project.ID); err != nil {
		serverError(w, err)
		return
	}
	for i := range envs {
		if err := s.Projects.RemoveDirectory(envs[i].ID); err != nil {
			s.Log.Warn("remove environment directory", "environment", envs[i].ID, "error", err)
		}
	}
	if err := s.Domains.Reconcile(r.Context()); err != nil {
		s.Log.Warn("reconcile after project delete", "error", err)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleDeploy(w http.ResponseWriter, r *http.Request) {
	project, env, ok := s.projectEnv(w, r)
	if !ok {
		return
	}
	user, _ := auth.UserFrom(r.Context())
	actor := ""
	if user != nil {
		actor = user.Email
	}
	deployment, err := s.Deployments.Trigger(r.Context(), project, env, deployments.Options{
		Trigger: deployments.TriggerManual,
		Actor:   actor,
	})
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, deployment)
}

// handleStopProject stops the stack without deleting anything.
func (s *Server) handleStopProject(w http.ResponseWriter, r *http.Request) {
	project, env, ok := s.projectEnv(w, r)
	if !ok {
		return
	}
	composeProject, err := s.Projects.ComposeProject(r.Context(), project, env)
	if err != nil {
		badRequest(w, err)
		return
	}
	if err := composeProject.Down(r.Context(), logWriter{s.Log}, false); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleExportServices hands back the project's managed services as a base64
// blob for another project's import. Secret values are withheld unless
// ?secrets=true is asked for explicitly, because the blob is only encoded, not
// encrypted, and it leaves here to end up on a clipboard.
func (s *Server) handleExportServices(w http.ResponseWriter, r *http.Request) {
	project, env, ok := s.projectEnv(w, r)
	if !ok {
		return
	}
	secrets := r.URL.Query().Get("secrets") == "true"
	payload, err := s.Projects.ExportServices(r.Context(), project, env, secrets)
	if err != nil {
		serverError(w, err)
		return
	}
	if secrets {
		// The one read that hands over plaintext secrets, so it is recorded like
		// a mutation. protected() audits writes only, and a stolen token draining
		// a project this way would otherwise leave no trace in the panel.
		user, _ := auth.UserFrom(r.Context())
		s.audit(r, user, http.StatusOK, auth.ViaCookie(r))
		s.Log.Warn("exported services with secret values", "project", project.Name)
	}
	writeJSON(w, http.StatusOK, map[string]any{"payload": payload, "secrets": secrets})
}

func (s *Server) handleGetCompose(w http.ResponseWriter, r *http.Request) {
	project, env, ok := s.projectEnv(w, r)
	if !ok {
		return
	}
	content, err := s.Projects.ReadComposeFile(project, env)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"content": content, "path": project.ComposePath})
}

// handlePutCompose only applies to projects whose source is a pasted compose
// file; a git-backed file would be overwritten by the next deployment.
func (s *Server) handlePutCompose(w http.ResponseWriter, r *http.Request) {
	project, env, ok := s.projectEnv(w, r)
	if !ok {
		return
	}
	if project.SourceType != database.SourceCompose {
		badRequest(w, errors.New("this project's compose file comes from git and is not editable here"))
		return
	}
	var req struct {
		Content string `json:"content"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	if err := s.Projects.WriteComposeFile(project, env, req.Content); err != nil {
		badRequest(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleGetProjectVariables returns the set shared by every environment.
// Unmasked: this is the editor, and handing the value over is the point.
func (s *Server) handleGetProjectVariables(w http.ResponseWriter, r *http.Request) {
	vars, err := s.Projects.ProjectVariables(r.Context(), r.PathValue("id"))
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, vars)
}

func (s *Server) handlePutProjectVariables(w http.ResponseWriter, r *http.Request) {
	project, err := s.DB.ProjectByID(r.Context(), r.PathValue("id"))
	if handleLookupError(w, err) {
		return
	}
	var req struct {
		Variables []projects.EnvVar `json:"variables"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	if err := s.Projects.SetProjectVariables(r.Context(), project.ID, req.Variables); err != nil {
		badRequest(w, err)
		return
	}
	// A shared variable changes what every environment's containers see, so
	// every .env has to be rewritten, not just the one the request came from.
	envs, err := s.DB.ListEnvironments(r.Context(), project.ID)
	if err != nil {
		serverError(w, err)
		return
	}
	for i := range envs {
		if _, err := s.Projects.WriteEnvFile(r.Context(), project, &envs[i]); err != nil {
			serverError(w, err)
			return
		}
	}
	vars, err := s.Projects.ProjectVariables(r.Context(), project.ID)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, vars)
}

// serviceView combines the stored service with its current container.
type serviceView struct {
	database.Service
	ContainerID string `json:"container_id"`
	State       string `json:"state"`
	Status      string `json:"status"`
	// RunningImage is what the container was actually started from, which drifts
	// from the service's configured image between an edit and the next deploy.
	RunningImage string `json:"running_image"`
	Health       string `json:"health"`
	Restarts     int    `json:"restart_count"`
	CreatedUnix  int64  `json:"created_unix"`
	// The sampler's newest reading, so a list of services can show usage without
	// opening a stats stream per row. Zero when nothing recent was recorded.
	CPUPercent  float64 `json:"cpu_percent"`
	MemoryUsage uint64  `json:"memory_usage"`
}

// staleReading is how old the newest recorded sample may be before a service is
// reported as having no current usage. The sampler ticks every metrics.Interval;
// two missed ticks means the container is gone, not merely between readings.
const staleReading = 3 * metrics.Interval

func (s *Server) handleListServices(w http.ResponseWriter, r *http.Request) {
	_, env, ok := s.projectEnv(w, r)
	if !ok {
		return
	}
	views, err := s.serviceViews(r.Context(), env)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, views)
}

func (s *Server) serviceViews(ctx context.Context, env *database.Environment) ([]serviceView, error) {
	services, err := s.DB.ListServices(ctx, env.ID)
	if err != nil {
		return nil, err
	}
	containers, err := s.Docker.ListContainers(ctx, env.ComposeProjectName)
	if err != nil {
		containers = nil
	}
	usage, err := s.DB.LatestServiceMetrics(ctx, time.Now().Add(-staleReading))
	if err != nil {
		return nil, err
	}
	byService := map[string]int{}
	for i, c := range containers {
		name := c.Labels[docker.ComposeServiceLabel]
		if existing, ok := byService[name]; !ok || (c.State == "running" && containers[existing].State != "running") {
			byService[name] = i
		}
	}
	out := make([]serviceView, 0, len(services))
	for _, svc := range services {
		view := serviceView{Service: svc}
		if idx, ok := byService[svc.ComposeServiceName]; ok {
			c := containers[idx]
			view.ContainerID = c.ID
			view.State = c.State
			view.Status = c.Status
			view.RunningImage = c.Image
			view.CreatedUnix = c.Created
			if info, err := s.Docker.Inspect(ctx, c.ID); err == nil {
				view.Restarts = info.RestartCount
				if info.State != nil && info.State.Health != nil {
					view.Health = info.State.Health.Status
				}
			}
			if reading, ok := usage[svc.ID]; ok && c.State == "running" {
				view.CPUPercent = reading.CPUPercent
				view.MemoryUsage = reading.MemoryUsage
			}
		}
		out = append(out, view)
	}
	return out, nil
}

func (s *Server) handleListDeployments(w http.ResponseWriter, r *http.Request) {
	_, env, ok := s.projectEnv(w, r)
	if !ok {
		return
	}
	list, err := s.DB.ListDeployments(r.Context(), env.ID, 50)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleListProjectDomains(w http.ResponseWriter, r *http.Request) {
	list, err := s.DB.ListProjectDomains(r.Context(), r.PathValue("id"))
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// logWriter adapts the structured logger to io.Writer for compose output that
// is not attached to a deployment (teardown, stop).
type logWriter struct {
	log interface{ Info(string, ...any) }
}

func (l logWriter) Write(b []byte) (int, error) {
	l.log.Info("compose", "output", trimTrailingNewline(string(b)))
	return len(b), nil
}

func trimTrailingNewline(s string) string {
	for len(s) > 0 && (s[len(s)-1] == '\n' || s[len(s)-1] == '\r') {
		s = s[:len(s)-1]
	}
	return s
}
