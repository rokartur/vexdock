package certificates

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestDirNameEscapesWildcard(t *testing.T) {
	if got := DirName("*.example.com"); got != "_wildcard.example.com" {
		t.Fatalf("wildcard must not reach the filesystem as a glob: %q", got)
	}
	if got := DirName("app.example.com"); got != "app.example.com" {
		t.Fatalf("plain hostname changed: %q", got)
	}
}

func TestIssueRefusesWildcardWithoutDNS01(t *testing.T) {
	issuer := NewIssuer(t.TempDir(), t.TempDir(), "https://acme.invalid/directory", "ops@example.com")
	if _, err := issuer.Issue(context.Background(), "*.example.com"); err == nil ||
		!strings.Contains(err.Error(), "DNS-01") {
		t.Fatalf("wildcard without a DNS provider must fail early, got %v", err)
	}
}

// zoneID has to climb the labels: the record lives under a.b.example.com while
// Cloudflare only knows the example.com zone.
func TestZoneIDWalksUpToTheRegisteredDomain(t *testing.T) {
	var asked []string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		name := r.URL.Query().Get("name")
		asked = append(asked, name)
		if name == "example.com" {
			_, _ = w.Write([]byte(`{"success":true,"result":[{"id":"zone-1"}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"success":true,"result":[]}`))
	}))
	defer server.Close()

	cf := &cloudflare{token: "t", client: server.Client(), baseURL: server.URL}
	id, err := cf.zoneID(context.Background(), "a.b.example.com")
	if err != nil {
		t.Fatalf("zone lookup failed: %v", err)
	}
	if id != "zone-1" {
		t.Fatalf("got zone %q", id)
	}
	if len(asked) != 3 || asked[0] != "a.b.example.com" || asked[2] != "example.com" {
		t.Fatalf("unexpected lookup order: %v", asked)
	}
}

func TestCloudflareSurfacesAPIErrors(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"success":false,"errors":[{"message":"Invalid API token"}]}`))
	}))
	defer server.Close()

	cf := &cloudflare{token: "t", client: server.Client(), baseURL: server.URL}
	_, err := cf.createTXT(context.Background(), "zone-1", "_acme-challenge.example.com", "v")
	if err == nil || !strings.Contains(err.Error(), "Invalid API token") {
		t.Fatalf("api error must reach the operator, got %v", err)
	}
}
