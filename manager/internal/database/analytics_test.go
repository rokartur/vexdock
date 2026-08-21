package database

import (
	"context"
	"testing"
	"time"
)

func TestTrafficSummary(t *testing.T) {
	db := open(t)
	ctx := context.Background()
	// Far enough back that the last event, three hours later, is still past.
	base := time.Now().Add(-5 * time.Hour).Truncate(time.Minute)

	record := func(offset time.Duration, e AnalyticsEvent) {
		t.Helper()
		if e.Kind == "" {
			e.Kind = "pageview"
		}
		e.Hostname = "example.com"
		if err := db.RecordAnalyticsEvent(ctx, base.Add(offset), e); err != nil {
			t.Fatalf("record: %v", err)
		}
	}

	// Ada reads two pages over four minutes: one visit, not a bounce.
	record(0, AnalyticsEvent{Visitor: "ada", Path: "/", Referrer: "news.ycombinator.com", Country: "PL", Device: "desktop", Browser: "Firefox", OS: "Linux"})
	record(2*time.Minute, AnalyticsEvent{Visitor: "ada", Kind: "ping", Path: "/"})
	record(4*time.Minute, AnalyticsEvent{Visitor: "ada", Path: "/pricing", Country: "PL", Device: "desktop", Browser: "Firefox", OS: "Linux"})
	record(4*time.Minute, AnalyticsEvent{Visitor: "ada", Kind: "signup", Path: "/pricing", Props: `{"plan":"pro"}`})
	// Grace lands once and leaves: a bounce with no duration.
	record(time.Minute, AnalyticsEvent{Visitor: "grace", Path: "/", Country: "DE", Device: "mobile", Browser: "Safari", OS: "iOS"})
	// Ada again, hours later. Past the session gap, so a second visit.
	record(3*time.Hour, AnalyticsEvent{Visitor: "ada", Path: "/", Country: "PL", Device: "desktop", Browser: "Firefox", OS: "Linux"})
	// Another host must not leak into the numbers.
	if err := db.RecordAnalyticsEvent(ctx, base, AnalyticsEvent{
		Hostname: "other.com", Visitor: "zed", Kind: "pageview", Path: "/",
	}); err != nil {
		t.Fatalf("record other host: %v", err)
	}

	summary, err := db.TrafficFor(ctx, "example.com", base.Add(-time.Hour), base.Add(-time.Hour), 3600, 20)
	if err != nil {
		t.Fatalf("traffic: %v", err)
	}

	if summary.Views != 4 || summary.Visitors != 2 {
		t.Fatalf("views/visitors = %d/%d, want 4/2", summary.Views, summary.Visitors)
	}
	if summary.Visits != 3 {
		t.Fatalf("visits = %d, want 3 (a gap over thirty minutes starts a new one)", summary.Visits)
	}
	// Ada's first visit lasts four minutes, her second and Grace's are instant.
	if summary.AvgDuration != 80 {
		t.Fatalf("avg duration = %ds, want 80s", summary.AvgDuration)
	}
	// Two of the three visits are single-pageview.
	if summary.BounceRate < 0.66 || summary.BounceRate > 0.67 {
		t.Fatalf("bounce rate = %.2f, want ~0.67", summary.BounceRate)
	}
	if len(summary.Pages) == 0 || summary.Pages[0].Name != "/" || summary.Pages[0].Count != 3 {
		t.Fatalf("top page = %+v, want / with 3 views", summary.Pages)
	}
	if len(summary.Referrers) != 1 || summary.Referrers[0].Name != "news.ycombinator.com" {
		t.Fatalf("referrers = %+v", summary.Referrers)
	}
	if len(summary.Events) != 1 || summary.Events[0].Name != "signup" {
		t.Fatalf("events = %+v, want one signup", summary.Events)
	}
	if len(summary.Countries) != 2 || summary.Countries[0].Name != "PL" {
		t.Fatalf("countries = %+v", summary.Countries)
	}

	// Nobody is online: the window starts after every event.
	fresh, err := db.TrafficFor(ctx, "example.com", base.Add(-time.Hour), time.Now().Add(time.Hour), 3600, 20)
	if err != nil {
		t.Fatalf("traffic online window: %v", err)
	}
	if fresh.Online != 0 || len(fresh.OnlinePages) != 0 {
		t.Fatalf("online = %d, pages = %+v, want nobody", fresh.Online, fresh.OnlinePages)
	}

	if err := db.PruneAnalytics(ctx, base.Add(2*time.Hour)); err != nil {
		t.Fatalf("prune: %v", err)
	}
	pruned, err := db.TrafficFor(ctx, "example.com", base.Add(-time.Hour), base.Add(-time.Hour), 3600, 20)
	if err != nil {
		t.Fatalf("traffic after prune: %v", err)
	}
	if pruned.Views != 1 {
		t.Fatalf("views after prune = %d, want the single later visit", pruned.Views)
	}
}
