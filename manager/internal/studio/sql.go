package studio

import (
	"context"
	"encoding/hex"
	"fmt"
	"maps"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"
)

type dialect int

const (
	postgres dialect = iota
	mysql
	sqlite
)

// runner is the one thing that differs between the SQL engines: how a
// statement reaches the database. Every value it returns is text or nil.
type runner interface {
	query(ctx context.Context, sql string, args []any, maxRows int) (resultSet, error)
	// transact runs every statement in one transaction and sums the rows they touched.
	transact(ctx context.Context, stmts []statement) (int64, error)
	close() error
}

type resultSet struct {
	columns   []string
	rows      [][]*string
	affected  int64
	truncated bool
}

type statement struct {
	sql  string
	args []any
}

type sqlConn struct {
	dialect dialect
	run     runner
}

// Each introspection query returns, per column: namespace, table, view,
// column, type, nullable, primary key, read-only; flags are 1 or 0. The
// arguments narrow it to one table and are empty for all of them.
var introspection = map[dialect]string{
	postgres: `select n.nspname, c.relname, (c.relkind in ('v', 'm'))::int, a.attname,
		format_type(a.atttypid, a.atttypmod), (not a.attnotnull)::int,
		coalesce(a.attnum = any(i.indkey), false)::int, (a.attgenerated <> '')::int
	from pg_class c
	join pg_namespace n on n.oid = c.relnamespace
	join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
	left join pg_index i on i.indrelid = c.oid and i.indisprimary
	where c.relkind in ('r', 'p', 'v', 'm', 'f') and n.nspname <> 'information_schema' and n.nspname not like 'pg!_%' escape '!'
		and ($1::text = '' or (n.nspname = $1::text and c.relname = $2::text))
	order by 1, 2, a.attnum`,
	mysql: `select c.table_schema, c.table_name, t.table_type <> 'BASE TABLE', c.column_name,
		c.column_type, c.is_nullable = 'YES', c.column_key = 'PRI',
		coalesce(c.generation_expression, '') <> '' or c.data_type like '%blob' or c.data_type in ('binary', 'varbinary', 'bit')
	from information_schema.columns c
	join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
	where c.table_schema = database() and (? = '' or (c.table_schema = ? and c.table_name = ?))
	order by c.table_name, c.ordinal_position`,
	sqlite: `select 'main', m.name, m.type = 'view', p.name, p.type, p."notnull" = 0, p.pk > 0,
		p.hidden <> 0 or upper(p.type) like '%BLOB%'
	from sqlite_schema m join pragma_table_xinfo(m.name) p
	where m.type in ('table', 'view') and m.name not like 'sqlite!_%' escape '!'
		and (? = '' or ('main' = ? and m.name = ?))
	order by m.name, p.cid`,
}

// namespaceList names the namespaces that exist even with no table in them.
var namespaceList = map[dialect]string{
	postgres: `select nspname from pg_namespace where nspname <> 'information_schema' and nspname not like 'pg!_%' escape '!' order by 1`,
	mysql:    `select database()`,
	sqlite:   `select 'main'`,
}

func (c *sqlConn) Close() error { return c.run.close() }

func (c *sqlConn) Schema(ctx context.Context) ([]Namespace, error) {
	names, err := c.run.query(ctx, namespaceList[c.dialect], nil, 10_000)
	if err != nil {
		return nil, err
	}
	tables, err := c.introspect(ctx, "", "")
	if err != nil {
		return nil, err
	}
	namespaces := make([]Namespace, 0, len(names.rows))
	for _, row := range names.rows {
		ns := Namespace{Name: text(row[0]), Tables: []Table{}}
		for _, t := range tables {
			if t.namespace == ns.Name {
				ns.Tables = append(ns.Tables, t.Table)
			}
		}
		namespaces = append(namespaces, ns)
	}
	return namespaces, nil
}

type namespacedTable struct {
	namespace string
	Table
}

// introspect reads every table, or just the one named, with its columns.
func (c *sqlConn) introspect(ctx context.Context, namespace, table string) ([]namespacedTable, error) {
	args := []any{namespace, namespace, table}
	if c.dialect == postgres {
		args = []any{namespace, table}
	}
	set, err := c.run.query(ctx, introspection[c.dialect], args, 1_000_000)
	if err != nil {
		return nil, err
	}
	var tables []namespacedTable
	for _, row := range set.rows {
		ns, name := text(row[0]), text(row[1])
		if len(tables) == 0 || tables[len(tables)-1].namespace != ns || tables[len(tables)-1].Name != name {
			tables = append(tables, namespacedTable{namespace: ns, Table: Table{Name: name, View: flag(row[2])}})
		}
		last := &tables[len(tables)-1]
		last.Columns = append(last.Columns, Column{
			Name:       text(row[3]),
			Type:       text(row[4]),
			Nullable:   flag(row[5]),
			PrimaryKey: flag(row[6]),
			ReadOnly:   flag(row[7]),
		})
	}
	return tables, nil
}

