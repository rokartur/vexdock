package database

import (
	"context"
	"database/sql"
	"errors"
)

// ErrNotFound is returned by every lookup helper when no row matches.
var ErrNotFound = errors.New("not found")

func (db *DB) CountUsers(ctx context.Context) (int, error) {
	var n int
	err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM users`).Scan(&n)
	return n, err
}

func (db *DB) CreateUser(ctx context.Context, email, passwordHash, role string) (*User, error) {
	u := &User{
		ID:           NewID(),
		Email:        email,
		PasswordHash: passwordHash,
		Role:         role,
		CreatedAt:    Now(),
		UpdatedAt:    Now(),
	}
	_, err := db.ExecContext(ctx,
		`INSERT INTO users (id, email, password_hash, role, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`,
		u.ID, u.Email, u.PasswordHash, u.Role, u.CreatedAt, u.UpdatedAt)
	if err != nil {
		return nil, err
	}
	return u, nil
}

func (db *DB) UserByEmail(ctx context.Context, email string) (*User, error) {
	return scanUser(db.QueryRowContext(ctx,
		`SELECT id, email, password_hash, role, created_at, updated_at FROM users WHERE email = ?`, email))
}

func (db *DB) UserByID(ctx context.Context, id string) (*User, error) {
	return scanUser(db.QueryRowContext(ctx,
		`SELECT id, email, password_hash, role, created_at, updated_at FROM users WHERE id = ?`, id))
}

func scanUser(row *sql.Row) (*User, error) {
	var u User
	err := row.Scan(&u.ID, &u.Email, &u.PasswordHash, &u.Role, &u.CreatedAt, &u.UpdatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (db *DB) CreateSession(ctx context.Context, userID, tokenHash, csrfToken, expiresAt string) (*Session, error) {
	s := &Session{
		ID:        NewID(),
		UserID:    userID,
		TokenHash: tokenHash,
		CSRFToken: csrfToken,
		ExpiresAt: expiresAt,
		CreatedAt: Now(),
	}
	_, err := db.ExecContext(ctx,
		`INSERT INTO sessions (id, user_id, token_hash, csrf_token, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
		s.ID, s.UserID, s.TokenHash, s.CSRFToken, s.ExpiresAt, s.CreatedAt)
	if err != nil {
		return nil, err
	}
	return s, nil
}

// SessionByTokenHash returns a session only while it is still valid.
func (db *DB) SessionByTokenHash(ctx context.Context, tokenHash string) (*Session, error) {
	var s Session
	err := db.QueryRowContext(ctx,
		`SELECT id, user_id, token_hash, csrf_token, expires_at, created_at FROM sessions WHERE token_hash = ? AND expires_at > ?`,
		tokenHash, Now()).
		Scan(&s.ID, &s.UserID, &s.TokenHash, &s.CSRFToken, &s.ExpiresAt, &s.CreatedAt)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNotFound
	}
	if err != nil {
		return nil, err
	}
	return &s, nil
}

func (db *DB) DeleteSession(ctx context.Context, tokenHash string) error {
	_, err := db.ExecContext(ctx, `DELETE FROM sessions WHERE token_hash = ?`, tokenHash)
	return err
}

// DeleteExpiredSessions is called by the scheduler to keep the table small.
func (db *DB) DeleteExpiredSessions(ctx context.Context) error {
	_, err := db.ExecContext(ctx, `DELETE FROM sessions WHERE expires_at <= ?`, Now())
	return err
}
