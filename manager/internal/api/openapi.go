package api

import (
	"net/http"
	"strings"
)

// handleOpenAPI publishes the machine-readable API description used by the
// future CLI and by anyone generating a client.
func (s *Server) handleOpenAPI(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, s.openAPISpec())
}

type openAPIOperation struct {
	Summary    string                `json:"summary"`
	Tags       []string              `json:"tags"`
	Parameters []openAPIParam        `json:"parameters,omitempty"`
	Responses  map[string]any        `json:"responses"`
	Security   []map[string][]string `json:"security,omitempty"`
}

type openAPIParam struct {
	Name     string         `json:"name"`
	In       string         `json:"in"`
	Required bool           `json:"required"`
	Schema   map[string]any `json:"schema"`
}

// route describes one endpoint for the generated spec.
type route struct {
	method  string
	path    string
	summary string
	tag     string
	public  bool
}

var apiRoutes = []route{
	{"get", "/api/health", "Liveness and dependency health", "system", true},
	{"get", "/api/system/version", "Installed and latest version", "system", true},
	{"get", "/api/auth/status", "Whether setup is needed", "auth", true},
	{"post", "/api/auth/setup", "Create the first administrator", "auth", true},
	{"post", "/api/auth/login", "Start a session", "auth", true},
	{"post", "/api/auth/logout", "End the current session", "auth", false},
	{"get", "/api/auth/me", "Current user and CSRF token", "auth", false},
	{"post", "/api/webhooks/projects/{token}", "Auto-deploy webhook", "webhooks", true},

	{"get", "/api/projects", "List projects", "projects", false},
	{"post", "/api/projects", "Create a project", "projects", false},
	{"get", "/api/projects/{id}", "Get one project", "projects", false},
	{"patch", "/api/projects/{id}", "Update a project", "projects", false},
	{"delete", "/api/projects/{id}", "Delete a project and its stack", "projects", false},
	{"post", "/api/projects/{id}/deploy", "Trigger a deployment", "projects", false},
	{"post", "/api/projects/{id}/redeploy", "Redeploy the current branch", "projects", false},
	{"post", "/api/projects/{id}/stop", "Stop the stack", "projects", false},
	{"get", "/api/projects/{id}/compose", "Read the compose file", "projects", false},
	{"put", "/api/projects/{id}/compose", "Replace the compose file", "projects", false},
	{"get", "/api/projects/{id}/environment", "List environment variables (masked)", "projects", false},
	{"put", "/api/projects/{id}/environment", "Replace environment variables", "projects", false},
	{"get", "/api/projects/{id}/services", "List services with live state", "services", false},
	{"get", "/api/projects/{id}/deployments", "Deployment history", "deployments", false},
	{"get", "/api/projects/{id}/domains", "Domains of a project", "domains", false},

	{"get", "/api/services/{id}", "Service detail", "services", false},
	{"post", "/api/services/{id}/start", "Start a service", "services", false},
	{"post", "/api/services/{id}/stop", "Stop a service", "services", false},
	{"post", "/api/services/{id}/restart", "Restart a service", "services", false},
	{"get", "/api/services/{id}/logs", "Stream logs (SSE)", "services", false},
	{"get", "/api/services/{id}/stats", "Stream CPU/RAM stats (SSE)", "services", false},
	{"get", "/api/services/{id}/terminal", "Interactive terminal (WebSocket)", "services", false},

	{"get", "/api/domains", "List all domains", "domains", false},
	{"post", "/api/domains", "Add a domain", "domains", false},
	{"patch", "/api/domains/{id}", "Update a domain", "domains", false},
	{"delete", "/api/domains/{id}", "Remove a domain", "domains", false},
	{"post", "/api/domains/{id}/certificate", "Issue or renew the certificate", "domains", false},

	{"get", "/api/deployments/{id}", "Deployment with steps", "deployments", false},
	{"get", "/api/deployments/{id}/events", "Stream deployment logs (SSE)", "deployments", false},
	{"post", "/api/deployments/{id}/cancel", "Cancel a running deployment", "deployments", false},
	{"post", "/api/deployments/{id}/rollback", "Redeploy this commit", "deployments", false},

	{"get", "/api/docker/containers", "List all containers on the host", "docker", false},
	{"post", "/api/docker/containers/{id}/{action}", "start | stop | restart | remove", "docker", false},
	{"get", "/api/docker/containers/{id}/logs", "Stream container logs (SSE)", "docker", false},
	{"get", "/api/docker/images", "List images", "docker", false},
	{"post", "/api/docker/images/pull", "Pull an image", "docker", false},
	{"delete", "/api/docker/images/{id}", "Remove an image", "docker", false},
	{"get", "/api/docker/volumes", "List volumes", "docker", false},
	{"delete", "/api/docker/volumes/{name}", "Remove a volume (confirm=true)", "docker", false},
	{"get", "/api/docker/networks", "List networks with connected containers", "docker", false},
	{"get", "/api/docker/cleanup", "Reclaimable space preview", "docker", false},
	{"post", "/api/docker/cleanup/{kind}", "Prune one category", "docker", false},

	{"get", "/api/registries", "List registries", "registries", false},
	{"post", "/api/registries", "Add a registry", "registries", false},
	{"delete", "/api/registries/{id}", "Remove a registry", "registries", false},

	{"get", "/api/tokens", "List API tokens", "tokens", false},
	{"post", "/api/tokens", "Create an API token", "tokens", false},
	{"delete", "/api/tokens/{id}", "Revoke an API token", "tokens", false},

	{"get", "/api/templates", "Built-in service templates", "templates", false},

	{"get", "/api/system/info", "Dashboard summary", "system", false},
	{"get", "/api/system/stats", "Stream host CPU/RAM/disk (SSE)", "system", false},
	{"get", "/api/system/events", "Stream platform events (SSE)", "system", false},
	{"get", "/api/system/settings", "Read platform settings", "system", false},
	{"put", "/api/system/settings", "Update platform settings", "system", false},
	{"get", "/api/system/certificates", "Certificate inventory", "system", false},
	{"get", "/api/system/audit", "Recent state-changing calls", "system", false},
	{"post", "/api/system/backup", "Create a configuration backup", "system", false},
	{"get", "/api/system/backups", "List backups", "system", false},
	{"post", "/api/system/update", "Start a platform update", "system", false},
}

