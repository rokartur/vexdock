// Package updater performs platform self-updates.
//
// The manager must not replace its own container from inside itself: it would
// be killed mid-swap with no way to recover. Instead it takes a backup and
// launches a short-lived, detached updater container that pulls the new images,
// recreates the stack and rolls back if the health check fails.
package updater

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"github.com/vexdock/platform/manager/internal/backup"
	"github.com/vexdock/platform/manager/internal/config"
)

// Script is the update shell script shipped inside the manager image.
//
//go:embed update.sh
var Script []byte

// UpdaterImage runs the update script; it ships the docker CLI and the compose
// plugin, which is all the script needs.
const UpdaterImage = "docker:28-cli"

// versionPattern is the only shape accepted for a target version, so nothing
// user-supplied can be reinterpreted by the shell inside the updater container.
var versionPattern = regexp.MustCompile(`^v?[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$`)

type Service struct {
	cfg     *config.Config
	backups *backup.Service

	mu         sync.Mutex
	latest     string
	latestAt   time.Time
	releaseAPI string
}

// New wires the updater. releaseAPI is the endpoint polled for the newest
// published version; an empty value disables update checks.
func New(cfg *config.Config, backups *backup.Service, releaseAPI string) *Service {
	return &Service{cfg: cfg, backups: backups, releaseAPI: releaseAPI}
}

// Status is what the System → Update screen renders.
type Status struct {
	Current         string `json:"current"`
	Latest          string `json:"latest"`
	UpdateAvailable bool   `json:"update_available"`
	CheckedAt       string `json:"checked_at"`
}

// Status reports the installed version and the newest published release.
func (s *Service) Status(ctx context.Context) Status {
	latest := s.latestVersion(ctx)
	return Status{
		Current:         s.cfg.Version,
		Latest:          latest,
		UpdateAvailable: latest != "" && latest != s.cfg.Version,
		CheckedAt:       time.Now().UTC().Format(time.RFC3339),
	}
}

// latestVersion queries the release API at most once every 15 minutes.
func (s *Service) latestVersion(ctx context.Context) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if time.Since(s.latestAt) < 15*time.Minute && s.latest != "" {
		return s.latest
	}
	if s.releaseAPI == "" {
		return ""
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.releaseAPI, nil)
	if err != nil {
		return s.latest
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return s.latest
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return s.latest
	}
	var payload struct {
		TagName string `json:"tag_name"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return s.latest
	}
	if versionPattern.MatchString(payload.TagName) {
		s.latest, s.latestAt = payload.TagName, time.Now()
	}
	return s.latest
}

// Start backs up the platform and launches the detached updater container.
func (s *Service) Start(ctx context.Context, version string) error {
	if version == "" {
		version = s.latestVersion(ctx)
	}
	if !versionPattern.MatchString(version) {
		return fmt.Errorf("invalid target version %q", version)
	}
	if _, err := s.backups.Create(ctx); err != nil {
		return fmt.Errorf("pre-update backup failed: %w", err)
	}
	scriptPath, err := s.writeScript()
	if err != nil {
		return err
	}
	// Each argument is passed separately; nothing is concatenated into a shell
	// command line.
	args := []string{
		"run", "--detach", "--rm",
		"--name", "platform-updater",
		"-v", "/var/run/docker.sock:/var/run/docker.sock",
		"-v", s.cfg.Root + ":" + s.cfg.Root,
		"-w", s.cfg.Root,
		"-e", "PLATFORM_ROOT=" + s.cfg.Root,
		UpdaterImage,
		"sh", scriptPath, version,
	}
	cmd := exec.CommandContext(ctx, "docker", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("start updater: %s", strings.TrimSpace(string(out)))
	}
	return nil
}

// writeScript materialises the embedded update script into the shared root so
// the updater container can execute it.
func (s *Service) writeScript() (string, error) {
	path := filepath.Join(s.cfg.SystemDir, "update.sh")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, Script, 0o755); err != nil {
		return "", err
	}
	return path, nil
}
