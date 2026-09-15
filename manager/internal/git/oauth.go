package git

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// GitLab and Gitea connect as OAuth applications. Both speak the same
// authorization-code flow, so the only per-provider details are the two
// endpoint paths and the scope names.

// GitLabScopes is what a connection needs: read the user to confirm who
// authorised, read repositories to clone them, api to list projects.
const GitLabScopes = "api read_user read_repository"

// GiteaScopes is Gitea's equivalent. Gitea rejects an authorisation whose
// scopes are not a subset of what the application was registered with, so this
// is also what the owner must tick when registering it.
const GiteaScopes = "read:repository read:user read:organization"

// Tokens is one OAuth grant.
type Tokens struct {
	AccessToken  string
	RefreshToken string
	// ExpiresAt is when the access token stops working, as a Unix second. Both
	// providers return a lifetime rather than a deadline, so this is computed.
	ExpiresAt int64
}

// Expired reports whether the access token needs refreshing. The minute of
// slack keeps a token from expiring between the check and the clone that uses
// it.
func (t Tokens) Expired() bool {
	return t.ExpiresAt == 0 || time.Now().Add(time.Minute).Unix() >= t.ExpiresAt
}

// AuthorizeURL is where the owner is sent to approve the application. state is
// handed back untouched on the callback, which is how the return leg knows
// which connection it belongs to.
func AuthorizeURL(providerType, host, clientID, redirectURI, state, scopes string) (string, error) {
	query := url.Values{
		"client_id":     {clientID},
		"redirect_uri":  {redirectURI},
		"response_type": {"code"},
		"state":         {state},
		"scope":         {scopes},
	}
	base := strings.TrimSuffix(host, "/")
	switch providerType {
	case ProviderGitLab:
		return base + "/oauth/authorize?" + query.Encode(), nil
	case ProviderGitea:
		return base + "/login/oauth/authorize?" + query.Encode(), nil
	}
	return "", fmt.Errorf("%s does not authorise through oauth", providerType)
}

// ExchangeCode turns the authorisation code from the callback into tokens.
func ExchangeCode(ctx context.Context, providerType, host, clientID, clientSecret, redirectURI, code string) (Tokens, error) {
	return oauthToken(ctx, providerType, host, url.Values{
		"client_id":     {clientID},
		"client_secret": {clientSecret},
		"code":          {code},
		"grant_type":    {"authorization_code"},
		"redirect_uri":  {redirectURI},
	})
}

// RefreshTokens trades a refresh token for a fresh grant. Both providers rotate
// the refresh token on every use, so the result has to be stored or the
// connection breaks on the call after next.
func RefreshTokens(ctx context.Context, providerType, host, clientID, clientSecret, redirectURI, refreshToken string) (Tokens, error) {
	if refreshToken == "" {
		return Tokens{}, fmt.Errorf("%s connection has not been authorised yet", providerType)
	}
	return oauthToken(ctx, providerType, host, url.Values{
		"client_id":     {clientID},
		"client_secret": {clientSecret},
		"refresh_token": {refreshToken},
		"grant_type":    {"refresh_token"},
		"redirect_uri":  {redirectURI},
	})
}

func oauthToken(ctx context.Context, providerType, host string, form url.Values) (Tokens, error) {
	endpoint, err := tokenEndpoint(providerType, host)
	if err != nil {
		return Tokens{}, err
	}

	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return Tokens{}, err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "vexdock")

	resp, err := providerHTTP.Do(req)
	if err != nil {
		return Tokens{}, err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return Tokens{}, apiError(providerType, resp)
	}

	var payload struct {
		AccessToken  string `json:"access_token"`
		RefreshToken string `json:"refresh_token"`
		ExpiresIn    int64  `json:"expires_in"`
		Error        string `json:"error"`
		ErrorDesc    string `json:"error_description"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&payload); err != nil {
		return Tokens{}, err
	}
	if payload.Error != "" {
		return Tokens{}, fmt.Errorf("%s oauth: %s: %s", providerType, payload.Error, payload.ErrorDesc)
	}
	if payload.AccessToken == "" {
		return Tokens{}, fmt.Errorf("%s returned no access token", providerType)
	}

	tokens := Tokens{AccessToken: payload.AccessToken, RefreshToken: payload.RefreshToken}
	if payload.ExpiresIn > 0 {
		tokens.ExpiresAt = time.Now().Add(time.Duration(payload.ExpiresIn) * time.Second).Unix()
	}
	return tokens, nil
}

func tokenEndpoint(providerType, host string) (string, error) {
	base := strings.TrimSuffix(host, "/")
	switch providerType {
	case ProviderGitLab:
		return base + "/oauth/token", nil
	case ProviderGitea:
		return base + "/login/oauth/access_token", nil
	}
	return "", fmt.Errorf("%s does not authorise through oauth", providerType)
}

// AuthenticatedUser is the login name of whoever authorised the connection.
// GitLab and Gitea both expose it, and it is what the dashboard shows to make
// a connection recognisable.
func (a Account) AuthenticatedUser(ctx context.Context) (string, error) {
	var user struct {
		Username string `json:"username"`
		Login    string `json:"login"`
	}
	if err := a.get(ctx, a.apiURL("/user"), &user); err != nil {
		return "", err
	}
	if user.Username != "" {
		return user.Username, nil
	}
	return user.Login, nil
}
