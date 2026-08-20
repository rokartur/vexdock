// Package compose drives the official `docker compose` CLI. The platform never
// reimplements Compose semantics: it shells out with one argument per slice
// element (never through `sh -c`) and reads back the resolved JSON config.
package compose

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os/exec"
	"sort"
	"strings"
)

// Project identifies one compose invocation: which directory, which files and
// under which compose project name its resources live.
type Project struct {
	Name string // --project-name, e.g. p_01JABCXYZ
	Dir  string // --project-directory, the repository root on disk
	// Files are the compose files in merge order: the project's own first, then
	// the overlay the manager generates for the services it owns.
	Files   []string
	EnvFile string // absolute path to the project .env, when present
}

// Config is the subset of `docker compose config --format json` the platform
// needs. Everything else stays Compose's business.
type Config struct {
	Name     string                   `json:"name"`
	Services map[string]ConfigService `json:"services"`
	Volumes  map[string]any           `json:"volumes"`
	Networks map[string]any           `json:"networks"`
}

type ConfigService struct {
	Image       string            `json:"image"`
	Build       any               `json:"build"`
	Ports       []ConfigPort      `json:"ports"`
	Environment map[string]any    `json:"environment"`
	Labels      map[string]string `json:"labels"`
}

type ConfigPort struct {
	Target    int    `json:"target"`
	Published string `json:"published"`
	Protocol  string `json:"protocol"`
}

// ServiceNames returns the compose services in stable order.
func (c *Config) ServiceNames() []string {
	names := make([]string, 0, len(c.Services))
	for name := range c.Services {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// ParseConfig decodes `docker compose config --format json` output.
func ParseConfig(raw []byte) (*Config, error) {
	var cfg Config
	if err := json.Unmarshal(raw, &cfg); err != nil {
		return nil, fmt.Errorf("parse compose config: %w", err)
	}
	if len(cfg.Services) == 0 {
		return nil, fmt.Errorf("compose file declares no services")
	}
	return &cfg, nil
}

func (p Project) args(extra ...string) []string {
	args := []string{"compose", "--project-name", p.Name, "--project-directory", p.Dir}
	for _, file := range p.Files {
		args = append(args, "--file", file)
	}
	if p.EnvFile != "" {
		args = append(args, "--env-file", p.EnvFile)
	}
	return append(args, extra...)
}

// Validate resolves and type-checks the compose file, returning the config.
func (p Project) Validate(ctx context.Context) (*Config, error) {
	cmd := exec.CommandContext(ctx, "docker", p.args("config", "--format", "json")...)
	var stderr strings.Builder
	cmd.Stderr = &stderr
	out, err := cmd.Output()
	if err != nil {
		return nil, fmt.Errorf("compose config failed: %s", firstLines(stderr.String(), err))
	}
	return ParseConfig(out)
}

// Run executes a compose subcommand, streaming combined output to w.
func (p Project) Run(ctx context.Context, w io.Writer, extra ...string) error {
	cmd := exec.CommandContext(ctx, "docker", p.args(extra...)...)
	cmd.Stdout = w
	cmd.Stderr = w
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("docker compose %s failed: %w", strings.Join(extra, " "), err)
	}
	return nil
}

// services, when set, scope the command to those compose services only.
func (p Project) Pull(ctx context.Context, w io.Writer, services ...string) error {
	return p.Run(ctx, w, append([]string{"pull", "--ignore-pull-failures"}, services...)...)
}

func (p Project) Build(ctx context.Context, w io.Writer, services ...string) error {
	return p.Run(ctx, w, append([]string{"build"}, services...)...)
}

func (p Project) Up(ctx context.Context, w io.Writer, services ...string) error {
	return p.Run(ctx, w, upArgs(services...)...)
}

// upArgs drops --remove-orphans when scoped: a single-service deploy must not
// tear siblings down just because they were not named.
func upArgs(services ...string) []string {
	if len(services) > 0 {
		return append([]string{"up", "-d"}, services...)
	}
	return []string{"up", "-d", "--remove-orphans"}
}

func (p Project) Down(ctx context.Context, w io.Writer, removeVolumes bool) error {
	args := []string{"down", "--remove-orphans"}
	if removeVolumes {
		args = append(args, "--volumes")
	}
	return p.Run(ctx, w, args...)
}

// firstLines keeps compose stderr readable in a deployment log line.
func firstLines(stderr string, fallback error) string {
	s := strings.TrimSpace(stderr)
	if s == "" {
		return fallback.Error()
	}
	lines := strings.Split(s, "\n")
	if len(lines) > 8 {
		lines = lines[:8]
	}
	return strings.Join(lines, "; ")
}
