package api

import (
	"errors"
	"net/http"

	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/projects"
)

// projectEnv loads the project named in the path together with the environment
// the request is about. ?environment= picks one; without it the request means
// the project's default, which is how every one of these routes behaved before
// environments existed and what keeps an old bookmark working.
//
// The lookup checks that the environment belongs to the project, so an id from
// somewhere else is a 404 rather than a way across the boundary.
func (s *Server) projectEnv(w http.ResponseWriter, r *http.Request) (*database.Project, *database.Environment, bool) {
	project, err := s.DB.ProjectByID(r.Context(), r.PathValue("id"))
	if handleLookupError(w, err) {
		return nil, nil, false
	}
	env, err := s.DB.EnvironmentOrDefault(r.Context(), project.ID, r.URL.Query().Get("environment"))
	if handleLookupError(w, err) {
		return nil, nil, false
	}
	return project, env, true
}

// environmentAndProject loads an environment addressed by its own id, along with
// the project it belongs to.
func (s *Server) environmentAndProject(w http.ResponseWriter, r *http.Request) (*database.Environment, *database.Project, bool) {
	env, err := s.DB.EnvironmentByID(r.Context(), r.PathValue("id"))
	if handleLookupError(w, err) {
		return nil, nil, false
	}
	project, err := s.DB.ProjectByID(r.Context(), env.ProjectID)
	if handleLookupError(w, err) {
		return nil, nil, false
	}
	return env, project, true
}

func (s *Server) handleListEnvironments(w http.ResponseWriter, r *http.Request) {
	project, err := s.DB.ProjectByID(r.Context(), r.PathValue("id"))
	if handleLookupError(w, err) {
		return
	}
	list, err := s.DB.ListEnvironments(r.Context(), project.ID)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleCreateEnvironment(w http.ResponseWriter, r *http.Request) {
	project, err := s.DB.ProjectByID(r.Context(), r.PathValue("id"))
	if handleLookupError(w, err) {
		return
	}
	var req struct {
		Name   string `json:"name"`
		Branch string `json:"branch"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	env, err := s.Projects.CreateEnvironment(r.Context(), project, req.Name, req.Branch)
	if err != nil {
		badRequest(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, env)
}

func (s *Server) handleGetEnvironment(w http.ResponseWriter, r *http.Request) {
	env, _, ok := s.environmentAndProject(w, r)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, env)
}

func (s *Server) handleUpdateEnvironment(w http.ResponseWriter, r *http.Request) {
	env, _, ok := s.environmentAndProject(w, r)
	if !ok {
		return
	}
	var req struct {
		Name   *string `json:"name"`
		Branch *string `json:"branch"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	name, branch := env.Name, env.Branch
	if req.Name != nil {
		name = *req.Name
	}
	if req.Branch != nil {
		branch = *req.Branch
	}
	if err := s.Projects.UpdateEnvironment(r.Context(), env, name, branch); err != nil {
		badRequest(w, err)
		return
	}
	writeJSON(w, http.StatusOK, env)
}

// handleDeleteEnvironment stops the environment's containers before dropping it,
// so deleting the record never leaves a stack running with nothing pointing at
// it. Volumes go too: an environment is a disposable copy, and the flag exists
// on project delete for the case where the data is not.
func (s *Server) handleDeleteEnvironment(w http.ResponseWriter, r *http.Request) {
	env, project, ok := s.environmentAndProject(w, r)
	if !ok {
		return
	}
	// DeleteEnvironment refuses the default environment, but the teardown below
	// is destructive and irreversible, so the refusal has to happen before it
	// rather than after: otherwise ?volumes=true answers 400 having already
	// removed the running stack and its data.
	if env.IsDefault {
		badRequest(w, errors.New("the default environment cannot be deleted"))
		return
	}
	removeVolumes := r.URL.Query().Get("volumes") == "true"
	if composeProject, err := s.Projects.ComposeProject(r.Context(), project, env); err == nil {
		if err := composeProject.Down(r.Context(), logWriter{s.Log}, removeVolumes); err != nil {
			s.Log.Warn("compose down during environment delete", "environment", env.ID, "error", err)
		}
	}
	if err := s.Projects.DeleteEnvironment(r.Context(), env); err != nil {
		badRequest(w, err)
		return
	}
	if err := s.Domains.Reconcile(r.Context()); err != nil {
		s.Log.Warn("reconcile after environment delete", "error", err)
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleGetEnvironmentVariables(w http.ResponseWriter, r *http.Request) {
	env, _, ok := s.environmentAndProject(w, r)
	if !ok {
		return
	}
	vars, err := s.Projects.EnvironmentVariables(r.Context(), env.ID)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, vars)
}

func (s *Server) handlePutEnvironmentVariables(w http.ResponseWriter, r *http.Request) {
	env, project, ok := s.environmentAndProject(w, r)
	if !ok {
		return
	}
	var req struct {
		Variables []projects.EnvVar `json:"variables"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	if err := s.Projects.SetEnvironmentVariables(r.Context(), env.ID, req.Variables); err != nil {
		badRequest(w, err)
		return
	}
	if _, err := s.Projects.WriteEnvFile(r.Context(), project, env); err != nil {
		serverError(w, err)
		return
	}
	vars, err := s.Projects.EnvironmentVariables(r.Context(), env.ID)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, vars)
}
