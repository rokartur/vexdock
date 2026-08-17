package api

import (
	"net/http"

	"github.com/vexdock/platform/manager/internal/domains"
)

func (s *Server) handleListDomains(w http.ResponseWriter, r *http.Request) {
	list, err := s.db.ListDomains(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}

func (s *Server) handleCreateDomain(w http.ResponseWriter, r *http.Request) {
	var req struct {
		ProjectID         string `json:"project_id"`
		Service           string `json:"service"`
		Hostname          string `json:"hostname"`
		ContainerPort     int    `json:"container_port"`
		HTTPS             bool   `json:"https_enabled"`
		RedirectHTTPS     bool   `json:"redirect_https"`
		CertificateSource string `json:"certificate_source"`
		CertificatePEM    string `json:"certificate_pem"`
		PrivateKeyPEM     string `json:"private_key_pem"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	domain, err := s.domains.Create(r.Context(), domains.CreateInput{
		ProjectID:         req.ProjectID,
		ServiceName:       req.Service,
		Hostname:          req.Hostname,
		ContainerPort:     req.ContainerPort,
		HTTPS:             req.HTTPS,
		RedirectHTTPS:     req.RedirectHTTPS,
		CertificateSource: req.CertificateSource,
		CertificatePEM:    req.CertificatePEM,
		PrivateKeyPEM:     req.PrivateKeyPEM,
	})
	if err != nil {
		// A domain that exists but failed certificate issuance is a partial
		// success: report it so the user can retry TLS without re-adding.
		if domain != nil {
			writeJSON(w, http.StatusCreated, map[string]any{"domain": domain, "warning": err.Error()})
			return
		}
		badRequest(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{"domain": domain})
}

func (s *Server) handleUpdateDomain(w http.ResponseWriter, r *http.Request) {
	domain, err := s.db.DomainByID(r.Context(), r.PathValue("id"))
	if handleLookupError(w, err) {
		return
	}
	var req struct {
		Hostname          *string `json:"hostname"`
		ContainerPort     *int    `json:"container_port"`
		HTTPS             *bool   `json:"https_enabled"`
		RedirectHTTPS     *bool   `json:"redirect_https"`
		CertificateSource *string `json:"certificate_source"`
		CertificatePEM    *string `json:"certificate_pem"`
		PrivateKeyPEM     *string `json:"private_key_pem"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	if req.Hostname != nil {
		domain.Hostname = *req.Hostname
	}
	if req.ContainerPort != nil {
		domain.ContainerPort = *req.ContainerPort
	}
	if req.HTTPS != nil {
		domain.HTTPSEnabled = *req.HTTPS
	}
	if req.RedirectHTTPS != nil {
		domain.RedirectHTTPS = *req.RedirectHTTPS
	}
	if req.CertificateSource != nil {
		domain.CertificateSource = *req.CertificateSource
	}
	update := domains.UpdateInput{}
	if req.CertificatePEM != nil {
		update.CertificatePEM = *req.CertificatePEM
	}
	if req.PrivateKeyPEM != nil {
		update.PrivateKeyPEM = *req.PrivateKeyPEM
	}
	if err := s.domains.Update(r.Context(), domain, update); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"domain": domain, "warning": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"domain": domain})
}

func (s *Server) handleDeleteDomain(w http.ResponseWriter, r *http.Request) {
	if err := s.domains.Delete(r.Context(), r.PathValue("id")); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleIssueCertificate retries or forces certificate issuance for a domain.
func (s *Server) handleIssueCertificate(w http.ResponseWriter, r *http.Request) {
	domain, err := s.db.DomainByID(r.Context(), r.PathValue("id"))
	if handleLookupError(w, err) {
		return
	}
	if err := s.domains.EnsureCertificate(r.Context(), domain); err != nil {
		writeError(w, http.StatusBadGateway, "CERTIFICATE_FAILED", err.Error(), nil)
		return
	}
	cert, err := s.db.CertificateByDomain(r.Context(), domain.ID)
	if handleLookupError(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, cert)
}

func (s *Server) handleListCertificates(w http.ResponseWriter, r *http.Request) {
	list, err := s.db.ListCertificates(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, list)
}
