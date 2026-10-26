// Command mcp is Vexdock's Model Context Protocol server. It holds no state and
// no secret: every tool call becomes REST calls to the manager, made with the
// caller's own bearer token, so the manager's token scopes are the only
// permission model.
package main

import (
	"context"
	"errors"
	"log/slog"
	"net/http"
	"os"
	"time"

	"github.com/modelcontextprotocol/go-sdk/auth"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

func main() {
	log := slog.New(slog.NewTextHandler(os.Stderr, nil))
	base := envOr("VEXDOCK_MANAGER_URL", "http://manager:8080")
	listen := envOr("MCP_LISTEN", ":8090")

	// No client timeout: deploy waits up to its own limit and every call
	// carries the tool call's context.
	tools := &toolbox{base: base, http: &http.Client{}}
	srv := &http.Server{Addr: listen, Handler: handler(tools, envOr("PLATFORM_VERSION", "dev"), log), ReadHeaderTimeout: 10 * time.Second}
	log.Info("mcp listening", "addr", listen, "manager", base)
	if err := srv.ListenAndServe(); err != nil {
		log.Error("mcp stopped", "error", err)
		os.Exit(1)
	}
}

func handler(tools *toolbox, version string, log *slog.Logger) http.Handler {
	server := newServer(tools, version)
	streamable := mcp.NewStreamableHTTPHandler(
		func(*http.Request) *mcp.Server { return server },
		&mcp.StreamableHTTPOptions{Stateless: true, Logger: log},
	)
	requireToken := auth.RequireBearerToken(tools.verify, &auth.RequireBearerTokenOptions{AllowMissingExpiration: true})
	mux := http.NewServeMux()
	mux.Handle("/mcp", requireToken(streamable))
	return mux
}

// verify asks the manager whether the token is good, so a bad one is a 401 at
// the transport where MCP clients expect it, not an error inside a tool.
func (t *toolbox) verify(ctx context.Context, token string, r *http.Request) (*auth.TokenInfo, error) {
	m := t.manager(r.Header)
	var me struct {
		User struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	if err := m.decode(ctx, http.MethodGet, "/api/me", nil, nil, &me); err != nil {
		var apiErr *apiError
		if errors.As(err, &apiErr) && apiErr.Status == http.StatusUnauthorized {
			return nil, auth.ErrInvalidToken
		}
		return nil, err
	}
	return &auth.TokenInfo{UserID: me.User.ID}, nil
}

func envOr(key, fallback string) string {
	if value := os.Getenv(key); value != "" {
		return value
	}
	return fallback
}
