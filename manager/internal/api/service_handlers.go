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
	"github.com/vexdock/platform/manager/internal/docker"
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
	if lookupFailed(w, err) {
		return
	}
	env, err := s.DB.EnvironmentByID(r.Context(), service.EnvironmentID)
	if lookupFailed(w, err) {
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
		ContainerName    string `json:"container_name"`
		Provider         string `json:"provider"`
		RepositoryURL    string `json:"repository_url"`
		Branch           string `json:"branch"`
		BuildPath        string `json:"build_path"`
		CredentialKind   string `json:"credential_kind"`
		CredentialSecret string `json:"credential_secret"`
		GitProviderID    string `json:"git_provider_id"`
		Owner            string `json:"owner"`
		Repository       string `json:"repository"`
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
			// libSQL only.
			SqldNode       string `json:"sqld_node"`
			SqldPrimaryURL string `json:"sqld_primary_url"`
			SqldNamespaces bool   `json:"sqld_namespaces"`
		} `json:"database"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	in := projects.ServiceInput{
		Name:             req.Name,
		ContainerName:    req.ContainerName,
		Provider:         req.Provider,
		RepositoryURL:    req.RepositoryURL,
		Branch:           req.Branch,
		BuildPath:        req.BuildPath,
		CredentialKind:   req.CredentialKind,
		CredentialSecret: req.CredentialSecret,
		GitProviderID:    req.GitProviderID,
		Owner:            req.Owner,
		Repository:       req.Repository,
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
			Sqld: engines.SqldSpec{
				Node:       req.Database.SqldNode,
				PrimaryURL: req.Database.SqldPrimaryURL,
				Namespaces: req.Database.SqldNamespaces,
			},
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
	case database.ClonesFromGit(*want), *want == database.ProviderImage, *want == database.ProviderRaw:
	default:
		return fmt.Errorf("unknown provider %q", *want)
	}
	service.Provider = *want
	if database.ClonesFromGit(*want) && service.Branch == "" {
		service.Branch = "main"
	}
	// The two git sources address a repository in different ways, and leaving
	// the old address behind would make requireCompleteProvider pass on a
	// service that cannot clone.
	if database.ClonesFromConnection(*want) {
		service.RepositoryURL, service.CredentialKind, service.CredentialEnc = "", database.GitCredentialNone, ""
	} else {
		service.GitProviderID, service.Owner, service.Repository = "", "", ""
	}
	// The deploy logs in whenever a username is stored, so it cannot outlive the image source.
	if *want != database.ProviderImage {
		service.RegistryURL, service.RegistryUsername, service.RegistryPasswordEnc = "", "", ""
	}
	return nil
}

// requireCompleteProvider rejects an edit that would leave a service claiming a
// provider it has no address for, which reaches docker as an empty build.
func requireCompleteProvider(service *database.Service) error {
	switch {
	case database.ClonesFromConnection(service.Provider) && service.Repository == "":
		return errors.New("a repository is required")
	case service.Provider == database.ProviderGit && service.RepositoryURL == "":
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
	if lookupFailed(w, err) {
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
		GitProviderID    *string `json:"git_provider_id"`
		Owner            *string `json:"owner"`
		Repository       *string `json:"repository"`
		Image            *string `json:"image"`
		ComposeFragment  *string `json:"compose_fragment"`
		AutoDeploy       *bool   `json:"auto_deploy"`
		PruneBuildCache  *bool   `json:"prune_build_cache"`
		BuildType        *string `json:"build_type"`
		Dockerfile       *string `json:"dockerfile"`
		BuildTarget      *string `json:"build_target"`
		RegistryURL      *string `json:"registry_url"`
		RegistryUsername *string `json:"registry_username"`
		RegistryPassword *string `json:"registry_password"`
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
	assign(&service.AutoDeploy, req.AutoDeploy)
	assign(&service.PruneBuildCache, req.PruneBuildCache)
	for _, err := range []error{
		assignValid(&service.RepositoryURL, req.RepositoryURL, security.ValidateGitURL),
		assignValid(&service.Branch, req.Branch, security.ValidateGitRef),
		assignValid(&service.BuildPath, req.BuildPath, security.ValidateSubPath),
		assignValid(&service.Image, req.Image, engines.ValidateImage),
		assignValid(&service.BuildType, req.BuildType, validateBuildType),
		assignValid(&service.Dockerfile, req.Dockerfile, security.ValidateSubPath),
		assignValid(&service.BuildTarget, req.BuildTarget, security.ValidateBuildTarget),
	} {
		if err != nil {
			badRequest(w, err)
			return
		}
	}
	if req.RegistryURL != nil || req.RegistryUsername != nil || req.RegistryPassword != nil {
		if err := s.Projects.SetRegistryLogin(service,
			valueOr(req.RegistryURL, service.RegistryURL),
			valueOr(req.RegistryUsername, service.RegistryUsername),
			valueOr(req.RegistryPassword, "")); err != nil {
			badRequest(w, err)
			return
		}
	}
	// Repointing a connected service means all three of connection, owner and
	// repository, because any one of them alone names a repository that may not
	// exist.
	if req.GitProviderID != nil || req.Owner != nil || req.Repository != nil {
		if err := s.Projects.SetGitRepository(r.Context(), service,
			valueOr(req.GitProviderID, service.GitProviderID),
			valueOr(req.Owner, service.Owner),
			valueOr(req.Repository, service.Repository)); err != nil {
			badRequest(w, err)
			return
		}
	}
	// A connection is the credential, so an edit that sets one wins over
	// credential fields the same request happened to carry.
	if req.CredentialKind != nil && service.GitProviderID == "" {
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
	if lookupFailed(w, err) {
		return
	}
	if err := s.Projects.DeleteService(r.Context(), service, env); err != nil {
		badRequest(w, err)
		return
	}
	// Every deploy is scoped to one service, so no later deploy would ever
	// remove this container as an orphan: nothing else will ever reap it, which
	// is why a client that hangs up must not abort the removal and why a failure
	// is reported rather than logged.
	removal := context.WithoutCancel(r.Context())
	if id, err := s.Docker.ServiceContainer(removal, env.ComposeProjectName, service.ComposeServiceName); err == nil {
		if err := s.Docker.Remove(removal, id, true); err != nil {
			serverError(w, fmt.Errorf("the service is deleted but its container could not be removed: %w", err))
			return
		}
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleDuplicateService puts the copy in the requested environment, or beside
// the original when the body names none.
func (s *Server) handleDuplicateService(w http.ResponseWriter, r *http.Request) {
	service, _, env, err := s.lookupService(r)
	if lookupFailed(w, err) {
		return
	}
	var req struct {
		Name          string `json:"name"`
		EnvironmentID string `json:"environment_id"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	target := env
	if req.EnvironmentID != "" {
		target, err = s.DB.EnvironmentByID(r.Context(), req.EnvironmentID)
		if lookupFailed(w, err) {
			return
		}
	}
	copied, err := s.Projects.DuplicateService(r.Context(), service, target, req.Name)
	if err != nil {
		badRequest(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, copied)
}

