//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"maps"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// wireFixture is the vocabulary shared with the JS half
// (unit:wire-protocol-parity) and with the server's TestWireParityServer.
const wireFixture = "../../../web/js-tests/fixtures/wire-protocol.json"

type wireManifest struct {
	Worker struct {
		Inbound  []string `json:"inbound"`
		Outbound []struct {
			Type      string `json:"type"`
			GoEmits   bool   `json:"goEmits"`
			JSHandler bool   `json:"jsHandler"`
		} `json:"outbound"`
		ProviderTypes struct {
			Types []string `json:"types"`
		} `json:"providerTypes"`
		ItemTypes          []string `json:"itemTypes"`
		ProcessingStatuses []struct {
			Status     string `json:"status"`
			HoldsClaim bool   `json:"holdsClaim"`
			Emitted    bool   `json:"emitted"`
		} `json:"processingStatuses"`
		Activities      []string `json:"activities"`
		ValidationCodes struct {
			Codes []struct {
				Code    string `json:"code"`
				Bounced bool   `json:"bounced"`
			} `json:"codes"`
		} `json:"validationCodes"`
		PendingRequest struct {
			Statuses []string `json:"statuses"`
			Kinds    []string `json:"kinds"`
		} `json:"pendingRequest"`
		DocKeys struct {
			Item        []string `json:"item"`
			ItemUntyped struct {
				Keys []string `json:"keys"`
			} `json:"itemUntyped"`
			ModelConfig          []string `json:"modelConfig"`
			Metadata             []string `json:"metadata"`
			PendingItem          []string `json:"pendingItem"`
			ProcessingState      []string `json:"processingState"`
			ToolResult           []string `json:"toolResult"`
			ErrorData            []string `json:"errorData"`
			CompactionAccounting []string `json:"compactionAccounting"`
			UndoState            []string `json:"undoState"`
			DisplayData          []string `json:"displayData"`
		} `json:"docKeys"`
	} `json:"worker"`
}

func loadWireManifest(t *testing.T) wireManifest {
	t.Helper()
	data, err := os.ReadFile(wireFixture)
	if err != nil {
		t.Fatalf("read %s: %v", wireFixture, err)
	}
	var m wireManifest
	if err := json.Unmarshal(data, &m); err != nil {
		t.Fatalf("parse %s: %v", wireFixture, err)
	}
	return m
}

// workerSource is this package's production code, parsed: the vocabulary is
// read from what the worker actually does, not from a list kept beside it.
type workerSource struct {
	fset  *token.FileSet
	files map[string]*ast.File
	// docKeys is the key constants by name: the Y.Map keys a call site names
	// through a constant instead of a literal. They are doc_keys.go's
	// constants, plus the meta* constants a feature declares beside the code
	// that owns that metadata key (isDocKeyConst).
	docKeys map[string]string
	// otherConsts is every other package-level constant, by name.
	otherConsts map[string]bool
}

// docKeysFile declares the Y.Map key constants.
const docKeysFile = "doc_keys.go"

// isDocKeyConst reports whether a package-level constant is a key constant:
// one declared in doc_keys.go, a processingState key named runField* (declared
// in run_entry.go with the accessors that read it), or a metadata key named
// meta* and declared beside the feature that owns it, where its documentation
// belongs.
func isDocKeyConst(file, name string) bool {
	if file == docKeysFile {
		return true
	}
	for _, prefix := range []string{"meta", "runField"} {
		if len(name) > len(prefix) && strings.HasPrefix(name, prefix) && name[len(prefix)] >= 'A' && name[len(prefix)] <= 'Z' {
			return true
		}
	}
	return false
}

