package api

import (
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"github.com/vexdock/platform/manager/internal/auth"
	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/git"
	"github.com/vexdock/platform/manager/internal/security"
)

// A connection is created in two halves. The first writes the row: the app
// credentials the owner registered, or the credential pair they pasted. The
// second is the handshake with the host, which returns through the redirect
// handlers at the bottom of this file and is what flips Connected to true.
//
// The row's id is the OAuth state throughout. The host echoes it back, it is
// unguessable for the same reason every other id is, and it says which
// connection the code belongs to without a side table of pending handshakes.

func (s *Server) handleListGitProviders(w http.ResponseWriter, r *http.Request) {
	providers, err := s.DB.ListGitProviders(r.Context())
	if err != nil {
		serverError(w, err)
		return
	}
	for i := range providers {
		s.attachWebhookURL(r, &providers[i])
	}
	writeJSON(w, http.StatusOK, map[string]any{"git_providers": providers})
}

func (s *Server) handleGetGitProvider(w http.ResponseWriter, r *http.Request) {
	provider, err := s.DB.GitProviderByID(r.Context(), r.PathValue("id"))
	if lookupFailed(w, err) {
		return
	}
	s.attachWebhookURL(r, provider)
	writeJSON(w, http.StatusOK, provider)
}

// attachWebhookURL is what the settings page pastes into the host's hook
// configuration. GitHub sets its own hook up from the manifest and signs it, so
// it never needs one.
func (s *Server) attachWebhookURL(r *http.Request, p *database.GitProvider) {
	if p.ProviderType == database.ProviderGitHub || p.WebhookSecretEnc == "" {
		return
	}
	secret, err := s.Cipher.Decrypt(p.WebhookSecretEnc)
	if err != nil {
		return
	}
	p.WebhookURL = s.publicOrigin(r) + "/api/deploy/" + p.ProviderType + "?token=" + url.QueryEscape(secret)
}

