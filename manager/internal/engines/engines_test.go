package engines

import (
	"regexp"
	"sort"
	"strings"
	"testing"
)

// A database image starts from the variables its env file carries, so the
// catalog is only correct if Render seeds every one the engine needs. This is
// the check that fails when an engine gains a variable and nobody adds it.
func TestRenderSeedsEveryRequiredVariable(t *testing.T) {
	for _, engine := range Catalog {
		t.Run(engine.Slug, func(t *testing.T) {
			out, err := Render(Spec{
				Engine:   engine.Slug,
				Name:     "shop-db",
				EnvFile:  "/projects/01jabc/services/shop-db.env",
				Image:    "clickhouse/clickhouse-server:24",
				DataPath: "/var/lib/clickhouse",
			})
			if err != nil {
				t.Fatalf("render: %v", err)
			}
			seeded := map[string]bool{}
			for _, v := range out.Env {
				seeded[v.Key] = true
			}
			for _, key := range requiredVars(engine.Slug) {
				if !seeded[key] {
					t.Errorf("the engine requires %s but Render does not seed it", key)
				}
			}
			// The volume has to be namespaced by service, or a second database
			// in the same project would mount the first one's data.
			if out.Volume != "shop-db-data" || !strings.Contains(out.Fragment, "shop-db-data:") {
				t.Errorf("volume = %q, fragment does not mount it per service", out.Volume)
			}
			if !strings.Contains(out.Fragment, `env_file: ["/projects/01jabc/services/shop-db.env"]`) {
				t.Error("the fragment does not read the service's own env file")
			}
		})
	}
}

func TestRenderRejectsUnsafeInput(t *testing.T) {
	base := Spec{Engine: "postgres", Name: "db", EnvFile: "/e.env"}
	cases := map[string]Spec{
		"tag with a second image":  withTag(base, "17-alpine\n    command: rm -rf /"),
		"database name with quote": withDatabase(base, `app"`),
		"user with a dollar":       withUser(base, "app$USER"),
		"unknown engine":           {Engine: "cassandra", Name: "db", EnvFile: "/e.env"},
		"custom without data path": {Engine: Custom, Name: "db", EnvFile: "/e.env", Image: "redis:7"},
		"custom with bad image": {
			Engine: Custom, Name: "db", EnvFile: "/e.env", Image: "redis:7; rm -rf /", DataPath: "/data",
		},
		"no env file": {Engine: "postgres", Name: "db"},
	}
	for name, spec := range cases {
		t.Run(name, func(t *testing.T) {
			if _, err := Render(spec); err == nil {
				t.Fatal("expected the spec to be refused")
			}
		})
	}
}

// A curated engine builds its image from the catalog, never from user text.
func TestRenderPinsTheCuratedRepository(t *testing.T) {
	out, err := Render(Spec{Engine: "valkey", Tag: "8-alpine", Name: "cache", EnvFile: "/e.env"})
	if err != nil {
		t.Fatalf("render: %v", err)
	}
	if out.Image != "valkey/valkey:8-alpine" {
		t.Fatalf("image = %q, want valkey/valkey:8-alpine", out.Image)
	}
	if !strings.Contains(out.Fragment, "image: valkey/valkey:8-alpine") {
		t.Error("the fragment does not run the resolved image")
	}
}

// Credentials reach the container through its env file, so nothing the user
// typed may end up interpolated by compose instead.
func TestFragmentsNeverInterpolate(t *testing.T) {
	for _, engine := range Catalog {
		out, err := Render(Spec{
			Engine: engine.Slug, Name: "db", EnvFile: "/e.env",
			Image: "clickhouse/clickhouse-server:24", DataPath: "/var/lib/clickhouse",
		})
		if err != nil {
			t.Fatalf("%s: render: %v", engine.Slug, err)
		}
		if strings.Contains(strings.ReplaceAll(out.Fragment, "$$", ""), "$") {
			t.Errorf("%s: fragment leaves a compose interpolation behind", engine.Slug)
		}
	}
}

func TestDescribeBuildsAConnectionURL(t *testing.T) {
	engine, _ := BySlug("postgres")
	got := Describe(engine, "shop-db", "postgres:17-alpine", map[string]string{
		"POSTGRES_DB":       "shop",
		"POSTGRES_USER":     "app",
		"POSTGRES_PASSWORD": "s3cret",
	})
	if got.URL != "postgresql://app:s3cret@shop-db:5432/shop" {
		t.Fatalf("url = %q", got.URL)
	}
}

// Valkey has no user and no database; the URL must not invent either.
func TestDescribeHandlesAnEngineWithoutAUser(t *testing.T) {
	engine, _ := BySlug("valkey")
	got := Describe(engine, "cache", "valkey/valkey:8-alpine", map[string]string{"VALKEY_PASSWORD": "pw"})
	if got.URL != "redis://pw@cache:6379/" {
		t.Fatalf("url = %q", got.URL)
	}
}

func withTag(s Spec, tag string) Spec     { s.Tag = tag; return s }
func withDatabase(s Spec, db string) Spec { s.Database = db; return s }
func withUser(s Spec, user string) Spec   { s.User = user; return s }

var referenced = regexp.MustCompile(`\$\$([A-Z0-9_]+)`)

// requiredVars proves every engine's fragment can actually start from the
// environment Render seeds for it.
func requiredVars(slug string) []string {
	engine, ok := BySlug(slug)
	if !ok {
		return nil
	}
	seen := map[string]bool{}
	out := []string{}
	add := func(name string) {
		if name == "" || seen[name] {
			return
		}
		seen[name] = true
		out = append(out, name)
	}
	// The variables the image itself reads never appear in the fragment now
	// that they arrive through an env file, so the catalog declares them.
	add(engine.DatabaseVar)
	add(engine.UserVar)
	add(engine.PasswordVar)
	for _, m := range referenced.FindAllStringSubmatch(engine.fragment, -1) {
		add(m[1])
	}
	sort.Strings(out)
	return out
}
