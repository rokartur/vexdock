package projects

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"os"
	"strings"
	"testing"

	"github.com/vexdock/platform/manager/internal/database"
)

// An application created as a bare name is the one service that has nothing to
// render, and the overlay is shared by every service in the project: emitting
// an empty body for it would fail the whole deploy, including its siblings.
func TestOverlaySkipsAnUnconfiguredApplication(t *testing.T) {
	svc := testService(t)
	ctx := context.Background()

	p, err := svc.Create(ctx, CreateInput{Name: "usagefleet"})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	if _, err := svc.CreateService(ctx, defaultEnv(t, svc, p), ServiceInput{Name: "web", Provider: database.ProviderUnconfigured}); err != nil {
		t.Fatalf("create unconfigured service: %v", err)
	}
	if _, err := svc.CreateService(ctx, defaultEnv(t, svc, p), ServiceInput{
		Name:     "db",
		Provider: database.ProviderImage,
		Database: &DatabaseInput{Engine: "postgres", Version: "17-alpine", Name: "app", User: "app", Password: "s3cret"},
	}); err != nil {
		t.Fatalf("create database: %v", err)
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
	if strings.Contains(overlay, "web:") {
		t.Errorf("an unconfigured application reached the overlay:\n%s", overlay)
	}
	if !strings.Contains(overlay, "image: postgres:17-alpine") {
		t.Errorf("its sibling was dropped with it:\n%s", overlay)
	}
}

// An export exists to be imported, so what matters is that it carries every
// field the create form would have asked for, and that a secret only leaves
// with its value when that was asked for explicitly.
func TestExportServicesWithholdsSecretsUnlessAsked(t *testing.T) {
	svc := testService(t)
	ctx := context.Background()

	p, err := svc.Create(ctx, CreateInput{Name: "usagefleet"})
	if err != nil {
		t.Fatalf("create project: %v", err)
	}
	if _, err := svc.CreateService(ctx, defaultEnv(t, svc, p), ServiceInput{
		Name:     "db",
		Provider: database.ProviderImage,
		Database: &DatabaseInput{Engine: "postgres", Version: "17-alpine", Name: "app", User: "app", Password: "s3cret"},
	}); err != nil {
		t.Fatalf("create database: %v", err)
	}

	withheld := decodeExport(t, svc, ctx, p, false)
	if len(withheld.Services) != 1 || withheld.Services[0].Image != "postgres:17-alpine" {
		t.Fatalf("export = %+v, want one postgres service", withheld.Services)
	}
	if withheld.Services[0].Engine != "postgres" {
		t.Errorf("engine did not travel, so the import cannot tell this is a database: %+v", withheld.Services[0])
	}
	for _, v := range withheld.Services[0].Env {
		if v.IsSecret && v.Value != "" {
			t.Errorf("%s left with its value in an export that did not ask for secrets", v.Key)
		}
		if !v.IsSecret && v.Value == "" {
			t.Errorf("%s lost its value, which was never a secret", v.Key)
		}
	}

	included := decodeExport(t, svc, ctx, p, true)
	if !hasSecret(included.Services[0].Env, "s3cret") {
		t.Errorf("an export asked for secrets came back without them: %+v", included.Services[0].Env)
	}
}

func decodeExport(t *testing.T, svc *Service, ctx context.Context, p *database.Project, secrets bool) Export {
	t.Helper()
	payload, err := svc.ExportServices(ctx, p, defaultEnv(t, svc, p), secrets)
	if err != nil {
		t.Fatalf("export: %v", err)
	}
	raw, err := base64.StdEncoding.DecodeString(payload)
	if err != nil {
		t.Fatalf("export is not base64: %v", err)
	}
	var out Export
	if err := json.Unmarshal(raw, &out); err != nil {
		t.Fatalf("export is not JSON: %v", err)
	}
	if out.Version != exportVersion {
		t.Fatalf("version = %d, want %d", out.Version, exportVersion)
	}
	return out
}

func hasSecret(env []PortableEnvVar, value string) bool {
	for _, v := range env {
		if v.IsSecret && v.Value == value {
			return true
		}
	}
	return false
}
