package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const (
	deployPoll    = 2 * time.Second
	deployTimeout = 15 * time.Minute
	logTailLines  = 50
)

const instructions = `Call whoami first: it says whether this token is an administrator or which projects it reaches, at read or write.
deploy and rollback wait for the pipeline and answer each service's status with the tail of its log.`

type toolbox struct {
	base string
	http *http.Client
}

func (t *toolbox) manager(header http.Header) *manager {
	return &manager{base: t.base, http: t.http, auth: header.Get("Authorization"), clientIP: header.Get("X-Real-IP")}
}

// add registers a tool whose result is JSON, or plain text when run answers a
// string. An error from the manager becomes a tool error the agent can read.
func add[In any](server *mcp.Server, t *toolbox, tool *mcp.Tool, run func(context.Context, *mcp.CallToolRequest, *manager, In) (any, error)) {
	mcp.AddTool(server, tool, func(ctx context.Context, req *mcp.CallToolRequest, in In) (*mcp.CallToolResult, any, error) {
		out, err := run(ctx, req, t.manager(req.Extra.Header), in)
		if err != nil {
			return &mcp.CallToolResult{IsError: true, Content: []mcp.Content{&mcp.TextContent{Text: err.Error()}}}, nil, nil
		}
		text, ok := out.(string)
		if !ok {
			raw, err := json.MarshalIndent(out, "", "  ")
			if err != nil {
				return nil, nil, err
			}
			text = string(raw)
		}
		return &mcp.CallToolResult{Content: []mcp.Content{&mcp.TextContent{Text: text}}}, nil, nil
	})
}

func reading(name, description string) *mcp.Tool {
	return &mcp.Tool{Name: name, Description: description, Annotations: &mcp.ToolAnnotations{ReadOnlyHint: true}}
}

func changing(name, description string, destructive bool) *mcp.Tool {
	return &mcp.Tool{Name: name, Description: description, Annotations: &mcp.ToolAnnotations{DestructiveHint: &destructive}}
}

func environment(id string) url.Values {
	if id == "" {
		return nil
	}
	return url.Values{"environment": {id}}
}

type projectRef struct {
	ProjectID     string `json:"project_id" jsonschema:"the project id from list_projects"`
	EnvironmentID string `json:"environment_id,omitempty" jsonschema:"an environment id from get_project; the project's default environment when omitted"`
}

type serviceRef struct {
	ServiceID string `json:"service_id" jsonschema:"the service id from get_project"`
}

type deploymentRef struct {
	DeploymentID string `json:"deployment_id" jsonschema:"the deployment id from deploy or list_deployments"`
}

type none struct{}

