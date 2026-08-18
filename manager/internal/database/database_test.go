package database

import (
	"context"
	"path/filepath"
	"strings"
	"testing"
)

func open(t *testing.T) *DB {
	t.Helper()
	db, err := Open(filepath.Join(t.TempDir(), "app.db"))
	if err != nil {
		t.Fatalf("open: %v", err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return db
}

func newProject(t *testing.T, db *DB, slug string) *Project {
	t.Helper()
	p := &Project{
		ID: NewID(), Name: slug, Slug: slug, SourceType: SourceGit,
		RepositoryURL: "https://github.com/user/app", Branch: "main",
		ComposePath: "compose.yml", WebhookToken: "tok-" + NewID(),
	}
	p.ComposeProjectName = "p_" + p.ID
	if err := db.CreateProject(context.Background(), p); err != nil {
		t.Fatalf("create project: %v", err)
	}
	return p
}

func TestMigrationsAreIdempotent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "app.db")
	first, err := Open(path)
	if err != nil {
		t.Fatalf("first open: %v", err)
	}
	_ = first.Close()
	// Reopening must not try to apply the same migrations again.
	second, err := Open(path)
	if err != nil {
		t.Fatalf("second open: %v", err)
	}
	defer second.Close()
	if _, err := second.ListProjects(context.Background()); err != nil {
		t.Fatalf("schema is not usable after reopening: %v", err)
	}
}

// The deployment state machine: numbers increase per project, and a manager
// restart must never leave a deployment stuck in running.
func TestDeploymentNumberingAndRecovery(t *testing.T) {
	ctx := context.Background()
	db := open(t)
	project := newProject(t, db, "app")
	// A second project must get its own independent numbering.
	other := newProject(t, db, "other")
	second := &Deployment{ProjectID: other.ID, Trigger: "manual"}
	if err := db.CreateDeployment(ctx, second); err != nil {
		t.Fatalf("create deployment for second project: %v", err)
	}
	if second.Number != 1 {
		t.Fatalf("per-project numbering leaked: got #%d", second.Number)
	}

	for want := 1; want <= 3; want++ {
		d := &Deployment{ProjectID: project.ID, Trigger: "manual"}
		if err := db.CreateDeployment(ctx, d); err != nil {
			t.Fatalf("create deployment: %v", err)
		}
		if d.Number != want {
			t.Fatalf("expected deployment #%d, got #%d", want, d.Number)
		}
		if d.Status != DeploymentQueued {
			t.Fatalf("new deployments must start queued, got %q", d.Status)
		}
	}

	running := &Deployment{ProjectID: project.ID, Trigger: "manual", Status: DeploymentRunning}
	if err := db.CreateDeployment(ctx, running); err != nil {
		t.Fatalf("create running deployment: %v", err)
	}
	unfinished, err := db.UnfinishedDeployments(ctx)
	if err != nil {
		t.Fatalf("unfinished: %v", err)
	}
	// Three queued for this project, one queued for the other, one running.
	if len(unfinished) != 5 {
		t.Fatalf("expected 5 unfinished deployments, got %d", len(unfinished))
	}

	running.Status = DeploymentSuccess
	running.FinishedAt = Now()
	if err := db.UpdateDeployment(ctx, running); err != nil {
		t.Fatalf("update: %v", err)
	}
	if n, err := db.CountDeploymentsByStatus(ctx, DeploymentSuccess); err != nil || n != 1 {
		t.Fatalf("expected 1 success, got %d (%v)", n, err)
	}

	list, err := db.ListDeployments(ctx, project.ID, 10)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(list) != 4 || list[0].Number != 4 {
		t.Fatalf("history is not newest-first: %+v", list)
	}
}

func TestServiceUpsertAndPrune(t *testing.T) {
	ctx := context.Background()
	db := open(t)
	project := newProject(t, db, "app")

	first, err := db.UpsertService(ctx, project.ID, "web")
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	again, err := db.UpsertService(ctx, project.ID, "web")
	if err != nil {
		t.Fatalf("upsert twice: %v", err)
	}
	if first.ID != again.ID {
		t.Fatal("upsert created a duplicate service row")
	}
	if _, err := db.UpsertService(ctx, project.ID, "worker"); err != nil {
		t.Fatalf("upsert worker: %v", err)
	}

	// A service removed from the compose file must disappear from the panel.
	if err := db.PruneServices(ctx, project.ID, []string{"web"}); err != nil {
		t.Fatalf("prune: %v", err)
	}
	services, err := db.ListServices(ctx, project.ID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(services) != 1 || services[0].ComposeServiceName != "web" {
		t.Fatalf("prune left %+v", services)
	}
}

func TestDeletingAProjectCascades(t *testing.T) {
	ctx := context.Background()
	db := open(t)
	project := newProject(t, db, "app")
	service, err := db.UpsertService(ctx, project.ID, "web")
	if err != nil {
		t.Fatalf("upsert service: %v", err)
	}
	domain := &Domain{ID: NewID(), ProjectID: project.ID, ServiceID: service.ID, Hostname: "a.example.com", ContainerPort: 3000}
	if err := db.CreateDomain(ctx, domain); err != nil {
		t.Fatalf("create domain: %v", err)
	}
	if err := db.UpsertSecret(ctx, project.ID, "TOKEN", "sealed", true); err != nil {
		t.Fatalf("upsert secret: %v", err)
	}

	if err := db.DeleteProject(ctx, project.ID); err != nil {
		t.Fatalf("delete project: %v", err)
	}
	domains, err := db.ListDomains(ctx)
	if err != nil {
		t.Fatalf("list domains: %v", err)
	}
	if len(domains) != 0 {
		t.Fatalf("domains survived the project: %+v", domains)
	}
	secrets, err := db.ListSecrets(ctx, project.ID)
	if err != nil {
		t.Fatalf("list secrets: %v", err)
	}
	if len(secrets) != 0 {
		t.Fatal("secrets survived the project")
	}
}

// Tags live in one comma-separated column, so the join on write and the split
// on read have to agree - and the column has to stay in step with the scan.
func TestProjectTagsRoundTrip(t *testing.T) {
	ctx := context.Background()
	db := open(t)
	p := newProject(t, db, "tagged")
	p.Tags = []string{"prod", "client-x"}
	if err := db.UpdateProject(ctx, p); err != nil {
		t.Fatalf("update: %v", err)
	}

	stored, err := db.ProjectByID(ctx, p.ID)
	if err != nil {
		t.Fatalf("read back: %v", err)
	}
	if strings.Join(stored.Tags, "|") != "prod|client-x" {
		t.Fatalf("got %v, want [prod client-x]", stored.Tags)
	}

	untagged, err := db.ProjectByID(ctx, newProject(t, db, "plain").ID)
	if err != nil {
		t.Fatalf("read untagged: %v", err)
	}
	if len(untagged.Tags) != 0 {
		t.Fatalf("got %v, want no tags", untagged.Tags)
	}
}
