package projects

import (
	"bytes"
	"context"
	"os"
	"path/filepath"

	"github.com/vexdock/platform/manager/internal/config"
	"github.com/vexdock/platform/manager/internal/database"
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

// A project created from nothing but a name has to be complete enough to open:
// a compose source, a starter file on disk, and a checkout that a later switch
// to git can clone into.
func TestCreateWithoutSourceStartsAsCompose(t *testing.T) {
	svc := testService(t)
	ctx := context.Background()

	p, err := svc.Create(ctx, CreateInput{Name: "My App", Tags: []string{"Staging"}})
	if err != nil {
		t.Fatalf("create: %v", err)
	}
	if p.SourceType != database.SourceCompose {
		t.Fatalf("source type %q, want compose", p.SourceType)
	}
	if got := strings.Join(p.Tags, "|"); got != "staging" {
		t.Fatalf("tags %v, want [staging]", p.Tags)
	}
	if content, err := svc.ReadComposeFile(p); err != nil || content != StarterCompose {
		t.Fatalf("compose file %q, err %v", content, err)
	}

	p.SourceType = database.SourceGit
	p.RepositoryURL = "https://github.com/user/app"
	if err := svc.Validate(p); err != nil {
		t.Fatalf("validate git: %v", err)
	}
	if err := svc.ResetCheckout(p); err != nil {
		t.Fatalf("reset checkout: %v", err)
	}
	entries, err := os.ReadDir(svc.RepositoryDir(p))
	if err != nil {
		t.Fatalf("read checkout: %v", err)
	}
	if len(entries) != 0 {
		t.Fatalf("checkout still holds %d entries, git clone needs it empty", len(entries))
	}
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
