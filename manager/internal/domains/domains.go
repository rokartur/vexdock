// Package domains maps hostnames onto compose services: it attaches the right
// container to the shared proxy network under a stable alias, renders the Nginx
// configuration and drives certificate issuance.
package domains

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"strings"
	"sync"
	"time"

	"github.com/vexdock/platform/manager/internal/certificates"
	"github.com/vexdock/platform/manager/internal/config"
	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/docker"
	"github.com/vexdock/platform/manager/internal/nginx"
	"github.com/vexdock/platform/manager/internal/security"
)

// SettingDashboardDomain stores the hostname the panel itself is served on.
const SettingDashboardDomain = "dashboard_domain"

// SettingDashboardHTTPS records whether the panel vhost should use TLS.
const SettingDashboardHTTPS = "dashboard_https"

type Service struct {
	db     *database.DB
	cfg    *config.Config
	docker *docker.Client
	nginx  *nginx.Manager
	certs  *certificates.Issuer
	log    *slog.Logger

	// reconcile is serialised: two concurrent reconciles would race on the
	// generated directory and on network attachments.
	mu sync.Mutex
}

func New(db *database.DB, cfg *config.Config, dockerClient *docker.Client, nginxManager *nginx.Manager,
	certs *certificates.Issuer, log *slog.Logger) *Service {
	return &Service{db: db, cfg: cfg, docker: dockerClient, nginx: nginxManager, certs: certs, log: log}
}

// CreateInput is the Add Domain form.
type CreateInput struct {
	ProjectID     string
	ServiceName   string
	Hostname      string
	ContainerPort int
	HTTPS         bool
	RedirectHTTPS bool
	// CertificateSource is database.CertLetsEncrypt or database.CertCustom.
	CertificateSource string
	// CertificatePEM and PrivateKeyPEM are only read for a custom source.
	CertificatePEM string
	PrivateKeyPEM  string
}

// Create validates and stores a domain, then reconciles the proxy so it starts
// serving immediately.
func (s *Service) Create(ctx context.Context, in CreateInput) (*database.Domain, error) {
	host, err := security.ValidateHostname(in.Hostname)
	if err != nil {
		return nil, err
	}
	if err := security.ValidatePort(in.ContainerPort); err != nil {
		return nil, err
	}
	project, err := s.db.ProjectByID(ctx, in.ProjectID)
	if err != nil {
		return nil, err
	}
	if err := security.ValidateServiceName(in.ServiceName); err != nil {
		return nil, err
	}
	service, err := s.db.UpsertService(ctx, project.ID, in.ServiceName)
	if err != nil {
		return nil, err
	}

	source, err := normaliseSource(in.CertificateSource)
	if err != nil {
		return nil, err
	}
	// A custom certificate is validated before the domain exists, so a bad
	// paste fails the form instead of leaving a domain that cannot serve TLS.
	if in.HTTPS && source == database.CertCustom {
		if _, err := certificates.Validate(host, in.CertificatePEM, in.PrivateKeyPEM); err != nil {
			return nil, err
		}
	}

	d := &database.Domain{
		ID:                database.NewID(),
		ProjectID:         project.ID,
		ServiceID:         service.ID,
		Hostname:          host,
		ContainerPort:     in.ContainerPort,
		HTTPSEnabled:      in.HTTPS,
		RedirectHTTPS:     in.RedirectHTTPS,
		CertificateSource: source,
	}
	if err := s.db.CreateDomain(ctx, d); err != nil {
		return nil, fmt.Errorf("domain %s is already in use: %w", host, err)
	}
	if d.HTTPSEnabled && source == database.CertCustom {
		if err := s.InstallCustomCertificate(ctx, d, in.CertificatePEM, in.PrivateKeyPEM); err != nil {
			return d, err
		}
		return d, nil
	}
	if err := s.Reconcile(ctx); err != nil {
		return d, err
	}
	if d.HTTPSEnabled {
		if err := s.EnsureCertificate(ctx, d); err != nil {
			// The domain exists and serves over HTTP; surface the TLS problem
			// without discarding the mapping the user just created.
			return d, err
		}
	}
	return d, nil
}

