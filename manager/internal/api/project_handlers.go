package api

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/vexdock/platform/manager/internal/auth"
	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/deployments"
	"github.com/vexdock/platform/manager/internal/docker"
	"github.com/vexdock/platform/manager/internal/projects"
)

// projectView enriches the stored project with live state for the UI.
type projectView struct {
	database.Project
	ServiceCount     int                  `json:"service_count"`
	RunningCount     int                  `json:"running_count"`
	Domains          []database.Domain    `json:"domains"`
	LatestDeployment *database.Deployment `json:"latest_deployment"`
	WebhookURL       string               `json:"webhook_url"`
	// WebhookSecretSet reports whether HMAC verification is on; the secret
	// itself is never returned.
	WebhookSecretSet bool `json:"webhook_secret_set"`
}

func (s *Server) handleListProjects(w http.ResponseWriter, r *http.Request) {
	list, err := s.db.ListProjects(r.Context())
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

func (s *Server) projectView(ctx context.Context, p *database.Project) (*projectView, error) {
	services, err := s.db.ListServices(ctx, p.ID)
	if err != nil {
		return nil, err
	}
	domainList, err := s.db.ListProjectDomains(ctx, p.ID)
	if err != nil {
		return nil, err
	}
	view := &projectView{
		Project:          *p,
		ServiceCount:     len(services),
		Domains:          domainList,
		WebhookURL:       s.projects.WebhookURL(p),
		WebhookSecretSet: s.setting(ctx, webhookSecretKey(p.ID)) != "",
	}
	if containers, err := s.docker.ListContainers(ctx, p.ComposeProjectName); err == nil {
		for _, c := range containers {
			if c.State == "running" {
				view.RunningCount++
			}
		}
	}
	if recent, err := s.db.ListDeployments(ctx, p.ID, 1); err == nil && len(recent) > 0 {
		view.LatestDeployment = &recent[0]
	}
	return view, nil
}

type createProjectRequest struct {
	Name           string `json:"name"`
	SourceType     string `json:"source_type"`
	RepositoryURL  string `json:"repository_url"`
	Branch         string `json:"branch"`
	ComposePath    string `json:"compose_path"`
	ComposeContent string `json:"compose_content"`
	// Template seeds the compose content from the built-in catalog.
	Template         string   `json:"template"`
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
	if req.Template != "" {
		template, ok := templateBySlug(req.Template)
		if !ok {
			badRequest(w, errors.New("unknown template "+req.Template))
			return
		}
		req.SourceType = database.SourceCompose
		req.ComposeContent = template.Compose
	}
	project, err := s.projects.Create(r.Context(), projects.CreateInput{
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
	project, err := s.db.ProjectByID(r.Context(), r.PathValue("id"))
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
	project, err := s.db.ProjectByID(r.Context(), r.PathValue("id"))
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
	if req.SourceType != nil {
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
	if err := s.projects.Validate(project); err != nil {
		badRequest(w, err)
		return
	}
	// Only once the new source validates, so a rejected switch leaves the
	// current checkout untouched.
	if project.SourceType != previousSource {
		if err := s.projects.ResetCheckout(project); err != nil {
			serverError(w, err)
			return
		}
	}
	if req.WebhookSecret != nil {
		// Trimming makes a whitespace-only value mean "turn verification off",
		// which is the only way to clear it from a password field.
		secret := strings.TrimSpace(*req.WebhookSecret)
		if err := s.db.SetSetting(r.Context(), webhookSecretKey(project.ID), secret); err != nil {
			serverError(w, err)
			return
		}
	}
	if req.CredentialKind != nil {
		secret := ""
		if req.CredentialSecret != nil {
			secret = *req.CredentialSecret
		}
		if err := s.projects.SetCredential(r.Context(), project, *req.CredentialKind, secret); err != nil {
			badRequest(w, err)
			return
		}
	} else if err := s.db.UpdateProject(r.Context(), project); err != nil {
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

// handleDeleteProject tears the stack down before removing any record of it.
func (s *Server) handleDeleteProject(w http.ResponseWriter, r *http.Request) {
	project, err := s.db.ProjectByID(r.Context(), r.PathValue("id"))
	if handleLookupError(w, err) {
		return
	}
	removeVolumes := r.URL.Query().Get("volumes") == "true"
	if composeProject, err := s.projects.ComposeProject(r.Context(), project); err == nil {
		if err := composeProject.Down(r.Context(), logWriter{s.log}, removeVolumes); err != nil {
			s.log.Warn("compose down during delete", "project", project.ID, "error", err)
		}
	}
	if err := s.db.DeleteProject(r.Context(), project.ID); err != nil {
		serverError(w, err)
		return
	}
	if err := s.projects.RemoveDirectory(project.ID); err != nil {
		s.log.Warn("remove project directory", "project", project.ID, "error", err)
	}
	if err := s.domains.Reconcile(r.Context()); err != nil {
		s.log.Warn("reconcile after project delete", "error", err)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleDeploy(w http.ResponseWriter, r *http.Request) {
	project, err := s.db.ProjectByID(r.Context(), r.PathValue("id"))
	if handleLookupError(w, err) {
		return
	}
	user, _ := auth.UserFrom(r.Context())
	actor := ""
	if user != nil {
		actor = user.Email
	}
	deployment, err := s.deployments.Trigger(r.Context(), project, deployments.Options{
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
	project, err := s.db.ProjectByID(r.Context(), r.PathValue("id"))
	if handleLookupError(w, err) {
		return
	}
	composeProject, err := s.projects.ComposeProject(r.Context(), project)
	if err != nil {
		badRequest(w, err)
		return
	}
	if err := composeProject.Down(r.Context(), logWriter{s.log}, false); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleGetCompose(w http.ResponseWriter, r *http.Request) {
	project, err := s.db.ProjectByID(r.Context(), r.PathValue("id"))
	if handleLookupError(w, err) {
		return
	}
	content, err := s.projects.ReadComposeFile(project)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"content": content, "path": project.ComposePath})
}

// handlePutCompose only applies to projects whose source is a pasted compose
// file; a git-backed file would be overwritten by the next deployment.
func (s *Server) handlePutCompose(w http.ResponseWriter, r *http.Request) {
	project, err := s.db.ProjectByID(r.Context(), r.PathValue("id"))
	if handleLookupError(w, err) {
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
	if err := s.projects.WriteComposeFile(project, req.Content); err != nil {
		badRequest(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleGetEnvironment(w http.ResponseWriter, r *http.Request) {
	vars, err := s.projects.Environment(r.Context(), r.PathValue("id"), true)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, vars)
}

func (s *Server) handlePutEnvironment(w http.ResponseWriter, r *http.Request) {
	project, err := s.db.ProjectByID(r.Context(), r.PathValue("id"))
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
	if err := s.projects.SetEnvironment(r.Context(), project.ID, req.Variables); err != nil {
		badRequest(w, err)
		return
	}
	if _, err := s.projects.WriteEnvFile(r.Context(), project); err != nil {
		serverError(w, err)
		return
	}
	vars, err := s.projects.Environment(r.Context(), project.ID, true)
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
	Image       string `json:"image"`
	Health      string `json:"health"`
	Restarts    int    `json:"restart_count"`
	CreatedUnix int64  `json:"created_unix"`
}

func (s *Server) handleListServices(w http.ResponseWriter, r *http.Request) {
	project, err := s.db.ProjectByID(r.Context(), r.PathValue("id"))
	if handleLookupError(w, err) {
		return
	}
	views, err := s.serviceViews(r.Context(), project)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, views)
}

func (s *Server) serviceViews(ctx context.Context, project *database.Project) ([]serviceView, error) {
	services, err := s.db.ListServices(ctx, project.ID)
	if err != nil {
		return nil, err
	}
	containers, err := s.docker.ListContainers(ctx, project.ComposeProjectName)
	if err != nil {
		containers = nil
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
			view.Image = c.Image
			view.CreatedUnix = c.Created
			if info, err := s.docker.Inspect(ctx, c.ID); err == nil {
				view.Restarts = info.RestartCount
				if info.State != nil && info.State.Health != nil {
					view.Health = info.State.Health.Status
				}
			}
		}
		out = append(out, view)
	}
	return out, nil
}

func (s *Server) handleListDeployments(w http.ResponseWriter, r *http.Request) {
	list, err := s.db.ListDeployments(r.Context(), r.PathValue("id"), 50)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleListProjectDomains(w http.ResponseWriter, r *http.Request) {
	list, err := s.db.ListProjectDomains(r.Context(), r.PathValue("id"))
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
