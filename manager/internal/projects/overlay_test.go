package projects

import (
	"context"
	"os"
	"strings"
	"testing"

	"github.com/vexdock/platform/manager/internal/database"
)

// The overlay is the only thing standing between a service row and docker, so
// a database has to come out of it mounting its own volume and reading its own
// env file, with the credentials never inlined into the YAML.
func TestOverlayRendersADatabaseService(t *testing.T) {
	svc := testService(t)
	ctx := context.Background()

	p, err := svc.Create(ctx, CreateInput{Name: "usagefleet"})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	db, err := svc.CreateService(ctx, defaultEnv(t, svc, p), ServiceInput{
		Name:     "usagefleet-db",
		Provider: database.ProviderImage,
		Database: &DatabaseInput{
			Engine: "postgres", Version: "17-alpine", Name: "app", User: "app", Password: "s3cret",
		},
	})
	if err != nil {
		t.Fatalf("create service: %v", err)
	}
	if db.Type != database.ServiceDatabase || db.Image != "postgres:17-alpine" {
		t.Fatalf("service = %+v, want a postgres:17-alpine database", db)
	}

	path, err := svc.WriteOverlay(ctx, defaultEnv(t, svc, p))
	if err != nil || path == "" {
		t.Fatalf("write overlay: %q, %v", path, err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read overlay: %v", err)
	}
	overlay := string(raw)
	for _, want := range []string{
		"  usagefleet-db:\n",
		"image: postgres:17-alpine",
		"usagefleet-db-data:/var/lib/postgresql/data",
		"PGDATA: /var/lib/postgresql/data",
		"\nvolumes:\n  usagefleet-db-data: {}\n",
	} {
		if !strings.Contains(overlay, want) {
			t.Errorf("overlay is missing %q:\n%s", want, overlay)
		}
	}
	if strings.Contains(overlay, "s3cret") {
		t.Error("the password was inlined into the compose file instead of the env file")
	}

	env, err := os.ReadFile(svc.ServiceEnvFilePath(defaultEnv(t, svc, p), "usagefleet-db"))
	if err != nil {
		t.Fatalf("read service env: %v", err)
	}
	if !strings.Contains(string(env), "POSTGRES_PASSWORD=s3cret") {
		t.Errorf("service env does not carry the password:\n%s", env)
	}

	// A project whose managed services are all gone must not keep serving a
	// stale overlay, or the next deploy resurrects the deleted container.
	if err := svc.DeleteService(ctx, db, defaultEnv(t, svc, p)); err != nil {
		t.Fatalf("delete service: %v", err)
	}
	if path, err := svc.WriteOverlay(ctx, defaultEnv(t, svc, p)); err != nil || path != "" {
		t.Fatalf("overlay after delete: %q, %v", path, err)
	}
}

// A container's name is what someone reads in docker ps, so it follows the
// project rather than the environment's opaque id, and it has to stay unique
// across the host: a second environment puts its own name in the middle, and a
// name already taken is refused rather than left for docker to fail on.
func TestContainerNames(t *testing.T) {
	svc := testService(t)
	ctx := context.Background()

	p, err := svc.Create(ctx, CreateInput{Name: "rokartur"})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	default_ := defaultEnv(t, svc, p)
	db, err := svc.CreateService(ctx, default_, ServiceInput{
		Name:     "db",
		Provider: database.ProviderImage,
		Database: &DatabaseInput{Engine: "postgres", Name: "app", User: "app", Password: "s3cret"},
	})
	if err != nil {
		t.Fatalf("create service: %v", err)
	}
	if db.ContainerName != "rokartur-db" {
		t.Errorf("container name %q, want rokartur-db", db.ContainerName)
	}

	staging, err := svc.CreateEnvironment(ctx, p, "staging", "main")
	if err != nil {
		t.Fatalf("create environment: %v", err)
	}
	copies, err := svc.db.ListServices(ctx, staging.ID)
	if err != nil {
		t.Fatalf("list staging services: %v", err)
	}
	if len(copies) != 1 || copies[0].ContainerName != "rokartur-staging-db" {
		t.Errorf("staging copy = %+v, want one container named rokartur-staging-db", copies)
	}
	if _, err := svc.CreateService(ctx, staging, ServiceInput{
		Name: "api", Provider: database.ProviderUnconfigured, ContainerName: "rokartur-db",
	}); err == nil {
		t.Error("two services took the same container name, which docker would refuse at deploy")
	}

	path, err := svc.WriteOverlay(ctx, default_)
	if err != nil {
		t.Fatalf("write overlay: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read overlay: %v", err)
	}
	if !strings.Contains(string(raw), "container_name: rokartur-db") {
		t.Errorf("the name did not reach the overlay:\n%s", raw)
	}
}

// Every overlay after the first is re-rendered from the stored row rather than
// from the create request, so anything the row does not carry is silently lost.
// Both cases here pin that: a version that is not the catalog default must not
// drift back to it, and a custom engine must still find its data path.
func TestOverlayReRendersFromTheStoredRow(t *testing.T) {
	svc := testService(t)
	ctx := context.Background()

	p, err := svc.Create(ctx, CreateInput{Name: "usagefleet"})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	if _, err := svc.CreateService(ctx, defaultEnv(t, svc, p), ServiceInput{
		Name:     "pinned",
		Provider: database.ProviderImage,
		Database: &DatabaseInput{
			Engine: "postgres", Version: "15-alpine", Name: "app", User: "app", Password: "s3cret",
		},
	}); err != nil {
		t.Fatalf("create pinned service: %v", err)
	}
	if _, err := svc.CreateService(ctx, defaultEnv(t, svc, p), ServiceInput{
		Name:     "byo",
		Provider: database.ProviderImage,
		Database: &DatabaseInput{
			Engine: "custom", Image: "valkey/valkey:8", DataPath: "/data", Password: "s3cret",
		},
	}); err != nil {
		t.Fatalf("create custom service: %v", err)
	}

	path, err := svc.WriteOverlay(ctx, defaultEnv(t, svc, p))
	if err != nil {
		t.Fatalf("write overlay: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read overlay: %v", err)
	}
	overlay := string(raw)
	for _, want := range []string{
		"image: postgres:15-alpine",
		"image: valkey/valkey:8",
		"byo-data:/data",
		// Every service key starts its own line at the services indent. A
		// fragment that does not end in a newline glues the next key onto its
		// last line, and the overlay stops being YAML docker will accept.
		"\n  byo:\n",
		"\n  pinned:\n",
	} {
		if !strings.Contains(overlay, want) {
			t.Errorf("overlay is missing %q:\n%s", want, overlay)
		}
	}
	if strings.Contains(overlay, "postgres:17-alpine") {
		t.Errorf("the pinned version was re-derived from the catalog default:\n%s", overlay)
	}
}

// Two databases of the same engine in one project are the case that the old
// project-level environment could not express.
func TestOverlayScopesCredentialsPerService(t *testing.T) {
	svc := testService(t)
	ctx := context.Background()

	p, err := svc.Create(ctx, CreateInput{Name: "twin"})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	for _, name := range []string{"primary", "secondary"} {
		if _, err := svc.CreateService(ctx, defaultEnv(t, svc, p), ServiceInput{
			Name:     name,
			Provider: database.ProviderImage,
			Database: &DatabaseInput{
				Engine: "postgres", Version: "17-alpine", Name: "app", User: "app", Password: name + "-pw",
			},
		}); err != nil {
			t.Fatalf("create %s: %v", name, err)
		}
	}
	if _, err := svc.WriteOverlay(ctx, defaultEnv(t, svc, p)); err != nil {
		t.Fatalf("write overlay: %v", err)
	}
	for _, name := range []string{"primary", "secondary"} {
		env, err := os.ReadFile(svc.ServiceEnvFilePath(defaultEnv(t, svc, p), name))
		if err != nil {
			t.Fatalf("read %s env: %v", name, err)
		}
		if !strings.Contains(string(env), "POSTGRES_PASSWORD="+name+"-pw") {
			t.Errorf("%s got the wrong password:\n%s", name, env)
		}
	}
}

// A compose fragment is the service body as the user wrote it. Named volumes
// have to be declared at the top of the overlay or compose rejects the file,
// and env_file: .env has to land on the project env file the Environment tab
// writes, not a relative path next to the compose file.
func TestOverlayRendersComposeFragmentVolumesAndEnvFile(t *testing.T) {
	svc := testService(t)
	ctx := context.Background()

	p, err := svc.Create(ctx, CreateInput{Name: "vault"})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	fragment := `image: vaultwarden/server:1.37.1-alpine
restart: always
env_file:
  - .env
volumes:
  - vaultwarden:/data
expose:
  - 80`
	if _, err := svc.CreateService(ctx, defaultEnv(t, svc, p), ServiceInput{
		Name:            "vaultwarden",
		Provider:        database.ProviderRaw,
		ComposeFragment: fragment,
	}); err != nil {
		t.Fatalf("create service: %v", err)
	}

	path, err := svc.WriteOverlay(ctx, defaultEnv(t, svc, p))
	if err != nil || path == "" {
		t.Fatalf("write overlay: %q, %v", path, err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read overlay: %v", err)
	}
	overlay := string(raw)
	envPath := svc.EnvFilePath(defaultEnv(t, svc, p))
	for _, want := range []string{
		"image: vaultwarden/server:1.37.1-alpine",
		"vaultwarden:/data",
		"\nvolumes:\n  vaultwarden: {}\n",
		"expose:",
		envPath,
	} {
		if !strings.Contains(overlay, want) {
			t.Errorf("overlay is missing %q:\n%s", want, overlay)
		}
	}
	if strings.Contains(overlay, "- .env") {
		t.Errorf("env_file still points at a relative .env:\n%s", overlay)
	}
}

// A static build writes its Dockerfile into the overlay, so the nginx config's
// $uri has to reach Docker as a literal rather than as a compose variable.
func TestOverlayRendersBuildTypes(t *testing.T) {
	svc := testService(t)
	ctx := context.Background()

	p, err := svc.Create(ctx, CreateInput{Name: "usagefleet"})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	env := defaultEnv(t, svc, p)
	for _, name := range []string{"site", "api"} {
		if _, err := svc.CreateService(ctx, env, ServiceInput{
			Name: name, Provider: database.ProviderGit, RepositoryURL: "https://example.com/app.git",
		}); err != nil {
			t.Fatalf("create %s: %v", name, err)
		}
	}
	site, err := svc.db.ServiceByName(ctx, env.ID, "site")
	if err != nil {
		t.Fatal(err)
	}
	site.BuildType = database.BuildStatic
	api, err := svc.db.ServiceByName(ctx, env.ID, "api")
	if err != nil {
		t.Fatal(err)
	}
	api.Dockerfile, api.BuildTarget = "docker/api.Dockerfile", "production"
	api.Mounts = "push:/data"
	for _, s := range []*database.Service{site, api} {
		if err := svc.db.UpdateService(ctx, s); err != nil {
			t.Fatal(err)
		}
	}
	if err := svc.db.CreateServicePort(ctx, &database.ServicePort{ServiceID: api.ID, Published: 5353, Target: 53, Protocol: "udp"}); err != nil {
		t.Fatal(err)
	}

	path, err := svc.WriteOverlay(ctx, env)
	if err != nil {
		t.Fatalf("write overlay: %v", err)
	}
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("read overlay: %v", err)
	}
	overlay := string(raw)
	for _, want := range []string{
		"      dockerfile_inline: |\n        FROM nginx:alpine\n",
		"try_files $$uri $$uri/ /index.html;",
		`      dockerfile: "docker/api.Dockerfile"`,
		`      target: "production"`,
		"    image: usagefleet/production/api:latest\n    pull_policy: never\n    ports:\n      - \"5353:53/udp\"\n",
		"    volumes:\n      - push:/data\n",
		"\nvolumes:\n  push:",
	} {
		if !strings.Contains(overlay, want) {
			t.Errorf("overlay lacks %q:\n%s", want, overlay)
		}
	}
}
