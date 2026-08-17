package compose

import (
	"strings"
	"testing"
)

// resolved is the shape `docker compose config --format json` produces.
const resolved = `{
  "name": "p_01jabc",
  "services": {
    "web": {
      "image": "nginx:alpine",
      "ports": [{"mode": "ingress", "target": 3000, "published": "3000", "protocol": "tcp"}],
      "healthcheck": {"test": ["CMD", "true"]}
    },
    "api": {
      "build": {"context": "."},
      "ports": [{"mode": "ingress", "target": 8080, "protocol": "tcp"}]
    },
    "worker": {"image": "busybox"}
  },
  "volumes": {"data": {}},
  "networks": {"default": {}}
}`

func TestParseConfig(t *testing.T) {
	cfg, err := ParseConfig([]byte(resolved))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if cfg.Name != "p_01jabc" {
		t.Fatalf("project name not parsed: %q", cfg.Name)
	}
	names := cfg.ServiceNames()
	if strings.Join(names, ",") != "api,web,worker" {
		t.Fatalf("service names not sorted/complete: %v", names)
	}
	if cfg.Services["api"].Build == nil {
		t.Fatal("build section lost")
	}
	if cfg.Services["web"].Healthcheck == nil {
		t.Fatal("healthcheck lost")
	}
}

func TestParseConfigRejectsEmpty(t *testing.T) {
	if _, err := ParseConfig([]byte(`{"services":{}}`)); err == nil {
		t.Fatal("a compose file with no services must be rejected")
	}
	if _, err := ParseConfig([]byte(`not json`)); err == nil {
		t.Fatal("invalid JSON must be rejected")
	}
}

func TestGuessPort(t *testing.T) {
	cfg, err := ParseConfig([]byte(resolved))
	if err != nil {
		t.Fatalf("parse: %v", err)
	}
	if got := cfg.GuessPort("web"); got != 3000 {
		t.Fatalf("expected 3000, got %d", got)
	}
	if got := cfg.GuessPort("api"); got != 8080 {
		t.Fatalf("expected 8080, got %d", got)
	}
	// A service with no published ports has nothing to prefill.
	if got := cfg.GuessPort("worker"); got != 0 {
		t.Fatalf("expected 0, got %d", got)
	}
	if got := cfg.GuessPort("missing"); got != 0 {
		t.Fatalf("expected 0 for an unknown service, got %d", got)
	}
}

func TestArgsKeepEveryValueSeparate(t *testing.T) {
	p := Project{Name: "p_01jabc", Dir: "/projects/01jabc/repository", File: "/projects/01jabc/repository/compose.yml", EnvFile: "/projects/01jabc/.env"}
	args := p.args("up", "-d")
	want := []string{
		"compose", "--project-name", "p_01jabc",
		"--project-directory", "/projects/01jabc/repository",
		"--file", "/projects/01jabc/repository/compose.yml",
		"--env-file", "/projects/01jabc/.env",
		"up", "-d",
	}
	if len(args) != len(want) {
		t.Fatalf("unexpected arg count %d: %v", len(args), args)
	}
	for i := range want {
		if args[i] != want[i] {
			t.Fatalf("arg %d: want %q, got %q", i, want[i], args[i])
		}
	}
	// Without an env file the flag must disappear entirely.
	p.EnvFile = ""
	for _, arg := range p.args("down") {
		if arg == "--env-file" {
			t.Fatal("--env-file emitted without a value")
		}
	}
}