// normaliseSource defaults to Let's Encrypt and rejects anything unknown.
func normaliseSource(source string) (string, error) {
	switch source {
	case "", database.CertLetsEncrypt:
		return database.CertLetsEncrypt, nil
	case database.CertCustom:
		return database.CertCustom, nil
	default:
		return "", fmt.Errorf("unknown certificate source %q", source)
	}
}

// InstallCustomCertificate stores a user-supplied pair and reloads the proxy.
func (s *Service) InstallCustomCertificate(ctx context.Context, d *database.Domain, certPEM, keyPEM string) error {
	result, err := s.certs.InstallCustom(d.Hostname, certPEM, keyPEM)
	if err != nil {
		_ = s.db.UpsertCertificate(ctx, &database.Certificate{
			DomainID:  d.ID,
			Hostname:  d.Hostname,
			Status:    database.CertFailed,
			LastError: err.Error(),
			Source:    database.CertCustom,
		})
		return err
	}
	if err := s.db.UpsertCertificate(ctx, &database.Certificate{
		DomainID:      d.ID,
		Hostname:      d.Hostname,
		Issuer:        result.Issuer,
		IssuedAt:      result.NotBefore.UTC().Format(time.RFC3339),
		ExpiresAt:     result.NotAfter.UTC().Format(time.RFC3339),
		LastRenewedAt: database.Now(),
		Status:        database.CertIssued,
		Source:        database.CertCustom,
	}); err != nil {
		return err
	}
	s.log.Info("custom certificate installed", "domain", d.Hostname, "expires", result.NotAfter)
	return s.Reconcile(ctx)
}

// Update changes an existing mapping and re-reconciles.
// UpdateInput carries the optional new certificate material alongside the
// changed domain.
type UpdateInput struct {
	CertificatePEM string
	PrivateKeyPEM  string
}

func (s *Service) Update(ctx context.Context, d *database.Domain, in UpdateInput) error {
	host, err := security.ValidateHostname(d.Hostname)
	if err != nil {
		return err
	}
	previous, err := s.db.DomainByID(ctx, d.ID)
	if err != nil {
		return err
	}
	d.Hostname = host
	if err := security.ValidatePort(d.ContainerPort); err != nil {
		return err
	}
	source, err := normaliseSource(d.CertificateSource)
	if err != nil {
		return err
	}
	d.CertificateSource = source

	uploading := strings.TrimSpace(in.CertificatePEM) != "" || strings.TrimSpace(in.PrivateKeyPEM) != ""
	if d.HTTPSEnabled && source == database.CertCustom && uploading {
		if _, err := certificates.Validate(host, in.CertificatePEM, in.PrivateKeyPEM); err != nil {
			return err
		}
	}
	// Switching source or hostname invalidates whatever is on disk, so drop it
	// rather than serve a certificate that no longer belongs to this domain.
	if previous.CertificateSource != source || previous.Hostname != host {
		if err := s.certs.Remove(previous.Hostname); err != nil {
			s.log.Warn("remove previous certificate", "domain", previous.Hostname, "error", err)
		}
	}

	if err := s.db.UpdateDomain(ctx, d); err != nil {
		return err
	}
	if d.HTTPSEnabled && source == database.CertCustom {
		if uploading {
			return s.InstallCustomCertificate(ctx, d, in.CertificatePEM, in.PrivateKeyPEM)
		}
		if !s.certs.Exists(d.Hostname) {
			if err := s.Reconcile(ctx); err != nil {
				return err
			}
			return fmt.Errorf("upload a certificate for %s to enable HTTPS", d.Hostname)
		}
	}
	if err := s.Reconcile(ctx); err != nil {
		return err
	}
	if d.HTTPSEnabled {
		return s.EnsureCertificate(ctx, d)
	}
	return nil
}

