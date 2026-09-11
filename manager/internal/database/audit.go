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

// PruneAudit keeps the newest n entries so the table cannot grow without bound.
func (db *DB) PruneAudit(ctx context.Context, keep int) error {
	_, err := db.ExecContext(ctx,
		`DELETE FROM audit_log WHERE id NOT IN (SELECT id FROM audit_log ORDER BY at DESC LIMIT ?)`, keep)
	return err
}
