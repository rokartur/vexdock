package studio

import (
	"context"
	"database/sql"
	"net"
	"strconv"

	mysqldriver "github.com/go-sql-driver/mysql"

	"github.com/vexdock/platform/manager/internal/engines"
)

// mysqlRunner holds one connection, so a console statement and the
// row_count() that reports it run in the same session.
type mysqlRunner struct {
	db   *sql.DB
	conn *sql.Conn
}

func openMySQL(ctx context.Context, c engines.Connection) (Conn, error) {
	cfg := mysqldriver.NewConfig()
	cfg.Net = "tcp"
	cfg.Addr = net.JoinHostPort(c.Host, strconv.Itoa(c.Port))
	cfg.User = c.User
	cfg.Passwd = c.Password
	cfg.DBName = c.Database
	// Client-side interpolation keeps every statement on the text protocol, so
	// dates and decimals arrive as the server prints them.
	cfg.InterpolateParams = true
	connector, err := mysqldriver.NewConnector(cfg)
	if err != nil {
		return nil, err
	}
	db := sql.OpenDB(connector)
	conn, err := db.Conn(ctx)
	if err != nil {
		db.Close()
		return nil, err
	}
	return &sqlConn{dialect: mysql, run: mysqlRunner{db: db, conn: conn}}, nil
}

func (r mysqlRunner) close() error {
	r.conn.Close()
	return r.db.Close()
}

func (r mysqlRunner) query(ctx context.Context, query string, args []any, maxRows int) (resultSet, error) {
	rows, err := r.conn.QueryContext(ctx, query, args...)
	if err != nil {
		return resultSet{}, err
	}
	set, err := scanRows(rows, maxRows)
	if err != nil || len(set.columns) > 0 {
		return set, err
	}
	err = r.conn.QueryRowContext(ctx, "select row_count()").Scan(&set.affected)
	return set, err
}

func (r mysqlRunner) transact(ctx context.Context, stmts []statement) (int64, error) {
	tx, err := r.conn.BeginTx(ctx, nil)
	if err != nil {
		return 0, err
	}
	defer tx.Rollback()
	var affected int64
	for _, stmt := range stmts {
		res, err := tx.ExecContext(ctx, stmt.sql, stmt.args...)
		if err != nil {
			return 0, err
		}
		n, err := res.RowsAffected()
		if err != nil {
			return 0, err
		}
		affected += n
	}
	return affected, tx.Commit()
}

func scanRows(rows *sql.Rows, maxRows int) (resultSet, error) {
	defer rows.Close()
	columns, err := rows.Columns()
	if err != nil {
		return resultSet{}, err
	}
	set := resultSet{columns: columns, rows: [][]*string{}}
	values := make([]sql.NullString, len(columns))
	targets := make([]any, len(columns))
	for i := range values {
		targets[i] = &values[i]
	}
	for rows.Next() {
		if len(set.rows) == maxRows {
			set.truncated = true
			break
		}
		if err := rows.Scan(targets...); err != nil {
			return resultSet{}, err
		}
		row := make([]*string, len(columns))
		for i, v := range values {
			if v.Valid {
				s := v.String
				row[i] = &s
			}
		}
		set.rows = append(set.rows, row)
	}
	return set, rows.Err()
}