func newServer(t *toolbox, version string) *mcp.Server {
	server := mcp.NewServer(&mcp.Implementation{Name: "vexdock", Version: version}, &mcp.ServerOptions{Instructions: instructions})

	add(server, t, reading("whoami", "The account behind this token and what it may do: admin, or a list of project ids with read or write."),
		func(ctx context.Context, _ *mcp.CallToolRequest, m *manager, _ none) (any, error) {
			return m.call(ctx, http.MethodGet, "/api/me", nil, nil)
		})

	add(server, t, reading("list_projects", "Every project this token can read, with its environments and container counts."),
		func(ctx context.Context, _ *mcp.CallToolRequest, m *manager, _ none) (any, error) {
			return m.call(ctx, http.MethodGet, "/api/projects", nil, nil)
		})

	add(server, t, reading("get_project", "One project in one environment: the project, its environments, services with their state, domains and the last ten deployments."),
		func(ctx context.Context, _ *mcp.CallToolRequest, m *manager, in projectRef) (any, error) {
			base := "/api/projects/" + url.PathEscape(in.ProjectID)
			env := environment(in.EnvironmentID)
			out := map[string]json.RawMessage{}
			for key, path := range map[string]string{"project": "", "environments": "/environments", "services": "/services", "domains": "/domains"} {
				raw, err := m.call(ctx, http.MethodGet, base+path, env, nil)
				if err != nil {
					return nil, err
				}
				out[key] = raw
			}
			var deployments []json.RawMessage
			if err := m.decode(ctx, http.MethodGet, base+"/deployments", env, nil, &deployments); err != nil {
				return nil, err
			}
			deployments = deployments[:min(10, len(deployments))]
			return map[string]any{"project": out["project"], "environments": out["environments"], "services": out["services"], "domains": out["domains"], "recent_deployments": deployments}, nil
		})

	add(server, t, reading("get_service", "One service's configuration and its scheduled tasks."),
		func(ctx context.Context, _ *mcp.CallToolRequest, m *manager, in serviceRef) (any, error) {
			base := "/api/services/" + url.PathEscape(in.ServiceID)
			service, err := m.call(ctx, http.MethodGet, base, nil, nil)
			if err != nil {
				return nil, err
			}
			tasks, err := m.call(ctx, http.MethodGet, base+"/tasks", nil, nil)
			if err != nil {
				return nil, err
			}
			return map[string]json.RawMessage{"service": service, "tasks": tasks}, nil
		})

	type logsInput struct {
		serviceRef
		Tail int `json:"tail,omitempty" jsonschema:"how many of the last lines to read; 200 when omitted"`
	}
	add(server, t, reading("service_logs", "The last lines a service's container wrote. stderr lines are prefixed with [stderr]."),
		func(ctx context.Context, _ *mcp.CallToolRequest, m *manager, in logsInput) (any, error) {
			tail := in.Tail
			if tail <= 0 {
				tail = 200
			}
			query := url.Values{"tail": {fmt.Sprint(tail)}, "follow": {"false"}}
			lines, err := m.events(ctx, "/api/services/"+url.PathEscape(in.ServiceID)+"/logs", query, "log", 0)
			if err != nil {
				return nil, err
			}
			var out strings.Builder
			for _, raw := range lines {
				var line struct {
					Stream string `json:"stream"`
					Text   string `json:"text"`
				}
				if err := json.Unmarshal(raw, &line); err != nil {
					return nil, err
				}
				if line.Stream == "stderr" {
					out.WriteString("[stderr] ")
				}
				out.WriteString(line.Text)
				out.WriteByte('\n')
			}
			return out.String(), nil
		})

	add(server, t, reading("service_stats", "One live CPU, memory, network and disk sample of a running service's container."),
		func(ctx context.Context, _ *mcp.CallToolRequest, m *manager, in serviceRef) (any, error) {
			samples, err := m.events(ctx, "/api/services/"+url.PathEscape(in.ServiceID)+"/stats", nil, "stats", 1)
			if err != nil {
				return nil, err
			}
			if len(samples) == 0 {
				return nil, errors.New("the container sent no sample; is it running?")
			}
			return samples[0], nil
		})

	add(server, t, reading("list_deployments", "The last fifty deployments of one environment of a project, newest first."),
		func(ctx context.Context, _ *mcp.CallToolRequest, m *manager, in projectRef) (any, error) {
			return m.call(ctx, http.MethodGet, "/api/projects/"+url.PathEscape(in.ProjectID)+"/deployments", environment(in.EnvironmentID), nil)
		})

	add(server, t, reading("get_deployment", "One deployment and its pipeline steps, each step's output cut to its last fifty lines."),
		func(ctx context.Context, _ *mcp.CallToolRequest, m *manager, in deploymentRef) (any, error) {
			return deploymentReport(ctx, m, in.DeploymentID)
		})

	add(server, t, reading("list_templates", "The application templates add_service_from_template accepts: the services each adds and the one its domain reaches."),
		func(ctx context.Context, _ *mcp.CallToolRequest, m *manager, _ none) (any, error) {
			return m.call(ctx, http.MethodGet, "/api/templates", nil, nil)
		})

	type deployInput struct {
		ProjectID     string `json:"project_id,omitempty" jsonschema:"deploy every service of this project's environment; give this or service_id"`
		ServiceID     string `json:"service_id,omitempty" jsonschema:"deploy only this service; give this or project_id"`
		EnvironmentID string `json:"environment_id,omitempty" jsonschema:"with project_id: the environment to deploy; the default one when omitted"`
	}
	add(server, t, changing("deploy", "Build and start the latest source of a project or one service, wait for the pipeline (up to 15 minutes) and answer each deployment's status and log tail.", false),
		func(ctx context.Context, req *mcp.CallToolRequest, m *manager, in deployInput) (any, error) {
			var ids []string
			switch {
			case (in.ProjectID == "") == (in.ServiceID == ""):
				return nil, errors.New("give exactly one of project_id and service_id")
			case in.ProjectID != "":
				var queued []struct {
					ID string `json:"id"`
				}
				if err := m.decode(ctx, http.MethodPost, "/api/projects/"+url.PathEscape(in.ProjectID)+"/deploy", environment(in.EnvironmentID), nil, &queued); err != nil {
					return nil, err
				}
				for _, d := range queued {
					ids = append(ids, d.ID)
				}
			default:
				var queued struct {
					ID string `json:"id"`
				}
				if err := m.decode(ctx, http.MethodPost, "/api/services/"+url.PathEscape(in.ServiceID)+"/deploy", nil, nil, &queued); err != nil {
					return nil, err
				}
				ids = []string{queued.ID}
			}
			return waitForDeployments(ctx, req, m, ids)
		})

	add(server, t, changing("cancel_deployment", "Stop a queued or running deployment.", false),
		func(ctx context.Context, _ *mcp.CallToolRequest, m *manager, in deploymentRef) (any, error) {
			return m.call(ctx, http.MethodPost, "/api/deployments/"+url.PathEscape(in.DeploymentID)+"/cancel", nil, nil)
		})

	add(server, t, changing("rollback", "Redeploy the image a past successful deployment built, wait for it and answer its status.", false),
		func(ctx context.Context, req *mcp.CallToolRequest, m *manager, in deploymentRef) (any, error) {
			var queued struct {
				ID string `json:"id"`
			}
			if err := m.decode(ctx, http.MethodPost, "/api/deployments/"+url.PathEscape(in.DeploymentID)+"/rollback", nil, nil, &queued); err != nil {
				return nil, err
			}
			return waitForDeployments(ctx, req, m, []string{queued.ID})
		})

	type actionInput struct {
		serviceRef
		Action string `json:"action" jsonschema:"start, stop or restart"`
	}
	add(server, t, changing("service_action", "Start, stop or restart a service's container without building anything.", false),
		func(ctx context.Context, _ *mcp.CallToolRequest, m *manager, in actionInput) (any, error) {
			if in.Action != "start" && in.Action != "stop" && in.Action != "restart" {
				return nil, errors.New("action must be start, stop or restart")
			}
			return m.call(ctx, http.MethodPost, "/api/services/"+url.PathEscape(in.ServiceID)+"/"+in.Action, nil, nil)
		})

	type execInput struct {
		serviceRef
		Command string `json:"command" jsonschema:"the command line, run by the shell inside the running container"`
		Shell   string `json:"shell,omitempty" jsonschema:"sh or bash; sh when omitted"`
	}
	add(server, t, changing("service_exec", "Run a command in a service's running container and answer its exit code and output. Not interactive; abandoned after ten minutes.", true),
		func(ctx context.Context, _ *mcp.CallToolRequest, m *manager, in execInput) (any, error) {
			body := map[string]string{"command": in.Command}
			if in.Shell != "" {
				body["shell"] = in.Shell
			}
			return m.call(ctx, http.MethodPost, "/api/services/"+url.PathEscape(in.ServiceID)+"/exec", nil, body)
		})

	type variablesRef struct {
		Scope string `json:"scope" jsonschema:"project (every environment), environment (one environment) or service (one service)"`
		ID    string `json:"id" jsonschema:"the id of the project, environment or service the scope names"`
	}
	add(server, t, reading("get_variables", "The variables of one layer, values in clear. A deploy merges project, then environment, then service, the narrowest winning."),
		func(ctx context.Context, _ *mcp.CallToolRequest, m *manager, in variablesRef) (any, error) {
			path, err := variablesPath(in.Scope, in.ID)
			if err != nil {
				return nil, err
			}
			return m.call(ctx, http.MethodGet, path, nil, nil)
		})

	type setVariablesInput struct {
		variablesRef
		Set        map[string]string `json:"set,omitempty" jsonschema:"keys to add or change, with their values"`
		SecretKeys []string          `json:"secret_keys,omitempty" jsonschema:"keys of set to store as secrets; a key already stored keeps its flag otherwise"`
		Remove     []string          `json:"remove,omitempty" jsonschema:"keys to delete"`
	}
	add(server, t, changing("set_variables", "Add, change or remove variables of one layer, leaving every other key as it is. Takes effect on the next deploy.", true),
		func(ctx context.Context, _ *mcp.CallToolRequest, m *manager, in setVariablesInput) (any, error) {
			path, err := variablesPath(in.Scope, in.ID)
			if err != nil {
				return nil, err
			}
			return mergeVariables(ctx, m, path, in.Set, in.SecretKeys, in.Remove)
		})

	type templateInput struct {
		projectRef
		Slug     string `json:"slug" jsonschema:"the template slug from list_templates"`
		Hostname string `json:"hostname,omitempty" jsonschema:"a domain to route to the template's web service, when it has one"`
	}
	add(server, t, changing("add_service_from_template", "Add a template's services to a project environment with generated passwords. Deploy afterwards to start them.", false),
		func(ctx context.Context, _ *mcp.CallToolRequest, m *manager, in templateInput) (any, error) {
			body := map[string]string{"slug": in.Slug}
			if in.Hostname != "" {
				body["hostname"] = in.Hostname
			}
			return m.call(ctx, http.MethodPost, "/api/projects/"+url.PathEscape(in.ProjectID)+"/services/template", environment(in.EnvironmentID), body)
		})

	type updateServiceInput struct {
		serviceRef
		Fields map[string]any `json:"fields" jsonschema:"the fields to change, named as get_service answers them: display_name, branch, image, build_type, dockerfile, build_path, compose_fragment, auto_deploy, mounts and so on"`
	}
	add(server, t, changing("update_service", "Change a service's configuration. Takes effect on the next deploy. Where it comes from (provider, repository, git_provider_id, owner, credentials, image, compose_fragment, registry login) needs an admin token.", false),
		func(ctx context.Context, _ *mcp.CallToolRequest, m *manager, in updateServiceInput) (any, error) {
			return m.call(ctx, http.MethodPatch, "/api/services/"+url.PathEscape(in.ServiceID), nil, in.Fields)
		})

	type domainInput struct {
		projectRef
		Service       string `json:"service" jsonschema:"the compose service name the domain routes to"`
		Hostname      string `json:"hostname" jsonschema:"the fully qualified hostname; its DNS must already point at this server for HTTPS"`
		ContainerPort int    `json:"container_port" jsonschema:"the port the service listens on inside its container"`
		HTTPS         bool   `json:"https_enabled,omitempty" jsonschema:"issue a Let's Encrypt certificate"`
		RedirectHTTPS bool   `json:"redirect_https,omitempty" jsonschema:"redirect plain http to https"`
	}
	add(server, t, changing("add_domain", "Route a hostname to a service. With https_enabled a certificate is issued; a failed issuance still adds the domain and answers a warning.", false),
		func(ctx context.Context, _ *mcp.CallToolRequest, m *manager, in domainInput) (any, error) {
			return m.call(ctx, http.MethodPost, "/api/domains", nil, map[string]any{
				"project_id": in.ProjectID, "environment_id": in.EnvironmentID, "service": in.Service, "hostname": in.Hostname,
				"container_port": in.ContainerPort, "https_enabled": in.HTTPS, "redirect_https": in.RedirectHTTPS,
			})
		})

	type domainRef struct {
		DomainID string `json:"domain_id" jsonschema:"the domain id from get_project"`
	}
	add(server, t, changing("remove_domain", "Stop routing a hostname. The service keeps running.", true),
		func(ctx context.Context, _ *mcp.CallToolRequest, m *manager, in domainRef) (any, error) {
			return m.call(ctx, http.MethodDelete, "/api/domains/"+url.PathEscape(in.DomainID), nil, nil)
		})

	type taskRef struct {
		TaskID string `json:"task_id" jsonschema:"the task id from get_service"`
	}
	add(server, t, changing("run_task", "Run a scheduled task now and answer the run with its output.", false),
		func(ctx context.Context, _ *mcp.CallToolRequest, m *manager, in taskRef) (any, error) {
			return m.call(ctx, http.MethodPost, "/api/tasks/"+url.PathEscape(in.TaskID)+"/run", nil, nil)
		})

	type queryInput struct {
		serviceRef
		Query  string `json:"query" jsonschema:"one SQL statement; it runs as written, writes included"`
		Schema string `json:"schema,omitempty" jsonschema:"the schema or database to run it in, for engines that have several"`
	}
	add(server, t, changing("query_database", "Run SQL against a database service through its own client and answer the rows.", true),
		func(ctx context.Context, _ *mcp.CallToolRequest, m *manager, in queryInput) (any, error) {
			return m.call(ctx, http.MethodPost, "/api/services/"+url.PathEscape(in.ServiceID)+"/studio/query", nil, map[string]string{"query": in.Query, "schema": in.Schema})
		})

	type cleanupInput struct {
		Kind string `json:"kind" jsonschema:"containers, images, networks or build-cache"`
	}
	add(server, t, changing("docker_cleanup", "Remove what no container uses: stopped containers, dangling images, unused networks or the build cache. Admin tokens only. Volumes are never pruned here; that is data.", true),
		func(ctx context.Context, _ *mcp.CallToolRequest, m *manager, in cleanupInput) (any, error) {
			switch in.Kind {
			case "containers", "images", "networks", "build-cache":
				return m.call(ctx, http.MethodPost, "/api/docker/cleanup/"+in.Kind, nil, nil)
			}
			return nil, errors.New("kind must be containers, images, networks or build-cache")
		})

	return server
}