func (s *Server) handleRenameGitProvider(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name string `json:"name"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	name := strings.TrimSpace(req.Name)
	if name == "" {
		badRequest(w, fmt.Errorf("name is required"))
		return
	}
	if err := s.DB.RenameGitProvider(r.Context(), r.PathValue("id"), name); lookupFailed(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleDeleteGitProvider refuses while services still clone through the
// connection, because deleting it would leave them unable to deploy with
// nothing in the UI explaining why.
func (s *Server) handleDeleteGitProvider(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	provider, err := s.DB.GitProviderByID(r.Context(), id)
	if lookupFailed(w, err) {
		return
	}
	services, err := s.DB.ServicesForProvider(r.Context(), id)
	if err != nil {
		serverError(w, err)
		return
	}
	if len(services) > 0 {
		writeError(w, http.StatusConflict, "GIT_PROVIDER_IN_USE",
			fmt.Sprintf("%d service(s) still deploy from this connection", len(services)),
			map[string]any{"services": len(services)})
		return
	}
	if err := s.DB.DeleteGitProvider(r.Context(), id); lookupFailed(w, err) {
		return
	}
	// The cached installation token outlives the row otherwise, and would keep
	// working until it expired.
	if provider.GitHub != nil {
		git.ForgetInstallation(provider.GitHub.InstallationID)
	}
	writeJSON(w, http.StatusOK, map[string]any{"ok": true})
}

// handleGitProviderRepositories lists what the connection can clone. The
// dashboard calls it to fill the repository picker, so it is also the honest
// test of whether a connection still works.
func (s *Server) handleGitProviderRepositories(w http.ResponseWriter, r *http.Request) {
	account, ok := s.gitAccount(w, r)
	if !ok {
		return
	}
	repos, err := account.Repositories(r.Context())
	if err != nil {
		writeError(w, http.StatusBadGateway, "GIT_PROVIDER_ERROR", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"repositories": repos})
}

func (s *Server) handleGitProviderBranches(w http.ResponseWriter, r *http.Request) {
	owner, repository := r.URL.Query().Get("owner"), r.URL.Query().Get("repository")
	if owner == "" || repository == "" {
		badRequest(w, fmt.Errorf("owner and repository are required"))
		return
	}
	account, ok := s.gitAccount(w, r)
	if !ok {
		return
	}
	branches, err := account.Branches(r.Context(), owner, repository)
	if err != nil {
		writeError(w, http.StatusBadGateway, "GIT_PROVIDER_ERROR", err.Error(), nil)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"branches": branches})
}

func (s *Server) gitAccount(w http.ResponseWriter, r *http.Request) (git.Account, bool) {
	account, err := s.Projects.GitAccount(r.Context(), r.PathValue("id"))
	if err != nil {
		writeError(w, http.StatusBadRequest, "GIT_PROVIDER_UNAVAILABLE", err.Error(), nil)
		return git.Account{}, false
	}
	return account, true
}

// handleCreateGitHubProvider writes the empty connection and hands back the App
// manifest. The dashboard POSTs that manifest to GitHub, which walks the owner
// through creating the App and returns to the callback below with a code.
func (s *Server) handleCreateGitHubProvider(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name         string `json:"name"`
		URL          string `json:"github_url"`
		Organization string `json:"organization"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	host := strings.TrimSuffix(strings.TrimSpace(req.URL), "/")
	if host == "" {
		host = "https://github.com"
	}
	provider := &database.GitProvider{
		ID:           database.NewID(),
		Name:         strings.TrimSpace(req.Name),
		ProviderType: database.ProviderGitHub,
		GitHub:       &database.GitHubProvider{URL: host},
	}
	if provider.Name == "" {
		badRequest(w, fmt.Errorf("name is required"))
		return
	}
	if err := s.DB.CreateGitProvider(r.Context(), provider); err != nil {
		serverError(w, err)
		return
	}
	// GitHub requires a globally unique App name, so the connection's own name
	// is not usable as it stands.
	manifest := git.NewAppManifest(fmt.Sprintf("vexdock-%s", provider.ID[:8]), s.publicOrigin(r))
	target := host + "/settings/apps/new"
	if org := strings.TrimSpace(req.Organization); org != "" {
		target = fmt.Sprintf("%s/organizations/%s/settings/apps/new", host, org)
	}
	writeJSON(w, http.StatusCreated, map[string]any{
		"git_provider_id": provider.ID,
		"manifest":        manifest,
		"manifest_url":    fmt.Sprintf("%s?state=%s", target, provider.ID),
	})
}

// handleGitHubCallback is where GitHub returns once the App exists. The code is
// single use and lives ten minutes; exchanging it is what yields the private
// key the manager signs with from then on.
func (s *Server) handleGitHubCallback(w http.ResponseWriter, r *http.Request) {
	code, state := r.URL.Query().Get("code"), r.URL.Query().Get("state")
	if code == "" || state == "" {
		badRequest(w, fmt.Errorf("github returned no code"))
		return
	}
	provider, err := s.DB.GitProviderByID(r.Context(), state)
	if lookupFailed(w, err) {
		return
	}
	if provider.GitHub == nil {
		badRequest(w, fmt.Errorf("%q is not a github connection", provider.Name))
		return
	}
	creds, err := git.ExchangeAppManifest(r.Context(), provider.GitHub.URL, code)
	if err != nil {
		writeError(w, http.StatusBadGateway, "GIT_PROVIDER_ERROR", err.Error(), nil)
		return
	}
	g := provider.GitHub
	g.AppName, g.AppID, g.ClientID = creds.Name, creds.AppID, creds.ClientID
	for target, secret := range map[*string]string{
		&g.ClientSecretEnc:  creds.ClientSecret,
		&g.PrivateKeyEnc:    creds.PrivateKey,
		&g.WebhookSecretEnc: creds.WebhookSecret,
	} {
		enc, err := s.Projects.Encrypt(secret)
		if err != nil {
			serverError(w, err)
			return
		}
		*target = enc
	}
	if err := s.DB.UpdateGitHubApp(r.Context(), g); err != nil {
		serverError(w, err)
		return
	}
	// The App exists but reaches nothing yet: the owner still has to install it
	// and pick the repositories it may read.
	http.Redirect(w, r, git.InstallURL(g.URL, creds.Slug, provider.ID), http.StatusFound)
}

