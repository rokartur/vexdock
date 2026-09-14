package templates

import (
	"regexp"
	"testing"

	"github.com/vexdock/platform/manager/internal/security"
)

var interpolation = regexp.MustCompile(`\$\{([A-Za-z_][A-Za-z0-9_]*)\}`)

// The catalog is data, and the failure it invites is a fragment referencing a
// variable nobody declares: compose interpolates it to the empty string and the
// stack comes up with a blank password instead of failing.
func TestCatalogIsConsistent(t *testing.T) {
	slugs := map[string]bool{}
	for _, entry := range Catalog {
		if slugs[entry.Slug] {
			t.Fatalf("duplicate template slug %q", entry.Slug)
		}
		slugs[entry.Slug] = true

		declared := map[string]bool{}
		for _, v := range entry.Variables {
			if err := security.ValidateEnvKey(v.Key); err != nil {
				t.Fatalf("%s: %v", entry.Slug, err)
			}
			declared[v.Key] = true
		}
		names := map[string]bool{}
		for _, svc := range entry.Services {
			if err := security.ValidateServiceName(svc.Name); err != nil {
				t.Fatalf("%s: %v", entry.Slug, err)
			}
			names[svc.Name] = true
			for _, match := range interpolation.FindAllStringSubmatch(svc.fragment, -1) {
				if !declared[match[1]] {
					t.Fatalf("%s: fragment %s references undeclared ${%s}", entry.Slug, svc.Name, match[1])
				}
			}
		}
		if entry.Domain == nil {
			continue
		}
		if !names[entry.Domain.Service] {
			t.Fatalf("%s: domain points at unknown service %q", entry.Slug, entry.Domain.Service)
		}
		if err := security.ValidatePort(entry.Domain.Port); err != nil {
			t.Fatalf("%s: %v", entry.Slug, err)
		}
	}
}

func TestRenderResolvesPlaceholders(t *testing.T) {
	rendered, err := Render("ghost", "blog.example.com")
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	values := map[string]Variable{}
	for _, v := range rendered.Variables {
		values[v.Key] = v
	}
	if got := values["GHOST_HOST"]; got.Value != "blog.example.com" || got.Secret {
		t.Fatalf("hostname placeholder unresolved: %+v", got)
	}
	password, root := values["GHOST_DB_PASSWORD"], values["GHOST_DB_ROOT_PASSWORD"]
	if password.Value == "" || !password.Secret {
		t.Fatalf("generated value is not a stored secret: %+v", password)
	}
	// Two generated values sharing a secret would hand the application the
	// root credential.
	if password.Value == root.Value {
		t.Fatal("generated values repeat")
	}
	again, err := Render("ghost", "blog.example.com")
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	for _, v := range again.Variables {
		if v.Key == "GHOST_DB_PASSWORD" && v.Value == password.Value {
			t.Fatal("two installs generated the same secret")
		}
	}
}

func TestRenderRejects(t *testing.T) {
	if _, err := Render("not-a-template", "example.com"); err == nil {
		t.Fatal("unknown slug must fail")
	}
	if _, err := Render("ghost", ""); err == nil {
		t.Fatal("a template with a domain must require a hostname")
	}
}
