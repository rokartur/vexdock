package api

import (
	"context"
	"strings"
	"testing"
	"time"
)

// The log SSE handler buffers lines and the client can vanish at any point. If
// scanLines ignored the context it would stay parked on a send nobody drains,
// and closing the reader cannot wake a goroutine already blocked on a channel.
func TestScanLinesReturnsWhenClientGoesAwayMidSend(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()

	done := make(chan struct{})
	go func() {
		defer close(done)
		// Nobody ever receives from out, so the first send blocks.
		scanLines(ctx, strings.NewReader("first\nsecond\n"), "stdout", make(chan logPayload))
	}()

	select {
	case <-done:
	case <-time.After(2 * time.Second):
		t.Fatal("scanLines stayed parked on a send after the context was cancelled")
	}
}

func TestScanLinesSplitsStreamIntoLines(t *testing.T) {
	out := make(chan logPayload, 8)
	// The trailing line has no newline: it must still be flushed at EOF.
	scanLines(context.Background(), strings.NewReader("one\ntwo\r\nthree"), "stderr", out)
	close(out)

	var got []string
	for line := range out {
		if line.Stream != "stderr" {
			t.Fatalf("stream = %q, want stderr", line.Stream)
		}
		got = append(got, line.Text)
	}
	want := []string{"one", "two\r", "three"}
	if strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("lines = %q, want %q", got, want)
	}
}
