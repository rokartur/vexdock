package deployments

import (
	"testing"

	"github.com/vexdock/platform/manager/internal/compose"
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
