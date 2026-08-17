package api

import (
	"errors"
	"net"
	"net/http"

	"github.com/vexdock/platform/manager/internal/auth"
	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/security"
)

type credentialsRequest struct {
	Email    string `json:"email"`
	Password string `json:"password"`
}

type sessionResponse struct {
	User      *database.User `json:"user"`
	CSRFToken string         `json:"csrf_token"`
}

// handleAuthStatus tells the SPA whether to show setup or login.
func (s *Server) handleAuthStatus(w http.ResponseWriter, r *http.Request) {
	needsSetup, err := s.auth.NeedsSetup(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	authenticated := false
	if _, _, err := s.authenticate(r); err == nil {
		authenticated = true
	}
	writeJSON(w, http.StatusOK, map[string]bool{
		"needs_setup":   needsSetup,
		"authenticated": authenticated,
	})
}

func (s *Server) handleSetup(w http.ResponseWriter, r *http.Request) {
	var req credentialsRequest
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	user, err := s.auth.Setup(r.Context(), req.Email, req.Password)
	if errors.Is(err, auth.ErrSetupClosed) {
		writeError(w, http.StatusConflict, "SETUP_CLOSED", err.Error(), nil)
		return
	}
	if err != nil {
		badRequest(w, err)
		return
	}
	// Log the new administrator straight in; the wizard should not ask twice.
	_, token, csrf, err := s.auth.Login(r.Context(), req.Email, req.Password, clientKey(r))
	if err != nil {
		serverError(w, err)
		return
	}
	s.auth.SetSessionCookie(w, token)
	writeJSON(w, http.StatusCreated, sessionResponse{User: user, CSRFToken: csrf})
}

func (s *Server) handleLogin(w http.ResponseWriter, r *http.Request) {
	var req credentialsRequest
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	user, token, csrf, err := s.auth.Login(r.Context(), req.Email, req.Password, clientKey(r))
	switch {
	case errors.Is(err, auth.ErrRateLimited):
		writeError(w, http.StatusTooManyRequests, "RATE_LIMITED", err.Error(), nil)
		return
	case errors.Is(err, auth.ErrInvalidCredentials):
		writeError(w, http.StatusUnauthorized, "INVALID_CREDENTIALS", err.Error(), nil)
		return
	case err != nil:
		serverError(w, err)
		return
	}
	s.auth.SetSessionCookie(w, token)
	writeJSON(w, http.StatusOK, sessionResponse{User: user, CSRFToken: csrf})
}

func (s *Server) handleLogout(w http.ResponseWriter, r *http.Request) {
	if c, err := r.Cookie(auth.SessionCookie); err == nil {
		if err := s.auth.Logout(r.Context(), c.Value); err != nil {
			serverError(w, err)
			return
		}
	}
	s.auth.ClearSessionCookie(w)
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	user, _ := auth.UserFrom(r.Context())
	resp := sessionResponse{User: user}
	if session, ok := auth.SessionFrom(r.Context()); ok && session != nil {
		resp.CSRFToken = session.CSRFToken
	}
	writeJSON(w, http.StatusOK, resp)
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
	raw := security.RandomToken(32)
	token, err := s.db.CreateAPIToken(r.Context(), user.ID, req.Name, security.HashToken(raw), raw[:6])
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

// clientKey identifies the caller for login rate limiting.
func clientKey(r *http.Request) string {
	if forwarded := r.Header.Get("X-Real-IP"); forwarded != "" {
		return forwarded
	}
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}
