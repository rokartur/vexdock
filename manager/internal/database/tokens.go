package database

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// The two levels a token can hold on a project. Write implies read.
const (
	AccessRead  = "read"
	AccessWrite = "write"
)

// APIToken is a non-cookie credential for CI, the CLI and MCP clients. Only the
// hash and a short display prefix are stored; the full value is shown once at
// creation. An admin token reaches every route; any other reaches only the
// projects in Projects. A token with a ClientID is an OAuth grant (oauth.go).
type APIToken struct {
	ID         string         `json:"id"`
	UserID     string         `json:"user_id"`
	Name       string         `json:"name"`
	Prefix     string         `json:"prefix"`
	Admin      bool           `json:"admin"`
	Projects   []ProjectGrant `json:"projects"`
	ClientID   string         `json:"client_id"`
	LastUsedAt string         `json:"last_used_at"`
	CreatedAt  string         `json:"created_at"`
}

type ProjectGrant struct {
	ProjectID string `json:"project_id"`
	Level     string `json:"level"`
}

// Allows reports whether the token may act on a project at the given level.
func (t *APIToken) Allows(projectID, level string) bool {
	if t.Admin {
		return true
	}
	for _, grant := range t.Projects {
		if grant.ProjectID == projectID && (grant.Level == AccessWrite || level == AccessRead) {
			return true
		}
	}
	return false
}

// CreateAPIToken stores an admin token when grants is empty and a project
// token otherwise.
func (db *DB) CreateAPIToken(ctx context.Context, userID, name, tokenHash, prefix string, grants []ProjectGrant) (*APIToken, error) {
	return db.insertToken(ctx, userID, name, tokenHash, prefix, grants, nil)
}

// insertToken stores a token, and with oauth set, the client and refresh
// token of an OAuth grant along with both expiries.
func (db *DB) insertToken(ctx context.Context, userID, name, tokenHash, prefix string, grants []ProjectGrant, oauth *oauthGrant) (*APIToken, error) {
	t := &APIToken{ID: NewID(), UserID: userID, Name: name, Prefix: prefix, Admin: len(grants) == 0, Projects: grants, CreatedAt: Now()}
	if t.Projects == nil {
		t.Projects = []ProjectGrant{}
	}
	var clientID, refreshHash any
	expiresAt, refreshExpiresAt := "", ""
	if oauth != nil {
		t.ClientID = oauth.clientID
		clientID, refreshHash = oauth.clientID, oauth.refreshHash
		expiresAt, refreshExpiresAt = expiry(OAuthAccessLifetime), expiry(OAuthRefreshLifetime)
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return nil, err
	}
	defer func() { _ = tx.Rollback() }()

	if _, err := tx.ExecContext(ctx,
		`INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, admin, client_id, expires_at, refresh_hash, refresh_expires_at, last_used_at, created_at)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, '', ?)`,
		t.ID, t.UserID, t.Name, tokenHash, t.Prefix, t.Admin, clientID, expiresAt, refreshHash, refreshExpiresAt, t.CreatedAt); err != nil {
		return nil, err
	}
	for _, grant := range grants {
		if _, err := tx.ExecContext(ctx,
			`INSERT INTO api_token_projects (token_id, project_id, level) VALUES (?, ?, ?)`,
			t.ID, grant.ProjectID, grant.Level); err != nil {
			return nil, err
		}
	}
	return t, tx.Commit()
}

func (db *DB) ListAPITokens(ctx context.Context) ([]APIToken, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id, user_id, name, prefix, admin, COALESCE(client_id, ''), last_used_at, created_at FROM api_tokens ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []APIToken{}
	for rows.Next() {
		var t APIToken
		if err := rows.Scan(&t.ID, &t.UserID, &t.Name, &t.Prefix, &t.Admin, &t.ClientID, &t.LastUsedAt, &t.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	for i := range out {
		if out[i].Projects, err = db.tokenGrants(ctx, out[i].ID); err != nil {
			return nil, err
		}
	}
	return out, nil
}

func (db *DB) DeleteAPIToken(ctx context.Context, id string) error {
	_, err := db.ExecContext(ctx, `DELETE FROM api_tokens WHERE id = ?`, id)
	return err
}

// APITokenByHash resolves a bearer token and records its use. An expired OAuth
// access token is not found. The user it points at lives in the better-auth
// database, which this package never opens.
func (db *DB) APITokenByHash(ctx context.Context, tokenHash string) (*APIToken, error) {
	var t APIToken
	var expiresAt string
	err := db.QueryRowContext(ctx,
		`SELECT id, user_id, name, prefix, admin, COALESCE(client_id, ''), expires_at, last_used_at, created_at FROM api_tokens WHERE token_hash = ?`, tokenHash).
		Scan(&t.ID, &t.UserID, &t.Name, &t.Prefix, &t.Admin, &t.ClientID, &expiresAt, &t.LastUsedAt, &t.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	if expiresAt != "" && ParseTime(expiresAt).Before(time.Now()) {
		return nil, ErrNotFound
	}
	if t.Projects, err = db.tokenGrants(ctx, t.ID); err != nil {
		return nil, err
	}
	// A minute of resolution is all the tokens page shows; writing on every
	// request would queue a CI run's calls behind one another on the single
	// writer connection.
	if time.Since(ParseTime(t.LastUsedAt)) < time.Minute {
		return &t, nil
	}
	// The token is already authenticated; a bookkeeping write that loses a race
	// for the single writer connection must not turn it into a 401.
	_, _ = db.ExecContext(ctx, `UPDATE api_tokens SET last_used_at = ? WHERE id = ?`, Now(), t.ID)
	return &t, nil
}

func (db *DB) tokenGrants(ctx context.Context, tokenID string) ([]ProjectGrant, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT project_id, level FROM api_token_projects WHERE token_id = ? ORDER BY project_id`, tokenID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []ProjectGrant{}
	for rows.Next() {
		var g ProjectGrant
		if err := rows.Scan(&g.ProjectID, &g.Level); err != nil {
			return nil, err
		}
		out = append(out, g)
	}
	return out, rows.Err()
}