// handleGitHubInstalled records which installation the App became. Without it
// there is nothing to mint a token against.
func (s *Server) handleGitHubInstalled(w http.ResponseWriter, r *http.Request) {
	installationID, state := r.URL.Query().Get("installation_id"), r.URL.Query().Get("state")
	if installationID == "" || state == "" {
		badRequest(w, fmt.Errorf("github returned no installation"))
		return
	}
	if err := s.DB.SetGitHubInstallation(r.Context(), state, installationID); lookupFailed(w, err) {
		return
	}
	git.ForgetInstallation(installationID)
	s.redirectToSettings(w, r)
}

// handleSaveGitLabProvider creates or re-registers a GitLab OAuth application.
// It answers with the URL the owner has to visit to authorize it, because an
// application without a grant cannot read anything.
func (s *Server) handleSaveGitLabProvider(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name          string `json:"name"`
		URL           string `json:"gitlab_url"`
		ApplicationID string `json:"application_id"`
		Secret        string `json:"secret"`
		GroupName     string `json:"group_name"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	host := hostOrDefault(req.URL, "https://gitlab.com")
	if strings.TrimSpace(req.ApplicationID) == "" || strings.TrimSpace(req.Secret) == "" {
		badRequest(w, fmt.Errorf("application id and secret are required"))
		return
	}
	redirectURI := s.redirectURI(r, "gitlab")
	secretEnc, err := s.Projects.Encrypt(strings.TrimSpace(req.Secret))
	if err != nil {
		serverError(w, err)
		return
	}
	g := &database.GitLabProvider{
		GitProviderID: r.PathValue("id"),
		URL:           host,
		ApplicationID: strings.TrimSpace(req.ApplicationID),
		RedirectURI:   redirectURI,
		SecretEnc:     secretEnc,
		GroupName:     strings.TrimSpace(req.GroupName),
	}
	if g.GitProviderID == "" {
		provider, err := s.createProvider(r, database.ProviderGitLab, req.Name, func(p *database.GitProvider) {
			g.GitProviderID = p.ID
			p.GitLab = g
		})
		if err != nil {
			badRequest(w, err)
			return
		}
		g.GitProviderID = provider.ID
	} else if err := s.DB.UpdateGitLabApp(r.Context(), g); lookupFailed(w, err) {
		return
	}
	authorize, err := git.AuthorizeURL(database.ProviderGitLab, host, g.ApplicationID, redirectURI,
		g.GitProviderID, git.GitLabScopes)
	if err != nil {
		badRequest(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"git_provider_id": g.GitProviderID, "authorize_url": authorize})
}

// handleSaveGiteaProvider is GitLab's flow with Gitea's scope names.
func (s *Server) handleSaveGiteaProvider(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name             string `json:"name"`
		URL              string `json:"gitea_url"`
		ClientID         string `json:"client_id"`
		ClientSecret     string `json:"client_secret"`
		OrganizationName string `json:"organization_name"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	host := hostOrDefault(req.URL, "https://gitea.com")
	if strings.TrimSpace(req.ClientID) == "" || strings.TrimSpace(req.ClientSecret) == "" {
		badRequest(w, fmt.Errorf("client id and secret are required"))
		return
	}
	redirectURI := s.redirectURI(r, "gitea")
	secretEnc, err := s.Projects.Encrypt(strings.TrimSpace(req.ClientSecret))
	if err != nil {
		serverError(w, err)
		return
	}
	g := &database.GiteaProvider{
		GitProviderID:    r.PathValue("id"),
		URL:              host,
		RedirectURI:      redirectURI,
		ClientID:         strings.TrimSpace(req.ClientID),
		ClientSecretEnc:  secretEnc,
		Scopes:           git.GiteaScopes,
		OrganizationName: strings.TrimSpace(req.OrganizationName),
	}
	if g.GitProviderID == "" {
		provider, err := s.createProvider(r, database.ProviderGitea, req.Name, func(p *database.GitProvider) {
			g.GitProviderID = p.ID
			p.Gitea = g
		})
		if err != nil {
			badRequest(w, err)
			return
		}
		g.GitProviderID = provider.ID
	} else if err := s.DB.UpdateGiteaApp(r.Context(), g); lookupFailed(w, err) {
		return
	}
	authorize, err := git.AuthorizeURL(database.ProviderGitea, host, g.ClientID, redirectURI,
		g.GitProviderID, git.GiteaScopes)
	if err != nil {
		badRequest(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"git_provider_id": g.GitProviderID, "authorize_url": authorize})
}

