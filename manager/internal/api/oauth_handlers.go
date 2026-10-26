package api

import (
	"crypto/sha256"
	"crypto/subtle"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"slices"
	"strings"
	"sync"
	"time"

	"github.com/vexdock/platform/manager/internal/auth"
	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/security"
)

// The manager is the OAuth 2.1 authorization server for its own MCP server, so
// clients that cannot send a header (claude.ai, ChatGPT) can still connect. A
// client registers itself, the administrator approves it on the dashboard's
// consent screen with the same project levels a token carries, and the grant
// it gets is an api_tokens row (database/oauth.go). PKCE with S256 is required.

const codeLifetime = 5 * time.Minute

// oauthIssuer is the authorization server's identifier, the dashboard's public
// origin. OAuth needs https, or plain http on a loopback address for local
// development; without either every OAuth endpoint answers OAUTH_DISABLED.
func (s *Server) oauthIssuer() (string, bool) {
	u, err := url.Parse(s.Config.PublicURL)
	if err != nil || s.Config.PublicURL == "" {
		return "", false
	}
	if u.Scheme == "https" || (u.Scheme == "http" && isLoopback(u.Hostname())) {
		return s.Config.PublicURL, true
	}
	return "", false
}

func oauthDisabled(w http.ResponseWriter) {
	writeError(w, http.StatusNotFound, "OAUTH_DISABLED", "OAuth needs PUBLIC_URL set to an https address", nil)
}

// allowAnyOrigin opens the public OAuth endpoints to clients that run in a
// browser (MCP Inspector). None of them reads a cookie, so no origin gains
// anything a server-side client does not already have.
func allowAnyOrigin(h http.HandlerFunc) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		if r.Method != http.MethodOptions {
			h(w, r)
			return
		}
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST")
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, MCP-Protocol-Version")
		w.WriteHeader(http.StatusNoContent)
	}
}

func (s *Server) handleAuthorizationServerMetadata(w http.ResponseWriter, r *http.Request) {
	issuer, ok := s.oauthIssuer()
	if !ok {
		oauthDisabled(w)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"issuer":                                issuer,
		"authorization_endpoint":                issuer + "/oauth/authorize",
		"token_endpoint":                        issuer + "/api/oauth/token",
		"registration_endpoint":                 issuer + "/api/oauth/register",
		"response_types_supported":              []string{"code"},
		"grant_types_supported":                 []string{"authorization_code", "refresh_token"},
		"code_challenge_methods_supported":      []string{"S256"},
		"token_endpoint_auth_methods_supported": []string{"none"},
	})
}

// handleProtectedResourceMetadata describes /mcp (RFC 9728). The MCP server
// points clients here from its 401.
func (s *Server) handleProtectedResourceMetadata(w http.ResponseWriter, r *http.Request) {
	issuer, ok := s.oauthIssuer()
	if !ok {
		oauthDisabled(w)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"resource":                 issuer + "/mcp",
		"authorization_servers":    []string{issuer},
		"bearer_methods_supported": []string{"header"},
	})
}

