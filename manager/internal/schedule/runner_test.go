package schedule

import (
	"sync"
	"testing"
)

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
