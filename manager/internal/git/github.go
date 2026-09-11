package git

import (
	"context"
	"crypto"
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"
)

// GitHub connects as a GitHub App, never as a personal access token. A personal
// token reaches everything its owner reaches; an App reaches only the
// repositories its owner ticked during the install. The App is created through
// GitHub's manifest flow, so nobody types a client secret or pastes a private
// key: the manager posts a manifest, GitHub creates the App and hands back the
// credentials, and the owner then picks which repositories it may read.

// AppManifest is the App description posted to GitHub.
type AppManifest struct {
	Name        string `json:"name"`
	URL         string `json:"url"`
	RedirectURL string `json:"redirect_url"`
	SetupURL    string `json:"setup_url"`
	// SetupOnUpdate brings the owner back here whenever they change which
	// repositories the App reaches, so the stored installation stays truthful.
	SetupOnUpdate bool              `json:"setup_on_update"`
	HookAttrs     map[string]any    `json:"hook_attributes"`
	Public        bool              `json:"public"`
	DefaultEvents []string          `json:"default_events"`
	DefaultPerms  map[string]string `json:"default_permissions"`
}

// NewAppManifest describes the App the manager wants. publicURL is where this
// installation is reachable, and it decides both where GitHub returns the
// owner and where it delivers pushes.
func NewAppManifest(name, publicURL string) AppManifest {
	base := strings.TrimSuffix(publicURL, "/")
	return AppManifest{
		Name:          name,
		URL:           base,
		RedirectURL:   base + "/api/providers/github/callback",
		SetupURL:      base + "/api/providers/github/installed",
		SetupOnUpdate: true,
		HookAttrs:     map[string]any{"url": base + "/api/deploy/github", "active": true},
		Public:        false,
		DefaultEvents: []string{"push"},
		// The least an App needs to clone a repository and follow its pushes.
		// Nothing here may write.
		DefaultPerms: map[string]string{
			"contents": "read",
			"metadata": "read",
		},
	}
}

// AppCredentials is what GitHub returns once a manifest becomes an App.
type AppCredentials struct {
	AppID         string
	Slug          string
	Name          string
	ClientID      string
	ClientSecret  string
	PrivateKey    string
	WebhookSecret string
}

// ExchangeAppManifest trades the one-time code GitHub sends to the manifest
// callback for the App's credentials. The code is valid once and for an hour.
func ExchangeAppManifest(ctx context.Context, host, code string) (AppCredentials, error) {
	endpoint := apiRoot(host) + "/app-manifests/" + url.PathEscape(code) + "/conversions"
	var payload struct {
		ID            int64  `json:"id"`
		Slug          string `json:"slug"`
		Name          string `json:"name"`
		ClientID      string `json:"client_id"`
		ClientSecret  string `json:"client_secret"`
		PEM           string `json:"pem"`
		WebhookSecret string `json:"webhook_secret"`
	}
	if err := githubCall(ctx, http.MethodPost, endpoint, "", &payload); err != nil {
		return AppCredentials{}, err
	}
	if payload.ID == 0 || payload.PEM == "" {
		return AppCredentials{}, fmt.Errorf("github created the app without a key")
	}
	return AppCredentials{
		AppID:         strconv.FormatInt(payload.ID, 10),
		Slug:          payload.Slug,
		Name:          payload.Name,
		ClientID:      payload.ClientID,
		ClientSecret:  payload.ClientSecret,
		PrivateKey:    payload.PEM,
		WebhookSecret: payload.WebhookSecret,
	}, nil
}

// InstallURL is where the owner goes to pick which repositories the App may
// read. GitHub returns to the App's setup URL afterwards with the installation
// id, which is the credential that actually clones.
func InstallURL(host, slug, state string) string {
	return fmt.Sprintf("%s/apps/%s/installations/new?state=%s",
		strings.TrimSuffix(host, "/"), url.PathEscape(slug), url.QueryEscape(state))
}

// installationToken is one minted token and the moment it stops being usable.
type installationToken struct {
	value   string
	expires time.Time
}

// tokenCache keeps a minted token for the hour it lives, keyed by installation:
// a deploy, a repository listing and a branch listing in the same minute should
// not be three round trips to GitHub.
var tokenCache sync.Map

