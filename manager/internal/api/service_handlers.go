package api

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/docker/docker/api/types/container"
	"github.com/docker/docker/pkg/stdcopy"

	dockersdk "github.com/vexdock/platform/manager/internal/docker"
)

// resolveServiceContainer maps a stored service to its current container id.
func (s *Server) resolveServiceContainer(ctx context.Context, serviceID string) (string, error) {
	service, err := s.db.ServiceByID(ctx, serviceID)
	if err != nil {
		return "", err
	}
	project, err := s.db.ProjectByID(ctx, service.ProjectID)
	if err != nil {
		return "", err
	}
	containers, err := s.docker.ListContainers(ctx, project.ComposeProjectName)
	if err != nil {
		return "", err
	}
	var fallback string
	for _, c := range containers {
		if c.Labels[dockersdk.ComposeServiceLabel] != service.ComposeServiceName {
			continue
		}
		if c.State == "running" {
			return c.ID, nil
		}
		fallback = c.ID
	}
	if fallback == "" {
		return "", errors.New("this service has no container yet - deploy the project first")
	}
	return fallback, nil
}

func (s *Server) handleGetService(w http.ResponseWriter, r *http.Request) {
	service, err := s.db.ServiceByID(r.Context(), r.PathValue("id"))
	if handleLookupError(w, err) {
		return
	}
	project, err := s.db.ProjectByID(r.Context(), service.ProjectID)
	if handleLookupError(w, err) {
		return
	}
	views, err := s.serviceViews(r.Context(), project)
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

// handleServiceAction implements start/stop/restart; the verb comes from the
// route pattern, never from user input.
func (s *Server) handleServiceAction(w http.ResponseWriter, r *http.Request) {
	containerID, err := s.resolveServiceContainer(r.Context(), r.PathValue("id"))
	if err != nil {
		badRequest(w, err)
		return
	}
	action := lastPathSegment(r.URL.Path)
	switch action {
	case "start":
		err = s.docker.Start(r.Context(), containerID)
	case "stop":
		err = s.docker.Stop(r.Context(), containerID)
	case "restart":
		err = s.docker.Restart(r.Context(), containerID)
	default:
		badRequest(w, errors.New("unsupported action"))
		return
	}
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
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

	reader, tty, err := s.docker.Logs(r.Context(), containerID, tail, follow, true)
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

	lines := make(chan logPayload, 256)
	go func() {
		defer close(lines)
		if tty {
			scanLines(reader, "stdout", lines)
			return
		}
		// Non-TTY containers use the multiplexed stream format.
		pr, pw := io.Pipe()
		errPr, errPw := io.Pipe()
		go func() {
			_, err := stdcopy.StdCopy(pw, errPw, reader)
			_ = pw.CloseWithError(err)
			_ = errPw.CloseWithError(err)
		}()
		done := make(chan struct{})
		go func() {
			scanLines(errPr, "stderr", lines)
			close(done)
		}()
		scanLines(pr, "stdout", lines)
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

func scanLines(r io.Reader, stream string, out chan<- logPayload) {
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
					out <- logPayload{Stream: stream, Text: line}
				}
				pending.Reset()
				pending.WriteString(text[idx+1:])
			}
		}
		if err != nil {
			if rest := strings.TrimRight(pending.String(), "\r\n"); rest != "" {
				out <- logPayload{Stream: stream, Text: rest}
			}
			return
		}
	}
}

// handleServiceMetrics returns recorded usage for one service. It reads by
// service id, so history survives the redeploys that replace the container.
func (s *Server) handleServiceMetrics(w http.ResponseWriter, r *http.Request) {
	since, bucket := metricsWindow(r)
	points, err := s.db.ServiceMetrics(r.Context(), r.PathValue("id"), since, bucket)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, points)
}

// handleServiceStats streams CPU/RAM/network/block-IO for one service.
func (s *Server) handleServiceStats(w http.ResponseWriter, r *http.Request) {
	containerID, err := s.resolveServiceContainer(r.Context(), r.PathValue("id"))
	if err != nil {
		badRequest(w, err)
		return
	}
	stats, err := s.docker.Stats(r.Context(), containerID, true)
	if err != nil {
		serverError(w, err)
		return
	}
	defer stats.Body.Close()

	sse, err := newSSE(w)
	if err != nil {
		serverError(w, err)
		return
	}
	dec := json.NewDecoder(stats.Body)
	for {
		if r.Context().Err() != nil {
			return
		}
		var frame container.StatsResponse
		if err := dec.Decode(&frame); err != nil {
			return
		}
		if err := sse.send("stats", dockersdk.SampleFrom(&frame)); err != nil {
			return
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