func (s *Server) openAPISpec() map[string]any {
	paths := map[string]map[string]openAPIOperation{}
	for _, rt := range apiRoutes {
		if paths[rt.path] == nil {
			paths[rt.path] = map[string]openAPIOperation{}
		}
		op := openAPIOperation{
			Summary:    rt.summary,
			Tags:       []string{rt.tag},
			Parameters: pathParams(rt.path),
			Responses: map[string]any{
				"200": map[string]any{"description": "Success"},
				"400": errorResponse(),
				"401": errorResponse(),
				"404": errorResponse(),
			},
		}
		if !rt.public {
			op.Security = []map[string][]string{{"sessionCookie": {}}, {"bearerToken": {}}}
		}
		paths[rt.path][rt.method] = op
	}

	return map[string]any{
		"openapi": "3.1.0",
		"info": map[string]any{
			"title":       "Platform Manager API",
			"version":     s.cfg.Version,
			"description": "Management API for the Docker platform. Mutations sent with a session cookie must include the X-CSRF-Token header.",
		},
		"servers": []map[string]string{{"url": "/"}},
		"paths":   paths,
		"components": map[string]any{
			"securitySchemes": map[string]any{
				"sessionCookie": map[string]any{"type": "apiKey", "in": "cookie", "name": "platform_session"},
				"bearerToken":   map[string]any{"type": "http", "scheme": "bearer"},
			},
			"schemas": map[string]any{
				"Error": map[string]any{
					"type": "object",
					"properties": map[string]any{
						"error": map[string]any{
							"type": "object",
							"properties": map[string]any{
								"code":    map[string]any{"type": "string"},
								"message": map[string]any{"type": "string"},
								"details": map[string]any{"type": "object"},
							},
							"required": []string{"code", "message"},
						},
					},
				},
			},
		},
	}
}

func errorResponse() map[string]any {
	return map[string]any{
		"description": "Error",
		"content": map[string]any{
			"application/json": map[string]any{
				"schema": map[string]string{"$ref": "#/components/schemas/Error"},
			},
		},
	}
}

// pathParams derives {placeholders} from the route pattern.
func pathParams(path string) []openAPIParam {
	var params []openAPIParam
	for _, segment := range strings.Split(path, "/") {
		if strings.HasPrefix(segment, "{") && strings.HasSuffix(segment, "}") {
			params = append(params, openAPIParam{
				Name:     strings.Trim(segment, "{}"),
				In:       "path",
				Required: true,
				Schema:   map[string]any{"type": "string"},
			})
		}
	}
	return params
}
