package api

import (
	"errors"
	"fmt"
	"net/http"

	"github.com/vexdock/platform/manager/internal/auth"
	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/security"
)

// Sign-in, sign-up and sessions belong to the better-auth service; Nginx routes
// /api/auth/* there. What remains here is the manager's own view of the caller
// and the API tokens it issues for CI.

// handleMe also tells the caller what it may do, so an agent holding a project
// token can find its projects before guessing at ids.
func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	user, _ := auth.UserFrom(r.Context())
	access := map[string]any{"admin": true, "projects": []database.ProjectGrant{}}
	if user.Token != nil {
		access = map[string]any{"admin": user.Token.Admin, "projects": user.Token.Projects}
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": user, "access": access})
}

func (s *Server) handleListTokens(w http.ResponseWriter, r *http.Request) {
	tokens, err := s.DB.ListAPITokens(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, tokens)
}

// handleCreateToken returns the raw token exactly once. Without projects the
// token is an admin token; with them it reaches only those projects.
func (s *Server) handleCreateToken(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name     string                  `json:"name"`
		Projects []database.ProjectGrant `json:"projects"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	if req.Name == "" {
		badRequest(w, errors.New("token name is required"))
		return
	}
	seen := map[string]bool{}
	for _, grant := range req.Projects {
		if grant.Level != database.AccessRead && grant.Level != database.AccessWrite {
			badRequest(w, fmt.Errorf("level must be %q or %q", database.AccessRead, database.AccessWrite))
			return
		}
		if seen[grant.ProjectID] {
			badRequest(w, fmt.Errorf("project %s is listed twice", grant.ProjectID))
			return
		}
		seen[grant.ProjectID] = true
		if _, err := s.DB.ProjectByID(r.Context(), grant.ProjectID); err != nil {
			if errors.Is(err, database.ErrNotFound) {
				badRequest(w, fmt.Errorf("no project %s", grant.ProjectID))
				return
			}
			serverError(w, err)
			return
		}
	}
	user, _ := auth.UserFrom(r.Context())
	raw := security.RandomToken(32)
	token, err := s.DB.CreateAPIToken(r.Context(), user.ID, req.Name, security.HashToken(raw), raw[:6], req.Projects)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"token": token, "value": raw})
}

func (s *Server) handleDeleteToken(w http.ResponseWriter, r *http.Request) {
	if err := s.DB.DeleteAPIToken(r.Context(), r.PathValue("id")); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
