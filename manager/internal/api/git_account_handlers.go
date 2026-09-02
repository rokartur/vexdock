package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/git"
)

func (s *Server) handleListGitAccounts(w http.ResponseWriter, r *http.Request) {
	list, err := s.DB.ListGitAccounts(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

// handleCreateGitAccount stores a provider token encrypted, after listing
// repositories once with it: a token that cannot read a repository list is a
// token that cannot clone either, and the failure belongs here rather than in
// the middle of a deployment.
func (s *Server) handleCreateGitAccount(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Provider string `json:"provider"`
		Name     string `json:"name"`
		Host     string `json:"host"`
		Token    string `json:"token"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" || strings.TrimSpace(req.Token) == "" {
		badRequest(w, errors.New("a name and a token are required"))
		return
	}
	host := strings.TrimSpace(req.Host)
	if _, err := git.APIBase(req.Provider, host); err != nil {
		badRequest(w, err)
		return
	}
	if _, err := git.ListRepositories(r.Context(), req.Provider, host, req.Token); err != nil {
		badRequest(w, err)
		return
	}
	encrypted, err := s.Cipher.Encrypt(req.Token)
	if err != nil {
		serverError(w, err)
		return
	}
	account := &database.GitAccount{Provider: req.Provider, Name: name, Host: host, EncryptedTok: encrypted}
	if err := s.DB.CreateGitAccount(r.Context(), account); err != nil {
		badRequest(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, account)
}

// handleDeleteGitAccount drops the token. Services that cloned through it keep
// their repository URL and fall back to no credential, which fails loudly on
// the next deployment instead of silently deploying an old checkout.
func (s *Server) handleDeleteGitAccount(w http.ResponseWriter, r *http.Request) {
	if err := s.DB.DeleteGitAccount(r.Context(), r.PathValue("id")); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleGitAccountRepositories is what the source picker reads: the token never
// leaves the manager, the dashboard only ever sees names and clone URLs.
func (s *Server) handleGitAccountRepositories(w http.ResponseWriter, r *http.Request) {
	account, err := s.DB.GitAccount(r.Context(), r.PathValue("id"))
	if handleLookupError(w, err) {
		return
	}
	token, err := s.Cipher.Decrypt(account.EncryptedTok)
	if err != nil {
		serverError(w, err)
		return
	}
	repos, err := git.ListRepositories(r.Context(), account.Provider, account.Host, token)
	if err != nil {
		badRequest(w, err)
		return
	}
	writeJSON(w, http.StatusOK, repos)
}
