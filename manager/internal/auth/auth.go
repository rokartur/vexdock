// Package auth authenticates API requests. It does not issue credentials:
// logging in, signing up and session lifetime belong to the better-auth
// service, which owns its own SQLite database. The manager opens that database
// read-only and validates the session cookie the browser presents.
package auth

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net"
	"net/http"
	"strings"
	"time"

	_ "modernc.org/sqlite"

	"github.com/vexdock/platform/manager/internal/config"
	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/security"
)

// SessionCookie is the cookie better-auth sets. Its value is
// "<token>.<signature>"; the token is what the session table stores.
const SessionCookie = "better-auth.session_token"

// ErrNoSession means the request carried no usable credential.
var ErrNoSession = errors.New("no valid session")

// User is the authenticated principal, as stored by better-auth.
type User struct {
	ID    string `json:"id"`
	Email string `json:"email"`
	Name  string `json:"name"`
}

type Service struct {
	cfg  *config.Config
	db   *database.DB
	auth *sql.DB
}

// New opens the better-auth database read-only. A missing file is not fatal:
// the auth service creates it on first boot and the manager picks it up on the
// next request.
func New(db *database.DB, cfg *config.Config) (*Service, error) {
	dsn := fmt.Sprintf("file:%s?mode=ro&_pragma=busy_timeout(5000)", cfg.AuthDatabasePath())
	authDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open auth database: %w", err)
	}
	authDB.SetMaxOpenConns(2)
	return &Service{cfg: cfg, db: db, auth: authDB}, nil
}

func (s *Service) Close() error { return s.auth.Close() }

// ViaCookie reports which credential a request carries: a Bearer header is an
// API token, anything else can only be the session cookie. Authenticate decides
// the same way, and a handler that has to name the credential after the fact
// asks here rather than restating the rule.
func ViaCookie(r *http.Request) bool {
	return !strings.HasPrefix(r.Header.Get("Authorization"), "Bearer ")
}

// Authenticate resolves a request to a user, accepting either a better-auth
// session cookie or a platform API token.
func (s *Service) Authenticate(r *http.Request) (*User, bool, error) {
	if !ViaCookie(r) {
		token := strings.TrimSpace(strings.TrimPrefix(r.Header.Get("Authorization"), "Bearer "))
		user, err := s.userByAPIToken(r.Context(), token)
		if err != nil {
			return nil, false, err
		}
		// API tokens are not sent automatically by browsers, so no CSRF check.
		return user, false, nil
	}

	cookie, err := r.Cookie(SessionCookie)
	if err != nil || cookie.Value == "" {
		return nil, false, ErrNoSession
	}
	user, err := s.userBySession(r.Context(), sessionToken(cookie.Value))
	if err != nil {
		return nil, false, err
	}
	return user, true, nil
}

// sessionToken strips the signature better-auth appends to the cookie value.
func sessionToken(cookieValue string) string {
	if idx := strings.IndexByte(cookieValue, '.'); idx > 0 {
		return cookieValue[:idx]
	}
	return cookieValue
}

func (s *Service) userBySession(ctx context.Context, token string) (*User, error) {
	if token == "" {
		return nil, ErrNoSession
	}
	var user User
	var expires time.Time
	err := s.auth.QueryRowContext(ctx,
		`SELECT u.id, u.email, u.name, s.expiresAt
		 FROM session s JOIN user u ON u.id = s.userId
		 WHERE s.token = ?`, token).
		Scan(&user.ID, &user.Email, &user.Name, &expires)
	if errors.Is(err, sql.ErrNoRows) {
		return nil, ErrNoSession
	}
	if err != nil {
		return nil, fmt.Errorf("read session: %w", err)
	}
	if !expires.IsZero() && expires.Before(time.Now()) {
		return nil, ErrNoSession
	}
	return &user, nil
}