func parseWorkerSource(t *testing.T) workerSource {
	t.Helper()
	paths, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	src := workerSource{fset: fset, files: map[string]*ast.File{}, docKeys: map[string]string{}, otherConsts: map[string]bool{}}
	for _, p := range paths {
		if strings.HasSuffix(p, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, p, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", p, err)
		}
		src.files[p] = f
	}
	for p, f := range src.files {
		for _, decl := range f.Decls {
			gen, ok := decl.(*ast.GenDecl)
			if !ok || gen.Tok != token.CONST {
				continue
			}
			for _, spec := range gen.Specs {
				vs := spec.(*ast.ValueSpec)
				for i, name := range vs.Names {
					if !isDocKeyConst(p, name.Name) {
						src.otherConsts[name.Name] = true
						continue
					}
					if i < len(vs.Values) {
						if v := strLit(vs.Values[i]); v != "" {
							src.docKeys[name.Name] = v
						}
					}
				}
			}
		}
	}
	return src
}

var (
	// yMapMethods are the Y.Map methods whose first argument is a key.
	yMapMethods = setOf("Get", "Set", "Delete", "Has")
	// metadataMethods are the document's metadata-map accessors: a key handed
	// to one of them is a metadata key (docKeys.metadata).
	metadataMethods = setOf("GetMetadata", "SetMetadata", "setMetadata", "getMetadataValue")
)

// keyArg is the Y.Map key a call argument names: a string literal's value, a
// doc_keys.go constant's value, or "" for anything else.
func (s workerSource) keyArg(e ast.Expr) string {
	if id, ok := e.(*ast.Ident); ok {
		return s.docKeys[id.Name]
	}
	return strLit(e)
}

func (s workerSource) inspect(fn func(file string, n ast.Node) bool) {
	names := make([]string, 0, len(s.files))
	for name := range s.files {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		ast.Inspect(s.files[name], func(n ast.Node) bool { return fn(name, n) })
	}
}

// strLit is the value of a string literal, or "" for anything else.
func strLit(e ast.Expr) string {
	lit, ok := e.(*ast.BasicLit)
	if !ok || lit.Kind != token.STRING {
		return ""
	}
	v, err := strconv.Unquote(lit.Value)
	if err != nil {
		return ""
	}
	return v
}

type stringSet map[string]bool

func setOf(values ...string) stringSet {
	s := stringSet{}
	for _, v := range values {
		s[v] = true
	}
	return s
}

// vocabSet is one of wire_vocab.go's all… lists as a set.
func vocabSet[T ~string](values []T) stringSet {
	s := stringSet{}
	for _, v := range values {
		if s[string(v)] {
			panic("wire_vocab.go lists " + string(v) + " twice")
		}
		s[string(v)] = true
	}
	return s
}

func (s stringSet) sorted() []string {
	out := make([]string, 0, len(s))
	for v := range s {
		out = append(out, v)
	}
	sort.Strings(out)
	return out
}

// missingFrom lists the members of s that are not in other.
func (s stringSet) missingFrom(other stringSet) []string {
	var out []string
	for _, v := range s.sorted() {
		if !other[v] {
			out = append(out, v)
		}
	}
	return out
}

// requireSameSet fails, naming both directions of the difference, unless the
// set the source yielded equals the one the manifest declares.
func requireSameSet(t *testing.T, what string, fromSource, declared stringSet) {
	t.Helper()
	if extra := fromSource.missingFrom(declared); len(extra) > 0 {
		t.Errorf("%s: the worker uses %v, which %s does not declare — add them there", what, extra, wireFixture)
	}
	if stale := declared.missingFrom(fromSource); len(stale) > 0 {
		t.Errorf("%s: %s declares %v, which the worker no longer uses — remove them there", what, wireFixture, stale)
	}
}

// requireAtLeast guards a scan against matching nothing useful: a source
// refactor that changes the shape a scan looks for must fail here, not let
// every comparison below pass on two empty sets.
func requireAtLeast(t *testing.T, what string, got stringSet, n int) {
	t.Helper()
	if len(got) < n {
		t.Fatalf("%s: the source scan found only %d (%v), expected at least %d — the shape it looks for has changed", what, len(got), got.sorted(), n)
	}
}

