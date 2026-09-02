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
	"errors"
	"fmt"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
	"sync"
	"time"

	"golang.org/x/mod/semver"

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

// SettingCleanupOldImages is the system_settings key for pruning the previous
// platform images after a successful update. "true" / "false"; empty is off.
const SettingCleanupOldImages = "updater.cleanup_old_images"

// semverTag normalises a release tag for semver.Compare, which requires the
// leading "v" that versionPattern treats as optional.
func semverTag(v string) string {
	if strings.HasPrefix(v, "v") {
		return v
	}
	return "v" + v
}

// versionPattern is the only shape accepted for a target version, so nothing
// user-supplied can be reinterpreted by the shell inside the updater container.
var versionPattern = regexp.MustCompile(`^v?[0-9]+\.[0-9]+\.[0-9]+(-[a-zA-Z0-9.]+)?$`)

type Service struct {
	cfg     *config.Config
	backups *backup.Service

	mu               sync.Mutex
	latest           string
	latestAt         time.Time
	cachedPrerelease bool
	repo             string
	releaseAPI       string
	rawBase          string
}

// New wires the updater. repo is the "owner/name" GitHub slug that publishes
// this platform: releases are read from it and the compose file for the target
// version is downloaded from it. An empty slug disables update checks.
func New(cfg *config.Config, backups *backup.Service, repo string) *Service {
	s := &Service{cfg: cfg, backups: backups, repo: repo}
	if repo != "" {
		// /releases/latest ignores prereleases, so read the list endpoint, which
		// includes them. It is not ordered by version, hence per_page=100 and the
		// explicit semver pick in latestVersion.
		s.releaseAPI = "https://api.github.com/repos/" + repo + "/releases?per_page=100"
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
	// ReleaseURL points at the latest release's notes on GitHub; empty when no
	// release is known or no repo is configured.
	ReleaseURL string `json:"release_url"`

	// CleanupOldImages is filled in by the API from system_settings; the
	// updater itself only receives it as an argument to Start.
	CleanupOldImages bool `json:"cleanup_old_images"`
}

// Status reports the installed version and the newest release on the chosen track.
func (s *Service) Status(ctx context.Context, includePrerelease bool) Status {
	latest, checkedAt := s.latestVersion(ctx, includePrerelease)
	// Zero means no lookup ever succeeded; the panel says "never" rather than
	// rendering year 1.
	checked := ""
	if !checkedAt.IsZero() {
		checked = checkedAt.UTC().Format(time.RFC3339)
	}
	releaseURL := ""
	if latest != "" && s.repo != "" {
		releaseURL = "https://github.com/" + s.repo + "/releases/tag/" + latest
	}
	return Status{
		Current:    s.cfg.Version,
		Latest:     latest,
		ReleaseURL: releaseURL,
		// Strictly newer, never merely different: the release list is not ordered
		// by version, so a plain inequality would happily offer a downgrade.
		UpdateAvailable: latest != "" && semver.Compare(semverTag(latest), semverTag(s.cfg.Version)) > 0,
		Beta:            includePrerelease,
		CheckedAt:       checked,
	}
}

// Invalidate drops the cached lookup so the next Status queries GitHub again,
// which is what the panel's manual check does. Callers must be authenticated:
// this turns a request into an outbound one against a rate-limited API.
func (s *Service) Invalidate() {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.latestAt = time.Time{}
}

// latestVersion queries the release API at most once every 2 minutes per track
// and reports when the returned answer was actually fetched.
func (s *Service) latestVersion(ctx context.Context, includePrerelease bool) (string, time.Time) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if !s.latestAt.IsZero() && time.Since(s.latestAt) < 2*time.Minute && s.cachedPrerelease == includePrerelease {
		return s.latest, s.latestAt
	}
	if s.releaseAPI == "" {
		return "", s.latestAt
	}
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, s.releaseAPI, nil)
	if err != nil {
		return s.latest, s.latestAt
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", "vexdock-updater")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return s.latest, s.latestAt
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return s.latest, s.latestAt
	}
	var payload []struct {
		TagName    string `json:"tag_name"`
		Draft      bool   `json:"draft"`
		Prerelease bool   `json:"prerelease"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return s.latest, s.latestAt
	}
	// GitHub orders this list by tag name, which sorts beta.10 below beta.2, so
	// take the highest version on the track rather than the first entry. When
	// nothing matches, latest stays empty (the UI shows "unknown") and the
	// timestamp still moves so we do not hammer GitHub.
	latest := ""
	for _, rel := range payload {
		if rel.Draft || !versionPattern.MatchString(rel.TagName) {
			continue
		}
		if rel.Prerelease && !includePrerelease {
			continue
		}
		if latest == "" || semver.Compare(semverTag(rel.TagName), semverTag(latest)) > 0 {
			latest = rel.TagName
		}
	}
	s.latest, s.latestAt, s.cachedPrerelease = latest, time.Now(), includePrerelease
	return latest, s.latestAt
}

// Start backs up the platform and launches the detached updater container.
func (s *Service) Start(ctx context.Context, version string, includePrerelease, cleanupOldImages bool) error {
	if version == "" {
		version, _ = s.latestVersion(ctx, includePrerelease)
	}
	if !versionPattern.MatchString(version) {
		return fmt.Errorf("invalid target version %q", version)
	}
	// The launch below removes any updater container first, so a second start
	// would kill one that is mid-recreate or mid-rollback.
	if s.State().Active() {
		return errors.New("an update is already running")
	}
	// From here the panel renders progress from the state file, so every error
	// path before the container launches must reset it to idle.
	s.writeState(State{Phase: PhaseBackup, Target: version, Previous: s.cfg.Version})
	fail := func(err error) error {
		s.writeState(State{Phase: PhaseIdle})
		return err
	}
	// Platform state only: an update replaces images, it does not touch
	// application volumes, and archiving them here would stall every update.
	if _, err := s.backups.Create(ctx, false); err != nil {
		return fail(fmt.Errorf("pre-update backup failed: %w", err))
	}
	scriptPath, err := s.writeScript()
	if err != nil {
		return fail(err)
	}
	// Each argument is passed separately; nothing is concatenated into a shell
	// command line.
	// A successful update removes its own container; a failed one is kept so
	// `docker logs vexdock-updater` can explain it, and cleared here.
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
		"sh", scriptPath, version, fmt.Sprintf("%t", cleanupOldImages),
	}
	cmd := exec.CommandContext(ctx, "docker", args...)
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fail(fmt.Errorf("start updater: %s", strings.TrimSpace(string(out))))
	}
	return nil
}

// LogTail returns the last lines of the updater container's output. A failed
// update keeps its container behind precisely so this can explain it; a
// missing container reads as no log.
func (s *Service) LogTail(ctx context.Context) string {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	out, err := exec.CommandContext(ctx, "docker", "logs", "--tail", "15", "vexdock-updater").CombinedOutput()
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(out))
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
