package updater

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/vexdock/platform/manager/internal/config"
)

func TestStateReadsIdleForMissingMalformedOrStale(t *testing.T) {
	s := &Service{cfg: &config.Config{SystemDir: filepath.Join(t.TempDir(), "system")}}

	if st := s.State(); st.Phase != PhaseIdle {
		t.Fatalf("missing file: phase = %q, want idle", st.Phase)
	}

	s.writeState(State{Phase: PhasePulling, Target: "v1.1.0"})
	if st := s.State(); st.Phase != PhasePulling || st.Target != "v1.1.0" {
		t.Fatalf("fresh active state = %+v", st)
	}

	write := func(st State) {
		data, err := json.Marshal(st)
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(s.statePath(), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}

	old := time.Now().Add(-time.Hour).Unix()
	write(State{Phase: PhasePulling, Target: "v1.1.0", At: old})
	if st := s.State(); st.Phase != PhaseIdle {
		t.Fatalf("stale active state: phase = %q, want idle", st.Phase)
	}

	// Terminal phases are results, not liveness claims; age must not erase them.
	write(State{Phase: PhaseRolledBack, Target: "v1.1.0", Error: "pull failed", At: old})
	if st := s.State(); st.Phase != PhaseRolledBack || st.Error != "pull failed" {
		t.Fatalf("old terminal state = %+v", st)
	}

	if err := os.WriteFile(s.statePath(), []byte("not json"), 0o644); err != nil {
		t.Fatal(err)
	}
	if st := s.State(); st.Phase != PhaseIdle {
		t.Fatalf("malformed file: phase = %q, want idle", st.Phase)
	}
}

func TestIncludePrerelease(t *testing.T) {
	cases := []struct {
		setting, current string
		want             bool
	}{
		{"true", "v1.0.0", true},
		{"false", "v1.0.0-beta.1", false},
		{"", "v1.0.0-beta.1", true},
		{"", "v1.0.0", false},
	}
	for _, tc := range cases {
		if got := IncludePrerelease(tc.setting, tc.current); got != tc.want {
			t.Fatalf("IncludePrerelease(%q, %q) = %v, want %v", tc.setting, tc.current, got, tc.want)
		}
	}
}

func TestLatestVersionIncludesPrereleaseWhenAsked(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/releases" {
			t.Fatalf("path = %s, want /releases", r.URL.Path)
		}
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`[
			{"tag_name":"v0.1.0-beta.2","draft":false,"prerelease":true},
			{"tag_name":"v0.1.0-beta.1","draft":false,"prerelease":true}
		]`))
	}))
	t.Cleanup(srv.Close)

	s := &Service{
		cfg:        &config.Config{Version: "v0.1.0-beta.1"},
		releaseAPI: srv.URL + "/releases",
	}
	st := s.Status(context.Background(), true)
	if st.Latest != "v0.1.0-beta.2" {
		t.Fatalf("latest = %q, want v0.1.0-beta.2", st.Latest)
	}
	if !st.UpdateAvailable || !st.Beta {
		t.Fatalf("status = %+v", st)
	}
}

func TestLatestVersionRefreshesAfterTwoMinutes(t *testing.T) {
	latest := "v0.1.0-beta.8"
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[{"tag_name":"` + latest + `","draft":false,"prerelease":true}]`))
	}))
	t.Cleanup(srv.Close)

	s := &Service{
		cfg:        &config.Config{Version: "v0.1.0-beta.8"},
		releaseAPI: srv.URL,
	}
	if st := s.Status(context.Background(), true); st.UpdateAvailable {
		t.Fatalf("initial status = %+v", st)
	}

	latest = "v0.1.0-beta.9"
	s.latestAt = time.Now().Add(-2 * time.Minute)
	st := s.Status(context.Background(), true)
	if st.Latest != latest || !st.UpdateAvailable {
		t.Fatalf("status after release = %+v, want latest %q", st, latest)
	}
}

func TestLatestVersionSkipsPrereleaseOnStableTrack(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[
			{"tag_name":"v0.1.0-beta.2","draft":false,"prerelease":true},
			{"tag_name":"v0.0.9","draft":false,"prerelease":false}
		]`))
	}))
	t.Cleanup(srv.Close)

	s := &Service{
		cfg:        &config.Config{Version: "v0.0.9"},
		releaseAPI: srv.URL + "/releases",
	}
	st := s.Status(context.Background(), false)
	if st.Latest != "v0.0.9" {
		t.Fatalf("latest = %q, want v0.0.9", st.Latest)
	}
	if st.UpdateAvailable || st.Beta {
		t.Fatalf("status = %+v", st)
	}
}

