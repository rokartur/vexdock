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

func TestNext(t *testing.T) {
	warsaw, err := time.LoadLocation("Europe/Warsaw")
	if err != nil {
		t.Fatalf("load timezone: %v", err)
	}

	cases := []struct {
		expr string
		from time.Time
		want string
	}{
		{"*/15 * * * *", time.Date(2024, 3, 6, 13, 31, 20, 0, time.UTC), "2024-03-06T13:45:00Z"},
		// Strictly after: a schedule matching right now points at the next one.
		{"0 3 * * *", time.Date(2024, 3, 6, 3, 0, 0, 0, time.UTC), "2024-03-07T03:00:00Z"},
		{"0 9 * * 1", time.Date(2024, 3, 6, 13, 0, 0, 0, time.UTC), "2024-03-11T09:00:00Z"},
		// A day skip that lands years out still resolves.
		{"0 0 29 2 *", time.Date(2024, 3, 1, 0, 0, 0, 0, time.UTC), "2028-02-29T00:00:00Z"},
		// The zone of the input decides the wall clock: the next 03:00 in Warsaw is
		// tomorrow morning, which is 02:00Z.
		{"0 3 * * *", time.Date(2024, 3, 6, 13, 0, 0, 0, warsaw), "2024-03-07T02:00:00Z"},
	}

	for _, c := range cases {
		s, err := Parse(c.expr)
		if err != nil {
			t.Fatalf("Parse(%q): %v", c.expr, err)
		}
		next, ok := s.Next(c.from)
		if !ok {
			t.Errorf("Parse(%q).Next(%s) found nothing", c.expr, c.from)
			continue
		}
		if got := next.UTC().Format(time.RFC3339); got != c.want {
			t.Errorf("Parse(%q).Next(%s) = %s, want %s", c.expr, c.from, got, c.want)
		}
	}

	// February 30th is a valid expression the calendar never reaches.
	never, err := Parse("0 0 30 2 *")
	if err != nil {
		t.Fatalf("Parse: %v", err)
	}
	if _, ok := never.Next(time.Now()); ok {
		t.Error("Next found a February 30th")
	}
}
