package api

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vexdock/platform/manager/internal/auth"
	"github.com/vexdock/platform/manager/internal/config"
	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/security"
)

// A project token reaches its own projects at its own level and nothing past
// them; the route table is the only thing enforcing that, so it is tested
// through the real router.
func TestProjectTokenScope(t *testing.T) {
	dir := t.TempDir()
	db, err := database.Open(filepath.Join(dir, "app.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	for _, id := range []string{"p1", "p2"} {
		mustDo(t, db.CreateProject(ctx, &database.Project{ID: id, Name: id, Slug: id, ComposeProjectName: id}))
		mustDo(t, db.CreateEnvironment(ctx, &database.Environment{ID: id, ProjectID: id, Name: "Production", Slug: "production", ComposeProjectName: id, IsDefault: true}))
		mustDo(t, db.CreateService(ctx, &database.Service{ID: "s-" + id, ProjectID: id, EnvironmentID: id, ComposeServiceName: "web", Provider: database.ProviderRaw}))
		mustDo(t, db.CreateDomain(ctx, &database.Domain{ID: "d-" + id, ProjectID: id, EnvironmentID: id, ServiceID: "s-" + id, Hostname: id + ".example.com", ContainerPort: 80}))
	}
	authService, err := auth.New(db, &config.Config{DataDir: dir})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = authService.Close() })
	handler := New(Deps{DB: db, Auth: authService, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}).Handler()

	mint := func(grants []database.ProjectGrant) string {
		raw := security.RandomToken(32)
		if _, err := db.CreateAPIToken(ctx, "u1", "test", security.HashToken(raw), raw[:6], grants); err != nil {
			t.Fatal(err)
		}
		return raw
	}
	reader := mint([]database.ProjectGrant{{ProjectID: "p1", Level: database.AccessRead}})
	writer := mint([]database.ProjectGrant{{ProjectID: "p1", Level: database.AccessWrite}})
	admin := mint(nil)

	call := func(token, method, path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}

	cases := []struct {
		name, token, method, path string
		want                      int
	}{
		{"own project", reader, "GET", "/api/projects/p1/environments", http.StatusOK},
		{"other project", reader, "GET", "/api/projects/p2/environments", http.StatusForbidden},
		{"other project through a service id", reader, "GET", "/api/services/s-p2/variables", http.StatusForbidden},
		{"secrets need write", reader, "GET", "/api/services/s-p1/variables", http.StatusForbidden},
		{"write passes the write routes", writer, "GET", "/api/services/s-p1/basic-auth", http.StatusOK},
		{"unknown id looks forbidden", reader, "GET", "/api/services/nope", http.StatusForbidden},
		{"instance routes are admin only", writer, "GET", "/api/tokens", http.StatusForbidden},
		{"deleting a project is admin only", writer, "DELETE", "/api/projects/p1", http.StatusForbidden},
		{"admin token passes", admin, "GET", "/api/tokens", http.StatusOK},
		{"admin token reaches every project", admin, "GET", "/api/projects/p2/environments", http.StatusOK},
	}
	for _, c := range cases {
		if w := call(c.token, c.method, c.path); w.Code != c.want {
			t.Errorf("%s: %s %s = %d, want %d: %s", c.name, c.method, c.path, w.Code, c.want, w.Body)
		}
	}

	// Routes whose body names a second project must check it too.
	intoOtherProject := []struct{ path, body string }{
		{"/api/domains", `{"project_id":"p2","service":"web","hostname":"x.example.com"}`},
		{"/api/services/s-p1/duplicate", `{"name":"copy","environment_id":"p2"}`},
		{"/api/services/s-p1/move", `{"environment_id":"p2"}`},
	}
	for _, c := range intoOtherProject {
		r := httptest.NewRequest("POST", c.path, strings.NewReader(c.body))
		r.Header.Set("Authorization", "Bearer "+writer)
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		if w.Code != http.StatusForbidden {
			t.Errorf("POST %s into another project: %d, want 403: %s", c.path, w.Code, w.Body)
		}
	}

	var domains []database.Domain
	mustDo(t, json.Unmarshal(call(reader, "GET", "/api/domains").Body.Bytes(), &domains))
	if len(domains) != 1 || domains[0].ProjectID != "p1" {
		t.Errorf("domain list = %+v, want only p1's", domains)
	}

	var me struct {
		Access struct {
			Admin    bool                    `json:"admin"`
			Projects []database.ProjectGrant `json:"projects"`
		} `json:"access"`
	}
	mustDo(t, json.Unmarshal(call(reader, "GET", "/api/me").Body.Bytes(), &me))
	if me.Access.Admin || len(me.Access.Projects) != 1 || me.Access.Projects[0].Level != database.AccessRead {
		t.Errorf("me = %+v, want one read grant", me.Access)
	}
}

func mustDo(t *testing.T, err error) {
	t.Helper()
	if err != nil {
		t.Fatal(err)
	}
}
