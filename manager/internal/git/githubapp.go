package git

// GitHub App support. A personal access token reaches everything its owner can
// reach; an app is installed on the repositories its owner picks and holds a
// private key instead of a token. The key signs a short JWT, the JWT mints an
// installation token that lives an hour, and that token both lists the
// installation's repositories and clones them.
//
// The app itself is created through GitHub's manifest flow: the dashboard posts
// a manifest describing the permissions, GitHub creates the app and hands back
// a one-time code, and the code is exchanged here for the key and the webhook
// secret. Nothing about the app is typed by hand.

import (
	"context"
	"crypto"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"time"
)

// App is a GitHub App as it exists right after GitHub created it.
type App struct {
	ID            string
	Slug          string
	Name          string
	PrivateKey    string
	WebhookSecret string
}

// Manifest describes the app GitHub is asked to create. The permissions are the
// least an app needs to clone a repository and follow its pushes.
func Manifest(name, publicURL string) map[string]any {
	return map[string]any{
		"name":         name,
		"url":          publicURL,
		"redirect_url": publicURL + "/api/git-apps/callback",
		// Where GitHub sends the owner after an install, and after every later
		// change to which repositories the app may reach.
		"setup_url":       publicURL + "/api/git-apps/installed",
		"setup_on_update": true,
		"public":          false,
		"hook_attributes": map[string]any{"url": publicURL + "/api/webhooks/github/app", "active": true},
		"default_events":  []string{"push"},
		"default_permissions": map[string]string{
			"contents": "read",
			"metadata": "read",
		},
	}
}

// ConvertManifest exchanges the one-time code GitHub redirects back with for the
// created app, private key and webhook secret included. The code is only valid
// for an hour and only once.
func ConvertManifest(ctx context.Context, code string) (App, error) {
	var body struct {
		ID            int64  `json:"id"`
		Slug          string `json:"slug"`
		Name          string `json:"name"`
		PEM           string `json:"pem"`
		WebhookSecret string `json:"webhook_secret"`
	}
	endpoint := "https://api.github.com/app-manifests/" + pathSegment(code) + "/conversions"
	if err := send(ctx, "github", http.MethodPost, endpoint, githubHeader(""), &body); err != nil {
		return App{}, err
	}
	if body.ID == 0 || body.PEM == "" {
		return App{}, fmt.Errorf("github created the app without a key")
	}
	return App{
		ID:            strconv.FormatInt(body.ID, 10),
		Slug:          body.Slug,
		Name:          body.Name,
		PrivateKey:    body.PEM,
		WebhookSecret: body.WebhookSecret,
	}, nil
}

// InstallationRepositories lists what an app installation can reach, which is
// every repository its owner selected, or every repository of the account when
// they chose all of them.
func InstallationRepositories(ctx context.Context, token string) ([]Repository, error) {
	var body struct {
		Repositories []repository `json:"repositories"`
	}
	endpoint := "https://api.github.com/installation/repositories?per_page=100"
	if err := send(ctx, "github", http.MethodGet, endpoint, githubHeader(token), &body); err != nil {
		return nil, err
	}
	return deployable(body.Repositories), nil
}

// AccountToken is what a connected account can authenticate with right now. A
// stored personal token already is one; an app account stores a private key
// instead and mints a token that lives an hour. Every caller that used to
// decrypt and send goes through here, so neither the clone nor the listings
// need to know which kind they are holding.
func AccountToken(ctx context.Context, appID, installationID, secret string) (string, error) {
	if appID == "" {
		return secret, nil
	}
	return InstallationToken(ctx, appID, installationID, secret)
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

// InstallationToken returns a token the installation can clone and read with,
// minting a new one when the cached one is close to expiring.
func InstallationToken(ctx context.Context, appID, installationID, privateKey string) (string, error) {
	if installationID == "" {
		return "", fmt.Errorf("the app is not installed on an account yet")
	}
	if cached, ok := tokenCache.Load(installationID); ok {
		if tok := cached.(installationToken); time.Now().Before(tok.expires) {
			return tok.value, nil
		}
	}
	jwt, err := appJWT(appID, privateKey)
	if err != nil {
		return "", err
	}
	var body struct {
		Token     string    `json:"token"`
		ExpiresAt time.Time `json:"expires_at"`
	}
	endpoint := "https://api.github.com/app/installations/" + pathSegment(installationID) + "/access_tokens"
	if err := send(ctx, "github", http.MethodPost, endpoint, githubHeader(jwt), &body); err != nil {
		return "", err
	}
	if body.Token == "" {
		return "", fmt.Errorf("github returned no installation token")
	}
	// A minute of slack so a token cannot expire between being handed out and
	// being used by a clone.
	tokenCache.Store(installationID, installationToken{value: body.Token, expires: body.ExpiresAt.Add(-time.Minute)})
	return body.Token, nil
}

// ForgetInstallation drops a cached token, so a disconnected account leaves
// nothing usable behind in memory.
func ForgetInstallation(installationID string) { tokenCache.Delete(installationID) }

// appJWT is the app's proof of identity: a ten minute RS256 token signed with
// the private key, which is the only thing GitHub accepts for minting
// installation tokens.
func appJWT(appID, privateKey string) (string, error) {
	key, err := parsePrivateKey(privateKey)
	if err != nil {
		return "", err
	}
	// Backdated because GitHub rejects a token whose iat is even slightly in its
	// future, and a server clock is never exactly GitHub's.
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
	digest := crypto.SHA256.New()
	digest.Write([]byte(signingInput))
	signature, err := rsa.SignPKCS1v15(rand.Reader, key, crypto.SHA256, digest.Sum(nil))
	if err != nil {
		return "", err
	}
	return signingInput + "." + encode(signature), nil
}

// parsePrivateKey reads the PEM GitHub generated. It ships PKCS#1, but a key
// re-saved by another tool comes back PKCS#8, and both are RSA.
func parsePrivateKey(privateKey string) (*rsa.PrivateKey, error) {
	block, _ := pem.Decode([]byte(privateKey))
	if block == nil {
		return nil, fmt.Errorf("the app key is not a PEM private key")
	}
	if key, err := x509.ParsePKCS1PrivateKey(block.Bytes); err == nil {
		return key, nil
	}
	parsed, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("the app key is not a usable RSA key: %w", err)
	}
	key, ok := parsed.(*rsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("the app key is not RSA")
	}
	return key, nil
}

// InstallationFromWebhook reads the installation a delivery belongs to. The
// payload is unverified at that point, so the value is only ever used to look
// up which secret the signature must be checked against.
func InstallationFromWebhook(body []byte) string {
	var payload struct {
		Installation struct {
			ID int64 `json:"id"`
		} `json:"installation"`
	}
	if err := json.Unmarshal(body, &payload); err != nil || payload.Installation.ID == 0 {
		return ""
	}
	return strconv.FormatInt(payload.Installation.ID, 10)
}

// pathSegment keeps a value that came from GitHub or a form out of the
// structure of a request path: anything but the digits and letters an id or a
// code is made of is dropped rather than escaped.
func pathSegment(segment string) string {
	return strings.Map(func(r rune) rune {
		switch {
		case r >= '0' && r <= '9', r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z':
			return r
		default:
			return -1
		}
	}, segment)
}

// githubHeader is how both an app JWT and an installation token authenticate;
// an empty credential is the unauthenticated manifest conversion, which is
// authorised by the one-time code in its path.
func githubHeader(credential string) http.Header {
	header := http.Header{"Accept": {"application/vnd.github+json"}}
	if credential != "" {
		header.Set("Authorization", "Bearer "+credential)
	}
	return header
}
