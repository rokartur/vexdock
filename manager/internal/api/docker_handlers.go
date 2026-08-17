package api

import (
	"errors"
	"io"
	"net/http"
	"strings"

	dockersdk "github.com/vexdock/platform/manager/internal/docker"
)

// containerView is the shape the Docker Resources screens render. Foreign
// containers are listed but flagged, so the platform never pretends to manage
// stacks it did not create.
type containerView struct {
	ID       string            `json:"id"`
	Names    []string          `json:"names"`
	Image    string            `json:"image"`
	State    string            `json:"state"`
	Status   string            `json:"status"`
	Created  int64             `json:"created"`
	Labels   map[string]string `json:"labels"`
	Managed  bool              `json:"managed"`
	Project  string            `json:"project"`
	Service  string            `json:"service"`
	Networks []string          `json:"networks"`
}

func (s *Server) handleListContainers(w http.ResponseWriter, r *http.Request) {
	containers, err := s.docker.ListContainers(r.Context(), "")
	if err != nil {
		serverError(w, err)
		return
	}
	managed := map[string]bool{}
	if projects, err := s.db.ListProjects(r.Context()); err == nil {
		for _, p := range projects {
			managed[p.ComposeProjectName] = true
		}
	}
	out := make([]containerView, 0, len(containers))
	for _, c := range containers {
		project := c.Labels[dockersdk.ComposeProjectLabel]
		view := containerView{
			ID:      c.ID,
			Names:   c.Names,
			Image:   c.Image,
			State:   c.State,
			Status:  c.Status,
			Created: c.Created,
			Labels:  c.Labels,
			Managed: managed[project],
			Project: project,
			Service: c.Labels[dockersdk.ComposeServiceLabel],
		}
		if c.NetworkSettings != nil {
			for name := range c.NetworkSettings.Networks {
				view.Networks = append(view.Networks, name)
			}
		}
		out = append(out, view)
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleContainerAction(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	var err error
	switch r.PathValue("action") {
	case "start":
		err = s.docker.Start(r.Context(), id)
	case "stop":
		err = s.docker.Stop(r.Context(), id)
	case "restart":
		err = s.docker.Restart(r.Context(), id)
	case "remove":
		err = s.docker.Remove(r.Context(), id, r.URL.Query().Get("force") == "true")
	default:
		badRequest(w, errors.New("unsupported container action"))
		return
	}
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleListImages(w http.ResponseWriter, r *http.Request) {
	images, err := s.docker.ListImages(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, images)
}

// handlePullImage streams pull progress as SSE so large layers show movement.
func (s *Server) handlePullImage(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Reference string `json:"reference"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	ref := strings.TrimSpace(req.Reference)
	if ref == "" || strings.HasPrefix(ref, "-") {
		badRequest(w, errors.New("a valid image reference is required"))
		return
	}
	reader, err := s.docker.PullImage(r.Context(), ref)
	if err != nil {
		badRequest(w, err)
		return
	}
	defer reader.Close()
	// The pull must finish even if the client disconnects mid-stream, so the
	// body is drained here rather than abandoned.
	body, err := io.ReadAll(reader)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]string{"output": string(body)})
}

func (s *Server) handleRemoveImage(w http.ResponseWriter, r *http.Request) {
	if err := s.docker.RemoveImage(r.Context(), r.PathValue("id"), r.URL.Query().Get("force") == "true"); err != nil {
		badRequest(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleListVolumes(w http.ResponseWriter, r *http.Request) {
	volumes, err := s.docker.ListVolumes(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, volumes.Volumes)
}

func (s *Server) handleRemoveVolume(w http.ResponseWriter, r *http.Request) {
	// Deleting a volume destroys data; the client must confirm explicitly.
	if r.URL.Query().Get("confirm") != "true" {
		writeError(w, http.StatusPreconditionRequired, "CONFIRMATION_REQUIRED",
			"Deleting a volume is irreversible. Repeat the request with confirm=true.", nil)
		return
	}
	if err := s.docker.RemoveVolume(r.Context(), r.PathValue("name"), false); err != nil {
		badRequest(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func (s *Server) handleListNetworks(w http.ResponseWriter, r *http.Request) {
	networks, err := s.docker.ListNetworks(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	detailed := make([]any, 0, len(networks))
	for _, n := range networks {
		inspect, err := s.docker.InspectNetwork(r.Context(), n.ID)
		if err != nil {
			detailed = append(detailed, n)
			continue
		}
		containers := make([]map[string]string, 0, len(inspect.Containers))
		for id, c := range inspect.Containers {
			containers = append(containers, map[string]string{"id": id, "name": c.Name, "ipv4": c.IPv4Address})
		}
		detailed = append(detailed, map[string]any{
			"id": n.ID, "name": n.Name, "driver": n.Driver, "scope": n.Scope,
			"created": n.Created, "labels": n.Labels, "containers": containers,
		})
	}
	writeJSON(w, http.StatusOK, detailed)
}

// handleCleanupPreview reports what a cleanup would reclaim, without touching
// anything. Nothing is ever pruned automatically.
func (s *Server) handleCleanupPreview(w http.ResponseWriter, r *http.Request) {
	usage, err := s.docker.DiskUsage(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	var unusedImages, stoppedContainers, unusedVolumes, buildCache int64
	inUse := map[string]bool{}
	for _, c := range usage.Containers {
		inUse[c.ImageID] = true
		if c.State != "running" {
			stoppedContainers += c.SizeRw
		}
	}
	for _, img := range usage.Images {
		if img.Containers == 0 && !inUse[img.ID] {
			unusedImages += img.Size
		}
	}
	for _, v := range usage.Volumes {
		if v.UsageData != nil && v.UsageData.RefCount == 0 {
			unusedVolumes += v.UsageData.Size
		}
	}
	for _, c := range usage.BuildCache {
		if !c.InUse {
			buildCache += c.Size
		}
	}
	writeJSON(w, http.StatusOK, map[string]int64{
		"unused_images":      unusedImages,
		"build_cache":        buildCache,
		"stopped_containers": stoppedContainers,
		"unused_volumes":     unusedVolumes,
		"layers_size":        usage.LayersSize,
	})
}

func (s *Server) handleCleanup(w http.ResponseWriter, r *http.Request) {
	report, err := s.docker.Prune(r.Context(), r.PathValue("kind"))
	if err != nil {
		badRequest(w, err)
		return
	}
	writeJSON(w, http.StatusOK, report)
}
