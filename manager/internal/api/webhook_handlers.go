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
	project, err := s.db.ProjectByWebhookToken(r.Context(), r.PathValue("token"))
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

	deployment, err := s.deployments.Trigger(r.Context(), project, deployments.Options{
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

// handleListTemplates returns the built-in catalog of one-click services.
func (s *Server) handleListTemplates(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, Templates)
}

// Template is a ready-made compose file for a common backing service. It
// creates an ordinary compose project: the platform adds no special database
// subsystem.
type Template struct {
	Slug        string `json:"slug"`
	Name        string `json:"name"`
	Description string `json:"description"`
	Compose     string `json:"compose"`
}

// Templates is the MVP catalog. Each one is plain Docker Compose the user can
// edit after creation.
var Templates = []Template{
	{
		Slug:        "postgres",
		Name:        "PostgreSQL 17",
		Description: "Relational database with a persistent volume.",
		Compose: `services:
  postgres:
    image: postgres:17-alpine
    restart: unless-stopped
    environment:
      POSTGRES_USER: ${POSTGRES_USER:-app}
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?set a password in Environment}
      POSTGRES_DB: ${POSTGRES_DB:-app}
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U ${POSTGRES_USER:-app}"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  postgres_data:
`,
	},
	{
		Slug:        "mysql",
		Name:        "MySQL 8",
		Description: "MySQL server with a persistent volume.",
		Compose: `services:
  mysql:
    image: mysql:8
    restart: unless-stopped
    environment:
      MYSQL_ROOT_PASSWORD: ${MYSQL_ROOT_PASSWORD:?set a password in Environment}
      MYSQL_DATABASE: ${MYSQL_DATABASE:-app}
    volumes:
      - mysql_data:/var/lib/mysql
    healthcheck:
      test: ["CMD", "mysqladmin", "ping", "-h", "localhost"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  mysql_data:
`,
	},
	{
		Slug:        "mariadb",
		Name:        "MariaDB",
		Description: "MariaDB server with a persistent volume.",
		Compose: `services:
  mariadb:
    image: mariadb:11
    restart: unless-stopped
    environment:
      MARIADB_ROOT_PASSWORD: ${MARIADB_ROOT_PASSWORD:?set a password in Environment}
      MARIADB_DATABASE: ${MARIADB_DATABASE:-app}
    volumes:
      - mariadb_data:/var/lib/mysql

volumes:
  mariadb_data:
`,
	},
	{
		Slug:        "valkey",
		Name:        "Valkey (Redis)",
		Description: "Redis-compatible in-memory store with persistence.",
		Compose: `services:
  valkey:
    image: valkey/valkey:8-alpine
    restart: unless-stopped
    command: ["valkey-server", "--appendonly", "yes"]
    volumes:
      - valkey_data:/data
    healthcheck:
      test: ["CMD", "valkey-cli", "ping"]
      interval: 10s
      timeout: 5s
      retries: 5

volumes:
  valkey_data:
`,
	},
	{
		Slug:        "mongodb",
		Name:        "MongoDB",
		Description: "Document database with a persistent volume.",
		Compose: `services:
  mongodb:
    image: mongo:8
    restart: unless-stopped
    environment:
      MONGO_INITDB_ROOT_USERNAME: ${MONGO_USER:-root}
      MONGO_INITDB_ROOT_PASSWORD: ${MONGO_PASSWORD:?set a password in Environment}
    volumes:
      - mongo_data:/data/db

volumes:
  mongo_data:
`,
	},
	{
		Slug:        "minio",
		Name:        "MinIO",
		Description: "S3-compatible object storage.",
		Compose: `services:
  minio:
    image: quay.io/minio/minio
    restart: unless-stopped
    command: ["server", "/data", "--console-address", ":9001"]
    environment:
      MINIO_ROOT_USER: ${MINIO_ROOT_USER:-admin}
      MINIO_ROOT_PASSWORD: ${MINIO_ROOT_PASSWORD:?set a password in Environment}
    volumes:
      - minio_data:/data

volumes:
  minio_data:
`,
	},
}

// templateBySlug is used by the create-project flow when the user picks one.
func templateBySlug(slug string) (Template, bool) {
	for _, t := range Templates {
		if t.Slug == slug {
			return t, true
		}
	}
	return Template{}, false
}