func (c *sqlConn) table(ctx context.Context, namespace, name string) (Table, error) {
	tables, err := c.introspect(ctx, namespace, name)
	if err != nil {
		return Table{}, err
	}
	if len(tables) == 0 {
		return Table{}, fmt.Errorf("no table %s.%s", namespace, name)
	}
	return tables[0].Table, nil
}

func (c *sqlConn) Rows(ctx context.Context, q RowsQuery) (Rows, error) {
	table, err := c.table(ctx, q.Namespace, q.Table)
	if err != nil {
		return Rows{}, err
	}
	b := sqlBuilder{dialect: c.dialect}
	where, err := b.where(table.Columns, q.Filters)
	if err != nil {
		return Rows{}, err
	}
	from := " from " + b.ref(q.Namespace, q.Table) + where

	// ponytail: exact count(*), slow on huge tables; pg reltuples estimate if it hurts.
	count, err := c.run.query(ctx, "select count(*)"+from, b.args, 1)
	if err != nil {
		return Rows{}, err
	}
	total, err := strconv.ParseInt(text(count.rows[0][0]), 10, 64)
	if err != nil {
		return Rows{}, err
	}

	key := keyOf(table)
	order, desc := key, false
	if q.Sort != "" {
		if _, err := findColumn(table.Columns, q.Sort); err != nil {
			return Rows{}, err
		}
		order, desc = []string{q.Sort}, q.Desc
	}
	names := make([]string, len(table.Columns))
	for i, col := range table.Columns {
		names[i] = b.quote(col.Name)
	}
	sql := "select " + strings.Join(names, ", ") + from + b.orderBy(order, desc) +
		fmt.Sprintf(" limit %d offset %d", q.Limit, q.Offset)
	set, err := c.run.query(ctx, sql, b.args, q.Limit)
	if err != nil {
		return Rows{}, err
	}
	return Rows{Columns: table.Columns, Key: key, Rows: cells(set.rows), Total: total}, nil
}

func (c *sqlConn) Apply(ctx context.Context, changes Changes) (int64, error) {
	table, err := c.table(ctx, changes.Namespace, changes.Table)
	if err != nil {
		return 0, err
	}
	stmts, err := statements(c.dialect, table, changes)
	if err != nil {
		return 0, err
	}
	return c.run.transact(ctx, stmts)
}

func (c *sqlConn) Query(ctx context.Context, namespace, query string) (Result, error) {
	if c.dialect == postgres && namespace != "" {
		search := sqlBuilder{dialect: postgres}.quote(namespace)
		if _, err := c.run.query(ctx, "select set_config('search_path', $1::text, false)", []any{search}, 1); err != nil {
			return Result{}, err
		}
	}
	set, err := c.run.query(ctx, query, nil, MaxResultRows)
	if err != nil {
		return Result{}, err
	}
	return Result{Columns: set.columns, Rows: cells(set.rows), Affected: set.affected, Truncated: set.truncated}, nil
}

// statements turns the grid's edits into SQL, refusing anything that could
// touch a row the user did not pick or a column they cannot write.
func statements(d dialect, table Table, changes Changes) ([]statement, error) {
	key := keyOf(table)
	if len(key) == 0 {
		return nil, errReadOnly
	}
	ref := sqlBuilder{dialect: d}.ref(changes.Namespace, changes.Table)
	var stmts []statement
	for _, u := range changes.Updates {
		if err := requireKey(key, u.Key); err != nil {
			return nil, err
		}
		if len(u.Values) == 0 {
			continue
		}
		b := sqlBuilder{dialect: d}
		var sets []string
		for _, name := range slices.Sorted(maps.Keys(u.Values)) {
			col, err := writableColumn(table.Columns, name)
			if err != nil {
				return nil, err
			}
			sets = append(sets, b.quote(name)+" = "+b.bind(u.Values[name], col.Type))
		}
		where := b.keyWhere(table.Columns, u.Key)
		stmts = append(stmts, statement{sql: "update " + ref + " set " + strings.Join(sets, ", ") + where, args: b.args})
	}
	for _, values := range changes.Inserts {
		b := sqlBuilder{dialect: d}
		sql, err := b.insert(ref, table.Columns, values)
		if err != nil {
			return nil, err
		}
		stmts = append(stmts, statement{sql: sql, args: b.args})
	}
	for _, del := range changes.Deletes {
		if err := requireKey(key, del.Key); err != nil {
			return nil, err
		}
		b := sqlBuilder{dialect: d}
		stmts = append(stmts, statement{sql: "delete from " + ref + b.keyWhere(table.Columns, del.Key), args: b.args})
	}
	return stmts, nil
}

// keyOf is the primary key, or nothing for a view or a table without one.
func keyOf(table Table) []string {
	key := []string{}
	if table.View {
		return key
	}
	for _, col := range table.Columns {
		if col.PrimaryKey {
			key = append(key, col.Name)
		}
	}
	return key
}

