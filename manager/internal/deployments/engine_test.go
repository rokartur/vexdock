package deployments

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"path/filepath"
	"testing"
	"time"

	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/events"
)

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
	project := &database.Project{ID: "p1", Name: "P", Slug: "p", ComposeProjectName: "p_p1"}
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
		{"canceled before it was read", context.Canceled, database.DeploymentCancelled},
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

// A deployment waiting for a global slot is still cancelable: it leaves as
// canceled, never as a row stuck in queued behind a slot it never got.
func TestCancelWhileWaitingForSlot(t *testing.T) {
	db, err := database.Open(filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatal(err)
	}
	defer db.Close()
	ctx := context.Background()
	project := &database.Project{ID: "p1", Name: "P", Slug: "p", ComposeProjectName: "p_p1"}
	if err := db.CreateProject(ctx, project); err != nil {
		t.Fatal(err)
	}
	env := &database.Environment{ID: "p1", ProjectID: "p1", Name: "Production", Slug: "production", ComposeProjectName: "p_p1", IsDefault: true}
	if err := db.CreateEnvironment(ctx, env); err != nil {
		t.Fatal(err)
	}
	e := NewEngine(db, nil, nil, nil, nil, events.NewBus(), slog.New(slog.NewTextHandler(io.Discard, nil)))
	// Every slot is taken by somebody else.
	for range cap(e.slots) {
		e.slots <- struct{}{}
	}

	d := &database.Deployment{ProjectID: "p1", EnvironmentID: "p1", ServiceName: "web", Trigger: TriggerManual}
	if err := db.CreateDeployment(ctx, d); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() {
		e.run(env.ID, d.ID, "")
		close(done)
	}()
	// Cancel registers in run before the slot wait, so poll until it is there.
	for {
		if err := e.Cancel(d.ID); err == nil {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("run did not return after cancel")
	}

	got, err := db.DeploymentByID(ctx, d.ID)
	if err != nil {
		t.Fatal(err)
	}
	if got.Status != database.DeploymentCancelled {
		t.Fatalf("status = %q, want %q", got.Status, database.DeploymentCancelled)
	}
	if len(e.slots) != cap(e.slots) {
		t.Fatalf("a canceled deployment released a slot it never held")
	}
}
