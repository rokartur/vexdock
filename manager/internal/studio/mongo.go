package studio

import (
	"cmp"
	"context"
	"errors"
	"fmt"
	"maps"
	"net"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"go.mongodb.org/mongo-driver/v2/bson"
	"go.mongodb.org/mongo-driver/v2/mongo"
	"go.mongodb.org/mongo-driver/v2/mongo/options"

	"github.com/vexdock/platform/manager/internal/engines"
)

// mongoConn shows a collection as a table: its columns are the top-level
// fields of the documents on the page and every cell is relaxed Extended
// JSON, so `"42"` stays a string and `42` a number when it is written back.
type mongoConn struct{ client *mongo.Client }

var mongoKey = []string{"_id"}

func openMongo(ctx context.Context, c engines.Connection) (Conn, error) {
	opts := options.Client().
		SetHosts([]string{net.JoinHostPort(c.Host, strconv.Itoa(c.Port))}).
		SetDirect(true).
		SetServerSelectionTimeout(10 * time.Second)
	if c.User != "" {
		opts.SetAuth(options.Credential{Username: c.User, Password: c.Password, AuthSource: "admin"})
	}
	client, err := mongo.Connect(opts)
	if err != nil {
		return nil, err
	}
	// Connect is lazy; ping so a wrong password fails here and not on first use.
	if err := client.Ping(ctx, nil); err != nil {
		_ = client.Disconnect(context.Background())
		return nil, err
	}
	return &mongoConn{client: client}, nil
}

func (m *mongoConn) Close() error { return m.client.Disconnect(context.Background()) }

func (m *mongoConn) Schema(ctx context.Context) ([]Namespace, error) {
	names, err := m.client.ListDatabaseNames(ctx, bson.D{})
	if err != nil {
		return nil, err
	}
	namespaces := []Namespace{}
	for _, name := range names {
		if name == "admin" || name == "config" || name == "local" {
			continue
		}
		specs, err := m.client.Database(name).ListCollectionSpecifications(ctx, bson.D{})
		if err != nil {
			return nil, err
		}
		ns := Namespace{Name: name, Tables: []Table{}}
		for _, spec := range specs {
			ns.Tables = append(ns.Tables, Table{Name: spec.Name, View: spec.Type == "view", Columns: []Column{}})
		}
		slices.SortFunc(ns.Tables, func(a, b Table) int { return strings.Compare(a.Name, b.Name) })
		namespaces = append(namespaces, ns)
	}
	return namespaces, nil
}

func (m *mongoConn) Rows(ctx context.Context, q RowsQuery) (Rows, error) {
	coll := m.client.Database(q.Namespace).Collection(q.Table)
	filter, err := mongoFilter(q.Filters)
	if err != nil {
		return Rows{}, err
	}
	total, err := coll.CountDocuments(ctx, filter)
	if err != nil {
		return Rows{}, err
	}
	order := 1
	if q.Desc {
		order = -1
	}
	sort := cmp.Or(q.Sort, "_id")
	find := options.Find().SetSort(bson.D{{Key: sort, Value: order}}).SetSkip(int64(q.Offset)).SetLimit(int64(q.Limit))
	cursor, err := coll.Find(ctx, filter, find)
	if err != nil {
		return Rows{}, err
	}
	defer cursor.Close(ctx)
	var docs []bson.Raw
	for cursor.Next(ctx) {
		docs = append(docs, slices.Clone(cursor.Current))
	}
	if err := cursor.Err(); err != nil {
		return Rows{}, err
	}
	names, rows, err := documentTable(docs)
	if err != nil {
		return Rows{}, err
	}
	columns := make([]Column, len(names))
	for i, name := range names {
		columns[i] = Column{Name: name, Type: "ejson", Nullable: true, PrimaryKey: name == "_id"}
	}
	key := mongoKey
	if m.isView(ctx, q.Namespace, q.Table) {
		key = []string{}
	}
	return Rows{Columns: columns, Key: key, Rows: rows, Total: total}, nil
}

func (m *mongoConn) isView(ctx context.Context, database, collection string) bool {
	specs, err := m.client.Database(database).ListCollectionSpecifications(ctx, bson.D{{Key: "name", Value: collection}})
	return err == nil && len(specs) == 1 && specs[0].Type == "view"
}

// Apply writes one document at a time and stops at the first failure.
// ponytail: no transaction, a standalone mongod has none; the count says how far it got.
func (m *mongoConn) Apply(ctx context.Context, changes Changes) (int64, error) {
	if m.isView(ctx, changes.Namespace, changes.Table) {
		return 0, errReadOnly
	}
	coll := m.client.Database(changes.Namespace).Collection(changes.Table)
	var affected int64
	for _, u := range changes.Updates {
		if err := requireKey(mongoKey, u.Key); err != nil {
			return affected, err
		}
		if len(u.Values) == 0 {
			continue
		}
		res, err := coll.UpdateOne(ctx, bson.D{{Key: "_id", Value: ejsonValue(u.Key["_id"])}}, bson.D{{Key: "$set", Value: mongoDoc(u.Values)}})
		if err != nil {
			return affected, err
		}
		affected += res.ModifiedCount
	}
	for _, values := range changes.Inserts {
		if _, err := coll.InsertOne(ctx, mongoDoc(values)); err != nil {
			return affected, err
		}
		affected++
	}
	for _, d := range changes.Deletes {
		if err := requireKey(mongoKey, d.Key); err != nil {
			return affected, err
		}
		res, err := coll.DeleteOne(ctx, bson.D{{Key: "_id", Value: ejsonValue(d.Key["_id"])}})
		if err != nil {
			return affected, err
		}
		affected += res.DeletedCount
	}
	return affected, nil
}

