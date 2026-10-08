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
)

// schedulerFieldsOnWorker are the names the run scheduler's state carries, or
// carried as loose ConversationWorker fields. None of them may be declared on
// the worker.
var schedulerFieldsOnWorker = []string{
	"needsReconcile", "reconcileRequest", "reconcileBit", "reconcileWake",
	"threadDispatch", "dispatchQueue", "turnRetired", "retiredQueue",
	"liveRunsPtr", "liveRegistry", "turnBoundaries", "activityAsserted",
}

// TestRunSchedulerOwnsItsState pins the run scheduler as an object rather than
// a group of worker fields. Its state — the reconcile bit, the run loop's three
// hand-offs, the live-run registry, the turn boundaries and the App Nap
// assertion — is read and written by runScheduler's own methods in
// run_scheduler.go and nowhere else in production code. The worker holds it as
// one named field, `sched`, and declares none of it, so no worker method can
// reach the state by its bare name.
//
// A source walk, so it needs nothing of the types it names to compile.
func TestRunSchedulerOwnsItsState(t *testing.T) {
	fset := token.NewFileSet()
	state := map[string]bool{}
	ownerUses := 0
	if owner, err := parser.ParseFile(fset, "run_scheduler.go", nil, 0); err == nil {
		state = structFieldNames(owner, "runScheduler")
		ast.Inspect(owner, func(n ast.Node) bool {
			if sel, ok := n.(*ast.SelectorExpr); ok && state[sel.Sel.Name] {
				ownerUses++
			}
			return true
		})
	}
	if len(state) < 6 {
		t.Errorf("run_scheduler.go declares a runScheduler of only %d fields (%v); the scheduler's state is not in one place", len(state), state)
	} else if ownerUses < len(state) {
		t.Fatalf("run_scheduler.go reads its own state only %d times — the selector walk is not recognising it", ownerUses)
	}

	// The worker's old loose names are forbidden as selectors too, so the walk
	// catches a reach into scheduler state whatever it happens to be called.
	forbidden := map[string]bool{}
	for name := range state {
		forbidden[name] = true
	}
	for _, name := range schedulerFieldsOnWorker {
		forbidden[name] = true
	}

	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	scanned := 0
	sawWorker := false
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") || f == "run_scheduler.go" {
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
				if forbidden[n.Sel.Name] {
					t.Errorf("%s: %s reaches run-scheduler state from outside run_scheduler.go; give runScheduler a method instead",
						fset.Position(n.Pos()), types.ExprString(n))
				}
			case *ast.TypeSpec:
				if n.Name.Name == "ConversationWorker" {
					sawWorker = true
					checkWorkerHoldsScheduler(t, fset, n)
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

// structFieldNames returns the field names of the struct type typeName
// declared in file, or an empty set if it declares none.
func structFieldNames(file *ast.File, typeName string) map[string]bool {
	fields := map[string]bool{}
	ast.Inspect(file, func(n ast.Node) bool {
		spec, ok := n.(*ast.TypeSpec)
		if !ok || spec.Name.Name != typeName {
			return true
		}
		if st, ok := spec.Type.(*ast.StructType); ok {
			for _, field := range st.Fields.List {
				for _, name := range field.Names {
					fields[name.Name] = true
				}
			}
		}
		return false
	})
	return fields
}

// checkWorkerHoldsScheduler fails unless ConversationWorker holds the scheduler
// as the named field `sched` and declares none of its state itself.
func checkWorkerHoldsScheduler(t *testing.T, fset *token.FileSet, spec *ast.TypeSpec) {
	t.Helper()
	st, ok := spec.Type.(*ast.StructType)
	if !ok {
		t.Fatal("ConversationWorker is not a struct")
	}
	banned := map[string]bool{}
	for _, name := range schedulerFieldsOnWorker {
		banned[name] = true
	}
	held := false
	for _, field := range st.Fields.List {
		typ := types.ExprString(field.Type)
		if len(field.Names) == 0 && strings.TrimPrefix(typ, "*") == "runScheduler" {
			t.Errorf("%s: ConversationWorker embeds runScheduler, which puts its fields on the worker's receiver",
				fset.Position(field.Pos()))
		}
		for _, name := range field.Names {
			if banned[name.Name] {
				t.Errorf("%s: ConversationWorker declares %s; scheduler state belongs on runScheduler",
					fset.Position(name.Pos()), name.Name)
			}
			if name.Name == "sched" && typ == "runScheduler" {
				held = true
			}
		}
	}
	if !held {
		t.Error("ConversationWorker has no `sched runScheduler` field")
	}
}
