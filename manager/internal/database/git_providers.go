package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"time"
)

// Git providers are stored as a parent row naming the connection and a child
// row holding whatever credentials that provider actually uses. Reading one
// always means reading both, so every query here joins rather than leaving the
// caller to remember which child table to look in.

const (
	githubColumns = `git_provider_id, github_app_name, github_app_id, github_client_id,
		github_client_secret, github_installation_id, github_private_key, github_webhook_secret, github_url`
	gitlabColumns = `git_provider_id, gitlab_url, application_id, redirect_uri, secret,
		access_token, refresh_token, group_name, expires_at`
	bitbucketColumns = `git_provider_id, bitbucket_username, app_password, bitbucket_email,
		api_token, bitbucket_workspace_name`
	giteaColumns = `git_provider_id, gitea_url, redirect_uri, client_id, client_secret,
		gitea_username, access_token, refresh_token, expires_at, scopes, last_authenticated_at,
		organization_name`
)

// CreateGitProvider writes the parent row and the child row for its type in one
// transaction, so a connection is never half a connection. The child struct
// matching p.ProviderType must be set; its GitProviderID is filled in here.
func (db *DB) CreateGitProvider(ctx context.Context, p *GitProvider) error {
	p.ID, p.CreatedAt = NewID(), Now()
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO git_providers (id, name, provider_type, created_at, webhook_secret_enc) VALUES (?, ?, ?, ?, ?)`,
		p.ID, p.Name, p.ProviderType, p.CreatedAt, p.WebhookSecretEnc); err != nil {
		return err
	}
	if err := insertGitProviderDetail(ctx, tx, p); err != nil {
		return err
	}
	return tx.Commit()
}

func insertGitProviderDetail(ctx context.Context, tx *sql.Tx, p *GitProvider) error {
	switch p.ProviderType {
	case ProviderGitHub:
		if p.GitHub == nil {
			p.GitHub = &GitHubProvider{}
		}
		p.GitHub.GitProviderID = p.ID
		if p.GitHub.URL == "" {
			p.GitHub.URL = "https://github.com"
		}
		g := p.GitHub
		_, err := tx.ExecContext(ctx,
			`INSERT INTO github (`+githubColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			g.GitProviderID, g.AppName, g.AppID, g.ClientID, g.ClientSecretEnc, g.InstallationID,
			g.PrivateKeyEnc, g.WebhookSecretEnc, g.URL)
		return err
	case ProviderGitLab:
		if p.GitLab == nil {
			return fmt.Errorf("gitlab connection is missing its details")
		}
		p.GitLab.GitProviderID = p.ID
		g := p.GitLab
		_, err := tx.ExecContext(ctx,
			`INSERT INTO gitlab (`+gitlabColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			g.GitProviderID, g.URL, g.ApplicationID, g.RedirectURI, g.SecretEnc,
			g.AccessTokenEnc, g.RefreshEnc, g.GroupName, g.ExpiresAt)
		return err
	case ProviderBitbucket:
		if p.Bitbucket == nil {
			return fmt.Errorf("bitbucket connection is missing its details")
		}
		p.Bitbucket.GitProviderID = p.ID
		g := p.Bitbucket
		_, err := tx.ExecContext(ctx,
			`INSERT INTO bitbucket (`+bitbucketColumns+`) VALUES (?, ?, ?, ?, ?, ?)`,
			g.GitProviderID, g.Username, g.PasswordEnc, g.Email, g.APITokenEnc, g.WorkspaceName)
		return err
	case ProviderGitea:
		if p.Gitea == nil {
			return fmt.Errorf("gitea connection is missing its details")
		}
		p.Gitea.GitProviderID = p.ID
		g := p.Gitea
		_, err := tx.ExecContext(ctx,
			`INSERT INTO gitea (`+giteaColumns+`) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
			g.GitProviderID, g.URL, g.RedirectURI, g.ClientID, g.ClientSecretEnc, g.Username,
			g.AccessTokenEnc, g.RefreshEnc, g.ExpiresAt, g.Scopes, g.LastAuthenticatedAt,
			g.OrganizationName)
		return err
	}
	return fmt.Errorf("unknown git provider type %q", p.ProviderType)
}

// GitProviderByID reads one connection with its credentials.
func (db *DB) GitProviderByID(ctx context.Context, id string) (*GitProvider, error) {
	var p GitProvider
	err := db.QueryRowContext(ctx,
		`SELECT id, name, provider_type, created_at, webhook_secret_enc FROM git_providers WHERE id = ?`, id).
		Scan(&p.ID, &p.Name, &p.ProviderType, &p.CreatedAt, &p.WebhookSecretEnc)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if err := db.loadGitProviderDetail(ctx, &p); err != nil {
		return nil, err
	}
	return &p, nil
}

// ListGitProviders reads every connection with its credentials, newest last so
// the dashboard's order is stable.
func (db *DB) ListGitProviders(ctx context.Context) ([]GitProvider, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id, name, provider_type, created_at, webhook_secret_enc FROM git_providers ORDER BY created_at, name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []GitProvider{}
	for rows.Next() {
		var p GitProvider
		if err := rows.Scan(&p.ID, &p.Name, &p.ProviderType, &p.CreatedAt, &p.WebhookSecretEnc); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		if err := db.loadGitProviderDetail(ctx, &out[i]); err != nil {
			return nil, err
		}
	}
	return out, nil
}

