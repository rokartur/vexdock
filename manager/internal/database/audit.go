package database

import "context"

// AuditEntry is one recorded state-changing request.
type AuditEntry struct {
	ID         string `json:"id"`
	At         string `json:"at"`
	Actor      string `json:"actor"`
	Method     string `json:"method"`
	Path       string `json:"path"`
	Status     int    `json:"status"`
	ClientIP   string `json:"client_ip"`
	Credential string `json:"credential"`
}

// RecordAudit appends an entry. Failures are the caller's to log: an audit
// write must never break the request it describes.
func (db *DB) RecordAudit(ctx context.Context, e AuditEntry) error {
	_, err := db.ExecContext(ctx,
		`INSERT INTO audit_log (id, at, actor, method, path, status, client_ip, credential)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
		NewID(), Now(), e.Actor, e.Method, e.Path, e.Status, e.ClientIP, e.Credential)
	return err
}

// ListAudit returns the newest entries first.
func (db *DB) ListAudit(ctx context.Context, limit int) ([]AuditEntry, error) {
	if limit <= 0 || limit > 500 {
		limit = 100
	}
	rows, err := db.QueryContext(ctx,
		`SELECT id, at, actor, method, path, status, client_ip, credential
		 FROM audit_log ORDER BY at DESC LIMIT ?`, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []AuditEntry{}
	for rows.Next() {
		var e AuditEntry
		if err := rows.Scan(&e.ID, &e.At, &e.Actor, &e.Method, &e.Path, &e.Status,
			&e.ClientIP, &e.Credential); err != nil {
			return nil, err
		}
		out = append(out, e)
	}
	return out, rows.Err()
}

// PruneAudit keeps the newest n entries so the table cannot grow without bound.
func (db *DB) PruneAudit(ctx context.Context, keep int) error {
	_, err := db.ExecContext(ctx,
		`DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY at DESC LIMIT ?)`, keep)
	return err
}
