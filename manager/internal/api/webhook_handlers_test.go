package api

import "testing"

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
