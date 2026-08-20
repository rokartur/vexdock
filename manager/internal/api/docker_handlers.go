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
	containers, err := s.Docker.ListContainers(r.Context(), "")
	if err != nil {
		serverError(w, err)
		return
	}
	managed, err := s.DB.ComposeProjectNames(r.Context())
	if err != nil {
		serverError(w, err)
		return
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
		err = s.Docker.Start(r.Context(), id)
	case "stop":
		err = s.Docker.Stop(r.Context(), id)
	case "restart":
		err = s.Docker.Restart(r.Context(), id)
	case "remove":
		err = s.Docker.Remove(r.Context(), id, r.URL.Query().Get("force") == "true")
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

// imageView, volumeView and networkView keep the four Docker Resources screens
// on one convention. Marshalling the SDK's own PascalCase structs instead would
// hand the dashboard two different shapes from sibling endpoints.
type imageView struct {
	ID         string   `json:"id"`
	RepoTags   []string `json:"repo_tags"`
	Created    int64    `json:"created"`
	Size       int64    `json:"size"`
	Containers int64    `json:"containers"`
}

func (s *Server) handleListImages(w http.ResponseWriter, r *http.Request) {
	images, err := s.Docker.ListImages(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	out := make([]imageView, 0, len(images))
	for _, img := range images {
		out = append(out, imageView{
			ID:         img.ID,
			RepoTags:   img.RepoTags,
			Created:    img.Created,
			Size:       img.Size,
			Containers: img.Containers,
		})
	}
	writeJSON(w, http.StatusOK, out)
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
	reader, err := s.Docker.PullImage(r.Context(), ref)
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
	if err := s.Docker.RemoveImage(r.Context(), r.PathValue("id"), r.URL.Query().Get("force") == "true"); err != nil {
		badRequest(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type volumeView struct {
	Name      string `json:"name"`
	Driver    string `json:"driver"`
	CreatedAt string `json:"created_at"`
	// Size and RefCount are -1 when Docker did not report usage data.
	Size     int64 `json:"size"`
	RefCount int64 `json:"ref_count"`
}

func (s *Server) handleListVolumes(w http.ResponseWriter, r *http.Request) {
	volumes, err := s.Docker.ListVolumes(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	out := make([]volumeView, 0, len(volumes.Volumes))
	for _, v := range volumes.Volumes {
		view := volumeView{Name: v.Name, Driver: v.Driver, CreatedAt: v.CreatedAt, Size: -1, RefCount: -1}
		if v.UsageData != nil {
			view.Size, view.RefCount = v.UsageData.Size, v.UsageData.RefCount
		}
		out = append(out, view)
	}
	writeJSON(w, http.StatusOK, out)
}

func (s *Server) handleRemoveVolume(w http.ResponseWriter, r *http.Request) {
	// Deleting a volume destroys data; the client must confirm explicitly.
	if r.URL.Query().Get("confirm") != "true" {
		writeError(w, http.StatusPreconditionRequired, "CONFIRMATION_REQUIRED",
			"Deleting a volume is irreversible. Repeat the request with confirm=true.", nil)
		return
	}
	if err := s.Docker.RemoveVolume(r.Context(), r.PathValue("name"), false); err != nil {
		badRequest(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]bool{"ok": true})
}

type networkView struct {
	ID         string             `json:"id"`
	Name       string             `json:"name"`
	Driver     string             `json:"driver"`
	Scope      string             `json:"scope"`
	Labels     map[string]string  `json:"labels"`
	Containers []networkContainer `json:"containers"`
}

type networkContainer struct {
	ID   string `json:"id"`
	Name string `json:"name"`
	IPv4 string `json:"ipv4"`
}

func (s *Server) handleListNetworks(w http.ResponseWriter, r *http.Request) {
	networks, err := s.Docker.ListNetworks(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	out := make([]networkView, 0, len(networks))
	for _, n := range networks {
		view := networkView{
			ID: n.ID, Name: n.Name, Driver: n.Driver, Scope: n.Scope, Labels: n.Labels,
			Containers: []networkContainer{},
		}
		// A network that cannot be inspected still belongs in the list; it just
		// has no membership to show.
		if inspect, err := s.Docker.InspectNetwork(r.Context(), n.ID); err == nil {
			for id, c := range inspect.Containers {
				view.Containers = append(view.Containers, networkContainer{ID: id, Name: c.Name, IPv4: c.IPv4Address})
			}
		}
		out = append(out, view)
	}
	writeJSON(w, http.StatusOK, out)
}

// handleCleanupPreview reports what a cleanup would reclaim, without touching
// anything. Nothing is ever pruned automatically.
func (s *Server) handleCleanupPreview(w http.ResponseWriter, r *http.Request) {
	usage, err := s.Docker.DiskUsage(r.Context())
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
	report, err := s.Docker.Prune(r.Context(), r.PathValue("kind"))
	if err != nil {
		badRequest(w, err)
		return
	}
	writeJSON(w, http.StatusOK, report)
}
