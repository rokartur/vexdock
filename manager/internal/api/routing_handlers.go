package api

import (
	"fmt"
	"net/http"
	"strings"

	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/nginx"
	"github.com/vexdock/platform/manager/internal/security"
)

// A service's redirects and basic-auth users live in the nginx vhosts of its
// domains, so every change reconciles the proxy. Its ports are compose ports
// and take effect on the next deploy.

func (s *Server) handleListServiceRedirects(w http.ResponseWriter, r *http.Request) {
	redirects, err := s.DB.ServiceRedirects(r.Context(), r.PathValue("id"))
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, redirects)
}

func (s *Server) handleCreateServiceRedirect(w http.ResponseWriter, r *http.Request) {
	if _, err := s.DB.ServiceByID(r.Context(), r.PathValue("id")); lookupFailed(w, err) {
		return
	}
	var in struct {
		Regex       string `json:"regex"`
		Replacement string `json:"replacement"`
		Permanent   bool   `json:"permanent"`
	}
	if err := decode(r, &in); err != nil {
		badRequest(w, err)
		return
	}
	replacement, err := security.ValidateRedirect(in.Regex, in.Replacement)
	if err != nil {
		badRequest(w, err)
		return
	}
	redirect := database.ServiceRedirect{ServiceID: r.PathValue("id"), Regex: in.Regex, Replacement: replacement, Permanent: in.Permanent}
	if err := s.DB.CreateServiceRedirect(r.Context(), &redirect); err != nil {
		serverError(w, err)
		return
	}
	if err := s.Domains.Reconcile(r.Context()); err != nil {
		s.undoRoutingRule(r, s.DB.DeleteServiceRedirect(r.Context(), redirect.ServiceID, redirect.ID))
		badRequest(w, fmt.Errorf("nginx rejected the redirect: %w", err))
		return
	}
	writeJSON(w, http.StatusCreated, redirect)
}

func (s *Server) handleDeleteServiceRedirect(w http.ResponseWriter, r *http.Request) {
	if err := s.DB.DeleteServiceRedirect(r.Context(), r.PathValue("id"), r.PathValue("redirectId")); err != nil {
		serverError(w, err)
		return
	}
	s.reconcileAfterDelete(w, r)
}

func (s *Server) handleListServiceBasicAuth(w http.ResponseWriter, r *http.Request) {
	users, err := s.DB.ServiceBasicAuths(r.Context(), r.PathValue("id"))
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, users)
}

func (s *Server) handleCreateServiceBasicAuth(w http.ResponseWriter, r *http.Request) {
	if _, err := s.DB.ServiceByID(r.Context(), r.PathValue("id")); lookupFailed(w, err) {
		return
	}
	var in struct {
		Username string `json:"username"`
		Password string `json:"password"`
	}
	if err := decode(r, &in); err != nil {
		badRequest(w, err)
		return
	}
	if err := security.ValidateBasicAuthUser(in.Username, in.Password); err != nil {
		badRequest(w, err)
		return
	}
	user := database.ServiceBasicAuth{ServiceID: r.PathValue("id"), Username: in.Username, PasswordHash: nginx.HashPassword(in.Password)}
	if err := s.DB.CreateServiceBasicAuth(r.Context(), &user); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			writeError(w, http.StatusConflict, "CONFLICT", fmt.Sprintf("user %q already exists", in.Username), nil)
			return
		}
		serverError(w, err)
		return
	}
	if err := s.Domains.Reconcile(r.Context()); err != nil {
		s.undoRoutingRule(r, s.DB.DeleteServiceBasicAuth(r.Context(), user.ServiceID, user.ID))
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, user)
}

func (s *Server) handleDeleteServiceBasicAuth(w http.ResponseWriter, r *http.Request) {
	if err := s.DB.DeleteServiceBasicAuth(r.Context(), r.PathValue("id"), r.PathValue("userId")); err != nil {
		serverError(w, err)
		return
	}
	s.reconcileAfterDelete(w, r)
}

func (s *Server) handleListServicePorts(w http.ResponseWriter, r *http.Request) {
	ports, err := s.DB.ServicePorts(r.Context(), r.PathValue("id"))
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, ports)
}

func (s *Server) handleCreateServicePort(w http.ResponseWriter, r *http.Request) {
	service, err := s.DB.ServiceByID(r.Context(), r.PathValue("id"))
	if lookupFailed(w, err) {
		return
	}
	if service.Provider == database.ProviderRaw {
		badRequest(w, fmt.Errorf("a compose fragment declares its ports in its own YAML"))
		return
	}
	var in struct {
		Published int    `json:"published"`
		Target    int    `json:"target"`
		Protocol  string `json:"protocol"`
	}
	if err := decode(r, &in); err != nil {
		badRequest(w, err)
		return
	}
	if err := security.ValidatePublishedPort(in.Published, in.Target, in.Protocol); err != nil {
		badRequest(w, err)
		return
	}
	port := database.ServicePort{ServiceID: service.ID, Published: in.Published, Target: in.Target, Protocol: in.Protocol}
	if err := s.DB.CreateServicePort(r.Context(), &port); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			writeError(w, http.StatusConflict, "CONFLICT", fmt.Sprintf("host port %d/%s is already published by a service", in.Published, in.Protocol), nil)
			return
		}
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, port)
}

func (s *Server) handleDeleteServicePort(w http.ResponseWriter, r *http.Request) {
	if err := s.DB.DeleteServicePort(r.Context(), r.PathValue("id"), r.PathValue("portId")); err != nil {
		serverError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// undoRoutingRule removes a rule nginx refused and puts the proxy back on the
// config it had, so one bad rule cannot wedge every later reconcile.
func (s *Server) undoRoutingRule(r *http.Request, deleteErr error) {
	if deleteErr != nil {
		s.Log.Error("remove rejected routing rule", "err", deleteErr)
		return
	}
	if err := s.Domains.Reconcile(r.Context()); err != nil {
		s.Log.Error("reconcile after removing rejected routing rule", "err", err)
	}
}

func (s *Server) reconcileAfterDelete(w http.ResponseWriter, r *http.Request) {
	if err := s.Domains.Reconcile(r.Context()); err != nil {
		serverError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
