package api

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/docker/docker/pkg/stdcopy"

	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/deployments"
	"github.com/vexdock/platform/manager/internal/engines"
	"github.com/vexdock/platform/manager/internal/projects"
	"github.com/vexdock/platform/manager/internal/security"
)

// lookupService resolves the {id} path value to a service, the environment that
// owns it and the project above that, which nearly every service route needs
// together. The environment is the one that matters at runtime: it names the
// containers.
func (s *Server) lookupService(r *http.Request) (*database.Service, *database.Project, *database.Environment, error) {
	service, err := s.DB.ServiceByID(r.Context(), r.PathValue("id"))
	if err != nil {
		return nil, nil, nil, err
	}
	project, err := s.DB.ProjectByID(r.Context(), service.ProjectID)
	if err != nil {
		return nil, nil, nil, err
	}
	env, err := s.DB.EnvironmentByID(r.Context(), service.EnvironmentID)
	if err != nil {
		return nil, nil, nil, err
	}
	return service, project, env, nil
}

// resolveServiceContainer maps a stored service to its current container id.
func (s *Server) resolveServiceContainer(ctx context.Context, serviceID string) (string, error) {
	service, err := s.DB.ServiceByID(ctx, serviceID)
	if err != nil {
		return "", err
	}
	env, err := s.DB.EnvironmentByID(ctx, service.EnvironmentID)
	if err != nil {
		return "", err
	}
	return s.Docker.ServiceContainer(ctx, env.ComposeProjectName, service.ComposeServiceName)
}

func (s *Server) handleGetService(w http.ResponseWriter, r *http.Request) {
	service, err := s.DB.ServiceByID(r.Context(), r.PathValue("id"))
	if handleLookupError(w, err) {
		return
	}
	env, err := s.DB.EnvironmentByID(r.Context(), service.EnvironmentID)
	if handleLookupError(w, err) {
		return
	}
	views, err := s.serviceViews(r.Context(), env)
	if err != nil {
		serverError(w, err)
		return
	}
	for _, v := range views {
		if v.ID == service.ID {
			writeJSON(w, http.StatusOK, v)
			return
		}
	}
	writeError(w, http.StatusNotFound, "NOT_FOUND", "Service not found", nil)
}

