package api

import (
	"context"
	"encoding/json"
	"io"
	"net"
	"net/http"
	"time"

	"github.com/coder/websocket"
)

// terminalMessage is the framing between xterm.js and the container exec.
// Input carries keystrokes; resize carries the new viewport.
type terminalMessage struct {
	Type string `json:"type"`
	Data string `json:"data,omitempty"`
	Cols uint   `json:"cols,omitempty"`
	Rows uint   `json:"rows,omitempty"`
}

// handleTerminal upgrades to WebSocket and attaches an interactive shell.
// This is the only endpoint that is not SSE: a terminal needs a duplex channel.
func (s *Server) handleTerminal(w http.ResponseWriter, r *http.Request) {
	containerID, err := s.resolveServiceContainer(r.Context(), r.PathValue("id"))
	if err != nil {
		badRequest(w, err)
		return
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// The dashboard is same-origin behind Nginx; anything else is rejected.
		OriginPatterns: sameOriginPatterns(r.Host),
	})
	if err != nil {
		s.Log.Warn("terminal upgrade failed", "error", err)
		return
	}
	defer conn.CloseNow()

	ctx, cancel := context.WithCancel(r.Context())
	defer cancel()

	session, err := s.Docker.Exec(ctx, containerID, nil, 120, 30)
	if err != nil {
		_ = conn.Write(ctx, websocket.MessageText, []byte(err.Error()))
		_ = conn.Close(websocket.StatusInternalError, "exec failed")
		return
	}
	defer session.Close()

	// Container output to the browser.
	go func() {
		defer cancel()
		buf := make([]byte, 32*1024)
		for {
			n, err := session.Response.Reader.Read(buf)
			if n > 0 {
				if writeErr := conn.Write(ctx, websocket.MessageBinary, buf[:n]); writeErr != nil {
					return
				}
			}
			if err != nil {
				if err != io.EOF {
					s.Log.Debug("terminal read ended", "error", err)
				}
				return
			}
		}
	}()

	// Browser input and resize events to the container.
	for {
		typ, data, err := conn.Read(ctx)
		if err != nil {
			return
		}
		if typ == websocket.MessageBinary {
			if _, err := session.Response.Conn.Write(data); err != nil {
				return
			}
			continue
		}
		var msg terminalMessage
		if err := json.Unmarshal(data, &msg); err != nil {
			continue
		}
		switch msg.Type {
		case "input":
			if _, err := session.Response.Conn.Write([]byte(msg.Data)); err != nil {
				return
			}
		case "resize":
			resizeCtx, resizeCancel := context.WithTimeout(ctx, 5*time.Second)
			if err := s.Docker.ResizeExec(resizeCtx, session.ID, msg.Cols, msg.Rows); err != nil {
				s.Log.Debug("terminal resize failed", "error", err)
			}
			resizeCancel()
		}
	}
}

// sameOriginPatterns accepts the request's own host with or without a port.
// Reverse proxies differ on whether they forward the port in the Host header,
// so comparing the raw values alone would reject legitimate same-origin
// requests while still needing to reject genuinely foreign origins.
func sameOriginPatterns(requestHost string) []string {
	patterns := []string{requestHost}
	host, _, err := net.SplitHostPort(requestHost)
	if err != nil {
		host = requestHost
	}
	if host != "" && host != requestHost {
		patterns = append(patterns, host)
	}
	if host != "" {
		patterns = append(patterns, host+":*")
	}
	return patterns
}