func variablesPath(scope, id string) (string, error) {
	switch scope {
	case "project":
		return "/api/projects/" + url.PathEscape(id) + "/variables", nil
	case "environment":
		return "/api/environments/" + url.PathEscape(id) + "/variables", nil
	case "service":
		return "/api/services/" + url.PathEscape(id) + "/variables", nil
	}
	return "", errors.New("scope must be project, environment or service")
}

type envVar struct {
	Key      string `json:"key"`
	Value    string `json:"value"`
	IsSecret bool   `json:"is_secret"`
}

// mergeVariables turns a partial edit into the whole set the manager's PUT
// replaces, so keys the agent did not mention survive.
func mergeVariables(ctx context.Context, m *manager, path string, set map[string]string, secretKeys, remove []string) (any, error) {
	var current []envVar
	if err := m.decode(ctx, http.MethodGet, path, nil, nil, &current); err != nil {
		return nil, err
	}
	removed := map[string]bool{}
	for _, key := range remove {
		removed[key] = true
	}
	secret := map[string]bool{}
	for _, key := range secretKeys {
		secret[key] = true
	}
	next := []envVar{}
	for _, v := range current {
		if removed[v.Key] {
			continue
		}
		if value, ok := set[v.Key]; ok {
			v.Value = value
			v.IsSecret = v.IsSecret || secret[v.Key]
			delete(set, v.Key)
		}
		next = append(next, v)
	}
	for key, value := range set {
		next = append(next, envVar{Key: key, Value: value, IsSecret: secret[key]})
	}
	if err := m.decode(ctx, http.MethodPut, path, nil, map[string]any{"variables": next}, &current); err != nil {
		return nil, err
	}
	keys := make([]string, 0, len(current))
	for _, v := range current {
		keys = append(keys, v.Key)
	}
	return map[string]any{"keys": keys}, nil
}

