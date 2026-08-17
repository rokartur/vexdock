package api

import (
	"errors"
	"net/http"

	"github.com/vexdock/platform/manager/internal/auth"
	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/deployments"
	"github.com/vexdock/platform/manager/internal/events"
)

func (s *Server) handleGetDeployment(w http.ResponseWriter, r *http.Request) {
	deployment, err := s.db.DeploymentByID(r.Context(), r.PathValue("id"))
	if handleLookupError(w, err) {
		return
	}
	steps, err := s.db.ListSteps(r.Context(), deployment.ID)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"deployment": deployment, "steps": steps})
}

// handleDeploymentEvents streams the live pipeline log. It replays the steps
// already recorded so a late subscriber still sees the whole deployment.
func (s *Server) handleDeploymentEvents(w http.ResponseWriter, r *http.Request) {
	deployment, err := s.db.DeploymentByID(r.Context(), r.PathValue("id"))
	if handleLookupError(w, err) {
		return
	}
	// Subscribe before replaying so nothing is lost in between.
	ch, unsubscribe := s.bus.Subscribe(events.DeploymentTopic(deployment.ID))
	defer unsubscribe()

	sse, err := newSSE(w)
	if err != nil {
		serverError(w, err)
		return
	}
	steps, err := s.db.ListSteps(r.Context(), deployment.ID)
	if err != nil {
		serverError(w, err)
		return
	}
	if err := sse.send("snapshot", map[string]any{"deployment": deployment, "steps": steps}); err != nil {
		return
	}
	if deployment.Status != database.DeploymentQueued && deployment.Status != database.DeploymentRunning {
		_ = sse.send("deployment.closed", nil)
		return
	}
	streamBus(r.Context(), sse, ch)
}

func (s *Server) handleCancelDeployment(w http.ResponseWriter, r *http.Request) {
	if err := s.deployments.Cancel(r.PathValue("id")); err != nil {
		badRequest(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// handleRollback redeploys the exact commit of a previous successful deployment.
func (s *Server) handleRollback(w http.ResponseWriter, r *http.Request) {
	target, err := s.db.DeploymentByID(r.Context(), r.PathValue("id"))
	if handleLookupError(w, err) {
		return
	}
	if target.CommitSHA == "" {
		badRequest(w, errors.New("this deployment has no commit to roll back to"))
		return
	}
	project, err := s.db.ProjectByID(r.Context(), target.ProjectID)
	if handleLookupError(w, err) {
		return
	}
	user, _ := auth.UserFrom(r.Context())
	actor := ""
	if user != nil {
		actor = user.Email
	}
	deployment, err := s.deployments.Trigger(r.Context(), project, deployments.Options{
		Trigger:   deployments.TriggerRollback,
		Actor:     actor,
		CommitSHA: target.CommitSHA,
	})
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, deployment)
}
