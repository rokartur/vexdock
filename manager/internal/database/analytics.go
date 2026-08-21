package database

import (
	"context"
	"fmt"
	"time"
)

// AnalyticsEvent is one beacon hit, already cleaned and bucketed by the
// analytics package.
type AnalyticsEvent struct {
	Hostname string
	Visitor  string
	Kind     string
	Path     string
	Referrer string
	Country  string
	Device   string
	Browser  string
	OS       string
	Props    string
}

// TrafficPoint is one bucket of the visits chart. At is unix seconds.
type TrafficPoint struct {
	At       int64 `json:"at"`
	Views    int   `json:"views"`
	Visitors int   `json:"visitors"`
}

// Breakdown is one row of a "top something" table.
type Breakdown struct {
	Name     string `json:"name"`
	Count    int    `json:"count"`
	Visitors int    `json:"visitors"`
}

// TrafficSummary is everything the analytics page shows for one domain in one
// window, so the page is one request.
type TrafficSummary struct {
	Views    int `json:"views"`
	Visitors int `json:"visitors"`
	// Online is distinct visitors seen within the last few minutes.
	Online int `json:"online"`
	Visits int `json:"visits"`
	// AvgDuration is the mean visit length in seconds.
	AvgDuration int `json:"avg_duration"`
	// BounceRate is the share of visits with a single pageview, 0 to 1.
	BounceRate float64 `json:"bounce_rate"`

	Series      []TrafficPoint `json:"series"`
	Pages       []Breakdown    `json:"pages"`
	Referrers   []Breakdown    `json:"referrers"`
	Countries   []Breakdown    `json:"countries"`
	Devices     []Breakdown    `json:"devices"`
	Browsers    []Breakdown    `json:"browsers"`
	Systems     []Breakdown    `json:"systems"`
	Events      []Breakdown    `json:"events"`
	OnlinePages []Breakdown    `json:"online_pages"`
}

