package api

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"

	"github.com/vexdock/platform/manager/internal/auth"
	"github.com/vexdock/platform/manager/internal/database"
)

// Every authenticated route is registered through one of three wrappers, so a
// route nobody classified does not exist. A dashboard session and an admin
// token pass all three; a project token passes signedIn, and project only for
// the projects it was granted.

// signedIn is for routes any credential may call: who am I, the catalogs, and
// the lists that filter themselves down to what the caller may see.
func (s *Server) signedIn(h http.HandlerFunc) http.Handler {
	return s.authenticated(h)
}

// admin is for routes that reach past one project: Docker, the system, Git
// providers, registries, tokens, and creating or deleting a project.
func (s *Server) admin(h http.HandlerFunc) http.Handler {
	return s.authenticated(func(w http.ResponseWriter, r *http.Request) {
		if !isAdmin(r) {
			forbidden(w)
			return
		}
		h(w, r)
	})
}

// projectOf names the project a request acts on.
type projectOf func(s *Server, r *http.Request) (string, error)

// project is for routes inside one project. level is database.AccessRead or
// database.AccessWrite.
func (s *Server) project(level string, of projectOf, h http.HandlerFunc) http.Handler {
	return s.authenticated(func(w http.ResponseWriter, r *http.Request) {
		if isAdmin(r) {
			h(w, r)
			return
		}
		projectID, err := of(s, r)
		if err != nil && !errors.Is(err, database.ErrNotFound) {
			serverError(w, err)
			return
		}
		// A missing resource answers like a forbidden one, so a project token
		// cannot probe for ids outside its projects.
		if projectID == "" || !allows(r, projectID, level) {
			forbidden(w)
			return
		}
		h(w, r)
	})
}

func isAdmin(r *http.Request) bool {
	user, _ := auth.UserFrom(r.Context())
	return user.Token == nil || user.Token.Admin
}

func allows(r *http.Request, projectID, level string) bool {
	user, _ := auth.UserFrom(r.Context())
	return user.Token == nil || user.Token.Allows(projectID, level)
}

func forbidden(w http.ResponseWriter) {
	writeError(w, http.StatusForbidden, "FORBIDDEN", "This token has no access to that", nil)
}

func projectByPath(_ *Server, r *http.Request) (string, error) {
	return r.PathValue("id"), nil
}

func projectOfService(s *Server, r *http.Request) (string, error) {
	service, err := s.DB.ServiceByID(r.Context(), r.PathValue("id"))
	if err != nil {
		return "", err
	}
	return service.ProjectID, nil
}

func projectOfEnvironment(s *Server, r *http.Request) (string, error) {
	env, err := s.DB.EnvironmentByID(r.Context(), r.PathValue("id"))
	if err != nil {
		return "", err
	}
	return env.ProjectID, nil
}

func projectOfDeployment(s *Server, r *http.Request) (string, error) {
	deployment, err := s.DB.DeploymentByID(r.Context(), r.PathValue("id"))
	if err != nil {
		return "", err
	}
	return deployment.ProjectID, nil
}

func projectOfDomain(s *Server, r *http.Request) (string, error) {
	domain, err := s.DB.DomainByID(r.Context(), r.PathValue("id"))
	if err != nil {
		return "", err
	}
	return domain.ProjectID, nil
}

func projectOfTask(s *Server, r *http.Request) (string, error) {
	task, err := s.DB.ScheduledTaskByID(r.Context(), r.PathValue("id"))
	if err != nil {
		return "", err
	}
	service, err := s.DB.ServiceByID(r.Context(), task.ServiceID)
	if err != nil {
		return "", err
	}
	return service.ProjectID, nil
}

// projectInBody serves POST /api/domains, the one route that names its project
// in the body. The body is put back for the handler. A body that is not JSON
// names no project, so a project token gets 403 rather than the handler's 400.
func projectInBody(_ *Server, r *http.Request) (string, error) {
	body, err := io.ReadAll(io.LimitReader(r.Body, 2<<20))
	if err != nil {
		return "", err
	}
	r.Body = io.NopCloser(bytes.NewReader(body))
	var req struct {
		ProjectID string `json:"project_id"`
	}
	_ = json.Unmarshal(body, &req)
	return req.ProjectID, nil
}
