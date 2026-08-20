package projects

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/vexdock/platform/manager/internal/database"
)

// Two environments of one project must not meet: separate compose namespaces,
// separate directories, separate services. Sharing any of the three is what
// would let a staging deploy stop production's containers.
func TestEnvironmentsAreIsolated(t *testing.T) {
	svc := testService(t)
	ctx := context.Background()

	p, err := svc.Create(ctx, CreateInput{Name: "usagefleet"})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	production := defaultEnv(t, svc, p)
	staging, err := svc.CreateEnvironment(ctx, p, "Staging", "develop")
	if err != nil {
		t.Fatalf("create staging: %v", err)
	}

	if staging.ComposeProjectName == production.ComposeProjectName {
		t.Fatalf("both environments share the docker namespace %s", staging.ComposeProjectName)
	}
	if svc.RepositoryDir(staging) == svc.RepositoryDir(production) {
		t.Fatal("both environments build from the same directory")
	}
	// The default environment keeps the project's own id, which is what makes
	// the upgrade from a pre-environment install a no-op on disk.
	if production.ID != p.ID {
		t.Fatalf("default environment id is %s, want the project's own %s", production.ID, p.ID)
	}

	// A service name is free in each environment separately.
	for _, env := range []*database.Environment{production, staging} {
		if _, err := svc.CreateService(ctx, env, ServiceInput{Name: "web", SourceType: database.ServiceUnconfigured}); err != nil {
			t.Fatalf("create web in %s: %v", env.Slug, err)
		}
	}
	if _, err := svc.CreateService(ctx, staging, ServiceInput{Name: "web", SourceType: database.ServiceUnconfigured}); err == nil {
		t.Fatal("the same name was accepted twice inside one environment")
	}

	// A new environment starts from the project's compose file rather than empty.
	content, err := svc.ReadComposeFile(p, staging)
	if err != nil || strings.TrimSpace(content) == "" {
		t.Fatalf("staging has no compose file to deploy: %q (%v)", content, err)
	}
}

// Project variables are shared; an environment's own override them. The .env
// compose reads is where the two meet, so that is where it is checked.
func TestEnvironmentVariablesOverrideSharedOnes(t *testing.T) {
	svc := testService(t)
	ctx := context.Background()

	p, err := svc.Create(ctx, CreateInput{Name: "usagefleet"})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	staging, err := svc.CreateEnvironment(ctx, p, "Staging", "")
	if err != nil {
		t.Fatalf("create staging: %v", err)
	}

	if err := svc.SetProjectVariables(ctx, p.ID, []EnvVar{
		{Key: "SHARED", Value: "everywhere"},
		{Key: "TIER", Value: "production"},
	}); err != nil {
		t.Fatalf("set project variables: %v", err)
	}
	if err := svc.SetEnvironmentVariables(ctx, staging.ID, []EnvVar{
		{Key: "TIER", Value: "staging"},
	}); err != nil {
		t.Fatalf("set environment variables: %v", err)
	}

	path, err := svc.WriteEnvFile(ctx, p, staging)
	if err != nil {
		t.Fatalf("write env file: %v", err)
	}
	body, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read env file: %v", err)
	}
	rendered := string(body)
	if !strings.Contains(rendered, "SHARED=everywhere") {
		t.Fatalf("the shared variable did not reach staging:\n%s", rendered)
	}
	if !strings.Contains(rendered, "TIER=staging") || strings.Contains(rendered, "TIER=production") {
		t.Fatalf("the environment did not override the shared value:\n%s", rendered)
	}
}
