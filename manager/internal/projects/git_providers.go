package projects

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/git"
	"github.com/vexdock/platform/manager/internal/security"
)

// A stored connection is not usable as it stands: its secrets are encrypted, a
// GitHub App holds a private key rather than a token, and a GitLab or Gitea
// grant expires. GitAccount is the single place that turns one into something
// that can list repositories and clone them, so listing, branch lookup and
// deployment all authenticate identically.
func (s *Service) GitAccount(ctx context.Context, gitProviderID string) (git.Account, error) {
	provider, err := s.db.GitProviderByID(ctx, gitProviderID)
	if err != nil {
		if errors.Is(err, database.ErrNotFound) {
			return git.Account{}, fmt.Errorf("unknown git provider %q", gitProviderID)
		}
		return git.Account{}, err
	}
	return s.accountFor(ctx, provider)
}

func (s *Service) accountFor(ctx context.Context, provider *database.GitProvider) (git.Account, error) {
	switch provider.ProviderType {
	case database.ProviderGitHub:
		return s.githubAccount(ctx, provider.GitHub)
	case database.ProviderGitLab:
		return s.gitlabAccount(ctx, provider.GitLab)
	case database.ProviderBitbucket:
		return s.bitbucketAccount(provider.Bitbucket)
	case database.ProviderGitea:
		return s.giteaAccount(ctx, provider.Gitea)
	}
	return git.Account{}, fmt.Errorf("unknown git provider type %q", provider.ProviderType)
}

// githubAccount mints an installation token from the App's private key. The
// token is scoped to the repositories the installation was granted and lives
// about an hour, so it is resolved per use rather than stored.
func (s *Service) githubAccount(ctx context.Context, g *database.GitHubProvider) (git.Account, error) {
	key, err := s.cipher.Decrypt(g.PrivateKeyEnc)
	if err != nil {
		return git.Account{}, err
	}
	token, err := git.InstallationToken(ctx, g.URL, g.AppID, key, g.InstallationID)
	if err != nil {
		return git.Account{}, err
	}
	return git.Account{Type: database.ProviderGitHub, Host: g.URL, Token: token}, nil
}

// gitlabAccount returns the stored access token, refreshing the grant first
// when it is about to expire. GitLab rotates the refresh token on every use, so
// the new pair is written back before it is used.
func (s *Service) gitlabAccount(ctx context.Context, g *database.GitLabProvider) (git.Account, error) {
	if g.AccessTokenEnc == "" {
		return git.Account{}, fmt.Errorf("this gitlab connection has not been authorised yet")
	}
	tokens, err := s.decryptTokens(g.AccessTokenEnc, g.RefreshEnc, g.ExpiresAt)
	if err != nil {
		return git.Account{}, err
	}
	if tokens.Expired() {
		secret, err := s.cipher.Decrypt(g.SecretEnc)
		if err != nil {
			return git.Account{}, err
		}
		refreshed, err := git.RefreshTokens(ctx, database.ProviderGitLab, g.URL,
			g.ApplicationID, secret, g.RedirectURI, tokens.RefreshToken)
		if err != nil {
			return git.Account{}, fmt.Errorf("gitlab connection expired and could not be refreshed: %w", err)
		}
		if err := s.storeGitLabTokens(ctx, g, refreshed); err != nil {
			return git.Account{}, err
		}
		tokens = refreshed
	}
	return git.Account{
		Type:  database.ProviderGitLab,
		Host:  g.URL,
		Token: tokens.AccessToken,
		Scope: g.GroupName,
	}, nil
}