// TestWireParityWorkerInbound pins the message types the worker dispatches to
// the manifest, in both directions. The worker's dispatch is a switch on the
// type in (*run).dispatchMessage; a case added or removed there without the
// manifest following fails here.
func TestWireParityWorkerInbound(t *testing.T) {
	m := loadWireManifest(t)

	handled := stringSet{}
	for typ := range workerInbound {
		handled[string(typ)] = true
	}
	requireAtLeast(t, "worker inbound", handled, 30)
	requireSameSet(t, "workerInbound (worker.go) message types", handled, setOf(m.Worker.Inbound...))
	requireSameSet(t, "allWorkerInbound (wire_vocab.go)", vocabSet(allWorkerInbound), setOf(m.Worker.Inbound...))
}

// TestWireParityWorkerOutbound pins the message types the worker sends.
//
// allWorkerOutbound is the list, and it must equal the manifest's goEmits
// entries exactly. Each of its constants must be used by production code
// outside wire_vocab.go — a type nothing sends is not emitted, whatever the
// list says. A worker message type written as a literal where a message type
// goes (a `Type:` field or a `"type":` map key) fails: the constants are the
// vocabulary. Literals stay legal for what is not a worker message — provider
// request bodies and item types — and in the hand-built JSON heads sync.go
// writes for speed, which are still checked against the manifest.
func TestWireParityWorkerOutbound(t *testing.T) {
	m := loadWireManifest(t)
	src := parseWorkerSource(t)

	emits := stringSet{}
	for _, o := range m.Worker.Outbound {
		if o.GoEmits {
			emits[o.Type] = true
		}
	}
	requireSameSet(t, "allWorkerOutbound (wire_vocab.go)", vocabSet(allWorkerOutbound), emits)

	// The constant behind each outbound value, and every name production code
	// outside wire_vocab.go uses.
	constOf := map[string]string{}
	used := stringSet{}
	src.inspect(func(file string, n ast.Node) bool {
		switch n := n.(type) {
		case *ast.ValueSpec:
			if typ, ok := n.Type.(*ast.Ident); ok && typ.Name == "wireMsgType" {
				for i, name := range n.Names {
					if i < len(n.Values) {
						constOf[strLit(n.Values[i])] = name.Name
					}
				}
			}
			return file != "wire_vocab.go"
		case *ast.Ident:
			if file != "wire_vocab.go" {
				used[n.Name] = true
			}
		}
		return true
	})
	for _, typ := range allWorkerOutbound {
		name := constOf[string(typ)]
		if name == "" {
			t.Errorf("allWorkerOutbound has %q, which no wireMsgType constant declares", typ)
		} else if !used[name] {
			t.Errorf("%s (%q) is in allWorkerOutbound but nothing outside wire_vocab.go uses it — the worker does not send it", name, typ)
		}
	}

	workerTypes := setOf(m.Worker.Inbound...)
	for _, o := range m.Worker.Outbound {
		workerTypes[o.Type] = true
	}
	known := stringSet{}
	maps.Copy(known, workerTypes)
	for _, v := range m.Worker.ProviderTypes.Types {
		known[v] = true
	}
	for _, v := range m.Worker.ItemTypes {
		known[v] = true
	}
	// The envelope the worker builds around its own messages for the server.
	known["worker-message"] = true

	rawHead := regexp.MustCompile(`"type":"([^"]+)"`)
	typePosition := stringSet{}
	var literal []string
	src.inspect(func(file string, n ast.Node) bool {
		switch n := n.(type) {
		case *ast.BasicLit:
			for _, sub := range rawHead.FindAllStringSubmatch(strLit(n), -1) {
				typePosition[sub[1]] = true
			}
		case *ast.KeyValueExpr:
			v := strLit(n.Value)
			if v == "" {
				return true
			}
			id, isField := n.Key.(*ast.Ident)
			if (isField && id.Name == "Type") || strLit(n.Key) == "type" {
				typePosition[v] = true
				if workerTypes[v] {
					literal = append(literal, fmt.Sprintf("%s:%d: message type %q", file, src.fset.Position(n.Pos()).Line, v))
				}
			}
		}
		return true
	})
	requireAtLeast(t, "worker type-position literals", typePosition, 10)
	sort.Strings(literal)
	for _, l := range literal {
		t.Error(l + " is a literal — use its wireMsgType constant (wire_vocab.go)")
	}
	for _, o := range m.Worker.Outbound {
		if !o.GoEmits && typePosition[o.Type] {
			t.Errorf("%s says the worker never emits %q, but it is used as a message type in the worker — set goEmits true", wireFixture, o.Type)
		}
	}
	if undeclared := typePosition.missingFrom(known); len(undeclared) > 0 {
		t.Errorf("the worker uses %v as message types, which %s does not declare — add each to worker.outbound (or providerTypes, if it is a provider request body type)", undeclared, wireFixture)
	}
}