func (s *Service) Delete(ctx context.Context, id string) error {
	domain, err := s.db.DomainByID(ctx, id)
	if err != nil {
		return err
	}
	if err := s.db.DeleteDomain(ctx, id); err != nil {
		return err
	}
	if err := s.certs.Remove(domain.Hostname); err != nil {
		s.log.Warn("remove certificate for deleted domain", "domain", domain.Hostname, "error", err)
	}
	return s.Reconcile(ctx)
}

// Reconcile makes the running proxy match the database: every domain's
// container joins the proxy network under its alias and the generated Nginx
// config is rewritten, validated and reloaded as one atomic set.
func (s *Service) Reconcile(ctx context.Context) error {
	s.mu.Lock()
	defer s.mu.Unlock()

	domains, err := s.db.ListDomains(ctx)
	if err != nil {
		return err
	}
	if err := s.docker.EnsureNetwork(ctx, s.cfg.ProxyNetwork); err != nil {
		return fmt.Errorf("ensure proxy network: %w", err)
	}

	desired := map[string]string{}
	for _, d := range domains {
		project, err := s.db.ProjectByID(ctx, d.ProjectID)
		if err != nil {
			s.log.Warn("domain points at a missing project", "domain", d.Hostname)
			continue
		}
		service, err := s.db.ServiceByID(ctx, d.ServiceID)
		if err != nil {
			s.log.Warn("domain points at a missing service", "domain", d.Hostname)
			continue
		}
		alias := nginx.Alias(project.ID, service.ComposeServiceName)

		// Attaching is best-effort: a stopped container must not block the rest
		// of the configuration from being written.
		if containerID, err := s.containerFor(ctx, project.ComposeProjectName, service.ComposeServiceName); err == nil {
			if err := s.docker.ConnectWithAlias(ctx, s.cfg.ProxyNetwork, containerID, alias); err != nil {
				s.log.Warn("proxy attach failed", "domain", d.Hostname, "error", err)
			}
		} else {
			s.log.Debug("no running container for domain yet", "domain", d.Hostname)
		}

		https := d.HTTPSEnabled && s.certs.Exists(d.Hostname)
		desired[nginx.FileName(d.Hostname)] = nginx.Render(nginx.Upstream{
			Hostname:      d.Hostname,
			Alias:         alias,
			Port:          d.ContainerPort,
			HTTPS:         https,
			RedirectHTTPS: d.RedirectHTTPS,
			CertDir:       "/certificates/" + certificates.DirName(d.Hostname),
		})
	}

	if vhost, name, ok := s.dashboardVhost(ctx); ok {
		desired[name] = vhost
	}
	return s.nginx.Apply(ctx, desired)
}

// dashboardVhost renders the panel's own vhost when the user assigned it a domain.
func (s *Service) dashboardVhost(ctx context.Context) (string, string, bool) {
	host, err := s.db.Setting(ctx, SettingDashboardDomain)
	if err != nil || host == "" {
		return "", "", false
	}
	host, err = security.ValidateHostname(host)
	if err != nil {
		return "", "", false
	}
	https := s.certs.Exists(host)
	body := nginx.RenderDashboard(host, "manager:8080", "/usr/share/nginx/html", https, "/certificates/"+host)
	return body, nginx.FileName(host), true
}

// containerFor resolves the current container of a compose service.
func (s *Service) containerFor(ctx context.Context, composeProject, serviceName string) (string, error) {
	containers, err := s.docker.ListContainers(ctx, composeProject)
	if err != nil {
		return "", err
	}
	var fallback string
	for _, c := range containers {
		if c.Labels[docker.ComposeServiceLabel] != serviceName {
			continue
		}
		if c.State == "running" {
			return c.ID, nil
		}
		fallback = c.ID
	}
	if fallback != "" {
		return fallback, nil
	}
	return "", errors.New("no container found for service")
}