// handleCreateService adds a service the manager owns to one environment. It is
// the only way a database reaches a project: the catalog renders it into the
// environment's overlay compose file rather than into a project of its own.
func (s *Server) handleCreateService(w http.ResponseWriter, r *http.Request) {
	_, env, ok := s.projectEnv(w, r)
	if !ok {
		return
	}
	var req struct {
		Name             string `json:"name"`
		Provider         string `json:"provider"`
		RepositoryURL    string `json:"repository_url"`
		Branch           string `json:"branch"`
		BuildPath        string `json:"build_path"`
		CredentialKind   string `json:"credential_kind"`
		CredentialSecret string `json:"credential_secret"`
		Image            string `json:"image"`
		ComposeFragment  string `json:"compose_fragment"`
		Database         *struct {
			Engine   string `json:"engine"`
			Version  string `json:"version"`
			Name     string `json:"name"`
			User     string `json:"user"`
			Password string `json:"password"`
			Image    string `json:"image"`
			DataPath string `json:"data_path"`
		} `json:"database"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	in := projects.ServiceInput{
		Name:             req.Name,
		Provider:         req.Provider,
		RepositoryURL:    req.RepositoryURL,
		Branch:           req.Branch,
		BuildPath:        req.BuildPath,
		CredentialKind:   req.CredentialKind,
		CredentialSecret: req.CredentialSecret,
		Image:            req.Image,
		ComposeFragment:  req.ComposeFragment,
	}
	if req.Database != nil {
		in.Provider = database.ProviderImage
		in.Database = &projects.DatabaseInput{
			Engine:   req.Database.Engine,
			Version:  req.Database.Version,
			Name:     req.Database.Name,
			User:     req.Database.User,
			Password: req.Database.Password,
			Image:    req.Database.Image,
			DataPath: req.Database.DataPath,
		}
	}
	service, err := s.Projects.CreateService(r.Context(), env, in)
	if err != nil {
		badRequest(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, service)
}

// adoptProvider changes where an application comes from. A database is not
// negotiable: its volume and its credentials were rendered from the engine it
// was created with, so a switch would orphan the data it is holding.
func adoptProvider(service *database.Service, want *string) error {
	if want == nil || *want == service.Provider {
		return nil
	}
	if service.Type != database.ServiceApplication {
		return errors.New("a database cannot change provider; delete it and create it again")
	}
	switch {
	case database.GitProvider(*want), *want == database.ProviderImage, *want == database.ProviderRaw:
	default:
		return fmt.Errorf("unknown provider %q", *want)
	}
	service.Provider = *want
	if database.GitProvider(*want) && service.Branch == "" {
		service.Branch = "main"
	}
	return nil
}

// requireCompleteProvider rejects an edit that would leave a service claiming a
// provider it has no address for, which reaches docker as an empty build.
func requireCompleteProvider(service *database.Service) error {
	switch {
	case database.GitProvider(service.Provider) && service.RepositoryURL == "":
		return errors.New("a repository URL is required")
	case service.Provider == database.ProviderImage && service.Image == "":
		return errors.New("an image is required")
	case service.Provider == database.ProviderRaw && strings.TrimSpace(service.ComposeFragment) == "":
		return errors.New("a compose fragment is required")
	}
	return nil
}

func (s *Server) handleUpdateService(w http.ResponseWriter, r *http.Request) {
	service, _, env, err := s.lookupService(r)
	if handleLookupError(w, err) {
		return
	}
	var req struct {
		DisplayName      *string `json:"display_name"`
		Provider         *string `json:"provider"`
		RepositoryURL    *string `json:"repository_url"`
		Branch           *string `json:"branch"`
		BuildPath        *string `json:"build_path"`
		CredentialKind   *string `json:"credential_kind"`
		CredentialSecret *string `json:"credential_secret"`
		Image            *string `json:"image"`
		ComposeFragment  *string `json:"compose_fragment"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	if err := adoptProvider(service, req.Provider); err != nil {
		badRequest(w, err)
		return
	}
	assign(&service.DisplayName, req.DisplayName)
	assign(&service.ComposeFragment, req.ComposeFragment)
	for _, err := range []error{
		assignValid(&service.RepositoryURL, req.RepositoryURL, security.ValidateGitURL),
		assignValid(&service.Branch, req.Branch, security.ValidateGitRef),
		assignValid(&service.BuildPath, req.BuildPath, security.ValidateSubPath),
		assignValid(&service.Image, req.Image, engines.ValidateImage),
	} {
		if err != nil {
			badRequest(w, err)
			return
		}
	}
	if req.CredentialKind != nil {
		secret := ""
		if req.CredentialSecret != nil {
			secret = *req.CredentialSecret
		}
		if err := s.Projects.SetCredential(service, *req.CredentialKind, secret); err != nil {
			badRequest(w, err)
			return
		}
	}
	if err := requireCompleteProvider(service); err != nil {
		badRequest(w, err)
		return
	}
	if err := s.DB.UpdateService(r.Context(), service); err != nil {
		serverError(w, err)
		return
	}
	// The overlay is what docker actually reads, so an edit that never reaches
	// it would silently do nothing on the next deploy.
	if _, err := s.Projects.WriteOverlay(r.Context(), env); err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, service)
}

