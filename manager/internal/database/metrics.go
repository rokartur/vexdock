package database

import (
	"context"
	"time"
)

// HostPoint is one bucket of host usage. At is unix seconds.
type HostPoint struct {
	At          int64   `json:"at"`
	CPUPercent  float64 `json:"cpu_percent"`
	MemoryUsed  uint64  `json:"memory_used"`
	MemoryTotal uint64  `json:"memory_total"`
	DiskUsed    uint64  `json:"disk_used"`
	DiskTotal   uint64  `json:"disk_total"`
}

// ContainerPoint is one bucket of container usage. The byte counters are
// cumulative since container start; the panel turns them into rates.
type ContainerPoint struct {
	At          int64   `json:"at"`
	CPUPercent  float64 `json:"cpu_percent"`
	MemoryUsage uint64  `json:"memory_usage"`
	MemoryLimit uint64  `json:"memory_limit"`
	NetworkRX   uint64  `json:"network_rx"`
	NetworkTX   uint64  `json:"network_tx"`
	BlockRead   uint64  `json:"block_read"`
	BlockWrite  uint64  `json:"block_write"`
}

// ContainerSample is one container reading handed to RecordContainerMetrics.
type ContainerSample struct {
	ContainerID string
	ServiceID   string
	CPUPercent  float64
	MemoryUsage uint64
	MemoryLimit uint64
	NetworkRX   uint64
	NetworkTX   uint64
	BlockRead   uint64
	BlockWrite  uint64
}

// RecordHostMetric appends one host reading.
func (db *DB) RecordHostMetric(ctx context.Context, at time.Time, p HostPoint) error {
	_, err := db.ExecContext(ctx,
		`INSERT INTO host_metrics (at, cpu_percent, memory_used, memory_total, disk_used, disk_total)
		 VALUES (?, ?, ?, ?, ?, ?)`,
		at.Unix(), p.CPUPercent, p.MemoryUsed, p.MemoryTotal, p.DiskUsed, p.DiskTotal)
	return err
}

// RecordContainerMetrics appends one reading per container in a single
// transaction, so a tick either lands whole or not at all.
func (db *DB) RecordContainerMetrics(ctx context.Context, at time.Time, samples []ContainerSample) error {
	if len(samples) == 0 {
		return nil
	}
	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()

	stmt, err := tx.PrepareContext(ctx,
		`INSERT INTO container_metrics (at, container_id, service_id, cpu_percent, memory_usage,
		 memory_limit, network_rx, network_tx, block_read, block_write)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
	if err != nil {
		return err
	}
	defer stmt.Close()

	for _, s := range samples {
		if _, err := stmt.ExecContext(ctx, at.Unix(), s.ContainerID, s.ServiceID, s.CPUPercent,
			s.MemoryUsage, s.MemoryLimit, s.NetworkRX, s.NetworkTX, s.BlockRead, s.BlockWrite); err != nil {
			return err
		}
	}
	return tx.Commit()
}

// HostMetrics returns host usage since `since`, averaged into buckets of
// `bucket` seconds so a long window still yields a chart-sized series.
func (db *DB) HostMetrics(ctx context.Context, since time.Time, bucket int64) ([]HostPoint, error) {
	bucket = clampBucket(bucket)
	rows, err := db.QueryContext(ctx,
		`SELECT (at / ?) * ? AS b, AVG(cpu_percent), AVG(memory_used), MAX(memory_total),
		        AVG(disk_used), MAX(disk_total)
		 FROM host_metrics WHERE at >= ? GROUP BY b ORDER BY b`,
		bucket, bucket, since.Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []HostPoint{}
	for rows.Next() {
		var p HostPoint
		var memoryUsed, diskUsed float64
		if err := rows.Scan(&p.At, &p.CPUPercent, &memoryUsed, &p.MemoryTotal, &diskUsed,
			&p.DiskTotal); err != nil {
			return nil, err
		}
		p.MemoryUsed = uint64(memoryUsed)
		p.DiskUsed = uint64(diskUsed)
		out = append(out, p)
	}
	return out, rows.Err()
}

// ServiceMetrics returns one service's usage since `since`, bucketed like
// HostMetrics. Cumulative counters take the bucket maximum rather than its
// average, so consecutive buckets still differ by the bytes moved between them.
func (db *DB) ServiceMetrics(ctx context.Context, serviceID string, since time.Time,
	bucket int64) ([]ContainerPoint, error) {
	bucket = clampBucket(bucket)
	rows, err := db.QueryContext(ctx,
		`SELECT (at / ?) * ? AS b, AVG(cpu_percent), AVG(memory_usage), MAX(memory_limit),
		        MAX(network_rx), MAX(network_tx), MAX(block_read), MAX(block_write)
		 FROM container_metrics WHERE service_id = ? AND at >= ? GROUP BY b ORDER BY b`,
		bucket, bucket, serviceID, since.Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	out := []ContainerPoint{}
	for rows.Next() {
		var p ContainerPoint
		var memoryUsage float64
		if err := rows.Scan(&p.At, &p.CPUPercent, &memoryUsage, &p.MemoryLimit, &p.NetworkRX,
			&p.NetworkTX, &p.BlockRead, &p.BlockWrite); err != nil {
			return nil, err
		}
		p.MemoryUsage = uint64(memoryUsage)
		out = append(out, p)
	}
	return out, rows.Err()
}

// PruneMetrics drops readings older than `before`, keeping both tables bounded.
func (db *DB) PruneMetrics(ctx context.Context, before time.Time) error {
	cutoff := before.Unix()
	if _, err := db.ExecContext(ctx, `DELETE FROM host_metrics WHERE at < ?`, cutoff); err != nil {
		return err
	}
	_, err := db.ExecContext(ctx, `DELETE FROM container_metrics WHERE at < ?`, cutoff)
	return err
}

func clampBucket(bucket int64) int64 {
	if bucket < 1 {
		return 1
	}
	return bucket
}
