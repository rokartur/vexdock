package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/deployments"
	"github.com/vexdock/platform/manager/internal/git"
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
	ref, repos := pushRef(body), pushRepos(body)
	queued, err := s.queueFollowers(r.Context(), project, ref, repos)
	if err != nil {
		serverError(w, err)
		return
	}
	if len(queued) == 0 {
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "ignored", "reason": "branch " + ref})
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"status": "queued", "deployment_ids": queued})
}

// handleProviderWebhook is where a push from a connected provider lands. Unlike
// the per-project hook above it is not told which project it is about: one URL
// serves every repository the connection can see, so the payload's owner and
// repository are what select the services to deploy.
func (s *Server) handleProviderWebhook(w http.ResponseWriter, r *http.Request) {
	providerType := r.PathValue("provider")
	if !git.IsProviderType(providerType) {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Unknown webhook", nil)
		return
	}
	body, err := io.ReadAll(io.LimitReader(r.Body, 1<<20))
	if err != nil {
		badRequest(w, err)
		return
	}
	defer r.Body.Close()

	push := parsePush(body)
	provider, err := s.webhookProvider(r, providerType, body, push)
	if err != nil {
		writeError(w, http.StatusUnauthorized, "SIGNATURE_INVALID", err.Error(), nil)
		return
	}
	if event := r.Header.Get("X-GitHub-Event"); event == "ping" {
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "pong"})
		return
	}
	if push.Owner == "" || push.Repository == "" {
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "ignored", "reason": "no repository in payload"})
		return
	}
	services, err := s.DB.ServicesForRepository(r.Context(), provider.ID, push.Owner, push.Repository, push.Branch())
	if err != nil {
		serverError(w, err)
		return
	}
	queued, err := s.queueEnvironments(r.Context(), services)
	if err != nil {
		serverError(w, err)
		return
	}
	if len(queued) == 0 {
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "ignored", "reason": "nothing tracks " +
			push.Owner + "/" + push.Repository + "@" + push.Branch()})
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"status": "queued", "deployment_ids": queued})
}

// webhookProvider identifies and authenticates the delivery. GitHub signs its
// payload with the secret the manifest generated, which is the strongest check
// available and the only one that tells connections apart when a server holds
// several. The other three hosts do not sign App-style deliveries, so they are
// matched on the repository host instead and a push they claim is only ever
// acted on if a service already tracks that exact repository.
func (s *Server) webhookProvider(r *http.Request, providerType string, body []byte, push pushPayload) (*database.GitProvider, error) {
	ctx := r.Context()
	if providerType == database.ProviderGitHub {
		provider, err := s.DB.GitProviderByInstallation(ctx, push.InstallationID)
		if err != nil {
			return nil, errUnknownWebhook
		}
		secret, err := s.Cipher.Decrypt(provider.GitHub.WebhookSecretEnc)
		if err != nil || secret == "" ||
			!git.VerifyWebhookSignature(secret, body, r.Header.Get("X-Hub-Signature-256")) {
			return nil, errSignatureMismatch
		}
		return provider, nil
	}
	providers, err := s.DB.ListGitProviders(ctx)
	if err != nil {
		return nil, err
	}
	for i := range providers {
		if providers[i].ProviderType == providerType && providers[i].Connected {
			return &providers[i], nil
		}
	}
	return nil, errUnknownWebhook
}

var (
	errUnknownWebhook    = errors.New("Unknown webhook")
	errSignatureMismatch = errors.New("Webhook signature mismatch")
)

// queueEnvironments deploys each environment the matched services live in,
// once. Two services in one environment tracking the same repository is a
// monorepo, and a monorepo deploys as one environment.
func (s *Server) queueEnvironments(ctx context.Context, services []database.Service) ([]string, error) {
	queued := []string{}
	seen := map[string]bool{}
	for _, svc := range services {
		if seen[svc.EnvironmentID] {
			continue
		}
		seen[svc.EnvironmentID] = true
		project, err := s.DB.ProjectByID(ctx, svc.ProjectID)
		if err != nil {
			return nil, err
		}
		if !project.AutoDeploy {
			continue
		}
		env, err := s.DB.EnvironmentByID(ctx, svc.EnvironmentID)
		if err != nil {
			return nil, err
		}
		deployment, err := s.Deployments.Trigger(ctx, project, env, deployments.Options{
			Trigger: deployments.TriggerWebhook,
			Actor:   "webhook",
		})
		if err != nil {
			return nil, err
		}
		queued = append(queued, deployment.ID)
	}
	return queued, nil
}

