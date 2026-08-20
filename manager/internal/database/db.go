// Package database owns the SQLite connection, schema migrations and every
// query in the management plane. Business logic packages depend on it; it
// depends on nothing but the driver, which keeps the import graph acyclic.
package database

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"io/fs"
	"sort"
	"strings"
	"time"

	"github.com/vexdock/platform/manager/migrations"
	_ "modernc.org/sqlite"
)

type DB struct {
	*sql.DB
}

// Open connects to SQLite with the pragmas recommended for an embedded
// management database and applies pending migrations.
func Open(path string) (*DB, error) {
	dsn := fmt.Sprintf("file:%s?_pragma=journal_mode(WAL)&_pragma=foreign_keys(ON)&_pragma=busy_timeout(5000)&_pragma=synchronous(NORMAL)", path)
	sqlDB, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	// SQLite handles one writer; a single connection removes lock contention
	// entirely and is plenty for a single-node management plane.
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetConnMaxLifetime(0)

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := sqlDB.PingContext(ctx); err != nil {
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}

	db := &DB{sqlDB}
	if err := db.migrate(ctx); err != nil {
		return nil, err
	}
	return db, nil
}

func (db *DB) migrate(ctx context.Context) error {
	if _, err := db.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_migrations (
		version TEXT PRIMARY KEY,
		applied_at TEXT NOT NULL
	)`); err != nil {
		return fmt.Errorf("create schema_migrations: %w", err)
	}

	entries, err := fs.ReadDir(migrations.FS, ".")
	if err != nil {
		return fmt.Errorf("read migrations: %w", err)
	}
	names := make([]string, 0, len(entries))
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".sql") {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)

	for _, name := range names {
		var applied int
		if err := db.QueryRowContext(ctx, `SELECT COUNT(*) FROM schema_migrations WHERE version = ?`, name).Scan(&applied); err != nil {
			return err
		}
		if applied > 0 {
			continue
		}
		body, err := migrations.FS.ReadFile(name)
		if err != nil {
			return err
		}
		if err := db.apply(ctx, name, string(body)); err != nil {
			return err
		}
	}
	return nil
}

// rebuildMarker opts a migration out of foreign key enforcement while it runs.
//
// SQLite cannot drop a table level constraint, so a migration that changes one
// has to rebuild the table: copy the rows into a new table, drop the old one,
// rename. With foreign keys enforced that DROP performs an implicit DELETE, so
// every ON DELETE CASCADE child row goes with it and the rebuild silently
// deletes the data it exists to preserve. Turning the pragma off is the
// documented remedy, and it only works outside a transaction, which is why the
// runner has to know before it opens one.
const rebuildMarker = "-- vexdock:rebuild"

func (db *DB) apply(ctx context.Context, name, body string) error {
	rebuild := strings.HasPrefix(body, rebuildMarker)
	if rebuild {
		// One connection serves the whole pool, so this reaches the migration.
		if _, err := db.ExecContext(ctx, `PRAGMA foreign_keys = OFF`); err != nil {
			return fmt.Errorf("disable foreign keys for %s: %w", name, err)
		}
		defer func() { _, _ = db.ExecContext(ctx, `PRAGMA foreign_keys = ON`) }()
	}

	tx, err := db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, body); err != nil {
		_ = tx.Rollback()
		return fmt.Errorf("apply migration %s: %w", name, err)
	}
	if rebuild {
		// Enforcement was off, so the rows it would have rejected are still
		// here. Find them while a rollback can still undo the damage.
		if err := danglingReferences(ctx, tx); err != nil {
			_ = tx.Rollback()
			return fmt.Errorf("apply migration %s: %w", name, err)
		}
	}
	if _, err := tx.ExecContext(ctx, `INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)`, name, Now()); err != nil {
		_ = tx.Rollback()
		return err
	}
	return tx.Commit()
}

func danglingReferences(ctx context.Context, tx *sql.Tx) error {
	rows, err := tx.QueryContext(ctx, `PRAGMA foreign_key_check`)
	if err != nil {
		return fmt.Errorf("foreign key check: %w", err)
	}
	defer rows.Close()

	broken := []string{}
	for rows.Next() {
		var child, parent string
		var rowid sql.NullInt64
		var constraint int
		if err := rows.Scan(&child, &rowid, &parent, &constraint); err != nil {
			return fmt.Errorf("foreign key check: %w", err)
		}
		broken = append(broken, child+" -> "+parent)
	}
	if err := rows.Err(); err != nil {
		return fmt.Errorf("foreign key check: %w", err)
	}
	if len(broken) > 0 {
		return fmt.Errorf("left %d dangling reference(s): %s", len(broken), strings.Join(unique(broken), ", "))
	}
	return nil
}

func unique(in []string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, s := range in {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

// ErrNotFound is returned by every lookup helper when no row matches.
var ErrNotFound = errors.New("not found")

// Now is the single timestamp format used across every table (RFC3339 UTC),
// which keeps string comparison in SQL chronologically correct.
func Now() string { return time.Now().UTC().Format(time.RFC3339Nano) }

// ParseTime reads a stored timestamp; the zero time means "unset".
func ParseTime(s string) time.Time {
	if s == "" {
		return time.Time{}
	}
	t, err := time.Parse(time.RFC3339Nano, s)
	if err != nil {
		return time.Time{}
	}
	return t
}