type step struct {
	Name   string `json:"name"`
	Status string `json:"status"`
	Output string `json:"output"`
}

type deploymentState struct {
	Deployment struct {
		ID          string `json:"id"`
		ServiceName string `json:"service_name"`
		Status      string `json:"status"`
		Error       string `json:"error"`
	} `json:"deployment"`
	Steps []step `json:"steps"`
}

func deploymentReport(ctx context.Context, m *manager, id string) (*deploymentState, error) {
	var state deploymentState
	if err := m.decode(ctx, http.MethodGet, "/api/deployments/"+url.PathEscape(id), nil, nil, &state); err != nil {
		return nil, err
	}
	for i := range state.Steps {
		state.Steps[i].Output = lastLines(state.Steps[i].Output, logTailLines)
	}
	return &state, nil
}

func finished(status string) bool {
	return status != "queued" && status != "running"
}

// waitForDeployments polls until every deployment has finished or the wait runs
// out, reporting progress so the client does not time the call out.
func waitForDeployments(ctx context.Context, req *mcp.CallToolRequest, m *manager, ids []string) (any, error) {
	ctx, cancel := context.WithTimeout(ctx, deployTimeout)
	defer cancel()
	stillRunning := map[string]any{
		"still_running": ids,
		"note":          "the deployments are still going; follow them with get_deployment",
	}
	reports := make([]*deploymentState, len(ids))
	for tick := 0; ; tick++ {
		done := 0
		var progress []string
		for i, id := range ids {
			if reports[i] != nil && finished(reports[i].Deployment.Status) {
				done++
				continue
			}
			report, err := deploymentReport(ctx, m, id)
			if ctx.Err() != nil {
				return stillRunning, nil
			}
			if err != nil {
				return nil, err
			}
			reports[i] = report
			if finished(report.Deployment.Status) {
				done++
			}
			progress = append(progress, report.Deployment.ServiceName+": "+report.Deployment.Status)
		}
		if done == len(ids) {
			return summarize(reports), nil
		}
		if token := req.Params.GetProgressToken(); token != nil {
			_ = req.Session.NotifyProgress(ctx, &mcp.ProgressNotificationParams{
				ProgressToken: token, Progress: float64(tick), Message: strings.Join(progress, ", "),
			})
		}
		select {
		case <-ctx.Done():
			return stillRunning, nil
		case <-time.After(deployPoll):
		}
	}
}

// summarize keeps, per deployment, the output of the step that decided it: the
// failed one, or the last one.
func summarize(reports []*deploymentState) []map[string]string {
	out := make([]map[string]string, 0, len(reports))
	for _, report := range reports {
		decisive := step{}
		for _, s := range report.Steps {
			decisive = s
			if s.Status == "failed" {
				break
			}
		}
		out = append(out, map[string]string{
			"id": report.Deployment.ID, "service": report.Deployment.ServiceName, "status": report.Deployment.Status,
			"error": report.Deployment.Error, "step": decisive.Name, "log_tail": decisive.Output,
		})
	}
	return out
}

func lastLines(text string, n int) string {
	lines := strings.Split(strings.TrimRight(text, "\n"), "\n")
	if len(lines) <= n {
		return text
	}
	return strings.Join(lines[len(lines)-n:], "\n")
}