// TestWireParityProcessingStatuses ties the statuses the worker writes to the
// manifest, and the manifest's holdsClaim to statusHoldsClaim. The JS half
// checks the same holdsClaim column against isRestingStatus, which is what
// keeps RESTING_STATUSES (web/js/model/processing-status.js) and
// statusHoldsClaim from drifting apart.
func TestWireParityProcessingStatuses(t *testing.T) {
	m := loadWireManifest(t)
	src := parseWorkerSource(t)

	// The processingStatus constants by name, so a write through
	// runEntry.setStatus(statusX) counts as writing statusX's value.
	statusConsts := map[string]string{}
	src.inspect(func(_ string, n ast.Node) bool {
		spec, ok := n.(*ast.ValueSpec)
		if !ok {
			return true
		}
		if typ, ok := spec.Type.(*ast.Ident); !ok || typ.Name != "processingStatus" {
			return true
		}
		for i, name := range spec.Names {
			if i < len(spec.Values) {
				statusConsts[name.Name] = strLit(spec.Values[i])
			}
		}
		return true
	})
	requireAtLeast(t, "processingStatus constants", setOf(slices.Collect(maps.Values(statusConsts))...), 5)

	statusWriters := setOf("sendStatus", "sendStatusText", "sendStatusWithCode", "writeProcessingState")
	stateMaps := setOf("entry", "state", "stateMap")
	written := stringSet{}
	src.inspect(func(_ string, n ast.Node) bool {
		switch n := n.(type) {
		case *ast.CallExpr:
			sel, ok := n.Fun.(*ast.SelectorExpr)
			if ok && statusWriters[sel.Sel.Name] && len(n.Args) > 0 {
				if v := strLit(n.Args[0]); v != "" {
					written[v] = true
				}
			}
			if ok && sel.Sel.Name == "setStatus" && len(n.Args) == 1 {
				if id, ok := n.Args[0].(*ast.Ident); ok && statusConsts[id.Name] != "" {
					written[statusConsts[id.Name]] = true
				}
			}
		case *ast.AssignStmt:
			for i, lhs := range n.Lhs {
				idx, ok := lhs.(*ast.IndexExpr)
				if !ok || strLit(idx.Index) != "status" || i >= len(n.Rhs) {
					continue
				}
				if id, ok := idx.X.(*ast.Ident); ok && stateMaps[id.Name] {
					if v := strLit(n.Rhs[i]); v != "" {
						written[v] = true
					}
				}
			}
		}
		return true
	})
	requireAtLeast(t, "processing statuses", written, 5)

	emitted := stringSet{}
	all := stringSet{}
	for _, s := range m.Worker.ProcessingStatuses {
		all[s.Status] = true
		if s.Emitted {
			emitted[s.Status] = true
		}
		if got := statusHoldsClaim(s.Status); got != s.HoldsClaim {
			t.Errorf("statusHoldsClaim(%q) = %v, but %s says holdsClaim %v", s.Status, got, wireFixture, s.HoldsClaim)
		}
	}
	requireSameSet(t, "allProcessingStatuses (wire_vocab.go)", vocabSet(allProcessingStatuses), all)
	if extra := written.missingFrom(all); len(extra) > 0 {
		t.Errorf("the worker writes processing statuses %v, which %s does not declare", extra, wireFixture)
	}
	if stale := emitted.missingFrom(written); len(stale) > 0 {
		t.Errorf("%s marks %v as emitted, but the worker never writes them — set emitted false", wireFixture, stale)
	}
	for _, s := range m.Worker.ProcessingStatuses {
		if !s.Emitted && written[s.Status] {
			t.Errorf("%s marks %q as never emitted, but the worker writes it — set emitted true", wireFixture, s.Status)
		}
	}
	// A status nobody declared holds the claim on both sides; the JS half
	// asserts the same of isRestingStatus.
	if !statusHoldsClaim("a-status-nobody-declared") {
		t.Error("statusHoldsClaim treats an unknown status as resting; the JS half assumes it holds the claim")
	}
}

