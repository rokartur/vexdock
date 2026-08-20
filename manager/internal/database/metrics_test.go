package database

import (
	"context"
	"testing"
	"time"
)

func TestMetricsBucketAndPrune(t *testing.T) {
	db := open(t)
	ctx := context.Background()
	base := time.Now().Truncate(time.Minute)

	// Two readings inside one 60s bucket, one in the next.
	for i, reading := range []struct {
		offset time.Duration
		cpu    float64
		rx     uint64
	}{
		{0, 10, 100},
		{30 * time.Second, 30, 400},
		{60 * time.Second, 50, 900},
	} {
		at := base.Add(reading.offset)
		if err := db.RecordHostMetric(ctx, at, HostPoint{CPUPercent: reading.cpu, MemoryUsed: 1 << 30,
			MemoryTotal: 4 << 30, DiskUsed: 1 << 30, DiskTotal: 8 << 30}); err != nil {
			t.Fatalf("record host %d: %v", i, err)
		}
		if err := db.RecordContainerMetrics(ctx, at, []ContainerSample{{
			ContainerID: "c1", ServiceID: "svc", CPUPercent: reading.cpu, NetworkRX: reading.rx,
		}}); err != nil {
			t.Fatalf("record container %d: %v", i, err)
		}
	}

	host, err := db.HostMetrics(ctx, base.Add(-time.Hour), 60)
	if err != nil {
		t.Fatalf("host metrics: %v", err)
	}
	if len(host) != 2 {
		t.Fatalf("expected 2 buckets, got %d", len(host))
	}
	if host[0].CPUPercent != 20 {
		t.Fatalf("expected the bucket to average cpu to 20, got %v", host[0].CPUPercent)
	}

	service, err := db.ServiceMetrics(ctx, "svc", base.Add(-time.Hour), 60)
	if err != nil {
		t.Fatalf("service metrics: %v", err)
	}
	// Cumulative counters take the bucket maximum, so the delta between buckets
	// is still the bytes moved between them.
	if service[0].NetworkRX != 400 || service[1].NetworkRX != 900 {
		t.Fatalf("expected counters 400 then 900, got %d then %d", service[0].NetworkRX, service[1].NetworkRX)
	}

	latest, err := db.LatestServiceMetrics(ctx, base.Add(-time.Hour))
	if err != nil {
		t.Fatalf("latest service metrics: %v", err)
	}
	if latest["svc"].CPUPercent != 50 {
		t.Fatalf("expected the newest reading, cpu 50, got %v", latest["svc"].CPUPercent)
	}
	// A window that starts after every reading has no current reading to report.
	fresh, err := db.LatestServiceMetrics(ctx, base.Add(time.Hour))
	if err != nil {
		t.Fatalf("latest service metrics after window: %v", err)
	}
	if len(fresh) != 0 {
		t.Fatalf("expected stale readings to be dropped, got %d", len(fresh))
	}

	if err := db.PruneMetrics(ctx, base.Add(time.Hour)); err != nil {
		t.Fatalf("prune: %v", err)
	}
	host, err = db.HostMetrics(ctx, base.Add(-time.Hour), 60)
	if err != nil {
		t.Fatalf("host metrics after prune: %v", err)
	}
	if len(host) != 0 {
		t.Fatalf("expected everything pruned, got %d buckets", len(host))
	}
}