// EnsureCertificate issues a certificate when one is missing or near expiry and
// re-renders the configuration so Nginx starts serving HTTPS.
func (s *Service) EnsureCertificate(ctx context.Context, d *database.Domain) error {
	if !d.HTTPSEnabled {
		return nil
	}
	if d.CertificateSource == database.CertCustom {
		// The user owns this certificate; the platform never replaces it.
		if !s.certs.Exists(d.Hostname) {
			return fmt.Errorf("no certificate uploaded for %s yet", d.Hostname)
		}
		return nil
	}
	if s.certs.Exists(d.Hostname) {
		if expiry, err := s.certs.Expiry(d.Hostname); err == nil && time.Until(expiry) > s.cfg.ACMERenewBefore {
			return nil
		}
	}
	s.log.Info("requesting certificate", "domain", d.Hostname)
	result, err := s.certs.Issue(ctx, d.Hostname)
	if err != nil {
		_ = s.db.UpsertCertificate(ctx, &database.Certificate{
			DomainID:  d.ID,
			Hostname:  d.Hostname,
			Status:    database.CertFailed,
			LastError: err.Error(),
		})
		return fmt.Errorf("certificate for %s failed: %w", d.Hostname, err)
	}
	if err := s.db.UpsertCertificate(ctx, &database.Certificate{
		DomainID:      d.ID,
		Hostname:      d.Hostname,
		Issuer:        result.Issuer,
		IssuedAt:      result.NotBefore.UTC().Format(time.RFC3339),
		ExpiresAt:     result.NotAfter.UTC().Format(time.RFC3339),
		LastRenewedAt: database.Now(),
		Status:        database.CertIssued,
	}); err != nil {
		return err
	}
	return s.Reconcile(ctx)
}

// RenewExpiring is the scheduler entry point; it renews everything inside the
// renewal window and reloads Nginx once at the end.
func (s *Service) RenewExpiring(ctx context.Context) {
	domains, err := s.db.ListDomains(ctx)
	if err != nil {
		s.log.Error("certificate renewal: list domains", "error", err)
		return
	}
	for _, d := range domains {
		if !d.HTTPSEnabled {
			continue
		}
		if d.CertificateSource == database.CertCustom {
			// Nothing to renew, but an expiring upload is worth saying out loud.
			if expiry, err := s.certs.Expiry(d.Hostname); err == nil && time.Until(expiry) < s.cfg.ACMERenewBefore {
				s.log.Warn("uploaded certificate is expiring", "domain", d.Hostname, "expires", expiry)
			}
			continue
		}
		if s.certs.Exists(d.Hostname) {
			expiry, err := s.certs.Expiry(d.Hostname)
			if err == nil && time.Until(expiry) > s.cfg.ACMERenewBefore {
				continue
			}
		}
		if err := s.EnsureCertificate(ctx, &d); err != nil {
			s.log.Error("certificate renewal failed", "domain", d.Hostname, "error", err)
		}
	}
}

// SetDashboardDomain publishes the panel on a hostname of the user's choosing.
func (s *Service) SetDashboardDomain(ctx context.Context, hostname string, https bool) error {
	if hostname == "" {
		if err := s.db.SetSetting(ctx, SettingDashboardDomain, ""); err != nil {
			return err
		}
		return s.Reconcile(ctx)
	}
	host, err := security.ValidateHostname(hostname)
	if err != nil {
		return err
	}
	if err := s.db.SetSetting(ctx, SettingDashboardDomain, host); err != nil {
		return err
	}
	if err := s.db.SetSetting(ctx, SettingDashboardHTTPS, fmt.Sprintf("%t", https)); err != nil {
		return err
	}
	if err := s.Reconcile(ctx); err != nil {
		return err
	}
	if https && !s.certs.Exists(host) {
		if _, err := s.certs.Issue(ctx, host); err != nil {
			return fmt.Errorf("certificate for %s failed: %w", host, err)
		}
		return s.Reconcile(ctx)
	}
	return nil
}
