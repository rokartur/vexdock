// Package auth owns password hashing, session cookies, CSRF and login rate
// limiting. Every mutating API route goes through Middleware + RequireCSRF.
package auth

import (
	"context"
	"errors"
	"net/http"
	"strings"
	"sync"
	"time"

	"golang.org/x/crypto/bcrypt"

	"github.com/vexdock/platform/manager/internal/config"
	"github.com/vexdock/platform/manager/internal/database"
	"github.com/vexdock/platform/manager/internal/security"
)

const (
	SessionCookie = "platform_session"
	CSRFHeader    = "X-CSRF-Token"
	// bcryptCost is deliberately above the library default: logins are rare and
	// the manager runs on a box where a leaked hash matters more than 100ms.
	bcryptCost = 12
)

var (
	ErrInvalidCredentials = errors.New("invalid email or password")
	ErrRateLimited        = errors.New("too many attempts, try again later")
	ErrSetupClosed        = errors.New("an administrator already exists")
)

type Service struct {
	db      *database.DB
	cfg     *config.Config
	limiter *rateLimiter
}

func New(db *database.DB, cfg *config.Config) *Service {
	return &Service{db: db, cfg: cfg, limiter: newRateLimiter(5, time.Minute)}
}

// NeedsSetup reports whether the first-run admin wizard should be shown.
func (s *Service) NeedsSetup(ctx context.Context) (bool, error) {
	n, err := s.db.CountUsers(ctx)
	return n == 0, err
}

// Setup creates the first administrator. It is permanently closed afterwards.
func (s *Service) Setup(ctx context.Context, email, password string) (*database.User, error) {
	needs, err := s.NeedsSetup(ctx)
	if err != nil {
		return nil, err
	}
	if !needs {
		return nil, ErrSetupClosed
	}
	return s.createUser(ctx, email, password, "admin")
}

func (s *Service) createUser(ctx context.Context, email, password, role string) (*database.User, error) {
	email = strings.ToLower(strings.TrimSpace(email))
	if !strings.Contains(email, "@") || len(email) < 3 {
		return nil, errors.New("a valid email address is required")
	}
	if len(password) < 10 {
		return nil, errors.New("password must be at least 10 characters")
	}
	hash, err := bcrypt.GenerateFromPassword([]byte(password), bcryptCost)
	if err != nil {
		return nil, err
	}
	return s.db.CreateUser(ctx, email, string(hash), role)
}

// Login verifies credentials and returns the raw session token plus the CSRF
// token the frontend must echo on mutations.
func (s *Service) Login(ctx context.Context, email, password, clientKey string) (*database.User, string, string, error) {
	if !s.limiter.allow(clientKey) {
		return nil, "", "", ErrRateLimited
	}
	email = strings.ToLower(strings.TrimSpace(email))
	user, err := s.db.UserByEmail(ctx, email)
	if err != nil {
		if errors.Is(err, database.ErrNotFound) {
			// Compare against a dummy hash so a missing user costs the same as a
			// wrong password and cannot be probed by timing.
			_ = bcrypt.CompareHashAndPassword([]byte("$2a$12$eImiTXuWVxfM37uY4JANjQ.uJqjJcXm7f4bBiZBoUdBEUxwn8Rj/y"), []byte(password))
			return nil, "", "", ErrInvalidCredentials
		}
		return nil, "", "", err
	}
	if err := bcrypt.CompareHashAndPassword([]byte(user.PasswordHash), []byte(password)); err != nil {
		return nil, "", "", ErrInvalidCredentials
	}
	s.limiter.reset(clientKey)

	token := security.RandomToken(32)
	csrf := security.RandomToken(32)
	expires := time.Now().UTC().Add(s.cfg.SessionTTL).Format(time.RFC3339Nano)
	if _, err := s.db.CreateSession(ctx, user.ID, security.HashToken(token), csrf, expires); err != nil {
		return nil, "", "", err
	}
	return user, token, csrf, nil
}

func (s *Service) Logout(ctx context.Context, token string) error {
	return s.db.DeleteSession(ctx, security.HashToken(token))
}

// SetSessionCookie writes the HttpOnly session cookie.
//
// Secure follows the actual scheme of the request rather than a static setting:
// a fresh install is reached over plain HTTP by IP, and a browser silently
// discards a Secure cookie there, which would make login impossible. Once the
// panel has a domain with TLS, the flag turns itself on.
func (s *Service) SetSessionCookie(w http.ResponseWriter, r *http.Request, token string) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookie,
		Value:    token,
		Path:     "/",
		HttpOnly: true,
		Secure:   isHTTPS(r),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   int(s.cfg.SessionTTL.Seconds()),
	})
}

func (s *Service) ClearSessionCookie(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{
		Name:     SessionCookie,
		Value:    "",
		Path:     "/",
		HttpOnly: true,
		Secure:   isHTTPS(r),
		SameSite: http.SameSiteLaxMode,
		MaxAge:   -1,
	})
}

// isHTTPS reports whether the browser reached the platform over TLS. The
// manager always sits behind Nginx, which forwards the original scheme.
func isHTTPS(r *http.Request) bool {
	if r.TLS != nil {
		return true
	}
	return strings.EqualFold(r.Header.Get("X-Forwarded-Proto"), "https")
}

type contextKey string

const (
	userKey    contextKey = "user"
	sessionKey contextKey = "session"
)

// Authenticate resolves the session cookie; it returns ErrNotFound when absent.
func (s *Service) Authenticate(r *http.Request) (*database.User, *database.Session, error) {
	c, err := r.Cookie(SessionCookie)
	if err != nil || c.Value == "" {
		return nil, nil, database.ErrNotFound
	}
	session, err := s.db.SessionByTokenHash(r.Context(), security.HashToken(c.Value))
	if err != nil {
		return nil, nil, err
	}
	user, err := s.db.UserByID(r.Context(), session.UserID)
	if err != nil {
		return nil, nil, err
	}
	return user, session, nil
}

// WithUser stores the authenticated principal on the request context.
func WithUser(ctx context.Context, u *database.User, s *database.Session) context.Context {
	return context.WithValue(context.WithValue(ctx, userKey, u), sessionKey, s)
}

func UserFrom(ctx context.Context) (*database.User, bool) {
	u, ok := ctx.Value(userKey).(*database.User)
	return u, ok
}

func SessionFrom(ctx context.Context) (*database.Session, bool) {
	s, ok := ctx.Value(sessionKey).(*database.Session)
	return s, ok
}

// rateLimiter is a fixed-window counter keyed by client IP.
// ponytail: in-memory only; move to SQLite if the manager ever runs replicated.
type rateLimiter struct {
	mu       sync.Mutex
	attempts map[string]*window
	limit    int
	period   time.Duration
}

type window struct {
	count int
	since time.Time
}

func newRateLimiter(limit int, period time.Duration) *rateLimiter {
	return &rateLimiter{attempts: map[string]*window{}, limit: limit, period: period}
}

func (r *rateLimiter) allow(key string) bool {
	r.mu.Lock()
	defer r.mu.Unlock()
	w, ok := r.attempts[key]
	if !ok || time.Since(w.since) > r.period {
		r.attempts[key] = &window{count: 1, since: time.Now()}
		return true
	}
	w.count++
	return w.count <= r.limit
}

func (r *rateLimiter) reset(key string) {
	r.mu.Lock()
	defer r.mu.Unlock()
	delete(r.attempts, key)
}