// queueFollowers deploys the environments of a project that track the pushed
// repository and branch. One push can deploy more than one environment, and
// usually deploys none of the others: production tracks main while staging
// tracks its own branch. A project's services can come from different
// repositories, so the payload's repository has to match too, or a push to one
// would redeploy the other.
func (s *Server) queueFollowers(ctx context.Context, project *database.Project, ref string, repos []string) ([]string, error) {
	envs, err := s.DB.ListEnvironments(ctx, project.ID)
	if err != nil {
		return nil, err
	}
	queued := []string{}
	for i := range envs {
		env := &envs[i]
		matched, err := s.environmentFollows(ctx, env, ref, repos)
		if err != nil {
			return nil, err
		}
		if !matched {
			continue
		}
		deployment, err := s.Deployments.Trigger(ctx, project, env, deployments.Options{
			Trigger: deployments.TriggerWebhook,
			Actor:   "webhook",
		})
		if err != nil {
			return nil, err
		}
		queued = append(queued, deployment.ID)
	}
	return queued, nil
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
		if !database.ClonesFromGit(svc.Provider) {
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
func pushRef(body []byte) string { return parsePush(body).Ref }

// pushPayload is the union of what the four hosts say about a push. Each names
// the repository differently: GitHub, Gitea and GitLab give an "owner/name"
// full name, Bitbucket gives a workspace and a slug, and only Bitbucket puts
// the branch in a changes array rather than in a ref.
type pushPayload struct {
	Ref            string
	Owner          string
	Repository     string
	BitbucketRef   string
	InstallationID string
}

// Branch is the pushed branch with the ref prefix removed, or "" when the
// payload named none.
func (p pushPayload) Branch() string {
	if p.Ref == "" {
		return p.BitbucketRef
	}
	return strings.TrimPrefix(p.Ref, "refs/heads/")
}

func parsePush(body []byte) pushPayload {
	var raw struct {
		Ref        string `json:"ref"`
		Repository struct {
			FullName string `json:"full_name"`
			// Bitbucket's full_name is workspace/slug too, but its own
			// workspace object is what survives a repository rename.
			Workspace struct {
				Slug string `json:"slug"`
			} `json:"workspace"`
			Name string `json:"name"`
			Slug string `json:"slug"`
		} `json:"repository"`
		// GitLab calls the repository a project and gives the pair split apart.
		Project struct {
			PathWithNamespace string `json:"path_with_namespace"`
		} `json:"project"`
		Push struct {
			Changes []struct {
				New struct {
					Name string `json:"name"`
					Type string `json:"type"`
				} `json:"new"`
			} `json:"changes"`
		} `json:"push"`
		Installation struct {
			ID json.Number `json:"id"`
		} `json:"installation"`
	}
	if err := json.Unmarshal(body, &raw); err != nil {
		return pushPayload{}
	}
	out := pushPayload{Ref: raw.Ref, InstallationID: raw.Installation.ID.String()}
	fullName := raw.Repository.FullName
	if fullName == "" {
		fullName = raw.Project.PathWithNamespace
	}
	// The last segment is the repository; everything before it is the owner,
	// which on GitLab can be a nested group several segments deep.
	if i := strings.LastIndex(fullName, "/"); i > 0 {
		out.Owner, out.Repository = fullName[:i], fullName[i+1:]
	}
	if workspace := raw.Repository.Workspace.Slug; workspace != "" {
		out.Owner = workspace
		if slug := raw.Repository.Slug; slug != "" {
			out.Repository = slug
		}
	}
	for _, change := range raw.Push.Changes {
		if change.New.Type == "branch" {
			out.BitbucketRef = change.New.Name
			break
		}
	}
	return out
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
