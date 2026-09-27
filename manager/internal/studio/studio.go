// Package studio reads and edits the data inside a database service. Every
// engine is reached over the network with the service's own credentials, and
// every cell crosses the API as text or null so the grid never guesses a type.
package studio

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/vexdock/platform/manager/internal/engines"
)

// ErrUnsupported marks an engine Studio cannot open. Every other error is the
// database's or the request's fault and its message is meant for the user.
var ErrUnsupported = errors.New("studio does not support this engine")

const (
	MaxPageSize    = 500
	MaxResultRows  = 1000
	defaultPageLen = 50
)

type Conn interface {
	Schema(ctx context.Context) ([]Namespace, error)
	Rows(ctx context.Context, q RowsQuery) (Rows, error)
	Apply(ctx context.Context, c Changes) (int64, error)
	Query(ctx context.Context, namespace, query string) (Result, error)
	Close() error
}

// Namespace is a Postgres schema, a MySQL or MongoDB database, SQLite's main
// or a Valkey logical database.
type Namespace struct {
	Name   string  `json:"name"`
	Tables []Table `json:"tables"`
}

type Table struct {
	Name string `json:"name"`
	// View is true for anything that cannot be written: a view, a materialized view.
	View    bool     `json:"view"`
	Columns []Column `json:"columns"`
}

type Column struct {
	Name       string `json:"name"`
	Type       string `json:"type"`
	Nullable   bool   `json:"nullable"`
	PrimaryKey bool   `json:"primary_key"`
	// ReadOnly columns show a lossy text form: binary data, generated values.
	ReadOnly bool `json:"read_only"`
}

type Filter struct {
	Column string `json:"column"`
	Op     string `json:"op"`
	Value  string `json:"value"`
}

var filterOps = []string{"eq", "neq", "gt", "gte", "lt", "lte", "contains", "starts_with", "is_null", "is_not_null"}

type RowsQuery struct {
	Namespace string
	Table     string
	Limit     int
	Offset    int
	Sort      string
	Desc      bool
	Filters   []Filter
}

type Rows struct {
	Columns []Column `json:"columns"`
	// Key names the columns that identify a row; empty means the table is read-only.
	Key       []string `json:"key"`
	Rows      [][]any  `json:"rows"`
	Total     int64    `json:"total"`
	Truncated bool     `json:"truncated"`
}

type Changes struct {
	Namespace string   `json:"schema"`
	Table     string   `json:"table"`
	Updates   []Update `json:"updates"`
	Inserts   []Values `json:"inserts"`
	Deletes   []Delete `json:"deletes"`
}

// Values maps a column to its new text, nil for NULL.
type Values map[string]*string

type Update struct {
	Key    map[string]string `json:"key"`
	Values Values            `json:"values"`
}

type Delete struct {
	Key map[string]string `json:"key"`
}

type Result struct {
	Columns    []string `json:"columns"`
	Rows       [][]any  `json:"rows"`
	Affected   int64    `json:"affected"`
	DurationMS int64    `json:"duration_ms"`
	Truncated  bool     `json:"truncated"`
}

// Open connects to a database service; conn.Host must be an address the
// manager can dial, not the compose alias.
func Open(ctx context.Context, conn engines.Connection) (Conn, error) {
	switch conn.Engine {
	case "postgres":
		return openPostgres(ctx, conn)
	case "mysql", "mariadb":
		return openMySQL(ctx, conn)
	case engines.LibSQL:
		return openLibSQL(conn), nil
	case "mongodb":
		return openMongo(ctx, conn)
	case "valkey":
		return openValkey(ctx, conn)
	}
	return nil, ErrUnsupported
}

// Normalize clamps paging and rejects filters the engines do not know.
func (q RowsQuery) Normalize() (RowsQuery, error) {
	if q.Limit <= 0 {
		q.Limit = defaultPageLen
	}
	q.Limit = min(q.Limit, MaxPageSize)
	if q.Offset < 0 {
		return q, errors.New("offset must not be negative")
	}
	for _, f := range q.Filters {
		if !slices.Contains(filterOps, f.Op) {
			return q, fmt.Errorf("unknown filter operator %q", f.Op)
		}
	}
	return q, nil
}

// findColumn fails on a name that is not a column of the table, before it reaches a query.
func findColumn(columns []Column, name string) (Column, error) {
	for _, col := range columns {
		if col.Name == name {
			return col, nil
		}
	}
	return Column{}, fmt.Errorf("unknown column %q", name)
}

var errReadOnly = errors.New("the table is read-only: it is a view or has no primary key")

// requireKey insists on the whole key, so a write can never match more than one row.
func requireKey(key []string, got map[string]string) error {
	if len(key) == 0 {
		return errReadOnly
	}
	if len(got) != len(key) {
		return fmt.Errorf("a row is identified by %v", key)
	}
	for _, name := range key {
		if _, ok := got[name]; !ok {
			return fmt.Errorf("a row is identified by %v", key)
		}
	}
	return nil
}