// A volume copy runs a container per volume, so the ceiling is generous.
const moveTimeout = 30 * time.Minute

// handleMoveService carries the volume data across. The old container goes
// first: it belongs to a compose project nothing will deploy again, and its
// volumes have to hold still while they are copied. The source volumes are
// kept, the same way delete keeps them.
func (s *Server) handleMoveService(w http.ResponseWriter, r *http.Request) {
	service, _, env, err := s.lookupService(r)
	if lookupFailed(w, err) {
		return
	}
	var req struct {
		EnvironmentID string `json:"environment_id"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	target, err := s.DB.EnvironmentByID(r.Context(), req.EnvironmentID)
	if lookupFailed(w, err) {
		return
	}
	container, err := s.Projects.CheckMoveService(r.Context(), service, env, target)
	if err != nil {
		badRequest(w, err)
		return
	}
	volumes, err := s.Projects.ServiceVolumes(r.Context(), env, service)
	if err != nil {
		serverError(w, err)
		return
	}

	// From here the work destroys a container and copies data; a browser that
	// navigates away mid-move must not leave the service half-carried.
	ctx, cancel := context.WithTimeout(context.WithoutCancel(r.Context()), moveTimeout)
	defer cancel()

	if id, err := s.Docker.ServiceContainer(ctx, env.ComposeProjectName, service.ComposeServiceName); err == nil {
		if err := s.Docker.Remove(ctx, id, true); err != nil {
			serverError(w, fmt.Errorf("remove the container before moving: %w", err))
			return
		}
	}
	for _, name := range volumes {
		from := env.ComposeProjectName + "_" + name
		to := target.ComposeProjectName + "_" + name
		err := s.Docker.CopyVolume(ctx, from, to)
		if errors.Is(err, docker.ErrVolumeMissing) {
			// The service was never deployed here, so there is no data to carry.
			s.Log.Info("move service volume: nothing to copy", "service", service.ID, "volume", from)
			continue
		}
		if err != nil {
			serverError(w, fmt.Errorf("copy volume %s: %w", from, err))
			return
		}
	}
	if err := s.Projects.MoveService(ctx, service, env, target, container); err != nil {
		badRequest(w, err)
		return
	}
	if err := s.Domains.Reconcile(ctx); err != nil {
		s.Log.Warn("reconcile proxy after service move", "service", service.ID, "error", err)
	}
	writeJSON(w, http.StatusOK, service)
}

func (s *Server) handleGetServiceEnvironment(w http.ResponseWriter, r *http.Request) {
	service, _, _, err := s.lookupService(r)
	if lookupFailed(w, err) {
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
	if lookupFailed(w, err) {
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
func assign[T any](dst *T, src *T) {
	if src != nil {
		*dst = *src
	}
}

// valueOr is assign for a field that has to be passed on rather than stored:
// what the request said, or what the service already holds.
func valueOr(src *string, current string) string {
	if src != nil {
		return *src
	}
	return current
}

func validateBuildType(raw string) (string, error) {
	switch raw {
	case database.BuildDockerfile, database.BuildStatic:
		return raw, nil
	}
	return "", fmt.Errorf("build type must be %s or %s", database.BuildDockerfile, database.BuildStatic)
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
	if lookupFailed(w, err) {
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
const maxLogLine = 64 * 1024

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
			// A stream that never sends a newline (a progress bar, a stray binary
			// blob) would grow pending until the container stops. Flush it instead.
			if pending.Len() > maxLogLine {
				if !send(pending.String()) {
					return
				}
				pending.Reset()
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
