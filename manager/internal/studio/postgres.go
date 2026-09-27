package studio

import (
	"context"
	"net"
	"net/url"
	"strconv"

	"github.com/jackc/pgx/v5/pgconn"

	"github.com/vexdock/platform/manager/internal/engines"
)

const boolOID = 16

// pgRunner talks to Postgres below pgx's type system: parameters go up as
// text and every result comes back in the text format, whatever the type.
type pgRunner struct{ conn *pgconn.PgConn }

func openPostgres(ctx context.Context, c engines.Connection) (Conn, error) {
	dsn := url.URL{
		Scheme:   "postgres",
		User:     url.UserPassword(c.User, c.Password),
		Host:     net.JoinHostPort(c.Host, strconv.Itoa(c.Port)),
		Path:     "/" + c.Database,
		RawQuery: "sslmode=disable",
	}
	conn, err := pgconn.Connect(ctx, dsn.String())
	if err != nil {
		return nil, err
	}
	return &sqlConn{dialect: postgres, run: pgRunner{conn}}, nil
}

func (r pgRunner) close() error { return r.conn.Close(context.Background()) }

// query sends a statement with arguments over the extended protocol, and one
// without over the simple protocol so a console script may hold several; the
// last result wins.
func (r pgRunner) query(ctx context.Context, sql string, args []any, maxRows int) (resultSet, error) {
	if len(args) > 0 {
		return readResult(r.conn.ExecParams(ctx, sql, textParams(args), nil, nil, nil), maxRows)
	}
	results := r.conn.Exec(ctx, sql)
	var set resultSet
	for results.NextResult() {
		next, err := readResult(results.ResultReader(), maxRows)
		if err != nil {
			results.Close()
			return resultSet{}, err
		}
		set = next
	}
	return set, results.Close()
}

func (r pgRunner) transact(ctx context.Context, stmts []statement) (int64, error) {
	if _, err := r.conn.Exec(ctx, "begin").ReadAll(); err != nil {
		return 0, err
	}
	var affected int64
	for _, stmt := range stmts {
		tag, err := r.conn.ExecParams(ctx, stmt.sql, textParams(stmt.args), nil, nil, nil).Close()
		if err != nil {
			_, _ = r.conn.Exec(ctx, "rollback").ReadAll()
			return 0, err
		}
		affected += tag.RowsAffected()
	}
	_, err := r.conn.Exec(ctx, "commit").ReadAll()
	return affected, err
}

func textParams(args []any) [][]byte {
	params := make([][]byte, len(args))
	for i, arg := range args {
		if s, ok := arg.(string); ok {
			params[i] = []byte(s)
		}
	}
	return params
}

func readResult(rr *pgconn.ResultReader, maxRows int) (resultSet, error) {
	fields := rr.FieldDescriptions()
	set := resultSet{columns: make([]string, len(fields)), rows: [][]*string{}}
	for i, f := range fields {
		set.columns[i] = f.Name
	}
	for rr.NextRow() {
		if len(set.rows) == maxRows {
			set.truncated = true
			break
		}
		values := rr.Values()
		row := make([]*string, len(values))
		for i, v := range values {
			if v == nil {
				continue
			}
			s := string(v)
			if fields[i].DataTypeOID == boolOID {
				s = strconv.FormatBool(s == "t")
			}
			row[i] = &s
		}
		set.rows = append(set.rows, row)
	}
	tag, err := rr.Close()
	set.affected = tag.RowsAffected()
	return set, err
}