func (s *Service) userByAPIToken(ctx context.Context, raw string) (*User, error) {
	token, err := s.db.APITokenByHash(ctx, security.HashToken(raw))
	if err != nil {
		return nil, ErrNoSession
	}
	// The token records which better-auth user created it; look up the current
	// details so a renamed account is reflected everywhere.
	user, err := s.userByID(ctx, token.UserID)
	if err != nil {
		return &User{ID: token.UserID, Email: "api-token:" + token.Name}, nil
	}
	return user, nil
}

func (s *Service) userByID(ctx context.Context, id string) (*User, error) {
	var user User
	err := s.auth.QueryRowContext(ctx, `SELECT id, email, name FROM user WHERE id = ?`, id).
		Scan(&user.ID, &user.Email, &user.Name)
	if err != nil {
		return nil, err
	}
	return &user, nil
}

// NeedsSetup reports whether the first administrator still has to be created.
func (s *Service) NeedsSetup(ctx context.Context) bool {
	var n int
	if err := s.auth.QueryRowContext(ctx, `SELECT COUNT(*) FROM user`).Scan(&n); err != nil {
		return true
	}
	return n == 0
}

type contextKey string

const userKey contextKey = "user"

func WithUser(ctx context.Context, u *User) context.Context {
	return context.WithValue(ctx, userKey, u)
}

func UserFrom(ctx context.Context) (*User, bool) {
	u, ok := ctx.Value(userKey).(*User)
	return u, ok
}

// SameOrigin reports whether a state-changing request came from the dashboard
// itself. Browsers cannot forge Origin, and same-origin fetches always send it
// for non-GET requests, so this is the CSRF defence for cookie sessions.
func SameOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		// No Origin means the request was not made by a browser page; a
		// cross-site form post would always carry one.
		return true
	}
	scheme, host, err := splitOrigin(origin)
	if err != nil {
		return false
	}
	return canonicalOrigin(scheme, host) == canonicalOrigin(requestScheme(r), r.Host)
}

// canonicalOrigin spells an origin out in full so that two ways of writing the
// same one compare equal. The port is always present, because a browser omits
// it when it is the scheme's default while a Host header may carry it, and the
// scheme is always present, because without it plain http on port 80 and TLS on
// 443 both reduce to the bare hostname and a page served over http would pass as
// the dashboard.
func canonicalOrigin(scheme, host string) string {
	scheme = strings.ToLower(scheme)
	host = strings.ToLower(host)
	if _, _, err := net.SplitHostPort(host); err != nil {
		switch scheme {
		case "https":
			host += ":443"
		case "http":
			host += ":80"
		}
	}
	return scheme + "://" + host
}

// requestScheme reports the scheme the browser actually used. Nginx sets
// X-Forwarded-Proto on the panel's /api/ location; a manager reached directly on
// its published port is plain http, and then the Origin says http too, so the
// two still agree. A browser cannot set this header on a cross-site request, so
// trusting it costs nothing the attacker did not already have.
func requestScheme(r *http.Request) string {
	proto, _, _ := strings.Cut(r.Header.Get("X-Forwarded-Proto"), ",")
	if proto = strings.TrimSpace(proto); proto != "" {
		return proto
	}
	if r.TLS != nil {
		return "https"
	}
	return "http"
}

// splitOrigin separates an Origin into the scheme and the host it names. This
// server deploys arbitrary projects, and one of them publishing a port on the
// dashboard's own hostname is ordinary: a page served from http://panel:8080
// must not pass as the dashboard on panel:443.
func splitOrigin(origin string) (scheme, host string, err error) {
	scheme, host, found := strings.Cut(strings.TrimSpace(origin), "://")
	if !found {
		return "", "", fmt.Errorf("unsupported origin %q", origin)
	}
	if scheme = strings.ToLower(scheme); scheme != "http" && scheme != "https" {
		return "", "", fmt.Errorf("unsupported origin %q", origin)
	}
	// An Origin carries no path and no credentials, but tolerate a trailing slash.
	host = strings.TrimSuffix(host, "/")
	if host == "" || strings.ContainsAny(host, "/@") {
		return "", "", fmt.Errorf("origin %q names no host", origin)
	}
	return scheme, host, nil
}
