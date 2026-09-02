package deployments

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"path/filepath"
	"testing"

	"github.com/vexdock/platform/manager/internal/compose"
	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/events"
)

func TestHasBuildScope(t *testing.T) {
	cfg := &compose.Config{
		Services: map[string]compose.ConfigService{
			"web":    {Image: "nginx"},
			"api":    {Build: map[string]any{"context": "."}},
			"worker": {Image: "busybox"},
		},
	}
	if !hasBuild(cfg) {
		t.Fatal("full project must see api's build")
	}
	if !hasBuild(cfg, "api") {
		t.Fatal("scoped to api must build")
	}
	if hasBuild(cfg, "web") {
		t.Fatal("scoped to web must skip build")
	}
	if hasBuild(cfg, "missing") {
		t.Fatal("unknown service must skip build")
	}
}

// finish is the one place a deployment leaves queued or running. It has to
// settle the row even when the pipeline never got as far as reading it, which
// is what a cancel while queued looks like.
func TestFinishSettlesEveryOutcome(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	project := &database.Project{ID: "p1", Name: "P", Slug: "p", ComposeProjectName: "p_p1", WebhookToken: "t"}
	if err := db.CreateProject(ctx, project); err != nil {
		t.Fatal(err)
	}
	env := &database.Environment{ID: "p1", ProjectID: "p1", Name: "Production", Slug: "production", ComposeProjectName: "p_p1", IsDefault: true}
	if err := db.CreateEnvironment(ctx, env); err != nil {
		t.Fatal(err)
	}
	e := &Engine{db: db, bus: events.NewBus(), log: slog.New(slog.NewTextHandler(io.Discard, nil))}

	cases := []struct {
		name   string
		err    error
		status string
	}{
		{"success", nil, database.DeploymentSuccess},
		{"cancelled before it was read", context.Canceled, database.DeploymentCancelled},
		{"failed", errors.New("compose config failed"), database.DeploymentFailed},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			d := &database.Deployment{ProjectID: "p1", EnvironmentID: "p1", Trigger: TriggerManual}
			if err := db.CreateDeployment(ctx, d); err != nil {
				t.Fatal(err)
			}
			// The pipeline has not loaded its row: p.deployment stays nil.
			newPipeline(e, d.ID, "").finish(tc.err)

			got, err := db.DeploymentByID(ctx, d.ID)
			if err != nil {
				t.Fatal(err)
			}
			if got.Status != tc.status {
				t.Fatalf("status = %q, want %q", got.Status, tc.status)
			}
			if got.FinishedAt == "" {
				t.Fatal("finished_at was not recorded")
			}
			if tc.err != nil && got.Error == "" {
				t.Fatal("a failed outcome recorded no error")
			}
		})
	}
}
