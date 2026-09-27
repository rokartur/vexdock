package studio

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"maps"
	"net"
	"slices"
	"strconv"
	"strings"
	"unicode"

	"github.com/vexdock/platform/manager/internal/engines"
)

// valkeyConn is a RESP2 client of just the commands Studio sends. The whole
// keyspace of database 0 is one table, a row per key.
type valkeyConn struct {
	conn net.Conn
	r    *bufio.Reader
}

// valkeyError is an error reply; it is a value so a pipeline stays in step.
type valkeyError string

func (e valkeyError) Error() string { return string(e) }

const (
	valkeyNamespace = "db0"
	valkeyTable     = "keys"
	// ponytail: a page is cut from at most this many matching keys, sorted; a cursor-paged view if keyspaces outgrow it.
	maxScannedKeys = 10_000
	previewItems   = 100
)

var valkeyColumns = []Column{
	{Name: "key", Type: "string", PrimaryKey: true},
	{Name: "type", Type: "string", ReadOnly: true},
	{Name: "ttl", Type: "integer", Nullable: true},
	{Name: "value", Type: "string", Nullable: true},
}

var valkeyKey = []string{"key"}

func openValkey(ctx context.Context, c engines.Connection) (Conn, error) {
	var dialer net.Dialer
	conn, err := dialer.DialContext(ctx, "tcp", net.JoinHostPort(c.Host, strconv.Itoa(c.Port)))
	if err != nil {
		return nil, err
	}
	if deadline, ok := ctx.Deadline(); ok {
		_ = conn.SetDeadline(deadline)
	}
	v := &valkeyConn{conn: conn, r: bufio.NewReader(conn)}
	if c.Password != "" {
		if _, err := v.call("AUTH", c.Password); err != nil {
			conn.Close()
			return nil, err
		}
	}
	return v, nil
}

func (v *valkeyConn) Close() error { return v.conn.Close() }

func (v *valkeyConn) Schema(context.Context) ([]Namespace, error) {
	return []Namespace{{Name: valkeyNamespace, Tables: []Table{{Name: valkeyTable, Columns: valkeyColumns}}}}, nil
}

func (v *valkeyConn) Rows(_ context.Context, q RowsQuery) (Rows, error) {
	if q.Namespace != valkeyNamespace || q.Table != valkeyTable {
		return Rows{}, fmt.Errorf("Valkey has one table, %s.%s", valkeyNamespace, valkeyTable)
	}
	if q.Sort != "" && q.Sort != "key" {
		return Rows{}, errors.New("Valkey rows sort by key only")
	}
	pattern, err := keyPattern(q.Filters)
	if err != nil {
		return Rows{}, err
	}
	keys, truncated, err := v.scan(pattern)
	if err != nil {
		return Rows{}, err
	}
	slices.Sort(keys)
	if q.Desc {
		slices.Reverse(keys)
	}
	page := keys[min(q.Offset, len(keys)):min(q.Offset+q.Limit, len(keys))]

	var meta [][]string
	for _, key := range page {
		meta = append(meta, []string{"TYPE", key}, []string{"TTL", key})
	}
	metaReplies, err := v.do(meta...)
	if err != nil {
		return Rows{}, err
	}
	var previews [][]string
	for i, key := range page {
		previews = append(previews, previewCommand(fmt.Sprint(metaReplies[2*i]), key))
	}
	values, err := v.do(previews...)
	if err != nil {
		return Rows{}, err
	}

	rows := make([][]any, len(page))
	for i, key := range page {
		kind := fmt.Sprint(metaReplies[2*i])
		var ttl any
		if seconds, ok := metaReplies[2*i+1].(int64); ok && seconds >= 0 {
			ttl = strconv.FormatInt(seconds, 10)
		}
		value, err := previewText(kind, values[i])
		if err != nil {
			return Rows{}, err
		}
		// ponytail: a key that is not UTF-8 shows as hex and cannot be edited from the grid.
		rows[i] = []any{printable(key), kind, ttl, value}
	}
	return Rows{Columns: valkeyColumns, Key: valkeyKey, Rows: rows, Total: int64(len(keys)), Truncated: truncated}, nil
}

func (v *valkeyConn) scan(pattern string) ([]string, bool, error) {
	seen := map[string]bool{}
	cursor := "0"
	for {
		reply, err := v.call("SCAN", cursor, "MATCH", pattern, "COUNT", "1000")
		if err != nil {
			return nil, false, err
		}
		parts, ok := reply.([]any)
		if !ok || len(parts) != 2 {
			return nil, false, fmt.Errorf("unexpected SCAN reply %v", reply)
		}
		batch, _ := parts[1].([]any)
		for _, key := range batch {
			seen[fmt.Sprint(key)] = true
		}
		cursor = fmt.Sprint(parts[0])
		if len(seen) >= maxScannedKeys {
			keys := slices.Collect(maps.Keys(seen))
			return keys[:maxScannedKeys], true, nil
		}
		if cursor == "0" {
			return slices.Collect(maps.Keys(seen)), false, nil
		}
	}
}

