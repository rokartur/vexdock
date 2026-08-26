package schedule

import (
	"log/slog"
	"sync"
	"testing"
	"time"

	"github.com/vexdock/platform/manager/internal/database"
)

// A task fires on its own wall clock, so the same instant is 3am for one task
// and not for another. Getting this wrong means a nightly job runs at noon.
func TestDueReadsTheInstantInTheTasksOwnTimezone(t *testing.T) {
	r := NewRunner(nil, nil, slog.New(slog.DiscardHandler))
	// 02:00 UTC in January is 03:00 in Warsaw and 20:00 the day before in Chicago.
	now := time.Date(2024, time.January, 15, 2, 0, 0, 0, time.UTC)

	cases := []struct {
		timezone string
		schedule string
		want     bool
	}{
		{"UTC", "0 3 * * *", false},
		{"Europe/Warsaw", "0 3 * * *", true},
		{"America/Chicago", "0 20 * * *", true},
		{"America/Chicago", "0 20 15 * *", false}, // still the 14th there
		{"", "0 2 * * *", true},                   // an empty zone is UTC
		{"Mars/Olympus", "* * * * *", false},      // unknown zone, skipped not guessed
		{"UTC", "nonsense", false},
	}
	for _, tc := range cases {
		task := database.ScheduledTask{ID: "task", Schedule: tc.schedule, Timezone: tc.timezone}
		if got := r.due(task, now); got != tc.want {
			t.Errorf("due(%q in %q) = %v, want %v", tc.schedule, tc.timezone, got, tc.want)
		}
	}
}

// The claim guard is what stops a job slower than its own schedule from piling
// up on itself, so it has to hold when a tick and a manual run race.
func TestOnlyOneRunPerTaskIsClaimedAtATime(t *testing.T) {
	r := NewRunner(nil, nil, nil)

	var claimed int
	var mu sync.Mutex
	var wg sync.WaitGroup
	for range 20 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if r.claim("task") {
				mu.Lock()
				claimed++
				mu.Unlock()
			}
		}()
	}
	wg.Wait()

	if claimed != 1 {
		t.Fatalf("claimed %d times concurrently, want 1", claimed)
	}
	if !r.claim("other") {
		t.Fatal("a different task should still be claimable")
	}
	r.release("task")
	if !r.claim("task") {
		t.Fatal("a released task should be claimable again")
	}
}
