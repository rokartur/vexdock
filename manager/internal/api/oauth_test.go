package api

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"net/url"
	"path/filepath"
	"strings"
	"testing"

	"github.com/vexdock/platform/manager/internal/auth"
	"github.com/vexdock/platform/manager/internal/config"
	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/security"
)

// The whole OAuth flow an MCP client walks, through the real router: register,
// consent, exchange, use, refresh, and a replayed refresh token revoking the
// grant.
func TestOAuthFlow(t *testing.T) {
	dir := t.TempDir()
	db, err := database.Open(filepath.Join(dir, "app.db"))
	mustDo(t, err)
	t.Cleanup(func() { _ = db.Close() })
	ctx := context.Background()
	for _, id := range []string{"p1", "p2"} {
		mustDo(t, db.CreateProject(ctx, &database.Project{ID: id, Name: id, Slug: id, ComposeProjectName: id}))
		mustDo(t, db.CreateEnvironment(ctx, &database.Environment{ID: id, ProjectID: id, Name: "Production", Slug: "production", ComposeProjectName: id, IsDefault: true}))
	}
	cfg := &config.Config{DataDir: dir, PublicURL: "https://panel.example.com"}
	authService, err := auth.New(db, cfg)
	mustDo(t, err)
	t.Cleanup(func() { _ = authService.Close() })
	handler := New(Deps{Config: cfg, DB: db, Auth: authService, Log: slog.New(slog.NewTextHandler(io.Discard, nil))}).Handler()
	raw := security.RandomToken(32)
	_, err = db.CreateAPIToken(ctx, "u1", "admin", security.HashToken(raw), raw[:6], nil)
	mustDo(t, err)
	admin := "Bearer " + raw

	send := func(method, path, contentType, authorization, body string) *httptest.ResponseRecorder {
		r := httptest.NewRequest(method, path, strings.NewReader(body))
		r.Header.Set("Content-Type", contentType)
		if authorization != "" {
			r.Header.Set("Authorization", authorization)
		}
		w := httptest.NewRecorder()
		handler.ServeHTTP(w, r)
		return w
	}
	decodeInto := func(w *httptest.ResponseRecorder, dst any) {
		t.Helper()
		if err := json.Unmarshal(w.Body.Bytes(), dst); err != nil {
			t.Fatalf("%d %s: %v", w.Code, w.Body, err)
		}
	}

	var meta struct {
		TokenEndpoint string `json:"token_endpoint"`
	}
	decodeInto(send("GET", "/.well-known/oauth-authorization-server", "", "", ""), &meta)
	if meta.TokenEndpoint != "https://panel.example.com/api/oauth/token" {
		t.Errorf("token_endpoint = %q", meta.TokenEndpoint)
	}

	if w := send("OPTIONS", "/api/oauth/register", "", "", ""); w.Code != http.StatusNoContent || w.Header().Get("Access-Control-Allow-Origin") != "*" {
		t.Errorf("a browser client's preflight: %d %v", w.Code, w.Header())
	}
	if w := send("POST", "/api/oauth/register", "application/json", "", `{"redirect_uris":["javascript:alert(1)"]}`); w.Code != http.StatusBadRequest {
		t.Errorf("a javascript: redirect registered: %d %s", w.Code, w.Body)
	}
	const callback = "http://127.0.0.1:33418/callback"
	var client struct {
		ClientID string `json:"client_id"`
	}
	decodeInto(send("POST", "/api/oauth/register", "application/json", "", `{"client_name":"Claude","redirect_uris":["`+callback+`"]}`), &client)

	verifier := security.RandomToken(48)
	sum := sha256.Sum256([]byte(verifier))
	authorize := map[string]any{
		"client_id": client.ClientID, "redirect_uri": callback, "response_type": "code", "state": "xyz",
		"code_challenge": base64.RawURLEncoding.EncodeToString(sum[:]), "code_challenge_method": "S256",
		"resource": "https://panel.example.com/mcp",
	}
	query := url.Values{}
	for key, value := range authorize {
		query.Set(key, value.(string))
	}
	if w := send("GET", "/api/oauth/authorize?"+query.Encode(), "", admin, ""); w.Code != http.StatusOK || !strings.Contains(w.Body.String(), `"client_name":"Claude"`) {
		t.Fatalf("authorize check: %d %s", w.Code, w.Body)
	}
	other := map[string]any{}
	for key, value := range authorize {
		other[key] = value
	}
	other["redirect_uri"] = "https://evil.example.com/callback"
	body, _ := json.Marshal(other)
	if w := send("POST", "/api/oauth/authorize", "application/json", admin, string(body)); w.Code != http.StatusBadRequest {
		t.Errorf("an unregistered redirect_uri was approved: %d %s", w.Code, w.Body)
	}

	authorize["projects"] = []database.ProjectGrant{{ProjectID: "p1", Level: database.AccessRead}}
	body, _ = json.Marshal(authorize)
	var approved struct {
		Redirect string `json:"redirect"`
	}
	decodeInto(send("POST", "/api/oauth/authorize", "application/json", admin, string(body)), &approved)
	redirect, err := url.Parse(approved.Redirect)
	mustDo(t, err)
	if redirect.Query().Get("state") != "xyz" || !strings.HasPrefix(approved.Redirect, callback+"?") {
		t.Fatalf("redirect = %q", approved.Redirect)
	}
	code := redirect.Query().Get("code")

	type tokens struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		Error        string `json:"error"`
	}
	exchange := func(form url.Values) (int, tokens) {
		form.Set("client_id", client.ClientID)
		w := send("POST", "/api/oauth/token", "application/x-www-form-urlencoded", "", form.Encode())
		var out tokens
		decodeInto(w, &out)
		return w.Code, out
	}
	if status, _ := exchange(url.Values{"grant_type": {"authorization_code"}, "code": {code}, "redirect_uri": {callback}, "code_verifier": {security.RandomToken(48)}}); status != http.StatusBadRequest {
		t.Errorf("a wrong verifier exchanged the code: %d", status)
	}
	// The failed attempt burned the code, so approve again.
	decodeInto(send("POST", "/api/oauth/authorize", "application/json", admin, string(body)), &approved)
	redirect, _ = url.Parse(approved.Redirect)
	codeForm := url.Values{"grant_type": {"authorization_code"}, "code": {redirect.Query().Get("code")}, "redirect_uri": {callback}, "code_verifier": {verifier}}
	status, first := exchange(codeForm)
	if status != http.StatusOK || first.AccessToken == "" || first.RefreshToken == "" {
		t.Fatalf("exchange: %d %+v", status, first)
	}
	if status, _ := exchange(codeForm); status != http.StatusBadRequest {
		t.Errorf("a code was exchanged twice: %d", status)
	}

	if w := send("GET", "/api/projects/p1/environments", "", "Bearer "+first.AccessToken, ""); w.Code != http.StatusOK {
		t.Errorf("granted project: %d", w.Code)
	}
	if w := send("GET", "/api/projects/p2/environments", "", "Bearer "+first.AccessToken, ""); w.Code != http.StatusForbidden {
		t.Errorf("project outside the grant: %d", w.Code)
	}

	// This refresh names the client the Basic way, with no client_id in the form.
	refresh := httptest.NewRequest("POST", "/api/oauth/token", strings.NewReader(url.Values{"grant_type": {"refresh_token"}, "refresh_token": {first.RefreshToken}}.Encode()))
	refresh.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	refresh.SetBasicAuth(client.ClientID, "")
	refreshed := httptest.NewRecorder()
	handler.ServeHTTP(refreshed, refresh)
	var second tokens
	decodeInto(refreshed, &second)
	if refreshed.Code != http.StatusOK || second.AccessToken == first.AccessToken {
		t.Fatalf("refresh: %d %+v", refreshed.Code, second)
	}
	if w := send("GET", "/api/me", "", "Bearer "+first.AccessToken, ""); w.Code != http.StatusUnauthorized {
		t.Errorf("a rotated-out access token still works: %d", w.Code)
	}
	if status, replay := exchange(url.Values{"grant_type": {"refresh_token"}, "refresh_token": {first.RefreshToken}}); status != http.StatusBadRequest || replay.Error != "invalid_grant" {
		t.Errorf("a replayed refresh token: %d %+v", status, replay)
	}
	if w := send("GET", "/api/me", "", "Bearer "+second.AccessToken, ""); w.Code != http.StatusUnauthorized {
		t.Errorf("the replay did not revoke the grant: %d", w.Code)
	}
}

func TestOAuthNeedsHTTPS(t *testing.T) {
	for publicURL, enabled := range map[string]bool{
		"":                        false,
		"http://203.0.113.7:3000": false,
		"http://127.0.0.1:3000":   true,
		"https://panel.example":   true,
	} {
		s := New(Deps{Config: &config.Config{PublicURL: publicURL}})
		if _, ok := s.oauthIssuer(); ok != enabled {
			t.Errorf("%q: enabled = %v, want %v", publicURL, ok, enabled)
		}
	}
}
