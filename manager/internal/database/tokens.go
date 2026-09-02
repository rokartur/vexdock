package database

import (
	"context"
	"database/sql"
	"errors"
	"time"
)

// APIToken is a non-cookie credential for CI and the CLI. Only the hash and a
// short display prefix are stored; the full value is shown once at creation.
type APIToken struct {
	ID         string `json:"id"`
	UserID     string `json:"user_id"`
	Name       string `json:"name"`
	Prefix     string `json:"prefix"`
	LastUsedAt string `json:"last_used_at"`
	CreatedAt  string `json:"created_at"`
}

func (db *DB) CreateAPIToken(ctx context.Context, userID, name, tokenHash, prefix string) (*APIToken, error) {
	t := &APIToken{ID: NewID(), UserID: userID, Name: name, Prefix: prefix, CreatedAt: Now()}
	_, err := db.ExecContext(ctx,
		`INSERT INTO api_tokens (id, user_id, name, token_hash, prefix, last_used_at, created_at)
		 VALUES (?, ?, ?, ?, ?, '', ?)`,
		t.ID, t.UserID, t.Name, tokenHash, t.Prefix, t.CreatedAt)
	if err != nil {
		return nil, err
	}
	return t, nil
}

func (db *DB) ListAPITokens(ctx context.Context) ([]APIToken, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT id, user_id, name, prefix, last_used_at, created_at FROM api_tokens ORDER BY created_at DESC`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []APIToken{}
	for rows.Next() {
		var t APIToken
		if err := rows.Scan(&t.ID, &t.UserID, &t.Name, &t.Prefix, &t.LastUsedAt, &t.CreatedAt); err != nil {
			return nil, err
		}
		out = append(out, t)
	}
	return out, rows.Err()
}

func (db *DB) DeleteAPIToken(ctx context.Context, id string) error {
	_, err := db.ExecContext(ctx, `DELETE FROM api_tokens WHERE id = ?`, id)
	return err
}

// APITokenByHash resolves a bearer token and records its use. The user it
// points at lives in the better-auth database, which this package never opens.
func (db *DB) APITokenByHash(ctx context.Context, tokenHash string) (*APIToken, error) {
	var t APIToken
	err := db.QueryRowContext(ctx,
		`SELECT id, user_id, name, prefix, last_used_at, created_at FROM api_tokens WHERE token_hash = ?`, tokenHash).
		Scan(&t.ID, &t.UserID, &t.Name, &t.Prefix, &t.LastUsedAt, &t.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	// A minute of resolution is all the tokens page shows; writing on every
	// request would queue a CI run's calls behind one another on the single
	// writer connection.
	if time.Since(ParseTime(t.LastUsedAt)) < time.Minute {
		return &t, nil
	}
	if _, err := db.ExecContext(ctx, `UPDATE api_tokens SET last_used_at = ? WHERE id = ?`, Now(), t.ID); err != nil {
		return nil, err
	}
	return &t, nil
}
