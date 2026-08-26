// Package schedule runs user-defined cron tasks inside service containers. It
// owns the cron expression parser and the once-a-minute runner loop.
package schedule

import (
	"fmt"
	"strconv"
	"strings"
	"time"
)

// Schedule is a parsed five field cron expression, one bitmask per field.
type Schedule struct {
	minute  uint64
	hour    uint64
	dom     uint64
	month   uint64
	dow     uint64
	domStar bool
	dowStar bool
}

type field struct {
	min, max int
	names    map[string]int
}

var (
	minutes = field{min: 0, max: 59}
	hours   = field{min: 0, max: 23}
	doms    = field{min: 1, max: 31}
	months  = field{min: 1, max: 12, names: map[string]int{
		"jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
		"jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12,
	}}
	dows = field{min: 0, max: 6, names: map[string]int{
		"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6,
	}}
)

var nicknames = map[string]string{
	"@yearly":   "0 0 1 1 *",
	"@annually": "0 0 1 1 *",
	"@monthly":  "0 0 1 * *",
	"@weekly":   "0 0 * * 0",
	"@daily":    "0 0 * * *",
	"@midnight": "0 0 * * *",
	"@hourly":   "0 * * * *",
}

// Parse reads a five field expression (minute hour day-of-month month
// day-of-week) or one of the @daily style nicknames. Each field accepts `*`,
// a number, `a-b`, a `/step` suffix and comma separated lists.
func Parse(expr string) (Schedule, error) {
	expr = strings.TrimSpace(expr)
	if nick, ok := nicknames[strings.ToLower(expr)]; ok {
		expr = nick
	}
	parts := strings.Fields(expr)
	if len(parts) != 5 {
		return Schedule{}, fmt.Errorf("cron expression needs 5 fields, got %d", len(parts))
	}

	s := Schedule{domStar: isStar(parts[2]), dowStar: isStar(parts[4])}
	for _, spec := range []struct {
		text  string
		f     field
		into  *uint64
		label string
	}{
		{parts[0], minutes, &s.minute, "minute"},
		{parts[1], hours, &s.hour, "hour"},
		{parts[2], doms, &s.dom, "day of month"},
		{parts[3], months, &s.month, "month"},
		{parts[4], dows, &s.dow, "day of week"},
	} {
		bits, err := parseField(spec.text, spec.f)
		if err != nil {
			return Schedule{}, fmt.Errorf("%s: %w", spec.label, err)
		}
		*spec.into = bits
	}
	return s, nil
}

// Match reports whether the schedule fires at t, to minute precision.
func (s Schedule) Match(t time.Time) bool {
	if s.minute&bit(t.Minute()) == 0 || s.hour&bit(t.Hour()) == 0 || s.month&bit(int(t.Month())) == 0 {
		return false
	}
	dom := s.dom&bit(t.Day()) != 0
	dow := s.dow&bit(int(t.Weekday())) != 0
	// Standard cron: when both day fields are restricted, either one matching is
	// enough. Otherwise the restricted one decides.
	if s.domStar || s.dowStar {
		return dom && dow
	}
	return dom || dow
}

func isStar(s string) bool { return s == "*" || strings.HasPrefix(s, "*/") }

func bit(n int) uint64 { return 1 << uint(n) }

func parseField(text string, f field) (uint64, error) {
	var bits uint64
	for _, part := range strings.Split(text, ",") {
		b, err := parseRange(part, f)
		if err != nil {
			return 0, err
		}
		bits |= b
	}
	return bits, nil
}

func parseRange(part string, f field) (uint64, error) {
	step := 1
	if base, stepText, ok := strings.Cut(part, "/"); ok {
		n, err := strconv.Atoi(stepText)
		if err != nil || n < 1 {
			return 0, fmt.Errorf("invalid step %q", stepText)
		}
		step, part = n, base
	}

	low, high := f.min, f.max
	if part != "*" {
		from, to, isRange := strings.Cut(part, "-")
		var err error
		if low, err = parseValue(from, f); err != nil {
			return 0, err
		}
		high = low
		if isRange {
			if high, err = parseValue(to, f); err != nil {
				return 0, err
			}
		} else if step > 1 {
			// `5/15` means "from 5 to the end of the field", as in `5-59/15`.
			high = f.max
		}
		if low > high {
			return 0, fmt.Errorf("range %q is inverted", part)
		}
	}

	var bits uint64
	for v := low; v <= high; v += step {
		bits |= bit(v)
	}
	return bits, nil
}

func parseValue(text string, f field) (int, error) {
	if n, ok := f.names[strings.ToLower(text)]; ok {
		return n, nil
	}
	n, err := strconv.Atoi(text)
	if err != nil {
		return 0, fmt.Errorf("invalid value %q", text)
	}
	// Both 0 and 7 are Sunday in every cron implementation.
	if f.max == 6 && n == 7 {
		n = 0
	}
	if n < f.min || n > f.max {
		return 0, fmt.Errorf("value %d out of range %d-%d", n, f.min, f.max)
	}
	return n, nil
}
