package studio

import (
	"bufio"
	"reflect"
	"strings"
	"testing"

	"go.mongodb.org/mongo-driver/v2/bson"
)

var users = Table{Name: "users", Columns: []Column{
	{Name: "org", Type: "integer", PrimaryKey: true},
	{Name: "id", Type: "integer", PrimaryKey: true},
	{Name: "name", Type: "text", Nullable: true},
	{Name: "slug", Type: "text", ReadOnly: true},
}}

func ptr(s string) *string { return &s }

func TestStatements(t *testing.T) {
	changes := Changes{
		Namespace: "app",
		Table:     "users",
		Updates:   []Update{{Key: map[string]string{"org": "1", "id": "2"}, Values: Values{"name": nil}}},
		Inserts:   []Values{{"id": ptr("3"), "name": ptr("o'hara")}},
		Deletes:   []Delete{{Key: map[string]string{"id": "4", "org": "1"}}},
	}
	want := map[dialect][]statement{
		postgres: {
			{`update "app"."users" set "name" = $1::text::text where "id" = $2::text::integer and "org" = $3::text::integer`, []any{nil, "2", "1"}},
			{`insert into "app"."users" ("id", "name") values ($1::text::integer, $2::text::text)`, []any{"3", "o'hara"}},
			{`delete from "app"."users" where "id" = $1::text::integer and "org" = $2::text::integer`, []any{"4", "1"}},
		},
		mysql: {
			{"update `users` set `name` = ? where `id` = ? and `org` = ?", []any{nil, "2", "1"}},
			{"insert into `users` (`id`, `name`) values (?, ?)", []any{"3", "o'hara"}},
			{"delete from `users` where `id` = ? and `org` = ?", []any{"4", "1"}},
		},
	}
	for d, stmts := range want {
		got, err := statements(d, users, changes)
		if err != nil {
			t.Fatal(err)
		}
		if !reflect.DeepEqual(got, stmts) {
			t.Errorf("dialect %d:\n got %q\nwant %q", d, got, stmts)
		}
	}
}

func TestStatementsRefuse(t *testing.T) {
	cases := map[string]Changes{
		"partial key":      {Deletes: []Delete{{Key: map[string]string{"id": "1"}}}},
		"read-only column": {Inserts: []Values{{"slug": ptr("x")}}},
		"unknown column":   {Updates: []Update{{Key: map[string]string{"org": "1", "id": "1"}, Values: Values{"nope": nil}}}},
	}
	for name, changes := range cases {
		if _, err := statements(postgres, users, changes); err == nil {
			t.Errorf("%s: want an error", name)
		}
	}
	view := Table{Name: "v", View: true, Columns: users.Columns}
	if _, err := statements(postgres, view, Changes{}); err != errReadOnly {
		t.Errorf("view: got %v, want errReadOnly", err)
	}
}

func TestWhere(t *testing.T) {
	b := sqlBuilder{dialect: sqlite}
	got, err := b.where(users.Columns, []Filter{
		{Column: "name", Op: "contains", Value: "50%_off!"},
		{Column: "id", Op: "gte", Value: "7"},
		{Column: "slug", Op: "is_null"},
	})
	if err != nil {
		t.Fatal(err)
	}
	want := ` where "name" like ? escape '!' and "id" >= ? and "slug" is null`
	if got != want || !reflect.DeepEqual(b.args, []any{"%50!%!_off!!%", "7"}) {
		t.Errorf("got %q %q", got, b.args)
	}
	if _, err := b.where(users.Columns, []Filter{{Column: "x\" or 1=1 --", Op: "eq"}}); err == nil {
		t.Error("an unknown column must be refused, not quoted")
	}
}

func TestEJSONRoundTrip(t *testing.T) {
	doc := bson.D{{Key: "n", Value: int32(42)}, {Key: "s", Value: "42"}, {Key: "id", Value: bson.NewObjectID()}}
	raw, err := bson.Marshal(doc)
	if err != nil {
		t.Fatal(err)
	}
	elements, err := bson.Raw(raw).Elements()
	if err != nil {
		t.Fatal(err)
	}
	for i, e := range elements {
		cell, err := ejsonText(e.Value())
		if err != nil {
			t.Fatal(err)
		}
		if back := ejsonValue(cell); !reflect.DeepEqual(back, doc[i].Value) {
			t.Errorf("%s: %q came back as %#v", e.Key(), cell, back)
		}
	}
	if got := ejsonValue("plain words"); got != "plain words" {
		t.Errorf("text that is not JSON stays a string, got %#v", got)
	}
}

func TestSplitCommand(t *testing.T) {
	got, err := splitCommand(`SET  "a key" 'it''s' "say \"hi\""`)
	want := []string{"SET", "a key", "its", `say "hi"`}
	if err != nil || !reflect.DeepEqual(got, want) {
		t.Errorf("got %q, %v", got, err)
	}
	if _, err := splitCommand(`GET "open`); err == nil {
		t.Error("an unterminated quote must fail")
	}
}

func TestReadReply(t *testing.T) {
	r := bufio.NewReader(strings.NewReader("*4\r\n$5\r\na\r\nbc\r\n:-2\r\n$-1\r\n-WRONGTYPE no\r\n"))
	got, err := readReply(r)
	if err != nil {
		t.Fatal(err)
	}
	if want := []any{"a\r\nbc", int64(-2), nil, valkeyError("WRONGTYPE no")}; !reflect.DeepEqual(got, want) {
		t.Errorf("got %#v", got)
	}
}

func TestKeyPattern(t *testing.T) {
	got, err := keyPattern([]Filter{{Column: "key", Op: "starts_with", Value: "user:*[1]"}})
	if err != nil || got != `user:\*\[1\]*` {
		t.Errorf("got %q, %v", got, err)
	}
	if _, err := keyPattern([]Filter{{Column: "value", Op: "eq", Value: "x"}}); err == nil {
		t.Error("only the key filters")
	}
}