// Apply queues every write in one MULTI/EXEC. Valkey does not roll back a
// command that fails inside EXEC, so a type check runs before it for SET.
func (v *valkeyConn) Apply(_ context.Context, changes Changes) (int64, error) {
	if changes.Namespace != valkeyNamespace || changes.Table != valkeyTable {
		return 0, fmt.Errorf("Valkey has one table, %s.%s", valkeyNamespace, valkeyTable)
	}
	var cmds [][]string
	for _, u := range changes.Updates {
		if err := requireKey(valkeyKey, u.Key); err != nil {
			return 0, err
		}
		key := u.Key["key"]
		if _, ok := u.Values["value"]; ok {
			kind, err := v.call("TYPE", key)
			if err != nil {
				return 0, err
			}
			if kind != "string" {
				return 0, fmt.Errorf("only string values are editable here; %s is a %v, change it from the console", key, kind)
			}
		}
		writes, err := keyWrites(key, u.Values, "KEEPTTL")
		if err != nil {
			return 0, err
		}
		cmds = append(cmds, writes...)
	}
	for _, values := range changes.Inserts {
		if values["key"] == nil || *values["key"] == "" {
			return 0, errors.New("a new row needs a key")
		}
		key := *values["key"]
		exists, err := v.call("EXISTS", key)
		if err != nil {
			return 0, err
		}
		if exists != int64(0) {
			return 0, fmt.Errorf("key %s already exists", key)
		}
		rest := maps.Clone(values)
		delete(rest, "key")
		if _, ok := rest["value"]; !ok {
			rest["value"] = new(string)
		}
		writes, err := keyWrites(key, rest)
		if err != nil {
			return 0, err
		}
		cmds = append(cmds, writes...)
	}
	for _, d := range changes.Deletes {
		if err := requireKey(valkeyKey, d.Key); err != nil {
			return 0, err
		}
		cmds = append(cmds, []string{"UNLINK", d.Key["key"]})
	}
	if len(cmds) == 0 {
		return 0, nil
	}
	replies, err := v.do(append(append([][]string{{"MULTI"}}, cmds...), []string{"EXEC"})...)
	if err != nil {
		return 0, err
	}
	for _, reply := range replies {
		if e, ok := reply.(valkeyError); ok {
			return 0, e
		}
	}
	results, _ := replies[len(replies)-1].([]any)
	for _, reply := range results {
		if e, ok := reply.(valkeyError); ok {
			return 0, e
		}
	}
	return int64(len(changes.Updates) + len(changes.Inserts) + len(changes.Deletes)), nil
}

// keyWrites turns a row's edited cells into commands, SET before the TTL so a
// new key exists by the time EXPIRE reaches it; setFlags ride on SET.
func keyWrites(key string, values Values, setFlags ...string) ([][]string, error) {
	for name := range values {
		if name != "value" && name != "ttl" {
			return nil, fmt.Errorf("column %q is read-only", name)
		}
	}
	var cmds [][]string
	if value, ok := values["value"]; ok {
		if value == nil {
			return nil, errors.New("a Valkey value cannot be null; delete the key instead")
		}
		cmds = append(cmds, append([]string{"SET", key, *value}, setFlags...))
	}
	if ttl, ok := values["ttl"]; ok {
		if ttl == nil || *ttl == "" {
			return append(cmds, []string{"PERSIST", key}), nil
		}
		seconds, err := strconv.ParseInt(*ttl, 10, 64)
		if err != nil || seconds <= 0 {
			return nil, fmt.Errorf("ttl must be a positive number of seconds, got %q", *ttl)
		}
		cmds = append(cmds, []string{"EXPIRE", key, *ttl})
	}
	return cmds, nil
}

// Query runs one command typed the way valkey-cli takes it, quotes and all.
func (v *valkeyConn) Query(_ context.Context, _ string, query string) (Result, error) {
	args, err := splitCommand(query)
	if err != nil {
		return Result{}, err
	}
	reply, err := v.call(args...)
	if err != nil {
		return Result{}, err
	}
	var cell any
	switch r := reply.(type) {
	case nil:
	case string:
		cell = printable(r)
	case int64:
		cell = strconv.FormatInt(r, 10)
	default:
		out, err := json.Marshal(r)
		if err != nil {
			return Result{}, err
		}
		cell = string(out)
	}
	return Result{Columns: []string{"reply"}, Rows: [][]any{{cell}}}, nil
}

// keyPattern turns the grid's filter into a SCAN glob; only the key column filters.
func keyPattern(filters []Filter) (string, error) {
	if len(filters) == 0 {
		return "*", nil
	}
	f := filters[0]
	if len(filters) > 1 || f.Column != "key" {
		return "", errors.New("Valkey rows filter by one condition on the key")
	}
	literal := globEscaper.Replace(f.Value)
	switch f.Op {
	case "eq":
		return literal, nil
	case "starts_with":
		return literal + "*", nil
	case "contains":
		return "*" + literal + "*", nil
	}
	return "", fmt.Errorf("Valkey keys filter by eq, starts_with or contains, not %s", f.Op)
}

