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

// SettingBeta is the system_settings key for the prerelease channel.
// "true" / "false"; empty means follow the installed version's track.
const SettingBeta = "updater.beta"

// versionPattern is the only shape accepted for a target version, so nothing
// user-supplied can be reinterpreted by the shell inside the updater container.
var versionPattern = regexp.MustCompile(`^v?[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$`)

type Service struct {
	cfg     *config.Config
	backups *backup.Service

	mu              sync.Mutex
	latest          string
	latestAt        time.Time
	cachedPrerelease bool
	releaseAPI      string
	rawBase         string
}

// New wires the updater. repo is the "owner/name" GitHub slug that publishes
// this platform: releases are read from it and the compose file for the target
// version is downloaded from it. An empty slug disables update checks.
func New(cfg *config.Config, backups *backup.Service, repo string) *Service {
	s := &Service{cfg: cfg, backups: backups}
	if repo != "" {
		// /releases/latest ignores prereleases. The list endpoint returns newest
		// first and includes them; Status filters drafts and, unless beta is on,
		// prereleases.
		s.releaseAPI = "https://api.github.com/repos/" + repo + "/releases"
		s.rawBase = "https://raw.githubusercontent.com/" + repo
	}
	return s
}

// IncludePrerelease resolves the beta channel: an explicit setting wins,
// otherwise a prerelease install stays on the prerelease track.
func IncludePrerelease(setting, current string) bool {
	switch setting {
	case "true":
		return true
	case "false":
		return false
	default:
		return strings.Contains(current, "-")
	}
}

// Status is what the System → About screen renders.
type Status struct {
	Current         string `json:"current"`
	Latest          string `json:"latest"`
	UpdateAvailable bool   `json:"update_available"`
	Beta            bool   `json:"beta"`
	CheckedAt       string `json:"checked_at"`
}

// Status reports the installed version and the newest release on the chosen track.
func (s *Service) Status(ctx context.Context, includePrerelease bool) Status {
	latest := s.latestVersion(ctx, includePrerelease)
	return Status{
		Current:         s.cfg.Version,
		Latest:          latest,
		UpdateAvailable: latest != "" && latest != s.cfg.Version,
		Beta:            includePrerelease,
		CheckedAt:       time.Now().UTC().Format(time.RFC3339),
	}
}

// latestVersion queries the release API at most once every 15 minutes per track.
func (s *Service) latestVersion(ctx context.Context, includePrerelease bool) string {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.latestAt.IsZero() && time.Since(s.latestAt) < 15*time.Minute && s.cachedPrerelease == includePrerelease {
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
	req.Header.Set("User-Agent", "vexdock-updater")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return s.latest
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return s.latest
	}
	var payload []struct {
		TagName    string `json:"tag_name"`
		Draft      bool   `json:"draft"`
		Prerelease bool   `json:"prerelease"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return s.latest
	}
	for _, rel := range payload {
		if rel.Draft || !versionPattern.MatchString(rel.TagName) {
			continue
		}
		if rel.Prerelease && !includePrerelease {
			continue
		}
		s.latest, s.latestAt, s.cachedPrerelease = rel.TagName, time.Now(), includePrerelease
		return s.latest
	}
	// No matching release on this track: remember the miss so we do not hammer
	// GitHub, but leave latest empty so the UI shows "unknown".
	s.latest, s.latestAt, s.cachedPrerelease = "", time.Now(), includePrerelease
	return ""
}

// Start backs up the platform and launches the detached updater container.
func (s *Service) Start(ctx context.Context, version string, includePrerelease bool) error {
	if version == "" {
		version = s.latestVersion(ctx, includePrerelease)
	}
	if !versionPattern.MatchString(version) {
		return fmt.Errorf("invalid target version %q", version)
	}
	// Platform state only: an update replaces images, it does not touch
	// application volumes, and archiving them here would stall every update.
	if _, err := s.backups.Create(ctx, false); err != nil {
		return fmt.Errorf("pre-update backup failed: %w", err)
	}
	scriptPath, err := s.writeScript()
	if err != nil {
		return err
	}
	// Each argument is passed separately; nothing is concatenated into a shell
	// command line.
	// The container is kept after it exits so `docker logs vexdock-updater`
	// can explain a failed update; the previous one is cleared here instead.
	_ = exec.CommandContext(ctx, "docker", "rm", "-f", "vexdock-updater").Run()
	args := []string{
		"run", "--detach",
		"--name", "vexdock-updater",
		"-v", "/var/run/docker.sock:/var/run/docker.sock",
		"-v", s.cfg.Root + ":" + s.cfg.Root,
		"-w", s.cfg.Root,
		"-e", "PLATFORM_ROOT=" + s.cfg.Root,
		"-e", "PLATFORM_RAW_BASE=" + s.rawBase,
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
