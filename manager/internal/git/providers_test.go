package git

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Each provider answers in its own field names; the picker only works if all
// three land on the same three fields.
func TestListRepositoriesMapsEveryProviderShape(t *testing.T) {
	cases := []struct {
		provider string
		auth     string
		body     string
	}{
		{
			provider: "github",
			auth:     "Bearer t",
			body:     `[{"full_name":"acme/api","clone_url":"https://github.com/acme/api.git","default_branch":"trunk"}]`,
		},
		{
			provider: "gitea",
			auth:     "token t",
			body:     `[{"full_name":"acme/api","clone_url":"https://github.com/acme/api.git","default_branch":"trunk"}]`,
		},
		{
			provider: "gitlab",
			auth:     "t",
			body: `[{"path_with_namespace":"acme/api","http_url_to_repo":"https://github.com/acme/api.git",
				"default_branch":"trunk"}]`,
		},
	}
	for _, tc := range cases {
		t.Run(tc.provider, func(t *testing.T) {
			var gotAuth string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotAuth = r.Header.Get("Authorization") + r.Header.Get("PRIVATE-TOKEN")
				_, _ = w.Write([]byte(tc.body))
			}))
			defer srv.Close()

			repos, err := listRepositories(context.Background(), tc.provider, srv.URL, "t")
			if err != nil {
				t.Fatalf("list: %v", err)
			}
			if gotAuth != tc.auth {
				t.Errorf("auth = %q, want %q", gotAuth, tc.auth)
			}
			if len(repos) != 1 {
				t.Fatalf("got %d repositories, want 1", len(repos))
			}
			want := Repository{
				FullName:      "acme/api",
				CloneURL:      "https://github.com/acme/api.git",
				DefaultBranch: "trunk",
			}
			if repos[0] != want {
				t.Errorf("got %+v, want %+v", repos[0], want)
			}
		})
	}
}

// A clone URL arrives over the network, so a provider that answers with
// something git would not accept must not reach a service.
func TestListRepositoriesDropsUncloneableURL(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`[{"full_name":"acme/api","clone_url":"file:///etc/passwd"}]`))
	}))
	defer srv.Close()

	repos, err := listRepositories(context.Background(), "github", srv.URL, "t")
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(repos) != 0 {
		t.Errorf("got %+v, want the entry dropped", repos)
	}
}

// Every provider names a branch the same way; only the path differs, and
// GitLab's is the one that has to carry an encoded slash.
func TestListBranchesPerProviderPath(t *testing.T) {
	want := map[string]string{
		"github": "/repos/acme/api/branches",
		"gitea":  "/repos/acme/api/branches",
		"gitlab": "/projects/acme%2Fapi/repository/branches",
	}
	for provider, wantPath := range want {
		t.Run(provider, func(t *testing.T) {
			var gotPath string
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				gotPath = r.URL.EscapedPath()
				_, _ = w.Write([]byte(`[{"name":"main"},{"name":"../etc"}]`))
			}))
			defer srv.Close()

			branches, err := listBranches(context.Background(), provider, srv.URL, "t", "acme/api")
			if err != nil {
				t.Fatalf("list: %v", err)
			}
			if gotPath != wantPath {
				t.Errorf("path = %q, want %q", gotPath, wantPath)
			}
			// The traversing name is not a ref git would check out.
			if len(branches) != 1 || branches[0] != "main" {
				t.Errorf("got %q, want [main]", branches)
			}
		})
	}
}

// The repository name comes from the dashboard and is interpolated into a URL
// path, so it never leaves the shape a provider uses.
func TestListBranchesRejectsRepoOutsidePathShape(t *testing.T) {
	for _, repo := range []string{"acme", "acme/../../admin", "acme/api?x=1", ""} {
		if _, err := ListBranches(context.Background(), "github", "", "t", repo); err == nil {
			t.Errorf("ListBranches(%q) = nil error, want a rejection", repo)
		}
	}
}

func TestAPIBase(t *testing.T) {
	cases := []struct {
		provider, host, want string
	}{
		{provider: "github", want: "https://api.github.com"},
		{provider: "github", host: "https://git.example.com/", want: "https://git.example.com/api/v3"},
		{provider: "gitlab", want: "https://gitlab.com/api/v4"},
		{provider: "gitea", host: "https://git.example.com", want: "https://git.example.com/api/v1"},
		{provider: "gitea", want: ""},                                  // a self-hosted provider needs its host
		{provider: "github", host: "http://git.example.com", want: ""}, // a token is never sent in the clear
		{provider: "git", host: "", want: ""},                          // a plain git URL has no API
	}
	for _, tc := range cases {
		got, err := APIBase(tc.provider, tc.host)
		if tc.want == "" {
			if err == nil {
				t.Errorf("APIBase(%q, %q) = %q, want an error", tc.provider, tc.host, got)
			}
			continue
		}
		if err != nil || got != tc.want {
			t.Errorf("APIBase(%q, %q) = %q, %v, want %q", tc.provider, tc.host, got, err, tc.want)
		}
	}
}