// InstallationToken returns the short-lived token an App installation clones
// and reads with, minting a new one when the cached one is close to expiring.
func InstallationToken(ctx context.Context, host, appID, privateKey, installationID string) (string, error) {
	if appID == "" || privateKey == "" {
		return "", fmt.Errorf("the github app has not been created yet")
	}
	if installationID == "" {
		return "", fmt.Errorf("the github app is not installed on an account yet")
	}
	if cached, ok := tokenCache.Load(installationID); ok {
		if tok := cached.(installationToken); time.Now().Before(tok.expires) {
			return tok.value, nil
		}
	}

	assertion, err := appJWT(appID, privateKey)
	if err != nil {
		return "", err
	}
	var payload struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	endpoint := apiRoot(host) + "/app/installations/" + url.PathEscape(installationID) + "/access_tokens"
	if err := githubCall(ctx, http.MethodPost, endpoint, assertion, &payload); err != nil {
		return "", err
	}
	if payload.Token == "" {
		return "", fmt.Errorf("github returned no installation token")
	}
	// A minute of slack so a token cannot expire between being handed out and
	// being used by a clone.
	tokenCache.Store(installationID, installationToken{value: payload.Token, expires: payload.ExpiresAt.Add(-time.Minute)})
	return payload.Token, nil
}

// ForgetInstallation drops a cached token, so a disconnected account leaves
// nothing usable behind in memory.
func ForgetInstallation(installationID string) { tokenCache.Delete(installationID) }

// githubCall performs one GitHub API request with the headers GitHub requires
// and decodes the body into out. bearer is an App JWT, an installation token,
// or empty for the unauthenticated manifest exchange.
func githubCall(ctx context.Context, method, endpoint, bearer string, out any) error {
	req, err := http.NewRequestWithContext(ctx, method, endpoint, nil)
	if err != nil {
		return err
	}
	if bearer != "" {
		req.Header.Set("Authorization", "Bearer "+bearer)
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("X-GitHub-Api-Version", "2022-11-28")
	req.Header.Set("User-Agent", "vexdock")

	resp, err := providerHTTP.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return apiError(ProviderGitHub, resp)
	}
	return json.NewDecoder(resp.Body).Decode(out)
}

// appJWT is the App's proof of identity: a ten minute RS256 token signed with
// the private key, which is the only thing GitHub accepts for minting
// installation tokens.
func appJWT(appID, privateKey string) (string, error) {
	key, err := parsePrivateKey(privateKey)
	if err != nil {
		return "", err
	}
	// Backdated because GitHub rejects a token whose iat is even slightly in
	// its future, and a server clock is never exactly GitHub's.
	now := time.Now().Add(-30 * time.Second)
	claims, err := json.Marshal(map[string]any{
		"iat": now.Unix(),
		"exp": now.Add(9 * time.Minute).Unix(),
		"iss": appID,
	})
	if err != nil {
		return "", err
	}
	encode := base64.RawURLEncoding.EncodeToString
	signingInput := encode([]byte(`{"alg":"RS256","typ":"JWT"}`)) + "." + encode(claims)
	digest := sha256.Sum256([]byte(signingInput))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest[:])
	if err != nil {
		return "", err
	}
	return signingInput + "." + encode(signature), nil
}

// parsePrivateKey reads the PEM GitHub generated. It ships PKCS#1, but a key
// re-saved by another tool comes back PKCS#8, and both are RSA.
func parsePrivateKey(privateKey string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(strings.TrimSpace(privateKey)))
	if block == nil {
		return nil, fmt.Errorf("the app key is not a PEM private key")
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("the app key is not a usable private key")
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("the app key is not an RSA private key")
	}
	return key, nil
}

// apiRoot is GitHub's API for a host: a separate domain on github.com, a path
// prefix on Enterprise Server.
func apiRoot(host string) string {
	host = strings.TrimSuffix(host, "/")
	if host == "" || host == "https://github.com" {
		return "https://api.github.com"
	}
	return host + "/api/v3"
}

// VerifyWebhookSignature checks a delivery really came from the App whose
// webhook secret this is. GitHub signs the raw body, so the comparison has to
// happen before any parsing, and it is constant time because the alternative
// leaks the signature one byte at a time.
func VerifyWebhookSignature(secret string, body []byte, signature string) bool {
	if secret == "" || signature == "" {
		return false
	}
	mac := hmac.New(sha256.New, []byte(secret))
	mac.Write(body)
	want := "sha256=" + hex.EncodeToString(mac.Sum(nil))
	return hmac.Equal([]byte(want), []byte(signature))
}
