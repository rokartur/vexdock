package database

import (
	"context"
	"database/sql"
	"io/fs"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vexdock/platform/manager/migrations"
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

// defaultEnv is the environment a project deploys into. Everything service and
// deployment shaped hangs off it now.
func defaultEnv(t *testing.T, db *DB, projectID string) *Environment {
	t.Helper()
	env, err := db.DefaultEnvironment(context.Background(), projectID)
	if err != nil {
		t.Fatalf("default environment: %v", err)
	}
	return env
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
	env := &Environment{
		ID: p.ID, ProjectID: p.ID, Name: "Production", Slug: "production",
		ComposeProjectName: p.ComposeProjectName, IsDefault: true,
	}
	if err := db.CreateEnvironment(context.Background(), env); err != nil {
		t.Fatalf("create environment: %v", err)
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
	second := &Deployment{ProjectID: other.ID, EnvironmentID: other.ID, Trigger: "manual"}
	if err := db.CreateDeployment(ctx, second); err != nil {
		t.Fatalf("create deployment for second project: %v", err)
	}
	if second.Number != 1 {
		t.Fatalf("per-project numbering leaked: got #%d", second.Number)
	}

	for want := 1; want <= 3; want++ {
		d := &Deployment{ProjectID: project.ID, EnvironmentID: project.ID, Trigger: "manual"}
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

	running := &Deployment{ProjectID: project.ID, EnvironmentID: project.ID, Trigger: "manual", Status: DeploymentRunning}
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

	list, err := db.ListDeployments(ctx, defaultEnv(t, db, project.ID).ID, 10)
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

	first, err := db.UpsertService(ctx, project.ID, defaultEnv(t, db, project.ID).ID, "web")
	if err != nil {
		t.Fatalf("upsert: %v", err)
	}
	again, err := db.UpsertService(ctx, project.ID, defaultEnv(t, db, project.ID).ID, "web")
	if err != nil {
		t.Fatalf("upsert twice: %v", err)
	}
	if first.ID != again.ID {
		t.Fatal("upsert created a duplicate service row")
	}
	if _, err := db.UpsertService(ctx, project.ID, defaultEnv(t, db, project.ID).ID, "worker"); err != nil {
		t.Fatalf("upsert worker: %v", err)
	}

	// A service removed from the compose file must disappear from the panel.
	if err := db.PruneServices(ctx, project.ID, []string{"web"}); err != nil {
		t.Fatalf("prune: %v", err)
	}
	services, err := db.ListServices(ctx, defaultEnv(t, db, project.ID).ID)
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
	service, err := db.UpsertService(ctx, project.ID, defaultEnv(t, db, project.ID).ID, "web")
	if err != nil {
		t.Fatalf("upsert service: %v", err)
	}
	domain := &Domain{ID: NewID(), ProjectID: project.ID, ServiceID: service.ID, Hostname: "a.example.com", ContainerPort: 3000}
	if err := db.CreateDomain(ctx, domain); err != nil {
		t.Fatalf("create domain: %v", err)
	}
	if err := db.UpsertSecret(ctx, ProjectScope, project.ID, "TOKEN", "sealed", true); err != nil {
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
	secrets, err := db.ListSecrets(ctx, ProjectScope, project.ID)
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

// openUpTo applies migrations in order and stops after the named one, which is
// how a test gets at the schema an existing install is upgrading from.
func openUpTo(t *testing.T, path, last string) *DB {
	t.Helper()
	sqlDB, err := sql.Open("sqlite", "file:"+path+"?_pragma=foreign_keys(ON)")
	if err != nil {
		t.Fatalf("open sqlite: %v", err)
	}
	sqlDB.SetMaxOpenConns(1)
	db := &DB{sqlDB}
	t.Cleanup(func() { _ = db.Close() })

	ctx := context.Background()
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version TEXT PRIMARY KEY, applied_at TEXT NOT NULL)`); err != nil {
		t.Fatalf("create schema_migrations: %v", err)
	}
	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		t.Fatalf("read migrations: %v", err)
	}
	for _, e := range entries {
		body, err := migrations.FS.ReadFile(e.Name())
		if err != nil {
			t.Fatalf("read %s: %v", e.Name(), err)
		}
		if err := db.apply(ctx, e.Name(), string(body)); err != nil {
			t.Fatalf("apply %s: %v", e.Name(), err)
		}
		if strings.HasPrefix(e.Name(), last) {
			return db
		}
	}
	t.Fatalf("no migration named %s", last)
	return nil
}

// 0010 rebuilds services to move its unique constraint onto the environment,
// and dropping a table with foreign keys enforced takes every cascading child
// row with it. An install with data in it must come out the other side whole.
func TestUpgradingToEnvironmentsKeepsData(t *testing.T) {
	ctx := context.Background()
	db := openUpTo(t, filepath.Join(t.TempDir(), "app.db"), "0009")

	// Everything here is raw SQL: the pre-0010 schema has no environment column,
	// so the helpers that write these rows today cannot describe it.
	project := &Project{
		ID: NewID(), Name: "app", Slug: "app", SourceType: SourceGit,
		RepositoryURL: "https://github.com/user/app", Branch: "main",
		ComposePath: "compose.yml", WebhookToken: "tok-" + NewID(),
	}
	project.ComposeProjectName = "p_" + project.ID
	if err := db.CreateProject(ctx, project); err != nil {
		t.Fatalf("create project: %v", err)
	}
	serviceID := NewID()
	if _, err := db.ExecContext(ctx,
		`INSERT INTO services (id, project_id, compose_service_name, created_at) VALUES (?, ?, 'web', ?)`,
		serviceID, project.ID, Now()); err != nil {
		t.Fatalf("insert service: %v", err)
	}
	if err := db.UpsertSecret(ctx, ServiceScope, serviceID, "TOKEN", "sealed", true); err != nil {
		t.Fatalf("upsert service secret: %v", err)
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO domains (id, project_id, service_id, hostname, container_port, created_at, updated_at)
		 VALUES (?, ?, ?, 'a.example.com', 3000, ?, ?)`,
		NewID(), project.ID, serviceID, Now(), Now()); err != nil {
		t.Fatalf("insert domain: %v", err)
	}

	if err := db.migrate(ctx); err != nil {
		t.Fatalf("upgrade: %v", err)
	}

	// A rebuild migration runs with foreign keys off, which is exactly the state
	// in which a wrong statement can leave the file itself damaged rather than
	// merely wrong.
	var integrity string
	if err := db.QueryRowContext(ctx, `PRAGMA integrity_check`).Scan(&integrity); err != nil {
		t.Fatalf("integrity check: %v", err)
	}
	if integrity != "ok" {
		t.Fatalf("the upgrade damaged the database: %s", integrity)
	}

	secrets, err := db.ListSecrets(ctx, ServiceScope, serviceID)
	if err != nil {
		t.Fatalf("list service secrets: %v", err)
	}
	if len(secrets) != 1 {
		t.Fatalf("the rebuild cascaded into service_secrets: %d rows left, want 1", len(secrets))
	}
	domains, err := db.ListDomains(ctx)
	if err != nil {
		t.Fatalf("list domains: %v", err)
	}
	if len(domains) != 1 {
		t.Fatalf("the rebuild cascaded into domains: %d rows left, want 1", len(domains))
	}

	// The backfilled environment has to own the containers that are already
	// running, or the first deploy after the upgrade orphans them.
	var id, composeName string
	if err := db.QueryRowContext(ctx,
		`SELECT id, compose_project_name FROM environments WHERE project_id = ? AND is_default = 1`,
		project.ID).Scan(&id, &composeName); err != nil {
		t.Fatalf("no default environment: %v", err)
	}
	if id != project.ID {
		t.Fatalf("default environment id is %s, want the project's own %s", id, project.ID)
	}
	if composeName != project.ComposeProjectName {
		t.Fatalf("default environment namespace is %s, want %s", composeName, project.ComposeProjectName)
	}

	// And the point of the rebuild: two environments, both with a "web".
	if _, err := db.ExecContext(ctx,
		`INSERT INTO environments (id, project_id, name, slug, compose_project_name, created_at, updated_at)
		 VALUES (?, ?, 'Staging', 'staging', ?, ?, ?)`,
		"env-staging", project.ID, "p_staging", Now(), Now()); err != nil {
		t.Fatalf("create staging: %v", err)
	}
	if _, err := db.ExecContext(ctx,
		`INSERT INTO services (id, project_id, environment_id, compose_service_name, created_at)
		 VALUES (?, ?, 'env-staging', 'web', ?)`, NewID(), project.ID, Now()); err != nil {
		t.Fatalf("staging cannot have its own web service: %v", err)
	}
}
