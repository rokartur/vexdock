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
	if ref := pushRef(body); ref != "" && !refMatchesBranch(ref, project.Branch) {
		writeJSON(w, http.StatusAccepted, map[string]string{"status": "ignored", "reason": "branch " + ref})
		return
	}

	deployment, err := s.Deployments.Trigger(r.Context(), project, deployments.Options{
		Trigger: deployments.TriggerWebhook,
		Actor:   "webhook",
	})
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, map[string]any{"status": "queued", "deployment_id": deployment.ID})
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