// loadGitProviderDetail fills in whichever child row belongs to this type. A
// parent without its child is a broken row rather than an empty connection, so
// it reports not found instead of quietly returning half a record.
func (db *DB) loadGitProviderDetail(ctx context.Context, p *GitProvider) error {
	var err error
	switch p.ProviderType {
	case ProviderGitHub:
		var g GitHubProvider
		err = db.QueryRowContext(ctx, `SELECT `+githubColumns+` FROM github WHERE git_provider_id = ?`, p.ID).
			Scan(&g.GitProviderID, &g.AppName, &g.AppID, &g.ClientID, &g.ClientSecretEnc,
				&g.InstallationID, &g.PrivateKeyEnc, &g.WebhookSecretEnc, &g.URL)
		p.GitHub = &g
	case ProviderGitLab:
		var g GitLabProvider
		err = db.QueryRowContext(ctx, `SELECT `+gitlabColumns+` FROM gitlab WHERE git_provider_id = ?`, p.ID).
			Scan(&g.GitProviderID, &g.URL, &g.ApplicationID, &g.RedirectURI, &g.SecretEnc,
				&g.AccessTokenEnc, &g.RefreshEnc, &g.GroupName, &g.ExpiresAt)
		p.GitLab = &g
	case ProviderBitbucket:
		var g BitbucketProvider
		err = db.QueryRowContext(ctx, `SELECT `+bitbucketColumns+` FROM bitbucket WHERE git_provider_id = ?`, p.ID).
			Scan(&g.GitProviderID, &g.Username, &g.PasswordEnc, &g.Email, &g.APITokenEnc, &g.WorkspaceName)
		p.Bitbucket = &g
	case ProviderGitea:
		var g GiteaProvider
		err = db.QueryRowContext(ctx, `SELECT `+giteaColumns+` FROM gitea WHERE git_provider_id = ?`, p.ID).
			Scan(&g.GitProviderID, &g.URL, &g.RedirectURI, &g.ClientID, &g.ClientSecretEnc,
				&g.Username, &g.AccessTokenEnc, &g.RefreshEnc, &g.ExpiresAt, &g.Scopes,
				&g.LastAuthenticatedAt, &g.OrganizationName)
		p.Gitea = &g
	default:
		return fmt.Errorf("unknown git provider type %q", p.ProviderType)
	}
	if errors.Is(err, sql.ErrNoRows) {
		return ErrNotFound
	}
	if err != nil {
		return err
	}
	p.markConnected()
	return nil
}

// GitProviderByInstallation finds the GitHub connection a webhook delivery
// belongs to. The payload names the installation, and the connection it maps to
// holds the secret that delivery has to be signed with.
func (db *DB) GitProviderByInstallation(ctx context.Context, installationID string) (*GitProvider, error) {
	var id string
	err := db.QueryRowContext(ctx,
		`SELECT git_provider_id FROM github WHERE github_installation_id = ? AND github_installation_id != ''`,
		installationID).Scan(&id)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return db.GitProviderByID(ctx, id)
}

// RenameGitProvider changes only the label. Credentials are replaced through
// their own update, never through a rename.
func (db *DB) RenameGitProvider(ctx context.Context, id, name string) error {
	res, err := db.ExecContext(ctx, `UPDATE git_providers SET name = ? WHERE id = ?`, name, id)
	if err != nil {
		return err
	}
	return affectedOne(res)
}

// SetWebhookSecret gives a connection made before the secret existed one, so
// its deliveries can be authenticated like every new connection's.
func (db *DB) SetWebhookSecret(ctx context.Context, id, secretEnc string) error {
	res, err := db.ExecContext(ctx, `UPDATE git_providers SET webhook_secret_enc = ? WHERE id = ?`, secretEnc, id)
	if err != nil {
		return err
	}
	return affectedOne(res)
}

// UpdateGitHubApp stores the credentials GitHub returns from the manifest
// exchange. It is the only moment an App's identity is written.
func (db *DB) UpdateGitHubApp(ctx context.Context, g *GitHubProvider) error {
	res, err := db.ExecContext(ctx,
		`UPDATE github SET github_app_name = ?, github_app_id = ?, github_client_id = ?,
			github_client_secret = ?, github_private_key = ?, github_webhook_secret = ?
		 WHERE git_provider_id = ?`,
		g.AppName, g.AppID, g.ClientID, g.ClientSecretEnc, g.PrivateKeyEnc, g.WebhookSecretEnc,
		g.GitProviderID)
	if err != nil {
		return err
	}
	return affectedOne(res)
}

// SetGitHubInstallation records which App installation a connection clones
// through. It is the last step of connecting GitHub, and also where a later
// "pick different repositories" lands.
func (db *DB) SetGitHubInstallation(ctx context.Context, id, installationID string) error {
	res, err := db.ExecContext(ctx,
		`UPDATE github SET github_installation_id = ? WHERE git_provider_id = ?`, installationID, id)
	if err != nil {
		return err
	}
	return affectedOne(res)
}