// handleOAuthRegister is open dynamic client registration (RFC 7591). Every
// client is public and gets no secret, whatever auth method it asked for.
func (s *Server) handleOAuthRegister(w http.ResponseWriter, r *http.Request) {
	if _, ok := s.oauthIssuer(); !ok {
		oauthDisabled(w)
		return
	}
	var req struct {
		RedirectURIs []string `json:"redirect_uris"`
		ClientName   string   `json:"client_name"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&req); err != nil {
		oauthError(w, http.StatusBadRequest, "invalid_client_metadata", err.Error())
		return
	}
	if len(req.RedirectURIs) == 0 || len(req.RedirectURIs) > 10 {
		oauthError(w, http.StatusBadRequest, "invalid_redirect_uri", "between 1 and 10 redirect_uris are required")
		return
	}
	for _, uri := range req.RedirectURIs {
		if !validRedirectURI(uri) {
			oauthError(w, http.StatusBadRequest, "invalid_redirect_uri", fmt.Sprintf("%q must be https, loopback http or an app's own scheme", uri))
			return
		}
	}
	name := strings.TrimSpace(req.ClientName)
	if name == "" {
		name = "MCP client"
	}
	if len(name) > 100 {
		oauthError(w, http.StatusBadRequest, "invalid_client_metadata", "client_name is longer than 100 bytes")
		return
	}
	client, err := s.DB.CreateOAuthClient(r.Context(), name, req.RedirectURIs)
	if err != nil {
		serverError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"client_id":                  client.ID,
		"client_id_issued_at":        database.ParseTime(client.CreatedAt).Unix(),
		"client_name":                client.Name,
		"redirect_uris":              client.RedirectURIs,
		"grant_types":                []string{"authorization_code", "refresh_token"},
		"response_types":             []string{"code"},
		"token_endpoint_auth_method": "none",
	})
}

// validRedirectURI accepts https, http on a loopback address and a native
// app's own scheme (cursor://). The consent screen navigates to this address,
// so a scheme a browser runs or reads locally would execute on the dashboard.
func validRedirectURI(raw string) bool {
	u, err := url.Parse(raw)
	if err != nil || u.Fragment != "" || u.Scheme == "" {
		return false
	}
	switch strings.ToLower(u.Scheme) {
	case "https":
		return u.Host != ""
	case "http":
		return isLoopback(u.Hostname())
	case "javascript", "data", "file", "vbscript", "blob", "about", "ws", "wss", "ftp":
		return false
	}
	return true
}

func isLoopback(host string) bool {
	if host == "localhost" {
		return true
	}
	ip := net.ParseIP(host)
	return ip != nil && ip.IsLoopback()
}

// authorizeRequest is the client's authorization request, which the consent
// screen passes on unchanged from its query string.
type authorizeRequest struct {
	ClientID            string `json:"client_id"`
	RedirectURI         string `json:"redirect_uri"`
	ResponseType        string `json:"response_type"`
	CodeChallenge       string `json:"code_challenge"`
	CodeChallengeMethod string `json:"code_challenge_method"`
	State               string `json:"state"`
	Resource            string `json:"resource"`
}

// handleOAuthAuthorizeCheck lets the consent screen validate the request and
// name the client before it asks the administrator anything.
func (s *Server) handleOAuthAuthorizeCheck(w http.ResponseWriter, r *http.Request) {
	q := r.URL.Query()
	req := authorizeRequest{
		ClientID:            q.Get("client_id"),
		RedirectURI:         q.Get("redirect_uri"),
		ResponseType:        q.Get("response_type"),
		CodeChallenge:       q.Get("code_challenge"),
		CodeChallengeMethod: q.Get("code_challenge_method"),
		State:               q.Get("state"),
		Resource:            q.Get("resource"),
	}
	client, _, ok := s.authorizeClient(w, r, req)
	if !ok {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"client_name": client.Name, "redirect_uri": req.RedirectURI})
}

// handleOAuthAuthorize records the administrator's approval and answers with
// the address the consent screen sends the browser back to. No projects means
// full access, as for a token.
func (s *Server) handleOAuthAuthorize(w http.ResponseWriter, r *http.Request) {
	var req struct {
		authorizeRequest
		Projects []database.ProjectGrant `json:"projects"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	client, issuer, ok := s.authorizeClient(w, r, req.authorizeRequest)
	if !ok || !s.validGrants(w, r, req.Projects) {
		return
	}
	user, _ := auth.UserFrom(r.Context())
	code := s.codes.add(authCode{
		clientID:    client.ID,
		redirectURI: req.RedirectURI,
		challenge:   req.CodeChallenge,
		userID:      user.ID,
		grants:      req.Projects,
	})
	redirect, err := url.Parse(req.RedirectURI)
	if err != nil {
		serverError(w, err)
		return
	}
	query := redirect.Query()
	query.Set("code", code)
	query.Set("iss", issuer)
	if req.State != "" {
		query.Set("state", req.State)
	}
	redirect.RawQuery = query.Encode()
	writeJSON(w, http.StatusOK, map[string]string{"redirect": redirect.String()})
}

// authorizeClient checks an authorization request against the registered
// client. A bad client or redirect URI is never redirected to, so every
// failure is an error for the consent screen to show.
func (s *Server) authorizeClient(w http.ResponseWriter, r *http.Request, req authorizeRequest) (*database.OAuthClient, string, bool) {
	issuer, ok := s.oauthIssuer()
	if !ok {
		oauthDisabled(w)
		return nil, "", false
	}
	client, err := s.DB.OAuthClientByID(r.Context(), req.ClientID)
	if errors.Is(err, database.ErrNotFound) {
		badRequest(w, errors.New("unknown client_id; the client has to register again"))
		return nil, "", false
	}
	if err != nil {
		serverError(w, err)
		return nil, "", false
	}
	var problem string
	switch {
	case !slices.Contains(client.RedirectURIs, req.RedirectURI):
		problem = "redirect_uri is not registered for this client"
	case req.ResponseType != "code":
		problem = `response_type must be "code"`
	case req.CodeChallenge == "" || req.CodeChallengeMethod != "S256":
		problem = "PKCE with code_challenge_method S256 is required"
	case req.Resource != "" && req.Resource != issuer+"/mcp":
		problem = fmt.Sprintf("resource must be %s/mcp", issuer)
	}
	if problem != "" {
		badRequest(w, errors.New(problem))
		return nil, "", false
	}
	return client, issuer, true
}

// handleOAuthToken exchanges an authorization code or a refresh token for a
// new token pair. Errors follow RFC 6749, not the API's own envelope, because
// OAuth client libraries parse them.
func (s *Server) handleOAuthToken(w http.ResponseWriter, r *http.Request) {
	issuer, ok := s.oauthIssuer()
	if !ok {
		oauthDisabled(w)
		return
	}
	r.Body = http.MaxBytesReader(w, r.Body, 64<<10)
	if err := r.ParseForm(); err != nil {
		oauthError(w, http.StatusBadRequest, "invalid_request", err.Error())
		return
	}
	form := r.PostForm
	// A public client may still authenticate the RFC 6749 way, with its id as the
	// Basic username and an empty password.
	clientID := form.Get("client_id")
	if basicID, _, ok := r.BasicAuth(); ok && clientID == "" {
		clientID = basicID
	}
	if resource := form.Get("resource"); resource != "" && resource != issuer+"/mcp" {
		oauthError(w, http.StatusBadRequest, "invalid_target", fmt.Sprintf("resource must be %s/mcp", issuer))
		return
	}
	access, refresh := security.RandomToken(32), security.RandomToken(32)
	switch form.Get("grant_type") {
	case "authorization_code":
		code, ok := s.codes.take(form.Get("code"))
		redirectURI := form.Get("redirect_uri")
		if !ok || code.clientID != clientID || (redirectURI != "" && redirectURI != code.redirectURI) ||
			!pkceMatches(code.challenge, form.Get("code_verifier")) {
			oauthError(w, http.StatusBadRequest, "invalid_grant", "the code is unknown, used, expired or was issued to another client")
			return
		}
		client, err := s.DB.OAuthClientByID(r.Context(), code.clientID)
		if err == nil {
			_, err = s.DB.CreateOAuthGrant(r.Context(), code.userID, client, code.grants, security.HashToken(access), security.HashToken(refresh), access[:6])
		}
		if err != nil {
			serverError(w, err)
			return
		}
	case "refresh_token":
		err := s.DB.RotateOAuthGrant(r.Context(), clientID, security.HashToken(form.Get("refresh_token")),
			security.HashToken(access), security.HashToken(refresh), access[:6])
		if errors.Is(err, database.ErrNotFound) {
			oauthError(w, http.StatusBadRequest, "invalid_grant", "the refresh token is unknown, expired or was already used")
			return
		}
		if err != nil {
			serverError(w, err)
			return
		}
	default:
		oauthError(w, http.StatusBadRequest, "unsupported_grant_type", `grant_type must be "authorization_code" or "refresh_token"`)
		return
	}
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, http.StatusOK, map[string]any{
		"access_token":  access,
		"token_type":    "Bearer",
		"expires_in":    int(database.OAuthAccessLifetime.Seconds()),
		"refresh_token": refresh,
	})
}

