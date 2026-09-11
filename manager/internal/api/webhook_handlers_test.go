package api

import "testing"

// A push is matched against every git service by repository and branch. The
// endpoint is public and triggers deploys, so the matching is worth a check
// independent of any provider's payload.
func TestNormalizeRepoTreatsTransportsAsOneRepository(t *testing.T) {
	want := "github.com/acme/app"
	for _, url := range []string{
		"https://github.com/acme/app.git",
		"https://github.com/acme/app",
		"ssh://git@github.com/acme/app.git",
		"git@github.com:acme/app.git",
		"GIT@GitHub.com:acme/App.git/",
	} {
		if got := normalizeRepo(url); got != want {
			t.Errorf("normalizeRepo(%q) = %q, want %q", url, got, want)
		}
	}
	if matchesAnyRepo("", []string{"https://github.com/acme/app"}) {
		t.Error("a service with no repository matched a push")
	}
	if matchesAnyRepo("https://github.com/acme/app", []string{"https://github.com/acme/other"}) {
		t.Error("a push from another repository matched")
	}
}

func TestRefMatchesBranch(t *testing.T) {
	if !refMatchesBranch("refs/heads/main", "main") || !refMatchesBranch("main", "main") {
		t.Error("the configured branch did not match its own push")
	}
	if refMatchesBranch("refs/heads/main", "release") || refMatchesBranch("refs/tags/main", "main") {
		t.Error("a different ref matched the branch")
	}
}

func TestPushPayloadFields(t *testing.T) {
	github := []byte(`{"ref":"refs/heads/main","repository":{"clone_url":"https://github.com/acme/app.git","ssh_url":"git@github.com:acme/app.git"}}`)
	if got := pushRef(github); got != "refs/heads/main" {
		t.Errorf("pushRef = %q", got)
	}
	if got := pushRepos(github); len(got) != 2 {
		t.Errorf("pushRepos = %v, want both transports", got)
	}
	gitlab := []byte(`{"ref":"refs/heads/main","project":{"git_http_url":"https://gitlab.com/acme/app.git"}}`)
	if got := pushRepos(gitlab); len(got) != 1 || got[0] != "https://gitlab.com/acme/app.git" {
		t.Errorf("pushRepos(gitlab) = %v", got)
	}
	// An unrecognised payload deploys the configured branch and skips the
	// repository check rather than failing the hook.
	if pushRef([]byte(`not json`)) != "" || len(pushRepos([]byte(`{}`))) != 0 {
		t.Error("an unknown payload should say nothing about ref or repository")
	}
}

// The provider deploy endpoint selects services by owner and repository, so
// each host's way of naming the pair has to come out the same.
func TestParsePushNamesTheRepository(t *testing.T) {
	cases := map[string]struct {
		body           string
		owner, repo    string
		branch         string
		installationID string
	}{
		"github": {
			body:           `{"ref":"refs/heads/main","repository":{"full_name":"acme/app"},"installation":{"id":4213}}`,
			owner:          "acme",
			repo:           "app",
			branch:         "main",
			installationID: "4213",
		},
		"gitlab": {
			body:   `{"ref":"refs/heads/release","project":{"path_with_namespace":"acme/group/app"}}`,
			owner:  "acme/group",
			repo:   "app",
			branch: "release",
		},
		"bitbucket": {
			body: `{"repository":{"workspace":{"slug":"acme"},"slug":"app"},` +
				`"push":{"changes":[{"new":{"name":"main","type":"branch"}}]}}`,
			owner:  "acme",
			repo:   "app",
			branch: "main",
		},
	}
	for name, tc := range cases {
		got := parsePush([]byte(tc.body))
		if got.Owner != tc.owner || got.Repository != tc.repo {
			t.Errorf("%s: got %q/%q, want %q/%q", name, got.Owner, got.Repository, tc.owner, tc.repo)
		}
		if got.Branch() != tc.branch {
			t.Errorf("%s: branch = %q, want %q", name, got.Branch(), tc.branch)
		}
		if got.InstallationID != tc.installationID {
			t.Errorf("%s: installation = %q, want %q", name, got.InstallationID, tc.installationID)
		}
	}
}
