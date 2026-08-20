package api

import (
	"errors"
	"net/http"

	"github.com/vexdock/platform/manager/internal/engines"
)

// handleListEngines returns the database catalog the create form is built from.
func (s *Server) handleListEngines(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, engines.Catalog)
}

// handleEngineVersions lists the image tags one engine offers. The answer is
// best effort by design: when Docker Hub is unreachable the catalog's offline
// list is returned with 200 rather than failing the form, and `live` says which
// of the two the caller got.
func (s *Server) handleEngineVersions(w http.ResponseWriter, r *http.Request) {
	engine, ok := engines.BySlug(r.PathValue("slug"))
	if !ok {
		writeError(w, http.StatusNotFound, "NOT_FOUND", "Unknown database engine", nil)
		return
	}
	if engine.Repository == "" {
		badRequest(w, errors.New("a custom image has no version list; type the full image reference"))
		return
	}
	versions, err := engines.Versions(r.Context(), engine)
	if err != nil {
		s.Log.Debug("engine version lookup fell back to the catalog", "engine", engine.Slug, "error", err)
	}
	writeJSON(w, http.StatusOK, map[string]any{"versions": versions, "live": err == nil})
}

// handleServiceDatabase is the connection panel of a database service. The
// values come from that service's own environment, which is what the container
// was started with, so an edited variable is reflected here immediately.
func (s *Server) handleServiceDatabase(w http.ResponseWriter, r *http.Request) {
	service, _, env, err := s.lookupService(r)
	if handleLookupError(w, err) {
		return
	}
	engine, ok := engines.BySlug(service.Engine)
	if !ok {
		badRequest(w, errors.New("this service is not a database"))
		return
	}
	// Unmasked: the connection panel exists to hand over the password, and the
	// route is behind the same session guard as the environment editor.
	vars, err := s.Projects.ServiceVariables(r.Context(), service.ID)
	if err != nil {
		serverError(w, err)
		return
	}
	values := make(map[string]string, len(vars))
	for _, v := range vars {
		values[v.Key] = v.Value
	}
	writeJSON(w, http.StatusOK, struct {
		engines.Connection
		Name       string   `json:"name"`
		Versions   []string `json:"versions"`
		DataVolume string   `json:"data_volume"`
	}{
		// The hostname is the compose service name: sibling services in the
		// project reach it there over the default network.
		Connection: engines.Describe(engine, service.ComposeServiceName, service.Image, values),
		Name:       engine.Name,
		Versions:   engine.Versions,
		// Compose namespaces volumes by project, which is the name docker
		// actually knows the data by.
		DataVolume: env.ComposeProjectName + "_" + service.ComposeServiceName + "-data",
	})
}