// TestWireParityActivitiesAndItemTypes pins the Activity* and ItemType*
// constants to the manifest.
func TestWireParityActivitiesAndItemTypes(t *testing.T) {
	m := loadWireManifest(t)
	src := parseWorkerSource(t)

	activities, itemTypes := stringSet{}, stringSet{}
	src.inspect(func(_ string, n ast.Node) bool {
		spec, ok := n.(*ast.ValueSpec)
		if !ok {
			return true
		}
		for i, name := range spec.Names {
			if i >= len(spec.Values) {
				break
			}
			v := strLit(spec.Values[i])
			switch {
			case v == "":
			case strings.HasPrefix(name.Name, "ItemType"):
				itemTypes[v] = true
			case strings.HasPrefix(name.Name, "Activity"):
				activities[v] = true
			}
		}
		return true
	})
	requireAtLeast(t, "ItemType constants", itemTypes, 10)
	requireSameSet(t, "item types", itemTypes, setOf(m.Worker.ItemTypes...))
	requireAtLeast(t, "Activity constants", activities, 2)
	requireSameSet(t, "activities", activities, setOf(m.Worker.Activities...))
}

// TestWireParityPendingRequests pins the statuses and kinds a pendingItems
// entry moves through to the manifest, and holds pending_requests.go to the
// typed constants: wherever it compares, switches on or writes a status or a
// kind, a bare string literal fails here, because the comparison would still
// compile against the named type and drift silently.
func TestWireParityPendingRequests(t *testing.T) {
	m := loadWireManifest(t)
	requireSameSet(t, "allPendingStatuses (wire_vocab.go)", vocabSet(allPendingStatuses), setOf(m.Worker.PendingRequest.Statuses...))
	requireSameSet(t, "allPendingKinds (wire_vocab.go)", vocabSet(allPendingKinds), setOf(m.Worker.PendingRequest.Kinds...))

	src := parseWorkerSource(t)
	file := src.files["pending_requests.go"]
	if file == nil {
		t.Fatal("pending_requests.go is gone; point this test at where pending requests live")
	}
	isField := func(e ast.Expr) bool {
		sel, ok := e.(*ast.SelectorExpr)
		return ok && (sel.Sel.Name == "status" || sel.Sel.Name == "kind")
	}
	// constName unwraps a string(…) conversion to the constant inside it.
	constName := func(e ast.Expr) string {
		if call, ok := e.(*ast.CallExpr); ok && len(call.Args) == 1 {
			e = call.Args[0]
		}
		if id, ok := e.(*ast.Ident); ok && strings.HasPrefix(id.Name, "pending") {
			return id.Name
		}
		return ""
	}
	var literals []string
	constants := stringSet{}
	check := func(e ast.Expr) {
		if v := strLit(e); v != "" {
			literals = append(literals, strconv.Quote(v))
		} else if name := constName(e); name != "" {
			constants[name] = true
		}
	}
	ast.Inspect(file, func(n ast.Node) bool {
		switch n := n.(type) {
		case *ast.SwitchStmt:
			if isField(n.Tag) {
				for _, stmt := range n.Body.List {
					for _, e := range stmt.(*ast.CaseClause).List {
						check(e)
					}
				}
			}
		case *ast.BinaryExpr:
			if (n.Op == token.EQL || n.Op == token.NEQ) && isField(n.X) {
				check(n.Y)
			}
		case *ast.CallExpr:
			if sel, ok := n.Fun.(*ast.SelectorExpr); ok && sel.Sel.Name == "Set" && len(n.Args) == 2 && strLit(n.Args[0]) == "status" {
				check(n.Args[1])
			}
		}
		return true
	})
	if len(literals) > 0 {
		t.Errorf("pending_requests.go compares or writes pending statuses/kinds as bare strings %v — use the constants in wire_vocab.go", literals)
	}
	requireAtLeast(t, "pending status/kind constants in use", constants, 8)
}

