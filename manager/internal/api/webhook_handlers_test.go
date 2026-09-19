package api

import (
	"bytes"
	"context"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/security"
)

// GitLab, Gitea and Bitbucket do not sign their deliveries, so the token in the
// hook URL is the only thing between a push and a deployment.
func TestWebhookProviderRequiresTheToken(t *testing.T) {
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
	secretEnc, err := cipher.Encrypt("s3cret")
	if err != nil {
		t.Fatalf("encrypt: %v", err)
	}
	provider := &database.GitProvider{
		Name:             "acme",
		ProviderType:     database.ProviderGitLab,
		WebhookSecretEnc: secretEnc,
		GitLab:           &database.GitLabProvider{URL: "https://gitlab.com", ApplicationID: "a", AccessTokenEnc: "t"},
	}
	if err := db.CreateGitProvider(context.Background(), provider); err != nil {
		t.Fatalf("create provider: %v", err)
	}

	s := New(Deps{DB: db, Cipher: cipher})
	for query, want := range map[string]bool{"": false, "?token=wrong": false, "?token=s3cret": true} {
		r := httptest.NewRequest("POST", "/api/deploy/gitlab"+query, nil)
		got, err := s.webhookProvider(r, database.ProviderGitLab, nil, pushPayload{})
		if (err == nil) != want {
			t.Errorf("%q: err = %v, want match %v", query, err, want)
		}
		if want && got.ID != provider.ID {
			t.Errorf("%q: matched %v", query, got)
		}
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
