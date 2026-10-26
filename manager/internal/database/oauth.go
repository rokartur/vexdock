package database

import (
	"context"
	"database/sql"
	"encoding/json"
	"errors"
	"time"
)

// How long an OAuth access token works, and how long a grant may sit unused
// before its refresh token stops working. Each refresh restarts the second.
const (
	OAuthAccessLifetime  = time.Hour
	OAuthRefreshLifetime = 30 * 24 * time.Hour
)

// OAuthClient is an MCP client that registered itself. Clients are public:
// there is no secret, PKCE binds the code to whoever asked for it.
type OAuthClient struct {
	ID           string   `json:"id"`
	Name         string   `json:"name"`
	RedirectURIs []string `json:"redirect_uris"`
	CreatedAt    string   `json:"created_at"`
}

type oauthGrant struct {
	clientID    string
	refreshHash string
}

// CreateOAuthClient registers a client. Registration needs no credential, so it
// also clears out what nobody uses: grants past their refresh lifetime, and
// clients a day old that hold no grant.
func (db *DB) CreateOAuthClient(ctx context.Context, name string, redirectURIs []string) (*OAuthClient, error) {
	uris, err := json.Marshal(redirectURIs)
	if err != nil {
		return nil, err
	}
	if _, err := db.ExecContext(ctx,
		`DELETE FROM api_tokens WHERE client_id IS NOT NULL AND refresh_expires_at < ?`, expiry(0)); err != nil {
		return nil, err
	}
	if _, err := db.ExecContext(ctx,
		`DELETE FROM oauth_clients WHERE created_at < ?
		 AND id NOT IN (SELECT client_id FROM api_tokens WHERE client_id IS NOT NULL)`,
		time.Now().UTC().Add(-24*time.Hour).Format(time.RFC3339Nano)); err != nil {
		return nil, err
	}
	c := &OAuthClient{ID: NewID(), Name: name, RedirectURIs: redirectURIs, CreatedAt: Now()}
	_, err = db.ExecContext(ctx,
		`INSERT INTO oauth_clients (id, name, redirect_uris, created_at) VALUES (?, ?, ?, ?)`,
		c.ID, c.Name, string(uris), c.CreatedAt)
	return c, err
}

func (db *DB) OAuthClientByID(ctx context.Context, id string) (*OAuthClient, error) {
	var c OAuthClient
	var uris string
	err := db.QueryRowContext(ctx,
		`SELECT id, name, redirect_uris, created_at FROM oauth_clients WHERE id = ?`, id).
		Scan(&c.ID, &c.Name, &uris, &c.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &c, json.Unmarshal([]byte(uris), &c.RedirectURIs)
}

// CreateOAuthGrant stores the token pair an authorization code was exchanged
// for, named after the client so the tokens page can tell grants apart.
func (db *DB) CreateOAuthGrant(ctx context.Context, userID string, client *OAuthClient, grants []ProjectGrant, accessHash, refreshHash, prefix string) (*APIToken, error) {
	return db.insertToken(ctx, userID, client.Name, accessHash, prefix, grants, &oauthGrant{clientID: client.ID, refreshHash: refreshHash})
}

// RotateOAuthGrant trades a live refresh token for a new pair. A refresh token
// that comes back after it was rotated has leaked, so the grant it belonged to
// is revoked (OAuth 2.1, section 4.3.1); the caller gets ErrNotFound for both.
func (db *DB) RotateOAuthGrant(ctx context.Context, clientID, refreshHash, accessHash, newRefreshHash, prefix string) error {
	res, err := db.ExecContext(ctx,
		`UPDATE api_tokens SET token_hash = ?, prefix = ?, expires_at = ?,
		 previous_refresh_hash = refresh_hash, refresh_hash = ?, refresh_expires_at = ?
		 WHERE client_id = ? AND refresh_hash = ? AND refresh_expires_at > ?`,
		accessHash, prefix, expiry(OAuthAccessLifetime), newRefreshHash, expiry(OAuthRefreshLifetime),
		clientID, refreshHash, expiry(0))
	if err != nil {
		return err
	}
	if rotated, err := res.RowsAffected(); err != nil || rotated == 1 {
		return err
	}
	if _, err := db.ExecContext(ctx,
		`DELETE FROM api_tokens WHERE client_id = ? AND previous_refresh_hash = ?`, clientID, refreshHash); err != nil {
		return err
	}
	return ErrNotFound
}

// expiry is a moment d from now in a format that sorts as text.
func expiry(d time.Duration) string {
	return time.Now().UTC().Add(d).Format(time.RFC3339)
}