// TestWireParityDocKeys pins the keys the worker reads and writes in the doc.
// `item` is ConversationItem's json tags; every other group is what the source
// uses at a key position (docFlow): a Y.Map key, a key of a Go map holding doc
// state at any depth, or one handed on through a forwarder. A key used without
// being declared fails, and so does a declared key nothing uses any more.
func TestWireParityDocKeys(t *testing.T) {
	m := loadWireManifest(t)
	src := parseWorkerSource(t)
	keys := m.Worker.DocKeys

	tags := stringSet{}
	ct := reflect.TypeOf(ConversationItem{})
	for i := 0; i < ct.NumField(); i++ {
		name, _, _ := strings.Cut(ct.Field(i).Tag.Get("json"), ",")
		if name != "" && name != "-" {
			tags[name] = true
		}
	}
	requireSameSet(t, "ConversationItem json tags (docKeys.item)", tags, setOf(keys.Item...))

	used, meta := stringSet{}, stringSet{}
	newDocFlow(src).keyPositions(func(_ string, e ast.Expr, via string) {
		v := src.keyArg(e)
		switch {
		case v == "":
		case metadataMethods[via]:
			meta[v] = true
		default:
			used[v] = true
		}
	})
	requireAtLeast(t, "doc keys", used, 100)
	requireAtLeast(t, "metadata keys", meta, 5)

	groups := map[string][]string{
		"itemUntyped":          keys.ItemUntyped.Keys,
		"modelConfig":          keys.ModelConfig,
		"pendingItem":          keys.PendingItem,
		"processingState":      keys.ProcessingState,
		"toolResult":           keys.ToolResult,
		"errorData":            keys.ErrorData,
		"compactionAccounting": keys.CompactionAccounting,
		"undoState":            keys.UndoState,
		"displayData":          keys.DisplayData,
	}
	usedOrMeta := stringSet{}
	maps.Copy(usedOrMeta, used)
	maps.Copy(usedOrMeta, meta)
	declared := setOf(keys.Item...)
	maps.Copy(declared, setOf(keys.Metadata...))
	for name, group := range groups {
		maps.Copy(declared, setOf(group...))
		if stale := setOf(group...).missingFrom(usedOrMeta); len(stale) > 0 {
			t.Errorf("docKeys.%s declares %v, which the worker no longer uses", name, stale)
		}
	}
	if undeclared := used.missingFrom(declared); len(undeclared) > 0 {
		t.Errorf("the worker uses doc keys %v, which %s does not declare under worker.docKeys", undeclared, wireFixture)
	}
	if extra := meta.missingFrom(setOf(keys.Metadata...)); len(extra) > 0 {
		t.Errorf("the worker uses metadata keys %v, which docKeys.metadata does not declare", extra)
	}
	if stale := setOf(keys.Metadata...).missingFrom(usedOrMeta); len(stale) > 0 {
		t.Errorf("docKeys.metadata declares %v, which the worker no longer uses", stale)
	}

	for _, f := range runProjectedFields {
		if !slices.Contains(keys.ProcessingState, f) {
			t.Errorf("runProjectedFields has %q, which docKeys.processingState does not declare", f)
		}
	}
}