func writableColumn(columns []Column, name string) (Column, error) {
	col, err := findColumn(columns, name)
	if err != nil {
		return col, err
	}
	if col.ReadOnly {
		return col, fmt.Errorf("column %q is read-only", name)
	}
	return col, nil
}

// sqlBuilder writes one statement: identifiers are quoted, values always bound.
type sqlBuilder struct {
	dialect dialect
	args    []any
}

func (b sqlBuilder) quote(name string) string {
	if b.dialect == mysql {
		return "`" + strings.ReplaceAll(name, "`", "``") + "`"
	}
	return `"` + strings.ReplaceAll(name, `"`, `""`) + `"`
}

// ref is the table's name in SQL; MySQL and SQLite only ever see one namespace.
func (b sqlBuilder) ref(namespace, table string) string {
	if b.dialect == postgres {
		return b.quote(namespace) + "." + b.quote(table)
	}
	return b.quote(table)
}

// bind adds a parameter. Postgres gets every value as text and casts it to the
// column's type, so the grid's text form of any type round-trips.
func (b *sqlBuilder) bind(value *string, columnType string) string {
	if value == nil {
		b.args = append(b.args, nil)
	} else {
		b.args = append(b.args, *value)
	}
	if b.dialect == postgres {
		return fmt.Sprintf("$%d::text::%s", len(b.args), columnType)
	}
	return "?"
}

var comparisons = map[string]string{"eq": "=", "neq": "<>", "gt": ">", "gte": ">=", "lt": "<", "lte": "<="}

func (b *sqlBuilder) where(columns []Column, filters []Filter) (string, error) {
	var parts []string
	for _, f := range filters {
		col, err := findColumn(columns, f.Column)
		if err != nil {
			return "", err
		}
		name := b.quote(col.Name)
		switch f.Op {
		case "is_null":
			parts = append(parts, name+" is null")
		case "is_not_null":
			parts = append(parts, name+" is not null")
		case "contains", "starts_with":
			pattern := escapeLike(f.Value) + "%"
			if f.Op == "contains" {
				pattern = "%" + pattern
			}
			like := name + " like "
			if b.dialect == postgres {
				like = name + "::text ilike "
			}
			parts = append(parts, like+b.bind(&pattern, "text")+" escape '!'")
		default:
			parts = append(parts, name+" "+comparisons[f.Op]+" "+b.bind(&f.Value, col.Type))
		}
	}
	if len(parts) == 0 {
		return "", nil
	}
	return " where " + strings.Join(parts, " and "), nil
}

func (b *sqlBuilder) keyWhere(columns []Column, key map[string]string) string {
	var parts []string
	for _, name := range slices.Sorted(maps.Keys(key)) {
		value := key[name]
		col, _ := findColumn(columns, name) // requireKey already matched every name to the key
		parts = append(parts, b.quote(name)+" = "+b.bind(&value, col.Type))
	}
	return " where " + strings.Join(parts, " and ")
}

func (b *sqlBuilder) insert(ref string, columns []Column, values Values) (string, error) {
	if len(values) == 0 {
		if b.dialect == mysql {
			return "insert into " + ref + " () values ()", nil
		}
		return "insert into " + ref + " default values", nil
	}
	var names, params []string
	for _, name := range slices.Sorted(maps.Keys(values)) {
		col, err := writableColumn(columns, name)
		if err != nil {
			return "", err
		}
		names = append(names, b.quote(name))
		params = append(params, b.bind(values[name], col.Type))
	}
	return "insert into " + ref + " (" + strings.Join(names, ", ") + ") values (" + strings.Join(params, ", ") + ")", nil
}

func (b sqlBuilder) orderBy(columns []string, desc bool) string {
	if len(columns) == 0 {
		return ""
	}
	direction := " asc"
	if desc {
		direction = " desc"
	}
	parts := make([]string, len(columns))
	for i, name := range columns {
		parts[i] = b.quote(name) + direction
	}
	return " order by " + strings.Join(parts, ", ")
}

// escapeLike makes a user's text match literally under `escape '!'`, the one
// escape clause all three dialects read the same way.
func escapeLike(s string) string {
	return strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(s)
}

func cells(rows [][]*string) [][]any {
	out := make([][]any, len(rows))
	for i, row := range rows {
		out[i] = make([]any, len(row))
		for j, v := range row {
			if v != nil {
				out[i][j] = printable(*v)
			}
		}
	}
	return out
}

// printable keeps a cell intact through JSON: bytes that are not UTF-8 become
// Postgres-style hex.
func printable(s string) string {
	if utf8.ValidString(s) {
		return s
	}
	return `\x` + hex.EncodeToString([]byte(s))
}

func text(v *string) string {
	if v == nil {
		return ""
	}
	return *v
}

func flag(v *string) bool { return v != nil && *v == "1" }
