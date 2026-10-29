//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"regexp"
	"slices"
	"strings"
	"testing"
)

// docFlowFixtureKeys is the docKeysFile every fixture is checked beside.
const docFlowFixtureKeys = `package worker

const (
	keyA = "a"
	keyB = "b"
)
`

// docFlowFixtureHeader opens every fixture: ycrdt and encoding/json resolve,
// as in the worker, to packages the shallow type-check cannot see into.
const docFlowFixtureHeader = `package worker

import (
	"encoding/json"

	ycrdt "github.com/skyterra/y-crdt"
)

var _ = json.Marshal
var _ *ycrdt.YMap
`

// wantMarker is a fixture line's expected finding: the literal key the line
// must be reported for.
var wantMarker = regexp.MustCompile(`// want (".*")$`)

// TestDocKeyFlowFixtures feeds docFlow small programs and holds keyFindings to
// exactly the lines each marks with `// want "<key>"`: a doc-state key it
// misses fails, and so does a key of a map that is not doc state.
func TestDocKeyFlowFixtures(t *testing.T) {
	for _, tc := range []struct{ name, body string }{
		{"direct Y.Map key", `
func f(m *ycrdt.YMap) {
	m.Get("direct") // want "direct"
	m.Set("set", 1) // want "set"
	m.Delete(keyA)
	m.Has(keyB)
}`},
		{"constant key passes", `
func f(m *ycrdt.YMap) {
	v, _ := m.Get(keyA).(map[string]any)
	_ = v[keyB]
	delete(v, keyA)
	m.Set(keyA, map[string]any{keyB: 1})
}`},
		{"through assignment", `
func f(m *ycrdt.YMap) {
	v, _ := m.Get(keyA).(map[string]any)
	x := v
	_ = x["assigned"] // want "assigned"
}`},
		{"through a parameter", `
func use(p map[string]any) any {
	return p["param"] // want "param"
}

func f(m *ycrdt.YMap) {
	v, _ := m.Get(keyA).(map[string]any)
	use(v)
}`},
		{"through a result", `
func read(m *ycrdt.YMap) map[string]any {
	v, _ := m.Get(keyA).(map[string]any)
	return v
}

func f(m *ycrdt.YMap) {
	r := read(m)
	_ = r["returned"] // want "returned"
}`},
		{"through a callback argument", `
func each(m *ycrdt.YMap, fn func(map[string]any)) {
	v, _ := m.Get(keyA).(map[string]any)
	fn(v)
}

func f(m *ycrdt.YMap) {
	each(m, func(e map[string]any) {
		_ = e["callback"] // want "callback"
	})
}`},
		{"through a method receiver", `
type entry map[string]any

func (e entry) get() any {
	return e["receiver"] // want "receiver"
}

func f(m *ycrdt.YMap) {
	v, _ := m.Get(keyA).(map[string]any)
	entry(v).get()
}`},
		{"through a range value", `
func f(m *ycrdt.YMap) {
	list, _ := m.Get(keyA).([]any)
	for _, it := range list {
		e, _ := it.(map[string]any)
		_ = e["ranged"] // want "ranged"
	}
}`},
		{"delete", `
func f(m *ycrdt.YMap) {
	v, _ := m.Get(keyA).(map[string]any)
	delete(v, "deleted") // want "deleted"
}`},
		{"map literal written", `
func f(m *ycrdt.YMap) {
	m.Set(keyA, map[string]any{
		"inline": 1, // want "inline"
		keyB:     2,
	})
	lit := map[string]any{"viaVar": 1} // want "viaVar"
	m.Set(keyB, lit)
	m.Set(keyA, map[string]any{keyB: map[string]any{"nested": 1}}) // want "nested"
	out := map[string]any{}
	sub := map[string]any{"stored": 1} // want "stored"
	out[keyB] = sub
	list := []any{}
	list = append(list, map[string]any{"appended": 1}) // want "appended"
	out[keyA] = list
	m.Set(keyA, out)
}`},
		{"doc value stored beside a map does not make it doc state", `
func f(m *ycrdt.YMap) {
	in, _ := m.Get(keyA).(map[string]any)
	parts := []map[string]any{{"kind": 1}}
	msg := map[string]any{"input": in, "parts": parts}
	msg["more"] = in
	msg["other"] = map[string]any{"free": 1}
	_ = msg
}`},
		{"unrelated map is not doc state", `
func f(m *ycrdt.YMap) {
	m.Set(keyA, 1)
	u := map[string]any{"free": 1}
	_ = u["free"]
	delete(u, "free")
}`},
		{"JSON decoded from a doc string", `
func f(m *ycrdt.YMap) {
	s, _ := m.Get(keyA).(string)
	var j map[string]any
	_ = json.Unmarshal([]byte(s), &j)
	_ = j["decoded"] // want "decoded"
}`},
		{"JSON encoded into a doc write", `
func f(m *ycrdt.YMap) {
	out := map[string]any{"encoded": 1} // want "encoded"
	b, _ := json.Marshal(out)
	m.Set(keyA, string(b))
}`},
		{"JSON field of a struct read from the doc", `
type item struct {
	Data json.RawMessage
}

func raw(m *ycrdt.YMap, key string) json.RawMessage {
	s, _ := m.Get(key).(string)
	return json.RawMessage(s)
}

func read(m *ycrdt.YMap) item {
	return item{Data: raw(m, keyA)}
}

func setData(it *item) {
	data := map[string]any{}
	_ = json.Unmarshal(it.Data, &data)
	data["field"] = 1 // want "field"
	it.Data, _ = json.Marshal(data)
}

func f(m *ycrdt.YMap) {
	it := read(m)
	setData(&it)
}`},
		{"JSON embedded in a piece of doc text is not doc state", `
func text(v any) string {
	s, _ := v.(string)
	return s
}

func f(m *ycrdt.YMap) {
	s := text(m.Get(keyA))
	var j map[string]any
	_ = json.Unmarshal([]byte(s[1:]), &j)
	_ = j["embedded"]
}`},
		{"JSON not from the doc is not doc state", `
func f(m *ycrdt.YMap, payload []byte) {
	m.Set(keyA, 1)
	var w map[string]any
	_ = json.Unmarshal(payload, &w)
	_ = w["free"]
	b, _ := json.Marshal(map[string]any{"wire": 1})
	_ = b
}`},
	} {
		t.Run(tc.name, func(t *testing.T) {
			source := docFlowFixtureHeader + tc.body + "\n"
			var want []string
			for i, line := range strings.Split(source, "\n") {
				if mk := wantMarker.FindStringSubmatch(line); mk != nil {
					want = append(want, fmt.Sprintf("fixture.go:%d: key %s is a literal", i+1, mk[1]))
				}
			}
			fset := token.NewFileSet()
			files := map[string]*ast.File{}
			for name, text := range map[string]string{docKeysFile: docFlowFixtureKeys, "fixture.go": source} {
				f, err := parser.ParseFile(fset, name, text, 0)
				if err != nil {
					t.Fatalf("parse %s: %v", name, err)
				}
				files[name] = f
			}
			got := keyFindings(newWorkerSource(fset, files))
			slices.Sort(want)
			if !slices.Equal(got, want) {
				t.Errorf("findings:\n  %s\nwant:\n  %s", strings.Join(got, "\n  "), strings.Join(want, "\n  "))
			}
		})
	}
}
