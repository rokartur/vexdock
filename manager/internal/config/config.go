// Package config resolves runtime configuration from the environment.
//
// The manager container bind-mounts the host platform root at the *same* path
// inside the container (see compose.yml) so that paths handed to the Docker
// daemon (bind mounts declared by user compose files) resolve identically on
// both sides.
package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

type Config struct {
	// Root is the platform state directory, identical on host and in-container.
	Root string

	DataDir         string
	ProjectsDir     string
	NginxDir        string
	CertificatesDir string
	BackupsDir      string
	SecretsDir      string
	SystemDir       string

	ListenAddr string

	// ProxyNetwork is the shared docker network joining Nginx and user services.
	ProxyNetwork string
	// NginxContainer is the container name used for `nginx -t` and reloads.
	NginxContainer string

	// PublicURL is the externally reachable dashboard origin, when known.
	PublicURL string

	Version string

	// ACMEDirectory is the Let's Encrypt directory endpoint.
	ACMEDirectory string
	ACMEEmail     string
	// ACMERenewBefore triggers renewal when a cert expires within this window.
	ACMERenewBefore time.Duration
}

const (
	LetsEncryptProduction = "https://acme-v02.api.letsencrypt.org/directory"
	LetsEncryptStaging    = "https://acme-staging-v02.api.letsencrypt.org/directory"
)

// Load builds the configuration and creates every state directory it needs.
func Load() (*Config, error) {
	root := env("PLATFORM_ROOT", "/opt/platform")
	if !filepath.IsAbs(root) {
		abs, err := filepath.Abs(root)
		if err != nil {
			return nil, fmt.Errorf("resolve PLATFORM_ROOT: %w", err)
		}
		root = abs
	}

	acmeDir := LetsEncryptProduction
	if boolEnv("PLATFORM_ACME_STAGING", false) {
		acmeDir = LetsEncryptStaging
	}

	c := &Config{
		Root:            root,
		DataDir:         filepath.Join(root, "data"),
		ProjectsDir:     filepath.Join(root, "projects"),
		NginxDir:        filepath.Join(root, "nginx"),
		CertificatesDir: filepath.Join(root, "certificates"),
		BackupsDir:      filepath.Join(root, "backups"),
		SecretsDir:      filepath.Join(root, "secrets"),
		SystemDir:       filepath.Join(root, "system"),
		ListenAddr:      env("PLATFORM_LISTEN", ":8080"),
		ProxyNetwork:    env("PLATFORM_PROXY_NETWORK", "vexdock-proxy"),
		NginxContainer:  env("PLATFORM_NGINX_CONTAINER", "vexdock-nginx"),
		PublicURL:       strings.TrimSuffix(env("PLATFORM_PUBLIC_URL", ""), "/"),
		Version:         env("PLATFORM_VERSION", "dev"),
		ACMEDirectory:   env("PLATFORM_ACME_DIRECTORY", acmeDir),
		ACMEEmail:       env("PLATFORM_ACME_EMAIL", ""),
		ACMERenewBefore: 30 * 24 * time.Hour,
	}

	for _, dir := range []string{c.DataDir, c.ProjectsDir, c.NginxDir, c.CertificatesDir, c.BackupsDir, c.SystemDir} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("create %s: %w", dir, err)
		}
	}
	// Secrets are readable by the manager only.
	if err := os.MkdirAll(c.SecretsDir, 0o700); err != nil {
		return nil, fmt.Errorf("create %s: %w", c.SecretsDir, err)
	}
	for _, dir := range []string{filepath.Join(c.NginxDir, "generated"), filepath.Join(c.NginxDir, "custom"), filepath.Join(c.NginxDir, "acme-challenge")} {
		if err := os.MkdirAll(dir, 0o755); err != nil {
			return nil, fmt.Errorf("create %s: %w", dir, err)
		}
	}
	return c, nil
}

// DatabasePath is the SQLite file backing the whole management plane.
func (c *Config) DatabasePath() string { return filepath.Join(c.DataDir, "app.db") }

// AuthDatabasePath is the better-auth database. The auth service writes it and
// the manager reads it to validate sessions.
func (c *Config) AuthDatabasePath() string { return filepath.Join(c.DataDir, "auth.db") }

// MasterKeyPath holds the AES-GCM key protecting secrets stored in SQLite.
func (c *Config) MasterKeyPath() string { return filepath.Join(c.SecretsDir, "master.key") }

// ProjectDir is the on-disk home of one project, keyed by ULID (never by name).
func (c *Config) ProjectDir(id string) string { return filepath.Join(c.ProjectsDir, id) }

func env(key, fallback string) string {
	if v := strings.TrimSpace(os.Getenv(key)); v != "" {
		return v
	}
	return fallback
}

func boolEnv(key string, fallback bool) bool {
	if v, err := strconv.ParseBool(env(key, "")); err == nil {
		return v
	}
	return fallback
}
