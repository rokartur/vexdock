package api

import (
	"testing"

	"github.com/vexdock/platform/manager/internal/database"
)

// One table serves the service tab and the cross-project page, which only works
// while every row names its own owner.
func TestWithOwnersNamesTheServiceAndProjectOfEveryTask(t *testing.T) {
	services := map[string]database.Service{
		"svc-1": {ID: "svc-1", ProjectID: "proj-1", ComposeServiceName: "api"},
		"svc-2": {ID: "svc-2", ProjectID: "proj-2", ComposeServiceName: "worker"},
	}
	projects := map[string]database.Project{
		"proj-1": {ID: "proj-1", Name: "Shop"},
		"proj-2": {ID: "proj-2", Name: "Blog"},
	}
	rows := withOwners([]database.ScheduledTask{
		{ID: "a", ServiceID: "svc-1", Schedule: "0 3 * * *", Enabled: true},
		{ID: "b", ServiceID: "svc-2", Schedule: "0 3 * * *", Enabled: false},
	}, services, projects)

	if len(rows) != 2 {
		t.Fatalf("got %d rows, want 2", len(rows))
	}
	if rows[0].ServiceName != "api" || rows[0].ProjectID != "proj-1" || rows[0].ProjectName != "Shop" {
		t.Errorf("first row owned by %q/%q, want api/Shop", rows[0].ProjectName, rows[0].ServiceName)
	}
	if rows[1].ServiceName != "worker" || rows[1].ProjectName != "Blog" {
		t.Errorf("second row owned by %q/%q, want worker/Blog", rows[1].ProjectName, rows[1].ServiceName)
	}
	if rows[0].NextRun == "" {
		t.Error("an enabled task came back without its next run")
	}
	if rows[1].NextRun != "" {
		t.Error("a disabled task claimed a next run")
	}
}