// bitbucketAccount prefers the API token pair, because Atlassian is retiring
// app passwords and a connection that has both should use the one that will
// keep working.
func (s *Service) bitbucketAccount(g *database.BitbucketProvider) (git.Account, error) {
	account := git.Account{
		Type:  database.ProviderBitbucket,
		Host:  "https://bitbucket.org",
		Scope: g.WorkspaceName,
	}
	switch {
	case g.APITokenEnc != "":
		token, err := s.cipher.Decrypt(g.APITokenEnc)
		if err != nil {
			return git.Account{}, err
		}
		account.Username, account.Password = g.Email, token
	case g.PasswordEnc != "":
		password, err := s.cipher.Decrypt(g.PasswordEnc)
		if err != nil {
			return git.Account{}, err
		}
		account.Username, account.Password = g.Username, password
	default:
		return git.Account{}, fmt.Errorf("this bitbucket connection has no credential")
	}
	return account, nil
}

// giteaAccount mirrors gitlabAccount; Gitea rotates refresh tokens the same way.
func (s *Service) giteaAccount(ctx context.Context, g *database.GiteaProvider) (git.Account, error) {
	if g.AccessTokenEnc == "" {
		return git.Account{}, fmt.Errorf("this gitea connection has not been authorised yet")
	}
	tokens, err := s.decryptTokens(g.AccessTokenEnc, g.RefreshEnc, g.ExpiresAt)
	if err != nil {
		return git.Account{}, err
	}
	if tokens.Expired() {
		secret, err := s.cipher.Decrypt(g.ClientSecretEnc)
		if err != nil {
			return git.Account{}, err
		}
		refreshed, err := git.RefreshTokens(ctx, database.ProviderGitea, g.URL,
			g.ClientID, secret, g.RedirectURI, tokens.RefreshToken)
		if err != nil {
			return git.Account{}, fmt.Errorf("gitea connection expired and could not be refreshed: %w", err)
		}
		if err := s.StoreGiteaTokens(ctx, g, refreshed, g.Username); err != nil {
			return git.Account{}, err
		}
		tokens = refreshed
	}
	return git.Account{
		Type:  database.ProviderGitea,
		Host:  g.URL,
		Token: tokens.AccessToken,
		Scope: g.OrganizationName,
	}, nil
}

func (s *Service) decryptTokens(accessEnc, refreshEnc string, expiresAt int64) (git.Tokens, error) {
	access, err := s.cipher.Decrypt(accessEnc)
	if err != nil {
		return git.Tokens{}, err
	}
	refresh := ""
	if refreshEnc != "" {
		if refresh, err = s.cipher.Decrypt(refreshEnc); err != nil {
			return git.Tokens{}, err
		}
	}
	return git.Tokens{AccessToken: access, RefreshToken: refresh, ExpiresAt: expiresAt}, nil
}

// StoreGitLabTokens encrypts and persists a grant. It is exported because the
// OAuth callback stores the first grant through the same path a refresh does.
func (s *Service) StoreGitLabTokens(ctx context.Context, g *database.GitLabProvider, tokens git.Tokens) error {
	return s.storeGitLabTokens(ctx, g, tokens)
}

func (s *Service) storeGitLabTokens(ctx context.Context, g *database.GitLabProvider, tokens git.Tokens) error {
	access, refresh, err := s.encryptTokens(tokens)
	if err != nil {
		return err
	}
	g.AccessTokenEnc, g.RefreshEnc, g.ExpiresAt = access, refresh, tokens.ExpiresAt
	return s.db.SetGitLabTokens(ctx, g.GitProviderID, access, refresh, tokens.ExpiresAt)
}

// StoreGiteaTokens encrypts and persists a grant along with who authorised it.
func (s *Service) StoreGiteaTokens(ctx context.Context, g *database.GiteaProvider, tokens git.Tokens, username string) error {
	access, refresh, err := s.encryptTokens(tokens)
	if err != nil {
		return err
	}
	g.AccessTokenEnc, g.RefreshEnc, g.ExpiresAt, g.Username = access, refresh, tokens.ExpiresAt, username
	return s.db.SetGiteaTokens(ctx, g.GitProviderID, access, refresh, username, tokens.ExpiresAt)
}

