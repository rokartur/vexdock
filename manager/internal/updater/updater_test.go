package updater

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/vexdock/platform/manager/internal/config"
)

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
