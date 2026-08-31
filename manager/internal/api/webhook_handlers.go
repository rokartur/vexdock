package api

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"strings"

	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/deployments"
	"github.com/vexdock/platform/manager/internal/security"
)

// handleWebhook is the auto-deploy entry point. The random per-project token in
// the path is the credential; when a GitHub secret is configured the HMAC
// signature is verified as well.
//
// It deliberately answers 202 for events it ignores (wrong branch, ping) so a
// provider does not disable the hook.
func (s *Server) handleWebhook(w http.ResponseWriter, r *http.Request) {
	project, err := s.DB.ProjectByWebhookToken(r.Context(), r.PathValue("token"))
	if err != nil {
		// Do not distinguish "no such project" from "not allowed".
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Unknown webhook", nil)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		badRequest(w, err)
		return
	}
	defer r.Body.Close()

	if secret := s.setting(r.Context(), webhookSecretKey(project.ID)); secret != "" {
		if !security.VerifyGitHubSignature(secret, body, r.Header.Get("X-Hub-Signature-256")) {
			writeError(w, http.StatusUnauthorized, "SIGNATURE_INVALID", "Webhook signature mismatch", nil)
			return
		}
	}
	if !project.AutoDeploy {
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "ignored", "reason": "auto deploy is disabled"})
		return
	}
	if event := r.Header.Get("X-GitHub-Event"); event == "ping" {
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "pong"})
		return
	}
	envs, err := s.DB.ListEnvironments(r.Context(), project.ID)
	if err != nil {
		serverError(w, err)
		return
	}
	// One push can deploy more than one environment, and usually deploys none of
	// the others: production tracks main while staging tracks its own branch. A
	// project's services can come from different repositories, so the payload's
	// repository has to match too, or a push to one would redeploy the other.
	ref, repos := pushRef(body), pushRepos(body)
	queued := []string{}
	for i := range envs {
		env := &envs[i]
		matched, err := s.environmentFollows(r.Context(), env, ref, repos)
		if err != nil {
			serverError(w, err)
			return
		}
		if !matched {
			continue
		}
		deployment, err := s.Deployments.Trigger(r.Context(), project, env, deployments.Options{
			Trigger: deployments.TriggerWebhook,
			Actor:   "webhook",
		})
		if err != nil {
			serverError(w, err)
			return
		}
		queued = append(queued, deployment.ID)
	}
	if len(queued) == 0 {
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "ignored", "reason": "branch " + ref})
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"status": "queued", "deployment_ids": queued})
}

// webhookSecretKey namespaces a project's optional HMAC secret in settings.
func webhookSecretKey(projectID string) string { return "webhook_secret:" + projectID }

// environmentFollows reports whether a push should redeploy an environment: one
// of its git services has to track both the pushed repository and the pushed
// branch. An environment branch overrides what its services ask for.
func (s *Server) environmentFollows(ctx context.Context, env *database.Environment, ref string, repos []string) (bool, error) {
	services, err := s.DB.ListServices(ctx, env.ID)
	if err != nil {
		return false, err
	}
	for _, svc := range services {
		if !database.GitProvider(svc.Provider) {
			continue
		}
		if len(repos) > 0 && !matchesAnyRepo(svc.RepositoryURL, repos) {
			continue
		}
		branch := env.Branch
		if branch == "" {
			branch = svc.Branch
		}
		if ref == "" || refMatchesBranch(ref, branch) {
			return true, nil
		}
	}
	return false, nil
}

// pushRef extracts the git ref from a GitHub/Gitea/GitLab push payload. An
// unrecognised payload returns "", which means "deploy the configured branch".
func pushRef(body []byte) string {
	var payload struct {
		Ref string `json:"ref"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return ""
	}
	return payload.Ref
}

// pushRepos lists every URL a push payload gives for the repository it came
// from. GitHub, Gitea and Bitbucket nest it under "repository", GitLab under
// "project", and each offers the clone URL in more than one transport. An empty
// result means the payload said nothing, and the repository check is skipped.
func pushRepos(body []byte) []string {
	var payload struct {
		Repository struct {
			CloneURL string `json:"clone_url"`
			SSHURL   string `json:"ssh_url"`
			HTMLURL  string `json:"html_url"`
			Links    struct {
				HTML struct {
					Href string `json:"href"`
				} `json:"html"`
			} `json:"links"`
		} `json:"repository"`
		Project struct {
			GitHTTPURL string `json:"git_http_url"`
			GitSSHURL  string `json:"git_ssh_url"`
		} `json:"project"`
	}
	if err := json.Unmarshal(body, &payload); err != nil {
		return nil
	}
	out := []string{}
	for _, url := range []string{
		payload.Repository.CloneURL, payload.Repository.SSHURL, payload.Repository.HTMLURL,
		payload.Repository.Links.HTML.Href, payload.Project.GitHTTPURL, payload.Project.GitSSHURL,
	} {
		if url != "" {
			out = append(out, url)
		}
	}
	return out
}

func matchesAnyRepo(configured string, repos []string) bool {
	want := normalizeRepo(configured)
	if want == "" {
		return false
	}
	for _, repo := range repos {
		if normalizeRepo(repo) == want {
			return true
		}
	}
	return false
}

// normalizeRepo reduces a repository URL to host and path so the same
// repository compares equal across https, ssh and scp-style git addresses.
func normalizeRepo(url string) string {
	s := strings.ToLower(strings.TrimSpace(url))
	if i := strings.Index(s, "://"); i >= 0 {
		s = s[i+3:]
	}
	if i := strings.Index(s, "@"); i >= 0 {
		s = s[i+1:]
	}
	// scp form is host:owner/repo; the colon is the path separator there.
	if i := strings.Index(s, ":"); i >= 0 {
		s = s[:i] + "/" + strings.TrimPrefix(s[i+1:], "/")
	}
	s = strings.TrimSuffix(strings.TrimRight(s, "/"), ".git")
	return strings.TrimRight(s, "/")
}

func refMatchesBranch(ref, branch string) bool {
	return ref == branch || strings.TrimPrefix(ref, "refs/heads/") == branch
}