func (s *Service) encryptTokens(tokens git.Tokens) (accessEnc, refreshEnc string, err error) {
	if accessEnc, err = s.cipher.Encrypt(tokens.AccessToken); err != nil {
		return "", "", err
	}
	if tokens.RefreshToken != "" {
		if refreshEnc, err = s.cipher.Encrypt(tokens.RefreshToken); err != nil {
			return "", "", err
		}
	}
	return accessEnc, refreshEnc, nil
}

// Encrypt stores a provider secret at rest. Connection credentials go through
// the same cipher as every other secret the manager holds.
func (s *Service) Encrypt(plaintext string) (string, error) { return s.cipher.Encrypt(plaintext) }

// GitSource is the remote one service clones and the credential that opens it.
// A provider-sourced service has no URL of its own: it names an owner and a
// repository, and the connection decides the host and the token, which is what
// lets a connection be re-authorised without touching any service.
type GitSource struct {
	URL  string
	Cred git.Credential
}

// GitSourceFor resolves what a service clones. A plain git service uses the URL
// and credential stored on it; the four connected providers go through their
// connection.
func (s *Service) GitSourceFor(ctx context.Context, svc *database.Service) (GitSource, error) {
	if !database.ClonesFromConnection(svc.Provider) {
		cred, err := s.credential(svc)
		if err != nil {
			return GitSource{}, err
		}
		return GitSource{URL: svc.RepositoryURL, Cred: cred}, nil
	}
	if svc.GitProviderID == "" {
		return GitSource{}, fmt.Errorf("service %q is not connected to a git provider", svc.ComposeServiceName)
	}
	account, err := s.GitAccount(ctx, svc.GitProviderID)
	if err != nil {
		return GitSource{}, err
	}
	if account.Type != svc.Provider {
		return GitSource{}, fmt.Errorf("service %q expects a %s connection", svc.ComposeServiceName, svc.Provider)
	}
	return GitSource{URL: account.CloneURL(svc.Owner, svc.Repository), Cred: account.Credential()}, nil
}

// credential decrypts the credential stored directly on a plain git service.
func (s *Service) credential(svc *database.Service) (git.Credential, error) {
	if svc.CredentialKind == "" || svc.CredentialKind == database.GitCredentialNone || svc.CredentialEnc == "" {
		return git.Credential{Kind: git.KindNone}, nil
	}
	value, err := s.cipher.Decrypt(svc.CredentialEnc)
	if err != nil {
		return git.Credential{}, err
	}
	return git.Credential{Kind: svc.CredentialKind, Value: value}, nil
}

// SetGitRepository points a service at a repository on a connection. The
// connection has to exist and has to be of the provider the service claims,
// because a GitHub service cloning through a GitLab grant would fail at deploy
// time with nothing useful to say.
func (s *Service) SetGitRepository(ctx context.Context, svc *database.Service, gitProviderID, owner, repository string) error {
	provider, err := s.db.GitProviderByID(ctx, gitProviderID)
	if err != nil {
		if errors.Is(err, database.ErrNotFound) {
			return fmt.Errorf("unknown git provider %q", gitProviderID)
		}
		return err
	}
	if provider.ProviderType != svc.Provider {
		return fmt.Errorf("%q is a %s connection, not %s", provider.Name, provider.ProviderType, svc.Provider)
	}
	owner, repository = strings.TrimSpace(owner), strings.TrimSpace(repository)
	if err := security.ValidateRepositoryOwner(owner); err != nil {
		return err
	}
	if err := security.ValidateRepositoryName(repository); err != nil {
		return err
	}
	svc.GitProviderID, svc.Owner, svc.Repository = provider.ID, owner, repository
	// The URL and the hand-entered credential belong to the plain git source
	// and would be stale the moment the connection is re-pointed.
	svc.RepositoryURL, svc.CredentialKind, svc.CredentialEnc = "", database.GitCredentialNone, ""
	return nil
}
