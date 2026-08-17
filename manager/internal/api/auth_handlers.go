package api

import (
	"errors"
	"net/http"

	"github.com/vexdock/platform/manager/internal/auth"
	"github.com/vexdock/platform/manager/internal/security"
)

// Sign-in, sign-up and sessions belong to the better-auth service; Nginx routes
// /api/auth/* there. What remains here is the manager's own view of the caller
// and the API tokens it issues for CI.

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	user, _ := auth.UserFrom(r.Context())
	writeJSON(w, http.StatusOK, map[string]any{"user": user})
}

func (s *Server) handleListTokens(w http.ResponseWriter, r *http.Request) {
	tokens, err := s.db.ListAPITokens(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, tokens)
}

// handleCreateToken returns the raw token exactly once.
func (s *Server) handleCreateToken(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	if req.Name == "" {
		badRequest(w, errors.New("token name is required"))
		return
	}
	user, _ := auth.UserFrom(r.Context())
	userID := ""
	if user != nil {
		userID = user.ID
	}
	raw := security.RandomToken(32)
	token, err := s.db.CreateAPIToken(r.Context(), userID, req.Name, security.HashToken(raw), raw[:6])
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"token": token, "value": raw})
}

func (s *Server) handleDeleteToken(w http.ResponseWriter, r *http.Request) {
	if err := s.db.DeleteAPIToken(r.Context(), r.PathValue("id")); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}
