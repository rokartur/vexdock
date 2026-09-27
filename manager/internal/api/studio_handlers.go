package api

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strconv"
	"time"

	"github.com/vexdock/platform/manager/internal/engines"
	"github.com/vexdock/platform/manager/internal/studio"
)

// studioTimeout bounds one Studio request end to end: connect, run, read.
const studioTimeout = 30 * time.Second

func (s *Server) handleStudioSchema(w http.ResponseWriter, r *http.Request) {
	ctx, cancel := context.WithTimeout(r.Context(), studioTimeout)
	defer cancel()
	conn, ok := s.openStudio(ctx, w, r)
	if !ok {
		return
	}
	defer conn.Close()
	namespaces, err := conn.Schema(ctx)
	if err != nil {
		studioFailed(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"schemas": namespaces})
}

func (s *Server) handleStudioRows(w http.ResponseWriter, r *http.Request) {
	q, err := rowsQuery(r)
	if err != nil {
		badRequest(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), studioTimeout)
	defer cancel()
	conn, ok := s.openStudio(ctx, w, r)
	if !ok {
		return
	}
	defer conn.Close()
	rows, err := conn.Rows(ctx, q)
	if err != nil {
		studioFailed(w, err)
		return
	}
	writeJSON(w, http.StatusOK, rows)
}

func (s *Server) handleStudioChanges(w http.ResponseWriter, r *http.Request) {
	var changes studio.Changes
	if err := decode(r, &changes); err != nil {
		badRequest(w, err)
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), studioTimeout)
	defer cancel()
	conn, ok := s.openStudio(ctx, w, r)
	if !ok {
		return
	}
	defer conn.Close()
	affected, err := conn.Apply(ctx, changes)
	if err != nil {
		studioFailed(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]int64{"affected": affected})
}

func (s *Server) handleStudioQuery(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Schema string `json:"schema"`
		Query  string `json:"query"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	if req.Query == "" {
		badRequest(w, errors.New("query is required"))
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), studioTimeout)
	defer cancel()
	conn, ok := s.openStudio(ctx, w, r)
	if !ok {
		return
	}
	defer conn.Close()
	started := time.Now()
	result, err := conn.Query(ctx, req.Schema, req.Query)
	if err != nil {
		studioFailed(w, err)
		return
	}
	result.DurationMS = time.Since(started).Milliseconds()
	writeJSON(w, http.StatusOK, result)
}

// openStudio connects to a database service's running container over its
// compose network; the credentials never leave the manager. When it cannot,
// it has already answered the request.
// ponytail: connect per request; a pool per service once the latency hurts.
func (s *Server) openStudio(ctx context.Context, w http.ResponseWriter, r *http.Request) (studio.Conn, bool) {
	service, _, env, err := s.lookupService(r)
	if lookupFailed(w, err) {
		return nil, false
	}
	engine, ok := engines.BySlug(service.Engine)
	if !ok || engine.Slug == engines.Custom {
		writeError(w, http.StatusBadRequest, "STUDIO_UNSUPPORTED", "Studio opens the catalog's databases only", nil)
		return nil, false
	}
	containerID, err := s.Docker.ServiceContainer(ctx, env.ComposeProjectName, service.ComposeServiceName)
	if err != nil {
		writeError(w, http.StatusConflict, "DATABASE_NOT_RUNNING", err.Error(), nil)
		return nil, false
	}
	info, err := s.Docker.Inspect(ctx, containerID)
	if err != nil {
		serverError(w, err)
		return nil, false
	}
	if !info.State.Running {
		writeError(w, http.StatusConflict, "DATABASE_NOT_RUNNING", "the database is not running - start or redeploy it", nil)
		return nil, false
	}
	vars, err := s.Projects.ServiceVariables(ctx, service.ID)
	if err != nil {
		serverError(w, err)
		return nil, false
	}
	values := make(map[string]string, len(vars))
	for _, v := range vars {
		values[v.Key] = v.Value
	}
	target := engines.Describe(engine, service.ComposeServiceName, service.Image, values)
	target.Host, err = s.Docker.ReachContainer(ctx, containerID, env.ComposeProjectName)
	if err != nil {
		serverError(w, err)
		return nil, false
	}
	conn, err := studio.Open(ctx, target)
	if err != nil {
		studioFailed(w, err)
		return nil, false
	}
	return conn, true
}

// studioFailed passes the database's own message through: it is what the
// user needs to fix their query, and it is their database.
func studioFailed(w http.ResponseWriter, err error) {
	if errors.Is(err, studio.ErrUnsupported) {
		writeError(w, http.StatusBadRequest, "STUDIO_UNSUPPORTED", err.Error(), nil)
		return
	}
	writeError(w, http.StatusBadRequest, "QUERY_FAILED", err.Error(), nil)
}

func rowsQuery(r *http.Request) (studio.RowsQuery, error) {
	params := r.URL.Query()
	q := studio.RowsQuery{
		Namespace: params.Get("schema"),
		Table:     params.Get("table"),
		Sort:      params.Get("sort"),
	}
	if q.Table == "" {
		return q, errors.New("table is required")
	}
	for name, dst := range map[string]*int{"limit": &q.Limit, "offset": &q.Offset} {
		if raw := params.Get(name); raw != "" {
			n, err := strconv.Atoi(raw)
			if err != nil {
				return q, fmt.Errorf("%s must be a number", name)
			}
			*dst = n
		}
	}
	switch params.Get("order") {
	case "", "asc":
	case "desc":
		q.Desc = true
	default:
		return q, errors.New("order is asc or desc")
	}
	if raw := params.Get("where"); raw != "" {
		if err := json.Unmarshal([]byte(raw), &q.Filters); err != nil {
			return q, fmt.Errorf("where must be a JSON list of filters: %w", err)
		}
	}
	return q.Normalize()
}