// handleDeleteService removes a managed service. Its named volume survives on
// purpose: dropping a database's data is a separate, explicit act.
func (s *Server) handleDeleteService(w http.ResponseWriter, r *http.Request) {
	service, _, env, err := s.lookupService(r)
	if handleLookupError(w, err) {
		return
	}
	if err := s.Projects.DeleteService(r.Context(), service, env); err != nil {
		badRequest(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) handleGetServiceEnvironment(w http.ResponseWriter, r *http.Request) {
	service, _, _, err := s.lookupService(r)
	if handleLookupError(w, err) {
		return
	}
	// Unmasked: this is the editor, and handing the value over is the point.
	vars, err := s.Projects.ServiceVariables(r.Context(), service.ID)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, vars)
}

func (s *Server) handlePutServiceEnvironment(w http.ResponseWriter, r *http.Request) {
	service, _, env, err := s.lookupService(r)
	if handleLookupError(w, err) {
		return
	}
	var req struct {
		Variables []projects.EnvVar `json:"variables"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	if err := s.Projects.SetServiceVariables(r.Context(), service.ID, req.Variables); err != nil {
		badRequest(w, err)
		return
	}
	if _, err := s.Projects.WriteOverlay(r.Context(), env); err != nil {
		serverError(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// assign applies an optional request field, leaving the value untouched when
// the caller omitted it.
func assign(dst *string, src *string) {
	if src != nil {
		*dst = *src
	}
}

// assignValid is assign for a field that create validates. An edit reaches the
// same git command and the same compose file as a create, so it has to clear
// the same bar; skipping it here would make PATCH the way around the checks.
func assignValid(dst *string, src *string, validate func(string) (string, error)) error {
	if src == nil {
		return nil
	}
	value, err := validate(*src)
	if err != nil {
		return err
	}
	*dst = value
	return nil
}

// handleDeployService runs the deploy pipeline for one compose service only.
func (s *Server) handleDeployService(w http.ResponseWriter, r *http.Request) {
	service, project, env, err := s.lookupService(r)
	if handleLookupError(w, err) {
		return
	}
	if service.Provider == database.ProviderUnconfigured {
		badRequest(w, errors.New("this service has no provider yet"))
		return
	}
	deployment, err := s.Deployments.Trigger(r.Context(), project, env, deployments.Options{
		Trigger:     deployments.TriggerManual,
		Actor:       actor(r.Context()),
		ServiceName: service.ComposeServiceName,
	})
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusAccepted, deployment)
}

// handleServiceAction implements start/stop/restart; the verb comes from the
// route pattern, never from user input.
func (s *Server) handleServiceAction(w http.ResponseWriter, r *http.Request) {
	containerID, err := s.resolveServiceContainer(r.Context(), r.PathValue("id"))
	if err != nil {
		badRequest(w, err)
		return
	}
	s.containerAction(w, r, containerID, lastPathSegment(r.URL.Path))
}

func (s *Server) handleServiceLogs(w http.ResponseWriter, r *http.Request) {
	containerID, err := s.resolveServiceContainer(r.Context(), r.PathValue("id"))
	if err != nil {
		badRequest(w, err)
		return
	}
	s.streamContainerLogs(w, r, containerID)
}

func (s *Server) handleContainerLogs(w http.ResponseWriter, r *http.Request) {
	s.streamContainerLogs(w, r, r.PathValue("id"))
}

// streamContainerLogs tails container output over SSE. Docker logs are never
// copied into SQLite: they are streamed straight from the engine.
func (s *Server) streamContainerLogs(w http.ResponseWriter, r *http.Request, containerID string) {
	tail := r.URL.Query().Get("tail")
	if tail == "" {
		tail = "200"
	}
	if _, err := strconv.Atoi(tail); err != nil && tail != "all" {
		badRequest(w, errors.New("tail must be a number or 'all'"))
		return
	}
	follow := r.URL.Query().Get("follow") != "false"

	reader, tty, err := s.Docker.Logs(r.Context(), containerID, tail, follow, true)
	if err != nil {
		badRequest(w, err)
		return
	}
	defer reader.Close()

	sse, err := newSSE(w)
	if err != nil {
		serverError(w, err)
		return
	}

	ctx := r.Context()
	lines := make(chan logPayload, 256)
	go func() {
		defer close(lines)
		if tty {
			scanLines(ctx, reader, "stdout", lines)
			return
		}
		// Non-TTY containers use the multiplexed stream format.
		pr, pw := io.Pipe()
		errPr, errPw := io.Pipe()
		// Closing the read ends releases StdCopy if it is parked writing to a
		// pipe this goroutine has stopped draining, which is what happens the
		// moment the client disconnects.
		defer pr.Close()
		defer errPr.Close()
		go func() {
			_, err := stdcopy.StdCopy(pw, errPw, reader)
			_ = pw.CloseWithError(err)
			_ = errPw.CloseWithError(err)
		}()
		done := make(chan struct{})
		go func() {
			scanLines(ctx, errPr, "stderr", lines)
			close(done)
		}()
		scanLines(ctx, pr, "stdout", lines)
		<-done
	}()

	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-r.Context().Done():
			return
		case line, ok := <-lines:
			if !ok {
				_ = sse.send("end", map[string]bool{"done": true})
				return
			}
			if err := sse.send("log", line); err != nil {
				return
			}
		case <-ticker.C:
			if err := sse.keepAlive(); err != nil {
				return
			}
		}
	}
}

type logPayload struct {
	Stream string `json:"stream"`
	Text   string `json:"text"`
}

// scanLines splits a log stream into lines and hands them to out. Every send
// races the context: out is buffered, and a client that disconnects while the
// buffer is full would otherwise park this goroutine forever, since closing the
// reader cannot wake a goroutine already blocked on a channel send.
func scanLines(ctx context.Context, r io.Reader, stream string, out chan<- logPayload) {
	send := func(text string) bool {
		select {
		case out <- logPayload{Stream: stream, Text: text}:
			return true
		case <-ctx.Done():
			return false
		}
	}
	buf := make([]byte, 32*1024)
	var pending strings.Builder
	for {
		n, err := r.Read(buf)
		if n > 0 {
			pending.Write(buf[:n])
			text := pending.String()
			idx := strings.LastIndexByte(text, '\n')
			if idx >= 0 {
				for _, line := range strings.Split(text[:idx], "\n") {
					if !send(line) {
						return
					}
				}
				pending.Reset()
				pending.WriteString(text[idx+1:])
			}
		}
		if err != nil {
			if rest := strings.TrimRight(pending.String(), "\r\n"); rest != "" {
				send(rest)
			}
			return
		}
	}
}

// handleServiceMetrics returns recorded usage for one service. It reads by
// service id, so history survives the redeploys that replace the container.
func (s *Server) handleServiceMetrics(w http.ResponseWriter, r *http.Request) {
	since, bucket := metricsWindow(r)
	points, err := s.DB.ServiceMetrics(r.Context(), r.PathValue("id"), since, bucket)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, points)
}

// handleServiceStats streams CPU/RAM/network/block-IO for one service. Docker's
// own stream pushes every second, which is far denser than anyone reads, so
// this polls on statsInterval instead.
func (s *Server) handleServiceStats(w http.ResponseWriter, r *http.Request) {
	containerID, err := s.resolveServiceContainer(r.Context(), r.PathValue("id"))
	if err != nil {
		badRequest(w, err)
		return
	}
	sse, err := newSSE(w)
	if err != nil {
		serverError(w, err)
		return
	}
	ticker := time.NewTicker(statsInterval)
	defer ticker.Stop()
	for {
		sample, err := s.Docker.Sample(r.Context(), containerID)
		if err != nil {
			return
		}
		if err := sse.send("stats", sample); err != nil {
			return
		}
		select {
		case <-r.Context().Done():
			return
		case <-ticker.C:
		}
	}
}

func lastPathSegment(path string) string {
	trimmed := strings.TrimSuffix(path, "/")
	if idx := strings.LastIndexByte(trimmed, '/'); idx >= 0 {
		return trimmed[idx+1:]
	}
	return trimmed
}
