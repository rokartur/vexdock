package schedule

import (
	"testing"
	"time"
)

func TestParseRejectsGarbage(t *testing.T) {
	for _, expr := range []string{"", "* * * *", "* * * * * *", "60 * * * *", "* 24 * * *", "*/0 * * * *", "5-1 * * * *", "x * * * *", "* * 0 * *"} {
		if _, err := Parse(expr); err == nil {
			t.Errorf("Parse(%q) accepted an invalid expression", expr)
		}
	}
}

func TestMatch(t *testing.T) {
	// 2024-03-06 is a Wednesday, 2024-03-10 a Sunday.
	at := func(s string) time.Time {
		t.Helper()
		parsed, err := time.Parse(time.RFC3339, s)
		if err != nil {
			t.Fatal(err)
		}
		return parsed
	}

	cases := []struct {
		expr string
		time string
		want bool
	}{
		{"* * * * *", "2024-03-06T13:37:00Z", true},
		{"*/15 * * * *", "2024-03-06T13:30:00Z", true},
		{"*/15 * * * *", "2024-03-06T13:31:00Z", false},
		{"5/15 * * * *", "2024-03-06T13:35:00Z", true},
		{"0 3 * * *", "2024-03-06T03:00:00Z", true},
		{"0 3 * * *", "2024-03-06T04:00:00Z", false},
		{"@daily", "2024-03-06T00:00:00Z", true},
		{"@hourly", "2024-03-06T13:00:00Z", true},
		{"0 0 * * sun", "2024-03-10T00:00:00Z", true},
		{"0 0 * * 7", "2024-03-10T00:00:00Z", true},
		{"0 0 * * 1-5", "2024-03-10T00:00:00Z", false},
		{"0 0 * * 1-5", "2024-03-06T00:00:00Z", true},
		{"0,30 9-17 * * *", "2024-03-06T09:30:00Z", true},
		{"0,30 9-17 * * *", "2024-03-06T18:30:00Z", false},
		{"0 0 1 jan *", "2024-01-01T00:00:00Z", true},
		{"0 0 1 jan *", "2024-02-01T00:00:00Z", false},
		// Both day fields restricted: either one matching fires the task.
		{"0 0 6 * sun", "2024-03-06T00:00:00Z", true},
		{"0 0 6 * sun", "2024-03-10T00:00:00Z", true},
		{"0 0 6 * sun", "2024-03-07T00:00:00Z", false},
	}

	for _, c := range cases {
		s, err := Parse(c.expr)
		if err != nil {
			t.Fatalf("Parse(%q): %v", c.expr, err)
		}
		if got := s.Match(at(c.time)); got != c.want {
			t.Errorf("Parse(%q).Match(%s) = %v, want %v", c.expr, c.time, got, c.want)
		}
	}
}
