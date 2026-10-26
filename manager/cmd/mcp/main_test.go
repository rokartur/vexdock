package main

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"slices"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type bearer struct {
	token string
	next  http.RoundTripper
}

func (b bearer) RoundTrip(r *http.Request) (*http.Response, error) {
	r = r.Clone(r.Context())
	r.Header.Set("Authorization", "Bearer "+b.token)
	return b.next.RoundTrip(r)
}

// fakeManager answers the two routes the test drives and records the
// variables PUT, so the merge can be checked against what reached the manager.
func fakeManager(t *testing.T, put *[]envVar) *httptest.Server {
	mux := http.NewServeMux()
	authorized := func(h http.HandlerFunc) http.HandlerFunc {
		return func(w http.ResponseWriter, r *http.Request) {
			if r.Header.Get("Authorization") != "Bearer good" {
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = io.WriteString(w, `{"error":{"code":"UNAUTHORIZED","message":"Authentication required"}}`)
				return
			}
			h(w, r)
		}
	}
	mux.HandleFunc("GET /api/me", authorized(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `{"user":{"id":"u1"},"access":{"admin":false,"projects":[]}}`)
	}))
	mux.HandleFunc("GET /api/services/s1/variables", authorized(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = io.WriteString(w, `[{"key":"KEEP","value":"1","is_secret":false},{"key":"CHANGE","value":"old","is_secret":true},{"key":"DROP","value":"x","is_secret":false}]`)
	}))
	mux.HandleFunc("PUT /api/services/s1/variables", authorized(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Variables []envVar `json:"variables"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		*put = body.Variables
		_ = json.NewEncoder(w).Encode(body.Variables)
	}))
	server := httptest.NewServer(mux)
	t.Cleanup(server.Close)
	return server
}

func connect(t *testing.T, endpoint, token string) (*mcp.ClientSession, error) {
	client := mcp.NewClient(&mcp.Implementation{Name: "test", Version: "0"}, nil)
	return client.Connect(context.Background(), &mcp.StreamableClientTransport{
		Endpoint:   endpoint,
		HTTPClient: &http.Client{Transport: bearer{token: token, next: http.DefaultTransport}},
	}, nil)
}

func TestServer(t *testing.T) {
	var put []envVar
	manager := fakeManager(t, &put)
	tools := &toolbox{base: manager.URL, http: manager.Client()}
	metadata := resourceMetadataURL("https://panel.example.com/")
	mcpServer := httptest.NewServer(handler(tools, "test", metadata, slog.New(slog.NewTextHandler(io.Discard, nil))))
	t.Cleanup(mcpServer.Close)

	if _, err := connect(t, mcpServer.URL+"/mcp", "bad"); err == nil {
		t.Fatal("a token the manager rejects connected")
	}
	// An OAuth client starts from the 401's pointer to the resource metadata.
	resp, err := http.Post(mcpServer.URL+"/mcp", "application/json", nil)
	if err != nil {
		t.Fatal(err)
	}
	_ = resp.Body.Close()
	if got, want := resp.Header.Get("WWW-Authenticate"), `Bearer resource_metadata="https://panel.example.com/.well-known/oauth-protected-resource/mcp"`; got != want {
		t.Errorf("WWW-Authenticate = %q, want %q", got, want)
	}

	session, err := connect(t, mcpServer.URL+"/mcp", "good")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = session.Close() })

	list, err := session.ListTools(context.Background(), nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(list.Tools) != 23 {
		t.Errorf("%d tools, want 23", len(list.Tools))
	}

	result, err := session.CallTool(context.Background(), &mcp.CallToolParams{
		Name: "set_variables",
		Arguments: map[string]any{
			"scope": "service", "id": "s1",
			"set":    map[string]string{"CHANGE": "new", "ADD": "2"},
			"remove": []string{"DROP"},
		},
	})
	if err != nil || result.IsError {
		t.Fatalf("set_variables: %v %+v", err, result)
	}
	want := []envVar{{Key: "KEEP", Value: "1"}, {Key: "CHANGE", Value: "new", IsSecret: true}, {Key: "ADD", Value: "2"}}
	if !slices.Equal(put, want) {
		t.Errorf("PUT %+v, want %+v", put, want)
	}

	result, err = session.CallTool(context.Background(), &mcp.CallToolParams{Name: "service_action", Arguments: map[string]any{"service_id": "s1", "action": "explode"}})
	if err != nil || !result.IsError {
		t.Errorf("an unknown action was not a tool error: %v %+v", err, result)
	}
}