// UpdateGitLabApp replaces the OAuth application the connection uses. Changing
// it invalidates the grant, so the caller clears the tokens with it.
func (db *DB) UpdateGitLabApp(ctx context.Context, g *GitLabProvider) error {
	res, err := db.ExecContext(ctx,
		`UPDATE gitlab SET gitlab_url = ?, application_id = ?, redirect_uri = ?, secret = ?,
			group_name = ? WHERE git_provider_id = ?`,
		g.URL, g.ApplicationID, g.RedirectURI, g.SecretEnc, g.GroupName, g.GitProviderID)
	if err != nil {
		return err
	}
	return affectedOne(res)
}

// SetGitLabTokens stores a grant, whether it came from the first authorization
// or from a refresh. GitLab rotates the refresh token on every use, so this
// runs on every refresh and not only at connect time.
func (db *DB) SetGitLabTokens(ctx context.Context, id, accessEnc, refreshEnc string, expiresAt int64) error {
	res, err := db.ExecContext(ctx,
		`UPDATE gitlab SET access_token = ?, refresh_token = ?, expires_at = ? WHERE git_provider_id = ?`,
		accessEnc, refreshEnc, expiresAt, id)
	if err != nil {
		return err
	}
	return affectedOne(res)
}

// UpdateBitbucketCredentials replaces the credential pair.
func (db *DB) UpdateBitbucketCredentials(ctx context.Context, g *BitbucketProvider) error {
	res, err := db.ExecContext(ctx,
		`UPDATE bitbucket SET bitbucket_username = ?, app_password = ?, bitbucket_email = ?,
			api_token = ?, bitbucket_workspace_name = ? WHERE git_provider_id = ?`,
		g.Username, g.PasswordEnc, g.Email, g.APITokenEnc, g.WorkspaceName, g.GitProviderID)
	if err != nil {
		return err
	}
	return affectedOne(res)
}

// UpdateGiteaApp replaces the OAuth application the connection uses.
func (db *DB) UpdateGiteaApp(ctx context.Context, g *GiteaProvider) error {
	res, err := db.ExecContext(ctx,
		`UPDATE gitea SET gitea_url = ?, redirect_uri = ?, client_id = ?, client_secret = ?,
			scopes = ?, organization_name = ? WHERE git_provider_id = ?`,
		g.URL, g.RedirectURI, g.ClientID, g.ClientSecretEnc, g.Scopes, g.OrganizationName,
		g.GitProviderID)
	if err != nil {
		return err
	}
	return affectedOne(res)
}

// SetGiteaTokens stores a grant and who it belongs to.
func (db *DB) SetGiteaTokens(ctx context.Context, id, accessEnc, refreshEnc, username string, expiresAt int64) error {
	res, err := db.ExecContext(ctx,
		`UPDATE gitea SET access_token = ?, refresh_token = ?, gitea_username = ?, expires_at = ?,
			last_authenticated_at = ? WHERE git_provider_id = ?`,
		accessEnc, refreshEnc, username, expiresAt, time.Now().Unix(), id)
	if err != nil {
		return err
	}
	return affectedOne(res)
}

// DeleteGitProvider removes the connection. The child row cascades; services
// that cloned through it are cut loose and fall back to being unconfigured,
// because their repository is no longer reachable and a deploy that silently
// used a different credential would be worse than one that stops.
func (db *DB) DeleteGitProvider(ctx context.Context, id string) error {
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx,
		`UPDATE services SET provider = ?, git_provider_id = '', owner = '', repository = ''
		 WHERE git_provider_id = ?`, ProviderUnconfigured, id); err != nil {
		return err
	}
	res, err := tx.ExecContext(ctx, `DELETE FROM git_providers WHERE id = ?`, id)
	if err != nil {
		return err
	}
	if err := affectedOne(res); err != nil {
		return err
	}
	return tx.Commit()
}

// ServicesForProvider finds every service that clones through a connection,
// whatever repository it points at.
func (db *DB) ServicesForProvider(ctx context.Context, gitProviderID string) ([]Service, error) {
	rows, err := db.QueryContext(ctx, `SELECT `+serviceColumns+` FROM services WHERE git_provider_id = ?`, gitProviderID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanServices(rows)
}

// ServicesForRepository finds every service a push to this repository should
// redeploy: the ones on this connection, pointing at this owner and repository,
// tracking the branch that moved.
func (db *DB) ServicesForRepository(ctx context.Context, gitProviderID, owner, repository, branch string) ([]Service, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT `+serviceColumns+` FROM services
		 WHERE git_provider_id = ? AND owner = ? COLLATE NOCASE AND repository = ? COLLATE NOCASE
		   AND branch = ?`,
		gitProviderID, owner, repository, branch)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanServices(rows)
}

func affectedOne(res sql.Result) error {
	n, err := res.RowsAffected()
	if err != nil {
		return err
	}
	if n == 0 {
		return ErrNotFound
	}
	return nil
}
