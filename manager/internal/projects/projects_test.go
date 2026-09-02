package projects

import (
	"bytes"
	"context"
	"os"
	"path/filepath"

	"github.com/vexdock/platform/manager/internal/config"
	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/git"
	"github.com/vexdock/platform/manager/internal/security"

	"strings"
	"testing"
)

func TestNormalizeTags(t *testing.T) {
	got := NormalizeTags([]string{" Client X ", "client-x", "", "  ", "Prod,staging"})
	want := []string{"client-x", "prod-staging"}

	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("got %v, want %v", got, want)
	}
}

// Tags share one comma-separated column, so a comma in a tag would split it in
// two on the way back out.
func TestNormalizeTagsNeverContainsSeparator(t *testing.T) {
	for _, tag := range NormalizeTags([]string{"a,b", "c, d"}) {
		if strings.Contains(tag, ",") {
			t.Fatalf("tag %q still contains the separator", tag)
		}
	}
}

func TestNormalizeTagsCaps(t *testing.T) {
	many := make([]string, MaxTags+5)
	for i := range many {
		many[i] = string(rune('a' + i%26))
	}
	if got := len(NormalizeTags(many)); got > MaxTags {
		t.Fatalf("kept %d tags, want at most %d", got, MaxTags)
	}
}

// Compose interpolates variables inside a double-quoted env value, so anything
// escapeEnvValue quotes has to survive that second pass too. A dollar is the
// dangerous one: unescaped, compose reads p$ssw0rd as p plus an unset variable
// and the container gets p.
func TestEscapeEnvValue(t *testing.T) {
	for _, c := range []struct {
		name  string
		value string
		want  string
	}{
		{"dollar", `p$ssw0rd`, `"p$$ssw0rd"`},
		{"dollar braces", `${HOME}`, `"$${HOME}"`},
		{"empty", ``, `""`},
		{"plain", `simple`, `simple`},
		{"space", `two words`, `"two words"`},
		{"quote", `say "hi"`, `"say \"hi\""`},
		{"newline", "a\nb", `"a\nb"`},
		{"backslash left bare when nothing forces quoting", `C:\tmp`, `C:\tmp`},
		{"backslash doubled once quoted", `C:\tmp dir`, `"C:\\tmp dir"`},
	} {
		t.Run(c.name, func(t *testing.T) {
			if got := escapeEnvValue(c.value); got != c.want {
				t.Fatalf("escapeEnvValue(%q) = %s, want %s", c.value, got, c.want)
			}
		})
	}
}

// A project is a grouping, so creating one takes nothing but a name: the
// question of where code comes from belongs to its services.
func TestCreateTakesNothingButAName(t *testing.T) {
	svc := testService(t)
	ctx := context.Background()

	p, err := svc.Create(ctx, CreateInput{Name: "My App", Tags: []string{"Staging"}})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if p.Slug != "my-app" {
		t.Fatalf("slug %q, want my-app", p.Slug)
	}
	if got := strings.Join(p.Tags, "|"); got != "staging" {
		t.Fatalf("tags %v, want [staging]", p.Tags)
	}
	if _, err := os.ReadDir(svc.repositoryDir(defaultEnv(t, svc, p).ID)); err != nil {
		t.Fatalf("checkout directory: %v", err)
	}
}

// defaultEnv is the environment Create makes alongside a project. Every path
// and every compose call hangs off it now, so the tests reach for it the same
// way the handlers do.
func defaultEnv(t *testing.T, svc *Service, p *database.Project) *database.Environment {
	t.Helper()
	env, err := svc.db.DefaultEnvironment(context.Background(), p.ID)
	if err != nil {
		t.Fatalf("default environment: %v", err)
	}
	return env
}

func testService(t *testing.T) *Service {
	t.Helper()
	root := t.TempDir()
	db, err := database.Open(filepath.Join(root, "app.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })

	cipher, err := security.NewCipher(bytes.Repeat([]byte{7}, 32))
	if err != nil {
		t.Fatalf("cipher: %v", err)
	}
	return New(db, &config.Config{Root: root, ProjectsDir: filepath.Join(root, "projects")}, cipher)
}

// A connected account is what makes a picked repository clonable: the service
// stores no credential of its own, so the token has to come from the account.
func TestCredentialComesFromConnectedAccount(t *testing.T) {
	svc := testService(t)
	ctx := context.Background()

	enc, err := svc.cipher.Encrypt("ghp_secret")
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	account := &database.GitAccount{Provider: "github", Name: "acme", EncryptedTok: enc}
	if err := svc.db.CreateGitAccount(ctx, account); err != nil {
		t.Fatalf("create account: %v", err)
	}

	service := &database.Service{CredentialKind: database.GitCredentialNone}
	if err := svc.SetGitAccount(ctx, service, account.ID); err != nil {
		t.Fatalf("set account: %v", err)
	}
	cred, err := svc.Credential(ctx, service)
	if err != nil {
		t.Fatalf("credential: %v", err)
	}
	if cred.Kind != git.KindToken || cred.Value != "ghp_secret" {
		t.Fatalf("got %+v, want the account token", cred)
	}

	if err := svc.SetGitAccount(ctx, service, ""); err != nil {
		t.Fatalf("clear account: %v", err)
	}
	if cred, err = svc.Credential(ctx, service); err != nil || cred.Kind != git.KindNone {
		t.Fatalf("got %+v, %v, want no credential once the account is cleared", cred, err)
	}
}
