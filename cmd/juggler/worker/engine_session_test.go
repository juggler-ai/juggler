//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"go/ast"
	"go/parser"
	"go/token"
	"go/types"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// TestEngineSessionOwnsItsState pins the engine session as an object rather
// than a group of worker fields. Its state — the exec-report fence, the trace
// receipt, the document vector — is read and written by engineSession's own
// methods in engine_session.go and nowhere else in production code. The worker
// holds it as one named field, `engine`, and embeds none of it, so no worker
// method can reach the state by its bare name.
//
// The reply slots are exempt: they are the session's surface, the channels a
// turn registers a request on and a handler delivers an answer to.
func TestEngineSessionOwnsItsState(t *testing.T) {
	fset := token.NewFileSet()
	owner, err := parser.ParseFile(fset, "engine_session.go", nil, 0)
	if err != nil {
		t.Fatalf("parsing engine_session.go: %v", err)
	}
	state := engineSessionStateFields(owner)
	if len(state) < 5 {
		t.Fatalf("engineSession declares only %d state fields (%v) — the walk is not seeing the type", len(state), state)
	}

	ownerUses := 0
	ast.Inspect(owner, func(n ast.Node) bool {
		if sel, ok := n.(*ast.SelectorExpr); ok && state[sel.Sel.Name] {
			ownerUses++
		}
		return true
	})
	if ownerUses < len(state) {
		t.Fatalf("engine_session.go reads its own state only %d times — the selector walk is not recognising it", ownerUses)
	}

	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	scanned := 0
	sawWorker := false
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") || f == "engine_session.go" {
			continue
		}
		file, err := parser.ParseFile(fset, f, nil, 0)
		if err != nil {
			t.Fatalf("parsing %s: %v", f, err)
		}
		scanned++
		ast.Inspect(file, func(n ast.Node) bool {
			switch n := n.(type) {
			case *ast.SelectorExpr:
				if state[n.Sel.Name] {
					t.Errorf("%s: %s reaches engine-session state from outside engine_session.go; give engineSession a method instead",
						fset.Position(n.Pos()), types.ExprString(n))
				}
			case *ast.TypeSpec:
				if n.Name.Name == "ConversationWorker" {
					sawWorker = true
					checkWorkerHoldsEngineSession(t, fset, n)
				}
			}
			return true
		})
	}
	if scanned < 20 {
		t.Fatalf("scanned only %d production files — the walk is not seeing the package", scanned)
	}
	if !sawWorker {
		t.Fatal("never found the ConversationWorker declaration")
	}
}

// engineSessionStateFields returns the names of engineSession's fields that are
// not reply slots.
func engineSessionStateFields(file *ast.File) map[string]bool {
	fields := map[string]bool{}
	ast.Inspect(file, func(n ast.Node) bool {
		spec, ok := n.(*ast.TypeSpec)
		if !ok || spec.Name.Name != "engineSession" {
			return true
		}
		st, ok := spec.Type.(*ast.StructType)
		if !ok {
			return false
		}
		for _, field := range st.Fields.List {
			if types.ExprString(field.Type) == "*replySlot" {
				continue
			}
			for _, name := range field.Names {
				fields[name.Name] = true
			}
		}
		return false
	})
	return fields
}

// checkWorkerHoldsEngineSession fails unless ConversationWorker holds the
// session as the named field `engine` and embeds no engine-shaped group.
func checkWorkerHoldsEngineSession(t *testing.T, fset *token.FileSet, spec *ast.TypeSpec) {
	t.Helper()
	st, ok := spec.Type.(*ast.StructType)
	if !ok {
		t.Fatal("ConversationWorker is not a struct")
	}
	held := false
	for _, field := range st.Fields.List {
		typ := types.ExprString(field.Type)
		if len(field.Names) == 0 && strings.HasPrefix(strings.TrimPrefix(typ, "*"), "engine") {
			t.Errorf("%s: ConversationWorker embeds %s, which puts its fields on the worker's receiver",
				fset.Position(field.Pos()), typ)
		}
		for _, name := range field.Names {
			if strings.HasPrefix(name.Name, "engine") && name.Name != "engine" && name.Name != "engineReadyFunc" {
				t.Errorf("%s: ConversationWorker declares %s; engine state belongs on engineSession",
					fset.Position(name.Pos()), name.Name)
			}
			if name.Name == "engine" && typ == "engineSession" {
				held = true
			}
		}
	}
	if !held {
		t.Error("ConversationWorker has no `engine engineSession` field")
	}
}

// TestEngineSessionAdmitsReportsFromTheAttachedEngineInOrder pins the
// accept-gate on its own, without a worker: a report from anyone but the
// attached engine is refused, so is one that does not advance the sequence, and
// a different engine attaching starts the fence again and forgets the reports
// the old one sent.
func TestEngineSessionAdmitsReportsFromTheAttachedEngineInOrder(t *testing.T) {
	var e engineSession
	now := time.Now()
	report := func(seq int64) *execReport {
		return &execReport{receivedAt: now, sentAtMs: now.UnixMilli(), seq: seq, ids: map[string]int64{}}
	}

	if reason, _ := e.admitReport("viewer", "engine", report(1)); reason != "origin" {
		t.Fatalf("a viewer's report was not refused for its origin: reason %q", reason)
	}
	if reason, _ := e.admitReport("engine", "", report(1)); reason != "origin" {
		t.Fatalf("a report with no engine attached was not refused: reason %q", reason)
	}
	if reason, _ := e.admitReport("engine", "engine", report(3)); reason != "" {
		t.Fatalf("the attached engine's first report was refused: %q", reason)
	}
	reason, last := e.admitReport("engine", "engine", report(3))
	if reason != "seq" || last != 3 {
		t.Fatalf("a replayed report: got reason %q last %d, want seq 3", reason, last)
	}
	if reason, _ := e.admitReport("engine", "engine", report(4)); reason != "" {
		t.Fatalf("an in-order report was refused: %q", reason)
	}
	if !e.reportsCurrent(now) {
		t.Fatal("two fresh accepted reports do not read as current")
	}

	// A new engine: seq 1 is admissible again, and one report is not enough.
	if reason, _ := e.admitReport("engine2", "engine2", report(1)); reason != "" {
		t.Fatalf("a newly attached engine's first report was refused: %q", reason)
	}
	if e.reportsCurrent(now) {
		t.Fatal("the old engine's report still counts toward the new engine's pair")
	}
}