func oauthError(w http.ResponseWriter, status int, code, description string) {
	w.Header().Set("Cache-Control", "no-store")
	writeJSON(w, status, map[string]string{"error": code, "error_description": description})
}

// pkceMatches checks a code verifier against its S256 challenge (RFC 7636).
func pkceMatches(challenge, verifier string) bool {
	if len(verifier) < 43 || len(verifier) > 128 {
		return false
	}
	sum := sha256.Sum256([]byte(verifier))
	return subtle.ConstantTimeCompare([]byte(base64.RawURLEncoding.EncodeToString(sum[:])), []byte(challenge)) == 1
}

// authCode is an approval waiting to be exchanged. Codes live in memory: a
// restart in the minutes between consent and exchange only means clicking
// Allow again.
type authCode struct {
	clientID, redirectURI, challenge, userID string
	grants                                   []database.ProjectGrant
	expires                                  time.Time
}

type authCodes struct {
	mu      sync.Mutex
	pending map[string]authCode
}

// add stores an approval and returns its single-use code, dropping the
// approvals nobody came back for.
func (c *authCodes) add(code authCode) string {
	c.mu.Lock()
	defer c.mu.Unlock()
	now := time.Now()
	for hash, pending := range c.pending {
		if now.After(pending.expires) {
			delete(c.pending, hash)
		}
	}
	raw := security.RandomToken(32)
	code.expires = now.Add(codeLifetime)
	c.pending[security.HashToken(raw)] = code
	return raw
}

func (c *authCodes) take(raw string) (authCode, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	hash := security.HashToken(raw)
	code, ok := c.pending[hash]
	delete(c.pending, hash)
	return code, ok && time.Now().Before(code.expires)
}