// TestWireParityDocKeysAreConstants requires every key position in the worker
// (docFlow: the keys of Y.Maps and of every Go map that is or becomes doc state,
// and the arguments of the forwarders it derives) to be named by a key constant
// (isDocKeyConst), so the constants are the whole of the worker's key
// vocabulary and TestWireParityDocKeys compares that vocabulary, not a scan for
// spellings. A string literal fails, including one reaching the position
// through a local variable, and so does any other package constant.
func TestWireParityDocKeysAreConstants(t *testing.T) {
	src := parseWorkerSource(t)

	for name := range metadataMethods {
		if !src.funcHasStringParam(name, 0) {
			t.Errorf("metadataMethods has %q, but no function %s takes a string key first", name, name)
		}
	}

	var bad []string
	seen := map[ast.Expr]bool{}
	newDocFlow(src).keyPositions(func(file string, e ast.Expr, _ string) {
		if seen[e] {
			return
		}
		seen[e] = true
		pos := src.fset.Position(e.Pos())
		switch a := e.(type) {
		case *ast.BasicLit:
			if a.Kind == token.STRING {
				bad = append(bad, fmt.Sprintf("%s:%d: key %s is a literal", file, pos.Line, a.Value))
			}
		case *ast.Ident:
			if src.otherConsts[a.Name] {
				bad = append(bad, fmt.Sprintf("%s:%d: key %s is a constant that is not a key constant", file, pos.Line, a.Name))
			}
		}
	})
	sort.Strings(bad)
	for _, b := range bad {
		t.Error(b + " — name it with a " + docKeysFile + " constant, or a meta* one beside the feature that owns it, and declare it in " + wireFixture + " under worker.docKeys")
	}
}

// funcHasStringParam reports whether a function or method called name exists
// with a string parameter at index i.
func (s workerSource) funcHasStringParam(name string, i int) bool {
	found := false
	s.inspect(func(_ string, n ast.Node) bool {
		fd, ok := n.(*ast.FuncDecl)
		if !ok || fd.Name.Name != name {
			return true
		}
		idx := 0
		for _, field := range fd.Type.Params.List {
			names := len(field.Names)
			if names == 0 {
				names = 1
			}
			for range names {
				if idx == i {
					if id, ok := field.Type.(*ast.Ident); ok && id.Name == "string" {
						found = true
					}
				}
				idx++
			}
		}
		return false
	})
	return found
}

// TestWireParityValidationCodes pins the codes a validation-error status
// carries, and which of them bounce the send. The client hands the message back
// to the composer for a bounced code only (llm-state.js, held to the same
// manifest by the JS half): handing it back after a turn that ran would put an
// already-sent message in the box. A code is bounced when it is raised inside
// handleSendMessage, which refuses before the user item is written; every
// other site reports a turn that already holds the message.
func TestWireParityValidationCodes(t *testing.T) {
	m := loadWireManifest(t)
	src := parseWorkerSource(t)

	found := map[string]bool{} // code → bounced
	for name := range src.files {
		for _, decl := range src.files[name].Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			inSend := fn.Name.Name == "handleSendMessage"
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				switch n := n.(type) {
				case *ast.CallExpr:
					sel, ok := n.Fun.(*ast.SelectorExpr)
					if ok && sel.Sel.Name == "sendStatusWithCode" && len(n.Args) == 4 && strLit(n.Args[0]) == string(statusValidationError) {
						if code := strLit(n.Args[3]); code != "" {
							found[code] = inSend
						}
					}
				case *ast.CompositeLit:
					if id, ok := n.Type.(*ast.Ident); ok && id.Name == "userFixableFailure" {
						for _, elt := range n.Elts {
							if kv, ok := elt.(*ast.KeyValueExpr); ok {
								if key, ok := kv.Key.(*ast.Ident); ok && key.Name == "code" {
									if code := strLit(kv.Value); code != "" {
										found[code] = false
									}
								}
							}
						}
					}
				}
				return true
			})
		}
	}
	codes := stringSet{}
	for code := range found {
		codes[code] = true
	}
	requireAtLeast(t, "validation codes", codes, 3)

	declared := stringSet{}
	for _, c := range m.Worker.ValidationCodes.Codes {
		declared[c.Code] = true
		if bounced, ok := found[c.Code]; ok && bounced != c.Bounced {
			t.Errorf("validation code %q: %s says bounced %v, but the worker raises it %s", c.Code, wireFixture, c.Bounced,
				map[bool]string{true: "in handleSendMessage, before the user item is written", false: "after the turn has the message"}[bounced])
		}
	}
	requireSameSet(t, "validation-error codes", codes, declared)
}
