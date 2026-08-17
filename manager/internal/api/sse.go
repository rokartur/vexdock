package api

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"time"

	"github.com/vexdock/platform/manager/internal/events"
)

// sseWriter emits Server-Sent Events. SSE carries every read-only realtime
// stream in the platform; WebSocket is reserved for the interactive terminal.
type sseWriter struct {
	w       http.ResponseWriter
	flusher http.Flusher
}

func newSSE(w http.ResponseWriter) (*sseWriter, error) {
	flusher, ok := w.(http.Flusher)
	if !ok {
		return nil, fmt.Errorf("streaming is not supported by this connection")
	}
	w.Header().Set("Content-Type", "text/event-stream")
	w.Header().Set("Cache-Control", "no-cache, no-transform")
	w.Header().Set("Connection", "keep-alive")
	// Belt and braces: Nginx buffering is already disabled in the vhost.
	w.Header().Set("X-Accel-Buffering", "no")
	w.WriteHeader(http.StatusOK)
	flusher.Flush()
	return &sseWriter{w: w, flusher: flusher}, nil
}

func (s *sseWriter) send(event string, data any) error {
	payload, err := json.Marshal(data)
	if err != nil {
		return err
	}
	if _, err := fmt.Fprintf(s.w, "event: %s\ndata: %s\n\n", event, payload); err != nil {
		return err
	}
	s.flusher.Flush()
	return nil
}

// keepAlive stops idle proxies from closing a quiet stream.
func (s *sseWriter) keepAlive() error {
	if _, err := fmt.Fprint(s.w, ": ping\n\n"); err != nil {
		return err
	}
	s.flusher.Flush()
	return nil
}

// streamBus pumps a bus subscription to the client until either side stops.
func streamBus(ctx context.Context, sse *sseWriter, ch <-chan events.Event) {
	ticker := time.NewTicker(20 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case msg, ok := <-ch:
			if !ok {
				return
			}
			if err := sse.send(msg.Type, msg.Data); err != nil {
				return
			}
		case <-ticker.C:
			if err := sse.keepAlive(); err != nil {
				return
			}
		}
	}
}
