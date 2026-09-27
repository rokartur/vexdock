package studio

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"

	"github.com/vexdock/platform/manager/internal/engines"
)

// hranaRunner speaks sqld's Hrana-over-HTTP: every call is one pipeline that
// opens a stream, runs, and closes it, so nothing stays open between requests.
// ponytail: default namespace only; a namespaced sqld picks one from the Host header.
type hranaRunner struct {
	url            string
	user, password string
}

func openLibSQL(c engines.Connection) Conn {
	return &sqlConn{dialect: sqlite, run: hranaRunner{
		url:      "http://" + net.JoinHostPort(c.Host, strconv.Itoa(c.Port)) + "/v2/pipeline",
		user:     c.User,
		password: c.Password,
	}}
}

func (hranaRunner) close() error { return nil }

type hranaStmt struct {
	SQL      string       `json:"sql"`
	Args     []hranaValue `json:"args,omitempty"`
	WantRows bool         `json:"want_rows"`
}

type hranaValue struct {
	Type   string          `json:"type"`
	Value  json.RawMessage `json:"value,omitempty"`
	Base64 string          `json:"base64,omitempty"`
}

type hranaError struct {
	Message string `json:"message"`
}

type hranaStmtResult struct {
	Cols []struct {
		Name string `json:"name"`
	} `json:"cols"`
	Rows             [][]hranaValue `json:"rows"`
	AffectedRowCount int64          `json:"affected_row_count"`
}

func (r hranaRunner) query(ctx context.Context, sql string, args []any, maxRows int) (resultSet, error) {
	var result hranaStmtResult
	stmt := hranaStmt{SQL: sql, Args: hranaArgs(args), WantRows: true}
	if err := r.pipeline(ctx, map[string]any{"type": "execute", "stmt": stmt}, &result); err != nil {
		return resultSet{}, err
	}
	set := resultSet{rows: [][]*string{}, affected: result.AffectedRowCount}
	for _, col := range result.Cols {
		set.columns = append(set.columns, col.Name)
	}
	for _, row := range result.Rows {
		if len(set.rows) == maxRows {
			set.truncated = true
			break
		}
		cells := make([]*string, len(row))
		for i, v := range row {
			cell, err := v.text()
			if err != nil {
				return resultSet{}, err
			}
			cells[i] = cell
		}
		set.rows = append(set.rows, cells)
	}
	return set, nil
}

// transact runs a batch in which every step waits for the one before it to
// succeed; if any fails, commit is skipped and rollback runs instead.
func (r hranaRunner) transact(ctx context.Context, stmts []statement) (int64, error) {
	steps := []map[string]any{{"stmt": hranaStmt{SQL: "begin"}}}
	for _, stmt := range stmts {
		steps = append(steps, map[string]any{
			"stmt":      hranaStmt{SQL: stmt.sql, Args: hranaArgs(stmt.args)},
			"condition": map[string]any{"type": "ok", "step": len(steps) - 1},
		})
	}
	commit := len(steps)
	steps = append(steps,
		map[string]any{"stmt": hranaStmt{SQL: "commit"}, "condition": map[string]any{"type": "ok", "step": commit - 1}},
		map[string]any{"stmt": hranaStmt{SQL: "rollback"}, "condition": map[string]any{
			"type": "not", "cond": map[string]any{"type": "ok", "step": commit},
		}},
	)
	var result struct {
		StepResults []*hranaStmtResult `json:"step_results"`
		StepErrors  []*hranaError      `json:"step_errors"`
	}
	if err := r.pipeline(ctx, map[string]any{"type": "batch", "batch": map[string]any{"steps": steps}}, &result); err != nil {
		return 0, err
	}
	for _, stepErr := range result.StepErrors {
		if stepErr != nil {
			return 0, errors.New(stepErr.Message)
		}
	}
	var affected int64
	for _, step := range result.StepResults[1:commit] {
		affected += step.AffectedRowCount
	}
	return affected, nil
}

// pipeline sends one request followed by a close and decodes that request's result.
func (r hranaRunner) pipeline(ctx context.Context, request map[string]any, result any) error {
	body, err := json.Marshal(map[string]any{"baton": nil, "requests": []any{request, map[string]string{"type": "close"}}})
	if err != nil {
		return err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, r.url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	if r.password != "" {
		req.SetBasicAuth(r.user, r.password)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		message, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return fmt.Errorf("sqld answered %s: %s", resp.Status, bytes.TrimSpace(message))
	}
	var res struct {
		Results []struct {
			Type     string      `json:"type"`
			Error    *hranaError `json:"error"`
			Response struct {
				Result json.RawMessage `json:"result"`
			} `json:"response"`
		} `json:"results"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&res); err != nil {
		return err
	}
	if len(res.Results) == 0 {
		return errors.New("sqld sent no result")
	}
	if first := res.Results[0]; first.Type == "error" {
		return errors.New(first.Error.Message)
	}
	return json.Unmarshal(res.Results[0].Response.Result, result)
}

func hranaArgs(args []any) []hranaValue {
	values := make([]hranaValue, len(args))
	for i, arg := range args {
		s, ok := arg.(string)
		if !ok {
			values[i] = hranaValue{Type: "null"}
			continue
		}
		quoted, _ := json.Marshal(s) // a string always marshals
		values[i] = hranaValue{Type: "text", Value: quoted}
	}
	return values
}

// text renders a Hrana value the way the grid shows it: blobs as hex, since
// SQLite lets any column hold one whatever its declared type.
func (v hranaValue) text() (*string, error) {
	var s string
	switch v.Type {
	case "null":
		return nil, nil
	case "float":
		s = string(v.Value)
	case "blob":
		b, err := base64.RawStdEncoding.DecodeString(strings.TrimRight(v.Base64, "="))
		if err != nil {
			return nil, err
		}
		s = `\x` + hex.EncodeToString(b)
	default:
		if err := json.Unmarshal(v.Value, &s); err != nil {
			return nil, err
		}
	}
	return &s, nil
}