// GitHub returns the release list ordered by tag name, so beta.10 arrives
// after beta.2 and an installed beta.10 must not be offered beta.9.
func TestLatestVersionPicksHighestSemverNotFirstEntry(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[
			{"tag_name":"v0.1.0-beta.9","draft":false,"prerelease":true},
			{"tag_name":"v0.1.0-beta.2","draft":false,"prerelease":true},
			{"tag_name":"v0.1.0-beta.10","draft":false,"prerelease":true},
			{"tag_name":"v0.1.0-beta.1","draft":false,"prerelease":true}
		]`))
	}))
	t.Cleanup(srv.Close)

	s := &Service{
		cfg:        &config.Config{Version: "v0.1.0-beta.10"},
		releaseAPI: srv.URL + "/releases",
	}
	st := s.Status(context.Background(), true)
	if st.Latest != "v0.1.0-beta.10" {
		t.Fatalf("latest = %q, want v0.1.0-beta.10", st.Latest)
	}
	if st.UpdateAvailable {
		t.Fatalf("offered a downgrade: %+v", st)
	}
}

func TestLatestVersionSkipsDrafts(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[
			{"tag_name":"v9.9.9","draft":true,"prerelease":false},
			{"tag_name":"v0.1.0-beta.2","draft":false,"prerelease":true}
		]`))
	}))
	t.Cleanup(srv.Close)

	s := &Service{
		cfg:        &config.Config{Version: "v0.1.0-beta.2"},
		releaseAPI: srv.URL + "/releases",
	}
	st := s.Status(context.Background(), true)
	if st.Latest != "v0.1.0-beta.2" {
		t.Fatalf("latest = %q, want v0.1.0-beta.2", st.Latest)
	}
	if st.UpdateAvailable {
		t.Fatal("did not expect update_available when current equals latest")
	}
}

func TestUpdateScriptCleansPreviousImagesOnlyWhenRequested(t *testing.T) {
	cases := []struct {
		cleanup string
		want    string
	}{
		{"false", ""},
		{"true", "ghcr.io/test/manager:v1.0.0"},
	}
	for _, tc := range cases {
		t.Run(tc.cleanup, func(t *testing.T) {
			root := t.TempDir()
			bin := filepath.Join(root, "bin")
			if err := os.MkdirAll(filepath.Join(root, "system"), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.Mkdir(bin, 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, "compose.yml"), []byte("services: {}\n"), 0o644); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, ".env"), nil, 0o600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(root, "update.sh"), Script, 0o755); err != nil {
				t.Fatal(err)
			}

			removedPath := filepath.Join(root, "removed-images")
			docker := `#!/bin/sh
set -eu
case "$1" in
    compose)
        case "$*" in
            *" config --images")
                if grep -q '^VERSION=v1.1.0$' "$PLATFORM_ROOT/.env"; then
                    printf '%s\n' ghcr.io/test/manager:v1.1.0 ghcr.io/test/auth:shared
                else
                    printf '%s\n' ghcr.io/test/manager:v1.0.0 ghcr.io/test/auth:shared
                fi
                ;;
            *" pull"|*" up -d --remove-orphans") ;;
            *) echo "unexpected compose command: $*" >&2; exit 1 ;;
        esac
        ;;
    inspect) echo healthy ;;
    image)
        [ "$2" = rm ]
        printf '%s\n' "$3" >> "$REMOVED_IMAGES"
        ;;
    rm)
        [ "$3" = vexdock-updater ]
        : > "$PLATFORM_ROOT/self-removed"
        ;;
    *) echo "unexpected docker command: $*" >&2; exit 1 ;;
esac
`
			if err := os.WriteFile(filepath.Join(bin, "docker"), []byte(docker), 0o755); err != nil {
				t.Fatal(err)
			}

			t.Setenv("PATH", bin+string(os.PathListSeparator)+os.Getenv("PATH"))
			t.Setenv("PLATFORM_ROOT", root)
			t.Setenv("REMOVED_IMAGES", removedPath)
			cmd := exec.Command("sh", "update.sh", "v1.1.0", tc.cleanup)
			cmd.Dir = root
			if out, err := cmd.CombinedOutput(); err != nil {
				t.Fatalf("update script: %v\n%s", err, out)
			}

			if _, err := os.Stat(filepath.Join(root, "self-removed")); err != nil {
				t.Fatalf("successful update did not remove its own container: %v", err)
			}

			// The script's state() helper must write JSON the Go State reader
			// understands, ending in phase done on success.
			stateService := &Service{cfg: &config.Config{SystemDir: filepath.Join(root, "system")}}
			if st := stateService.State(); st.Phase != PhaseDone || st.Target != "v1.1.0" {
				t.Fatalf("state after successful update = %+v", st)
			}

			removed, err := os.ReadFile(removedPath)
			if err != nil && !os.IsNotExist(err) {
				t.Fatal(err)
			}
			if got := strings.TrimSpace(string(removed)); got != tc.want {
				t.Fatalf("removed images = %q, want %q", got, tc.want)
			}
		})
	}
}