var globEscaper = strings.NewReplacer(`\`, `\\`, "*", `\*`, "?", `\?`, "[", `\[`, "]", `\]`)

func previewCommand(kind, key string) []string {
	n := strconv.Itoa(previewItems - 1)
	switch kind {
	case "string":
		return []string{"GET", key}
	case "list":
		return []string{"LRANGE", key, "0", n}
	case "set":
		return []string{"SSCAN", key, "0", "COUNT", strconv.Itoa(previewItems)}
	case "zset":
		return []string{"ZRANGE", key, "0", n, "WITHSCORES"}
	case "hash":
		return []string{"HSCAN", key, "0", "COUNT", strconv.Itoa(previewItems)}
	case "stream":
		return []string{"XRANGE", key, "-", "+", "COUNT", strconv.Itoa(previewItems)}
	}
	return []string{"TYPE", key}
}

// previewText shows a string as itself and anything else as JSON of its first items.
func previewText(kind string, reply any) (any, error) {
	if e, ok := reply.(valkeyError); ok {
		return nil, e
	}
	switch kind {
	case "string":
		if s, ok := reply.(string); ok {
			return printable(s), nil
		}
		return nil, nil
	case "set", "hash":
		scan, _ := reply.([]any)
		if len(scan) != 2 {
			return nil, nil
		}
		reply = scan[1]
	case "list", "zset", "stream":
	default:
		return nil, nil
	}
	items, _ := reply.([]any)
	if kind == "hash" {
		fields := map[string]any{}
		for i := 0; i+1 < len(items); i += 2 {
			fields[fmt.Sprint(items[i])] = items[i+1]
		}
		reply = fields
	} else {
		reply = items[:min(len(items), previewItems)]
	}
	out, err := json.Marshal(reply)
	return string(out), err
}

// call sends one command and turns an error reply into an error.
func (v *valkeyConn) call(args ...string) (any, error) {
	replies, err := v.do(args)
	if err != nil {
		return nil, err
	}
	if e, ok := replies[0].(valkeyError); ok {
		return nil, e
	}
	return replies[0], nil
}

// do pipelines commands: all are written, then one reply read per command.
func (v *valkeyConn) do(cmds ...[]string) ([]any, error) {
	w := bufio.NewWriter(v.conn)
	for _, cmd := range cmds {
		fmt.Fprintf(w, "*%d\r\n", len(cmd))
		for _, arg := range cmd {
			fmt.Fprintf(w, "$%d\r\n%s\r\n", len(arg), arg)
		}
	}
	if err := w.Flush(); err != nil {
		return nil, err
	}
	replies := make([]any, len(cmds))
	for i := range replies {
		reply, err := readReply(v.r)
		if err != nil {
			return nil, err
		}
		replies[i] = reply
	}
	return replies, nil
}

// readReply decodes one RESP2 reply: a string, an int64, nil, a valkeyError or a []any of those.
func readReply(r *bufio.Reader) (any, error) {
	line, err := r.ReadString('\n')
	if err != nil {
		return nil, err
	}
	line = strings.TrimSuffix(line, "\r\n")
	if line == "" {
		return nil, errors.New("empty reply from Valkey")
	}
	body := line[1:]
	switch line[0] {
	case '+':
		return body, nil
	case '-':
		return valkeyError(body), nil
	case ':':
		return strconv.ParseInt(body, 10, 64)
	case '$':
		n, err := strconv.Atoi(body)
		if err != nil || n < 0 {
			return nil, err
		}
		buf := make([]byte, n+2)
		if _, err := io.ReadFull(r, buf); err != nil {
			return nil, err
		}
		return string(buf[:n]), nil
	case '*':
		n, err := strconv.Atoi(body)
		if err != nil || n < 0 {
			return nil, err
		}
		items := make([]any, n)
		for i := range items {
			if items[i], err = readReply(r); err != nil {
				return nil, err
			}
		}
		return items, nil
	}
	return nil, fmt.Errorf("unexpected reply from Valkey: %q", line)
}

// splitCommand splits a line into arguments; quotes group, and a backslash
// inside double quotes takes the next character as is.
func splitCommand(line string) ([]string, error) {
	var args []string
	var arg strings.Builder
	var quote rune
	inArg, escaped := false, false
	for _, r := range line {
		switch {
		case escaped:
			arg.WriteRune(r)
			escaped = false
		case quote != 0 && r == quote:
			quote = 0
		case quote == '"' && r == '\\':
			escaped = true
		case quote != 0:
			arg.WriteRune(r)
		case r == '"' || r == '\'':
			quote, inArg = r, true
		case unicode.IsSpace(r):
			if inArg {
				args = append(args, arg.String())
				arg.Reset()
				inArg = false
			}
		default:
			arg.WriteRune(r)
			inArg = true
		}
	}
	if quote != 0 {
		return nil, errors.New("unterminated quote")
	}
	if inArg {
		args = append(args, arg.String())
	}
	if len(args) == 0 {
		return nil, errors.New("type a command, such as GET key")
	}
	return args, nil
}
