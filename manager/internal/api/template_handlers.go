package api

import (
	"context"
	"fmt"
	"net/http"

	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/domains"
	"github.com/vexdock/platform/manager/internal/projects"
	"github.com/vexdock/platform/manager/internal/templates"
)

// handleListTemplates returns the application catalog the template picker is
// built from.
func (s *Server) handleListTemplates(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, templates.Catalog)
}

// handleCreateFromTemplate installs one catalog entry into an environment: its
// generated values become environment variables, each of its compose services
// becomes a raw service, and the domain it declares is pointed at the service
// that serves it.
//
// Nothing records that these services came from a template. They are ordinary
// rows from here on, editable like any pasted fragment.
func (s *Server) handleCreateFromTemplate(w http.ResponseWriter, r *http.Request) {
	project, env, ok := s.projectEnv(w, r)
	if !ok {
		return
	}
	var req struct {
		Slug     string `json:"slug"`
		Hostname string `json:"hostname"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	rendered, err := templates.Render(req.Slug, req.Hostname)
	if err != nil {
		badRequest(w, err)
		return
	}
	if err := s.seedTemplateVariables(r.Context(), env, rendered.Variables); err != nil {
		serverError(w, err)
		return
	}

	created := make([]*database.Service, 0, len(rendered.Services))
	for _, svc := range rendered.Services {
		service, err := s.Projects.CreateService(r.Context(), env, projects.ServiceInput{
			Name:            svc.Name,
			Provider:        database.ProviderRaw,
			ComposeFragment: svc.Fragment(),
		})
		if err != nil {
			// Half a template is a stack that cannot start, so the services
			// that did land go back out again rather than being left to be
			// found later.
			for _, done := range created {
				_ = s.Projects.DeleteService(r.Context(), done, env)
			}
			badRequest(w, fmt.Errorf("%s: %w", svc.Name, err))
			return
		}
		created = append(created, service)
	}
	if rendered.Domain == nil {
		writeJSON(w, http.StatusCreated, map[string]any{"services": created})
		return
	}

	domain, err := s.Domains.Create(r.Context(), domains.CreateInput{
		ProjectID:         project.ID,
		EnvironmentID:     env.ID,
		ServiceName:       rendered.Domain.Service,
		Hostname:          req.Hostname,
		ContainerPort:     rendered.Domain.Port,
		HTTPS:             true,
		RedirectHTTPS:     true,
		CertificateSource: database.CertLetsEncrypt,
	})
	if err != nil {
		// The services exist either way, and the certificate cannot be issued
		// before the app answers, so a failure here is reported rather than
		// rolled back.
		writeJSON(w, http.StatusCreated, map[string]any{"services": created, "domain": domain, "warning": err.Error()})
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"services": created, "domain": domain})
}

// seedTemplateVariables adds a template's values to the environment it is
// installed into. A key the environment already holds keeps its value: that is
// what a second install of the same template, or a password the user has since
// changed, has to see.
func (s *Server) seedTemplateVariables(ctx context.Context, env *database.Environment, vars []templates.Variable) error {
	if len(vars) == 0 {
		return nil
	}
	merged, err := s.Projects.EnvironmentVariables(ctx, env.ID)
	if err != nil {
		return err
	}
	have := make(map[string]bool, len(merged))
	for _, v := range merged {
		have[v.Key] = true
	}
	for _, v := range vars {
		if have[v.Key] {
			continue
		}
		merged = append(merged, projects.EnvVar{Key: v.Key, Value: v.Value, IsSecret: v.Secret})
	}
	return s.Projects.SetEnvironmentVariables(ctx, env.ID, merged)
}
