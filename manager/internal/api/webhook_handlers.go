package api

import (
	"context"
	"crypto/subtle"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strings"

	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/deployments"
	"github.com/vexdock/platform/manager/internal/git"
)

// handleProviderWebhook is where a push from a connected provider lands. It is
// not told which project it is about: one URL serves every repository the
// connection can see, so the payload's owner and repository are what select the
// services to deploy.
//
// It deliberately answers 202 for events it ignores (nothing tracks the
// repository, ping) so a provider does not disable the hook.
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
	queued, err := s.queueServices(r.Context(), services)
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
// several. The other three hosts do not sign App-style deliveries at all, so
// their hook URL carries a per-connection token instead: Bitbucket Cloud has no
// secret field to put one in, and a query parameter is the one transport all
// three can carry.
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
	token := r.URL.Query().Get("token")
	if token == "" {
		return nil, errSignatureMismatch
	}
	providers, err := s.DB.ListGitProviders(ctx)
	if err != nil {
		return nil, err
	}
	for i := range providers {
		if providers[i].ProviderType != providerType || !providers[i].Connected {
			continue
		}
		secret, err := s.Cipher.Decrypt(providers[i].WebhookSecretEnc)
		if err != nil {
			continue
		}
		if subtle.ConstantTimeCompare([]byte(token), []byte(secret)) == 1 {
			return &providers[i], nil
		}
	}
	return nil, errSignatureMismatch
}

var (
	errUnknownWebhook    = errors.New("Unknown webhook")
	errSignatureMismatch = errors.New("Webhook signature mismatch")
)

// queueServices deploys every matched service. Two services of one environment
// tracking the same repository is a monorepo, and each of them deploys on its
// own.
func (s *Server) queueServices(ctx context.Context, services []database.Service) ([]string, error) {
	queued := []string{}
	for _, svc := range services {
		if !svc.AutoDeploy {
			continue
		}
		project, err := s.DB.ProjectByID(ctx, svc.ProjectID)
		if err != nil {
			return nil, err
		}
		env, err := s.DB.EnvironmentByID(ctx, svc.EnvironmentID)
		if err != nil {
			return nil, err
		}
		deployment, err := s.Deployments.Trigger(ctx, project, env, deployments.Options{
			Trigger:     deployments.TriggerWebhook,
			Actor:       "webhook",
			ServiceName: svc.ComposeServiceName,
		})
		if err != nil {
			return nil, err
		}
		queued = append(queued, deployment.ID)
	}
	return queued, nil
}

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
