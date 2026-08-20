package api

import (
	"encoding/json"
	"io"
	"net/http"
	"strings"

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
	// the others: production tracks main while staging tracks its own branch, so
	// each environment is matched against the branch it actually follows.
	ref := pushRef(body)
	queued := []string{}
	for i := range envs {
		env := &envs[i]
		branch := env.Branch
		if branch == "" {
			branch = project.Branch
		}
		if ref != "" && !refMatchesBranch(ref, branch) {
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

func refMatchesBranch(ref, branch string) bool {
	return ref == branch || strings.TrimPrefix(ref, "refs/heads/") == branch
}
