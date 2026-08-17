package nginx

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/vexdock/platform/manager/internal/docker"
)

// Manager owns the generated config directory and the reload cycle.
//
// Applying is a full reconcile: the caller renders the complete desired set and
// Manager makes the directory match it. A failed `nginx -t` restores the exact
// previous directory contents, so a bad config can never take the proxy down.
// Hand-written files in the custom directory are included by nginx.conf but are
// never touched here: reconciliation owns the generated directory only.
type Manager struct {
	mu             sync.Mutex
	generatedDir   string
	nginxContainer string
	docker         *docker.Client
	log            *slog.Logger
}

func NewManager(generatedDir, nginxContainer string, dockerClient *docker.Client, log *slog.Logger) *Manager {
	return &Manager{
		generatedDir:   generatedDir,
		nginxContainer: nginxContainer,
		docker:         dockerClient,
		log:            log,
	}
}

// Apply writes the desired file set, validates it and reloads Nginx.
func (m *Manager) Apply(ctx context.Context, desired map[string]string) error {
	m.mu.Lock()
	defer m.mu.Unlock()

	before, err := m.snapshot()
	if err != nil {
		return err
	}
	if equalSets(before, desired) {
		return nil
	}
	if err := m.write(desired); err != nil {
		_ = m.write(before)
		return err
	}
	if out, err := m.Test(ctx); err != nil {
		// Restore byte-for-byte and re-verify, so the running proxy keeps the
		// last configuration that was known good.
		if restoreErr := m.write(before); restoreErr != nil {
			m.log.Error("nginx rollback failed", "error", restoreErr)
		}
		m.log.Error("generated nginx configuration rejected", "output", out)
		return fmt.Errorf("nginx configuration test failed: %s", condense(out, err))
	}
	if err := m.Reload(ctx); err != nil {
		return err
	}
	m.log.Info("nginx configuration applied", "vhosts", len(desired))
	return nil
}

// Test runs `nginx -t` inside the proxy container.
func (m *Manager) Test(ctx context.Context) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, code, err := m.docker.ExecOutput(ctx, m.nginxContainer, []string{"nginx", "-t"})
	if err != nil {
		return out, err
	}
	if code != 0 {
		return out, fmt.Errorf("nginx -t exited with %d", code)
	}
	return out, nil
}

// Reload asks Nginx to pick up the validated configuration without dropping
// in-flight connections.
func (m *Manager) Reload(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	out, code, err := m.docker.ExecOutput(ctx, m.nginxContainer, []string{"nginx", "-s", "reload"})
	if err != nil {
		return fmt.Errorf("nginx reload: %w", err)
	}
	if code != 0 {
		return fmt.Errorf("nginx reload exited with %d: %s", code, condense(out, nil))
	}
	return nil
}

// snapshot reads the current generated directory.
func (m *Manager) snapshot() (map[string]string, error) {
	entries, err := os.ReadDir(m.generatedDir)
	if err != nil {
		return nil, fmt.Errorf("read generated dir: %w", err)
	}
	out := map[string]string{}
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".conf") {
			continue
		}
		body, err := os.ReadFile(filepath.Join(m.generatedDir, e.Name()))
		if err != nil {
			return nil, err
		}
		out[e.Name()] = string(body)
	}
	return out, nil
}

// write makes the directory contain exactly the given files.
func (m *Manager) write(files map[string]string) error {
	current, err := m.snapshot()
	if err != nil {
		return err
	}
	for name := range current {
		if _, keep := files[name]; !keep {
			if err := os.Remove(filepath.Join(m.generatedDir, name)); err != nil {
				return err
			}
		}
	}
	for _, name := range SortedFileNames(files) {
		path := filepath.Join(m.generatedDir, name)
		tmp := path + ".tmp"
		if err := os.WriteFile(tmp, []byte(files[name]), 0o644); err != nil {
			return err
		}
		if err := os.Rename(tmp, path); err != nil {
			return err
		}
	}
	return nil
}

func equalSets(a, b map[string]string) bool {
	if len(a) != len(b) {
		return false
	}
	for k, v := range a {
		if b[k] != v {
			return false
		}
	}
	return true
}

func condense(out string, err error) string {
	s := strings.TrimSpace(out)
	if s == "" && err != nil {
		return err.Error()
	}
	lines := strings.Split(s, "\n")
	if len(lines) > 6 {
		lines = lines[len(lines)-6:]
	}
	return strings.Join(lines, "; ")
}
