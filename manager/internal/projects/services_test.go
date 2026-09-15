package projects

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/vexdock/platform/manager/internal/database"
)

// fixture is a project with a staging environment and one service in
// production, the shape both transfers start from.
func fixture(t *testing.T) (*Service, *database.Project, *database.Environment, *database.Environment, *database.Service) {
	t.Helper()
	svc := testService(t)
	ctx := context.Background()

	p, err := svc.Create(ctx, CreateInput{Name: "acme"})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	production := defaultEnv(t, svc, p)
	// Created before the service: a new environment is seeded from the default
	// one, so a later staging would already hold a copy of it.
	staging, err := svc.CreateEnvironment(ctx, p, "Staging", "")
	if err != nil {
		t.Fatalf("create staging: %v", err)
	}
	web, err := svc.CreateService(ctx, production, ServiceInput{
		Name: "web", Provider: database.ProviderImage, Image: "nginx:1.27",
	})
	if err != nil {
		t.Fatalf("create service: %v", err)
	}
	if err := svc.SetServiceVariables(ctx, web.ID, []EnvVar{{Key: "TOKEN", Value: "t0", IsSecret: true}}); err != nil {
		t.Fatalf("set variables: %v", err)
	}
	if err := svc.db.CreateScheduledTask(ctx, &database.ScheduledTask{
		ServiceID: web.ID, Name: "nightly", Schedule: "0 3 * * *", Command: "echo hi", Shell: "sh", Enabled: true,
	}); err != nil {
		t.Fatalf("create task: %v", err)
	}
	return svc, p, production, staging, web
}

func TestDuplicateServiceCopiesVariablesAndTasks(t *testing.T) {
	svc, _, production, _, web := fixture(t)
	ctx := context.Background()

	copied, err := svc.DuplicateService(ctx, web, production, "web-copy")
	if err != nil {
		t.Fatalf("duplicate: %v", err)
	}
	if copied.ID == web.ID || copied.ContainerName == web.ContainerName {
		t.Fatalf("the copy shares %s with the original", copied.ID)
	}
	vars, err := svc.ServiceVariables(ctx, copied.ID)
	if err != nil {
		t.Fatalf("variables: %v", err)
	}
	if len(vars) != 1 || vars[0].Key != "TOKEN" || vars[0].Value != "t0" {
		t.Fatalf("got %+v, want the original's variables", vars)
	}
	tasks, err := svc.db.ScheduledTasksByService(ctx, copied.ID)
	if err != nil {
		t.Fatalf("tasks: %v", err)
	}
	if len(tasks) != 1 || tasks[0].Name != "nightly" {
		t.Fatalf("got %+v, want the original's scheduled task", tasks)
	}
	if _, err := svc.DuplicateService(ctx, web, production, "web"); err == nil {
		t.Fatal("a duplicate was accepted under the original's own name")
	}
}

func TestMoveServiceTakesItsDomainAlong(t *testing.T) {
	svc, p, production, staging, web := fixture(t)
	ctx := context.Background()

	domain := &database.Domain{
		ID: database.NewID(), ProjectID: p.ID, EnvironmentID: production.ID, ServiceID: web.ID,
		Hostname: "acme.test", ContainerPort: 80,
	}
	if err := svc.db.CreateDomain(ctx, domain); err != nil {
		t.Fatalf("create domain: %v", err)
	}

	if err := svc.MoveService(ctx, web, production, staging); err != nil {
		t.Fatalf("move: %v", err)
	}

	moved, err := svc.db.ServiceByID(ctx, web.ID)
	if err != nil {
		t.Fatalf("read service: %v", err)
	}
	if moved.EnvironmentID != staging.ID {
		t.Fatalf("service sits in %s, want staging", moved.EnvironmentID)
	}
	if moved.ContainerName != "acme-staging-web" {
		t.Fatalf("container is %q, want the name staging would have given it", moved.ContainerName)
	}
	domains, err := svc.db.ListProjectDomains(ctx, p.ID)
	if err != nil {
		t.Fatalf("list domains: %v", err)
	}
	if len(domains) != 1 || domains[0].EnvironmentID != staging.ID {
		t.Fatalf("got %+v, want the domain pointing at staging", domains)
	}
	tasks, err := svc.db.ScheduledTasksByService(ctx, web.ID)
	if err != nil {
		t.Fatalf("tasks: %v", err)
	}
	if len(tasks) != 1 {
		t.Fatalf("got %d tasks, want the one that moved with the service", len(tasks))
	}

	// The overlay is what docker reads: production must stop rendering the
	// service and staging must start.
	if _, err := os.Stat(svc.cfg.ProjectDir(production.ID) + "/managed.yml"); !os.IsNotExist(err) {
		t.Fatalf("production still has an overlay: %v", err)
	}
	body, err := os.ReadFile(svc.cfg.ProjectDir(staging.ID) + "/managed.yml")
	if err != nil {
		t.Fatalf("read staging overlay: %v", err)
	}
	if !strings.Contains(string(body), "acme-staging-web") {
		t.Fatalf("staging overlay does not run the service:\n%s", body)
	}
}