// RecordAnalyticsEvent appends one hit.
func (db *DB) RecordAnalyticsEvent(ctx context.Context, at time.Time, e AnalyticsEvent) error {
	_, err := db.ExecContext(ctx,
		`INSERT INTO analytics_events (at, hostname, visitor, kind, path, referrer, country, device, browser, os, props)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		at.Unix(), e.Hostname, e.Visitor, e.Kind, e.Path, e.Referrer, e.Country, e.Device, e.Browser, e.OS, e.Props)
	return err
}

// TrafficFor aggregates one domain's window. Every section is a separate query
// against the same index; SQLite is local, so the round trips are free and the
// alternative is one query nobody can read.
func (db *DB) TrafficFor(ctx context.Context, hostname string, since, onlineSince time.Time,
	bucket int64, limit int,
) (*TrafficSummary, error) {
	from, online := since.Unix(), onlineSince.Unix()
	summary := &TrafficSummary{}

	err := db.QueryRowContext(ctx,
		`SELECT COUNT(*) FILTER (WHERE kind = 'pageview'), COUNT(DISTINCT visitor)
		 FROM analytics_events WHERE hostname = ? AND at >= ?`,
		hostname, from).Scan(&summary.Views, &summary.Visitors)
	if err != nil {
		return nil, err
	}

	if err := db.onlineNow(ctx, hostname, online, limit, summary); err != nil {
		return nil, err
	}

	if err := db.visitStats(ctx, hostname, from, summary); err != nil {
		return nil, err
	}

	summary.Series, err = db.trafficSeries(ctx, hostname, from, clampBucket(bucket))
	if err != nil {
		return nil, err
	}

	// Every "top" table is the same query with a different column. They rank by
	// visitors, except custom events, where the number of times it fired is the
	// number someone is actually after.
	sections := []struct {
		into      *[]Breakdown
		column    string
		condition string
		from      int64
		byCount   bool
	}{
		{into: &summary.Pages, column: "path", condition: "kind = 'pageview'", from: from},
		{into: &summary.Referrers, column: "referrer", condition: "kind = 'pageview' AND referrer != ''", from: from},
		{into: &summary.Countries, column: "country", condition: "kind = 'pageview'", from: from},
		{into: &summary.Devices, column: "device", condition: "kind = 'pageview'", from: from},
		{into: &summary.Browsers, column: "browser", condition: "kind = 'pageview'", from: from},
		{into: &summary.Systems, column: "os", condition: "kind = 'pageview'", from: from},
		{into: &summary.Events, column: "kind", condition: "kind NOT IN ('pageview', 'ping', 'leave')", from: from, byCount: true},
	}
	for _, section := range sections {
		rows, err := db.breakdown(ctx, hostname, section.from, section.column, section.condition, section.byCount, limit)
		if err != nil {
			return nil, err
		}
		*section.into = rows
	}
	return summary, nil
}

// liveVisitors keeps the one row per visitor that says where they are now: the
// latest event in the window, dropping whoever's latest event was a leave. Any
// event within the window would count a tab that closed four minutes ago,
// which is what someone watching "online" notices first. Ties on the same
// second break by insertion order, since a bounce sends its pageview and its
// leave inside one.
const liveVisitors = `WITH ranked AS (
         SELECT visitor, kind, path,
                ROW_NUMBER() OVER (PARTITION BY visitor ORDER BY at DESC, rowid DESC) AS seq
         FROM analytics_events WHERE hostname = ? AND at >= ?
     ),
     live AS (SELECT visitor, path FROM ranked WHERE seq = 1 AND kind != 'leave')`

// onlineNow fills in who is here and what they are reading.
func (db *DB) onlineNow(ctx context.Context, hostname string, since int64, limit int, summary *TrafficSummary) error {
	if err := db.QueryRowContext(ctx, liveVisitors+` SELECT COUNT(*) FROM live`,
		hostname, since).Scan(&summary.Online); err != nil {
		return err
	}

	rows, err := db.QueryContext(ctx, liveVisitors+
		` SELECT path, COUNT(*), COUNT(DISTINCT visitor) FROM live
		  WHERE path != '' GROUP BY path ORDER BY 2 DESC, 1 LIMIT ?`,
		hostname, since, limit)
	if err != nil {
		return err
	}
	defer rows.Close()

	summary.OnlinePages = []Breakdown{}
	for rows.Next() {
		var b Breakdown
		if err := rows.Scan(&b.Name, &b.Count, &b.Visitors); err != nil {
			return err
		}
		summary.OnlinePages = append(summary.OnlinePages, b)
	}
	return rows.Err()
}

// visitStats derives visits, their length and the bounce rate from the raw
// events: a gap of more than thirty minutes starts a new visit, exactly like
// every other analytics tool defines a session.
func (db *DB) visitStats(ctx context.Context, hostname string, from int64, summary *TrafficSummary) error {
	const sessionGap = 1800
	var visits int
	var duration, bounce float64
	err := db.QueryRowContext(ctx,
		`WITH hits AS (
		     SELECT visitor, at, kind,
		            LAG(at) OVER (PARTITION BY visitor ORDER BY at) AS previous
		     FROM analytics_events
		     WHERE hostname = ? AND at >= ? AND kind IN ('pageview', 'ping')
		 ),
		 marked AS (
		     SELECT visitor, at, kind,
		            SUM(CASE WHEN previous IS NULL OR at - previous > ? THEN 1 ELSE 0 END)
		                OVER (PARTITION BY visitor ORDER BY at) AS visit
		     FROM hits
		 ),
		 visits AS (
		     SELECT MAX(at) - MIN(at) AS seconds,
		            COUNT(*) FILTER (WHERE kind = 'pageview') AS views
		     FROM marked GROUP BY visitor, visit
		 )
		 SELECT COUNT(*), COALESCE(AVG(seconds), 0), COALESCE(AVG(CASE WHEN views <= 1 THEN 1.0 ELSE 0 END), 0)
		 FROM visits`,
		hostname, from, sessionGap).Scan(&visits, &duration, &bounce)
	if err != nil {
		return err
	}
	summary.Visits, summary.AvgDuration, summary.BounceRate = visits, int(duration), bounce
	return nil
}

func (db *DB) trafficSeries(ctx context.Context, hostname string, from, bucket int64) ([]TrafficPoint, error) {
	rows, err := db.QueryContext(ctx,
		`SELECT (at / ?) * ? AS b, COUNT(*) FILTER (WHERE kind = 'pageview'), COUNT(DISTINCT visitor)
		 FROM analytics_events WHERE hostname = ? AND at >= ? GROUP BY b ORDER BY b`,
		bucket, bucket, hostname, from)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []TrafficPoint{}
	for rows.Next() {
		var p TrafficPoint
		if err := rows.Scan(&p.At, &p.Views, &p.Visitors); err != nil {
			return nil, err
		}
		out = append(out, p)
	}
	return out, rows.Err()
}

// breakdown groups by one column. The column and condition are package
// constants from TrafficFor, never anything a request supplied.
func (db *DB) breakdown(ctx context.Context, hostname string, from int64, column, condition string,
	byCount bool, limit int,
) ([]Breakdown, error) {
	order := "3 DESC, 2 DESC"
	if byCount {
		order = "2 DESC, 3 DESC"
	}
	query := fmt.Sprintf(
		`SELECT %s, COUNT(*), COUNT(DISTINCT visitor) FROM analytics_events
		 WHERE hostname = ? AND at >= ? AND %s
		 GROUP BY %s ORDER BY %s LIMIT ?`, column, condition, column, order)
	rows, err := db.QueryContext(ctx, query, hostname, from, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []Breakdown{}
	for rows.Next() {
		var b Breakdown
		if err := rows.Scan(&b.Name, &b.Count, &b.Visitors); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

// PruneAnalytics drops events older than `before`.
func (db *DB) PruneAnalytics(ctx context.Context, before time.Time) error {
	_, err := db.ExecContext(ctx, `DELETE FROM analytics_events WHERE at < ?`, before.Unix())
	return err
}

// ClearAnalytics drops every event of one site and reports how many went.
func (db *DB) ClearAnalytics(ctx context.Context, hostname string) (int64, error) {
	result, err := db.ExecContext(ctx, `DELETE FROM analytics_events WHERE hostname = ?`, hostname)
	if err != nil {
		return 0, err
	}
	return result.RowsAffected()
}