// handleSaveBitbucketProvider takes a credential pair rather than an app, so
// there is no handshake: the connection is usable the moment it is stored.
func (s *Server) handleSaveBitbucketProvider(w http.ResponseWriter, r *http.Request) {
	var req struct {
		Name          string `json:"name"`
		Username      string `json:"bitbucket_username"`
		AppPassword   string `json:"app_password"`
		Email         string `json:"bitbucket_email"`
		APIToken      string `json:"api_token"`
		WorkspaceName string `json:"bitbucket_workspace_name"`
	}
	if err := decode(r, &req); err != nil {
		badRequest(w, err)
		return
	}
	hasAppPassword := strings.TrimSpace(req.Username) != "" && strings.TrimSpace(req.AppPassword) != ""
	hasAPIToken := strings.TrimSpace(req.Email) != "" && strings.TrimSpace(req.APIToken) != ""
	if !hasAppPassword && !hasAPIToken {
		badRequest(w, fmt.Errorf("give either a username and app password, or an email and API token"))
		return
	}
	g := &database.BitbucketProvider{
		GitProviderID: r.PathValue("id"),
		Username:      strings.TrimSpace(req.Username),
		Email:         strings.TrimSpace(req.Email),
		WorkspaceName: strings.TrimSpace(req.WorkspaceName),
	}
	for target, secret := range map[*string]string{
		&g.PasswordEnc: strings.TrimSpace(req.AppPassword),
		&g.APITokenEnc: strings.TrimSpace(req.APIToken),
	} {
		if secret == "" {
			continue
		}
		enc, err := s.Projects.Encrypt(secret)
		if err != nil {
			serverError(w, err)
			return
		}
		*target = enc
	}
	if g.GitProviderID == "" {
		provider, err := s.createProvider(r, database.ProviderBitbucket, req.Name, func(p *database.GitProvider) {
			g.GitProviderID = p.ID
			p.Bitbucket = g
		})
		if err != nil {
			badRequest(w, err)
			return
		}
		writeJSON(w, http.StatusCreated, map[string]any{"git_provider_id": provider.ID})
		return
	}
	if err := s.DB.UpdateBitbucketCredentials(r.Context(), g); lookupFailed(w, err) {
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"git_provider_id": g.GitProviderID})
}

