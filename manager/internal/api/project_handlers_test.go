package api

import (
	"context"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/vexdock/platform/manager/internal/database"
)

func TestDeleteProjectRefusesWhileServicesRemain(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatalf("open db: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	if err := db.CreateProject(ctx, &database.Project{ID: "p1", Name: "P", Slug: "p", ComposeProjectName: "p_p1"}); err != nil {
		t.Fatal(err)
	}
	env := &database.Environment{ID: "p1", ProjectID: "p1", Name: "Production", Slug: "production", ComposeProjectName: "p_p1", IsDefault: true}
	if err := db.CreateEnvironment(ctx, env); err != nil {
		t.Fatal(err)
	}
	svc := &database.Service{ID: "s1", ProjectID: "p1", EnvironmentID: "p1", ComposeServiceName: "web", Provider: database.ProviderRaw}
	if err := db.CreateService(ctx, svc); err != nil {
		t.Fatal(err)
	}

	r := httptest.NewRequest(http.MethodDelete, "/api/projects/p1", nil)
	r.SetPathValue("id", "p1")
	w := httptest.NewRecorder()
	New(Deps{DB: db}).handleDeleteProject(w, r)

	if w.Code != http.StatusConflict {
		t.Fatalf("status %d, want 409: %s", w.Code, w.Body)
	}
	if _, err := db.ProjectByID(ctx, "p1"); err != nil {
		t.Fatalf("project gone: %v", err)
	}
}
