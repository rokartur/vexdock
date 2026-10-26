package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
)

// manager calls the manager's REST API with the MCP client's own bearer token,
// so the manager alone decides what the caller may do.
type manager struct {
	base     string
	http     *http.Client
	auth     string // the caller's Authorization header, forwarded as is
	clientIP string
}

// apiError is the manager's error envelope, kept whole so the agent sees the
// code it can act on (FORBIDDEN, NOT_FOUND, CONFIRMATION_REQUIRED, ...).
type apiError struct {
	Status  int
	Code    string `json:"code"`
	Message string `json:"message"`
}

func (e *apiError) Error() string {
	return fmt.Sprintf("%d %s: %s", e.Status, e.Code, e.Message)
}

func (m *manager) do(ctx context.Context, method, path string, query url.Values, body any) (*http.Response, error) {
	var reader io.Reader
	if body != nil {
		payload, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(payload)
	}
	target := m.base + path
	if len(query) > 0 {
		target += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, target, reader)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", m.auth)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	// The manager's audit log names the caller by this header.
	if m.clientIP != "" {
		req.Header.Set("X-Real-IP", m.clientIP)
	}
	res, err := m.http.Do(req)
	if err != nil {
		return nil, err
	}
	if res.StatusCode < 400 {
		return res, nil
	}
	defer res.Body.Close()
	var envelope struct {
		Error apiError `json:"error"`
	}
	raw, _ := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if json.Unmarshal(raw, &envelope) != nil || envelope.Error.Code == "" {
		return nil, &apiError{Status: res.StatusCode, Code: "HTTP_ERROR", Message: strings.TrimSpace(string(raw))}
	}
	envelope.Error.Status = res.StatusCode
	return nil, &envelope.Error
}

// call answers the response body as JSON.
func (m *manager) call(ctx context.Context, method, path string, query url.Values, body any) (json.RawMessage, error) {
	res, err := m.do(ctx, method, path, query, body)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	raw, err := io.ReadAll(res.Body)
	if err != nil {
		return nil, err
	}
	return raw, nil
}

// decode answers the response body decoded into out.
func (m *manager) decode(ctx context.Context, method, path string, query url.Values, body, out any) error {
	raw, err := m.call(ctx, method, path, query, body)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, out)
}

// events reads a server-sent event stream and collects the data of every event
// named name, stopping after limit of them or when the stream ends.
func (m *manager) events(ctx context.Context, path string, query url.Values, name string, limit int) ([]json.RawMessage, error) {
	res, err := m.do(ctx, http.MethodGet, path, query, nil)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var out []json.RawMessage
	event := ""
	scanner := bufio.NewScanner(res.Body)
	scanner.Buffer(make([]byte, 64<<10), 4<<20)
	for scanner.Scan() {
		line := scanner.Text()
		if after, ok := strings.CutPrefix(line, "event: "); ok {
			event = after
			continue
		}
		if after, ok := strings.CutPrefix(line, "data: "); ok && event == name {
			out = append(out, json.RawMessage(after))
			if len(out) == limit {
				return out, nil
			}
		}
	}
	return out, scanner.Err()
}
