package notify

import (
	"encoding/json"
	"testing"

	"github.com/vexdock/platform/manager/internal/database"
)

func TestBodyShapePerService(t *testing.T) {
	d := &database.Deployment{ID: "d1", Number: 7, Status: database.DeploymentFailed}

	discord, ok := body("https://discord.com/api/webhooks/1/abc", "boom", d).(map[string]string)
	if !ok || discord["content"] != "boom" {
		t.Fatalf("discord payload must use content: %#v", discord)
	}
	slack, ok := body("https://hooks.slack.com/services/x", "boom", d).(map[string]string)
	if !ok || slack["text"] != "boom" {
		t.Fatalf("slack payload must use text: %#v", slack)
	}
	generic, ok := body("https://example.com/hook", "boom", d).(map[string]any)
	if !ok || generic["deployment"] == nil {
		t.Fatalf("generic payload must carry the deployment: %#v", generic)
	}
	if _, err := json.Marshal(generic); err != nil {
		t.Fatalf("generic payload must marshal: %v", err)
	}
}

func TestMessageNamesProjectAndError(t *testing.T) {
	got := message("shop", &database.Deployment{Number: 3, Status: database.DeploymentFailed,
		Branch: "main", Error: "exit 1"})
	want := "Deployment #3 of shop failed on main: exit 1"
	if got != want {
		t.Fatalf("got %q want %q", got, want)
	}
}

func TestValidateURLRejectsNonHTTP(t *testing.T) {
	if err := ValidateURL(""); err != nil {
		t.Fatalf("empty url disables notifications, must be accepted: %v", err)
	}
	if err := ValidateURL("https://example.com/hook"); err != nil {
		t.Fatalf("valid url rejected: %v", err)
	}
	for _, bad := range []string{"file:///etc/passwd", "ftp://example.com", "not a url", "https://"} {
		if err := ValidateURL(bad); err == nil {
			t.Fatalf("url %q should have been rejected", bad)
		}
	}
}