// Query runs a database command written as Extended JSON, such as
// {"find": "users", "filter": {"age": {"$gt": 30}}}; a cursor's first batch
// becomes the rows, any other reply is one row.
func (m *mongoConn) Query(ctx context.Context, namespace, query string) (Result, error) {
	var command bson.D
	if err := bson.UnmarshalExtJSON([]byte(query), false, &command); err != nil {
		return Result{}, fmt.Errorf("a MongoDB command is one Extended JSON document: %w", err)
	}
	reply, err := m.client.Database(cmp.Or(namespace, "admin")).RunCommand(ctx, command).Raw()
	if err != nil {
		return Result{}, err
	}
	docs := []bson.Raw{reply}
	if batch, err := reply.LookupErr("cursor", "firstBatch"); err == nil {
		values, err := batch.Array().Values()
		if err != nil {
			return Result{}, err
		}
		docs = docs[:0]
		for _, v := range values {
			docs = append(docs, v.Document())
		}
	}
	truncated := len(docs) > MaxResultRows
	docs = docs[:min(len(docs), MaxResultRows)]
	columns, rows, err := documentTable(docs)
	if err != nil {
		return Result{}, err
	}
	return Result{Columns: columns, Rows: rows, Truncated: truncated}, nil
}

// documentTable lays documents out as rows under the union of their fields,
// _id first and the rest in the order they first appear.
func documentTable(docs []bson.Raw) ([]string, [][]any, error) {
	columns := []string{}
	index := map[string]int{}
	var parsed []map[string]string
	for _, doc := range docs {
		elements, err := doc.Elements()
		if err != nil {
			return nil, nil, err
		}
		fields := map[string]string{}
		for _, e := range elements {
			if _, ok := index[e.Key()]; !ok {
				index[e.Key()] = len(columns)
				columns = append(columns, e.Key())
			}
			if fields[e.Key()], err = ejsonText(e.Value()); err != nil {
				return nil, nil, err
			}
		}
		parsed = append(parsed, fields)
	}
	if i, ok := index["_id"]; ok && i > 0 {
		columns = append([]string{"_id"}, slices.Delete(columns, i, i+1)...)
	}
	rows := make([][]any, len(parsed))
	for i, fields := range parsed {
		rows[i] = make([]any, len(columns))
		for j, name := range columns {
			if v, ok := fields[name]; ok {
				rows[i][j] = v
			}
		}
	}
	return columns, rows, nil
}

func ejsonText(v bson.RawValue) (string, error) {
	out, err := bson.MarshalExtJSON(bson.D{{Key: "v", Value: v}}, false, false)
	if err != nil {
		return "", err
	}
	return strings.TrimSuffix(strings.TrimPrefix(string(out), `{"v":`), "}"), nil
}

// ejsonValue reads a cell back: Extended JSON when it parses as one value,
// otherwise the text itself as a string.
func ejsonValue(text string) any {
	var doc bson.D
	if err := bson.UnmarshalExtJSON([]byte(`{"v":`+text+`}`), false, &doc); err != nil || len(doc) != 1 {
		return text
	}
	return doc[0].Value
}

func mongoDoc(values Values) bson.D {
	doc := bson.D{}
	for _, name := range slices.Sorted(maps.Keys(values)) {
		var v any
		if values[name] != nil {
			v = ejsonValue(*values[name])
		}
		doc = append(doc, bson.E{Key: name, Value: v})
	}
	return doc
}

var mongoComparisons = map[string]string{"neq": "$ne", "gt": "$gt", "gte": "$gte", "lt": "$lt", "lte": "$lte"}

func mongoFilter(filters []Filter) (bson.D, error) {
	var clauses bson.A
	for _, f := range filters {
		if f.Column == "" || strings.HasPrefix(f.Column, "$") {
			return nil, errors.New("filter on a field name")
		}
		var cond any
		switch f.Op {
		case "eq":
			cond = ejsonValue(f.Value)
		case "is_null":
			cond = nil
		case "is_not_null":
			cond = bson.D{{Key: "$ne", Value: nil}}
		case "contains":
			cond = bson.D{{Key: "$regex", Value: regexp.QuoteMeta(f.Value)}, {Key: "$options", Value: "i"}}
		case "starts_with":
			cond = bson.D{{Key: "$regex", Value: "^" + regexp.QuoteMeta(f.Value)}}
		default:
			cond = bson.D{{Key: mongoComparisons[f.Op], Value: ejsonValue(f.Value)}}
		}
		clauses = append(clauses, bson.D{{Key: f.Column, Value: cond}})
	}
	if len(clauses) == 0 {
		return bson.D{}, nil
	}
	return bson.D{{Key: "$and", Value: clauses}}, nil
}