// handleOAuthCallback finishes a GitLab or Gitea authorization. Both hosts
// return an authorization code that is exchanged for a grant, and both rotate
// their refresh token, so the pair is stored rather than just the access token.
func (s *Server) handleOAuthCallback(w http.ResponseWriter, r *http.Request) {
	providerType := r.PathValue("provider")
	code, state := r.URL.Query().Get("code"), r.URL.Query().Get("state")
	if code == "" || state == "" {
		badRequest(w, fmt.Errorf("%s returned no authorization code", providerType))
		return
	}
	provider, err := s.DB.GitProviderByID(r.Context(), state)
	if lookupFailed(w, err) {
		return
	}
	if provider.ProviderType != providerType {
		badRequest(w, fmt.Errorf("%q is not a %s connection", provider.Name, providerType))
		return
	}
	switch providerType {
	case database.ProviderGitLab:
		g := provider.GitLab
		secret, err := s.decryptOrFail(w, g.SecretEnc)
		if err != nil {
			return
		}
		tokens, err := git.ExchangeCode(r.Context(), database.ProviderGitLab, g.URL,
			g.ApplicationID, secret, g.RedirectURI, code)
		if err != nil {
			writeError(w, http.StatusBadGateway, "GIT_PROVIDER_ERROR", err.Error(), nil)
			return
		}
		if err := s.Projects.StoreGitLabTokens(r.Context(), g, tokens); err != nil {
			serverError(w, err)
			return
		}
	case database.ProviderGitea:
		g := provider.Gitea
		secret, err := s.decryptOrFail(w, g.ClientSecretEnc)
		if err != nil {
			return
		}
		tokens, err := git.ExchangeCode(r.Context(), database.ProviderGitea, g.URL,
			g.ClientID, secret, g.RedirectURI, code)
		if err != nil {
			writeError(w, http.StatusBadGateway, "GIT_PROVIDER_ERROR", err.Error(), nil)
			return
		}
		// Gitea's repository listing is per user, so who authorized decides
		// what the connection can see and is worth recording.
		username, err := git.Account{Type: database.ProviderGitea, Host: g.URL, Token: tokens.AccessToken}.
			AuthenticatedUser(r.Context())
		if err != nil {
			writeError(w, http.StatusBadGateway, "GIT_PROVIDER_ERROR", err.Error(), nil)
			return
		}
		if err := s.Projects.StoreGiteaTokens(r.Context(), g, tokens, username); err != nil {
			serverError(w, err)
			return
		}
	default:
		badRequest(w, fmt.Errorf("%q does not use oauth", providerType))
		return
	}
	s.redirectToSettings(w, r)
}

func (s *Server) decryptOrFail(w http.ResponseWriter, ciphertext string) (string, error) {
	plaintext, err := s.Cipher.Decrypt(ciphertext)
	if err != nil {
		serverError(w, err)
	}
	return plaintext, err
}

// createProvider writes the parent row and its detail in one transaction. The
// caller fills the detail struct, because only it knows which of the four it is.
func (s *Server) createProvider(r *http.Request, providerType, name string, attach func(*database.GitProvider)) (*database.GitProvider, error) {
	provider := &database.GitProvider{
		ID:           database.NewID(),
		Name:         strings.TrimSpace(name),
		ProviderType: providerType,
	}
	if provider.Name == "" {
		return nil, fmt.Errorf("name is required")
	}
	if providerType != database.ProviderGitHub {
		secretEnc, err := s.Cipher.Encrypt(security.RandomToken(24))
		if err != nil {
			return nil, err
		}
		provider.WebhookSecretEnc = secretEnc
	}
	attach(provider)
	if err := s.DB.CreateGitProvider(r.Context(), provider); err != nil {
		return nil, err
	}
	return provider, nil
}

// publicOrigin is the address a provider has to come back to. PLATFORM_PUBLIC_URL
// wins when it is set, because an install that knows its own domain should not
// depend on which hostname a browser happened to use; otherwise the request
// answers, so connecting works on a fresh install with no domain configured yet.
func (s *Server) publicOrigin(r *http.Request) string {
	if s.Config.PublicURL != "" {
		return s.Config.PublicURL
	}
	return auth.Origin(r)
}

// redirectURI is what the owner registers with the host, so it has to match
// byte for byte on both sides or the authorization is refused. It is stored on
// the connection for exactly that reason: the exchange has to repeat whatever
// the authorization used, even if the panel is reached differently later.
func (s *Server) redirectURI(r *http.Request, providerType string) string {
	return fmt.Sprintf("%s/api/providers/%s/callback", s.publicOrigin(r), providerType)
}

// redirectToSettings sends the browser back to where the owner started. The
// redirect handlers are reached by navigation, not by fetch, so answering with
// JSON would leave them staring at it.
func (s *Server) redirectToSettings(w http.ResponseWriter, r *http.Request) {
	http.Redirect(w, r, "/system/settings/git", http.StatusFound)
}

func hostOrDefault(raw, fallback string) string {
	host := strings.TrimSuffix(strings.TrimSpace(raw), "/")
	if host == "" {
		return fallback
	}
	return host
}
