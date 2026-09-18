package engines

import (
	"strings"
	"testing"
)

// The picker is only useful if the newest release is the first thing in it, and
// Docker Hub's own order is by push date, which a patch on an old major wins.
func TestNewestFirst(t *testing.T) {
	tags := []string{"17-alpine", "bookworm", "18.6-alpine3.24", "19beta3", "18", "latest", "9.6"}
	newestFirst(tags)
	got := strings.Join(tags, " ")
	want := "latest 18 18.6-alpine3.24 17-alpine 9.6 19beta3 bookworm"
	if got != want {
		t.Errorf("got %q, want %q", got, want)
	}
}
