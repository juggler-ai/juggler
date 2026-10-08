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

// workerSeam is one piece of ConversationWorker state that is an object of its
// own: a type declared in ownerFile, held by the worker as the named field
// workerField, whose fields only ownerFile reads or writes.
type workerSeam struct {
	typeName    string
	ownerFile   string
	workerField string
	// legacy are the names this state carried as worker fields (loose, or
	// promoted from an embedded group). The worker may not declare them, and no
	// production file may select them, so the state cannot come back under its
	// former name.
	legacy []string
}

// workerSeams lists every seam this test pins. The engine session and the run
// scheduler have guards of their own (TestEngineSessionOwnsItsState,
// TestRunSchedulerOwnsItsState).
var workerSeams = []workerSeam{
	{
		typeName: "livenessClock", ownerFile: "liveness_clock.go", workerField: "liveness",
		legacy: []string{"livenessTicker", "lastLivenessMs"},
	},
	{
		typeName: "undoGrouping", ownerFile: "undo_grouping.go", workerField: "undo",
		legacy: []string{"suppressItemsChange", "suppressReconcileAfterHistoryNavUntilMs",
			"compactionMergeFromIdx", "undoCoalesceFromIdx"},
	},
	{
		typeName: "docSaver", ownerFile: "doc_saver.go", workerField: "saver",
		legacy: []string{"saveTimer", "saveRequest", "saveChan", "dirty", "flushReq"},
	},
	{
		typeName: "reconcileBaselines", ownerFile: "reconcile_baselines.go", workerField: "baselines",
		legacy: []string{"lastReconciledStrategyIDs", "strategyBaselineSet", "sweptDenials", "denialBaselineSet"},
	},
	{
		typeName: "deliveryPumps", ownerFile: "delivery_pumps.go", workerField: "pumps",
		legacy: []string{"deliveryPumps"},
	},
	{
		typeName: "workerInbox", ownerFile: "worker_inbox.go", workerField: "inbox",
		legacy: []string{"inboundQ", "inbound", "replyTo"},
	},
	{
		typeName: "*toolCommandTracker", ownerFile: "tool_command_state.go", workerField: "tools",
		legacy: []string{"redriveInterval"},
	},
}

// TestWorkerSeamsOwnTheirState pins ConversationWorker as a holder of named
// objects rather than a flat bag of fields. For each seam in workerSeams, the
// type's state is read and written by the methods in its own file and nowhere
// else in production code, and the worker holds it by name. The worker embeds
// nothing at all: an embedded group puts its fields on the worker's receiver,
// which groups the declarations and encapsulates nothing.
//
// A source walk, so it needs nothing of the types it names to compile.
func TestWorkerSeamsOwnTheirState(t *testing.T) {
	fset := token.NewFileSet()

	// forbidden maps a selector name to the seam whose state it is.
	forbidden := map[string]string{}
	for _, seam := range workerSeams {
		typeName := strings.TrimPrefix(seam.typeName, "*")
		state := map[string]bool{}
		ownerUses := map[string]int{}
		if owner, err := parser.ParseFile(fset, seam.ownerFile, nil, 0); err == nil {
			state = structFieldNames(owner, typeName)
			ast.Inspect(owner, func(n ast.Node) bool {
				if sel, ok := n.(*ast.SelectorExpr); ok && state[sel.Sel.Name] {
					ownerUses[sel.Sel.Name]++
				}
				return true
			})
		}
		if len(state) == 0 {
			t.Errorf("%s declares no %s struct; that state is not in one place", seam.ownerFile, typeName)
		}
		for name := range state {
			if ownerUses[name] == 0 {
				t.Errorf("%s never reads %s.%s — the selector walk is not recognising it", seam.ownerFile, typeName, name)
			}
			forbidden[name] = typeName
		}
		for _, name := range seam.legacy {
			forbidden[name] = typeName
		}
	}

	owners := map[string]bool{}
	for _, seam := range workerSeams {
		owners[seam.ownerFile] = true
	}

	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	scanned := 0
	sawWorker := false
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
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
				owner, ok := forbidden[n.Sel.Name]
				if !ok {
					return true
				}
				if seamFileFor(owner) == f {
					return true
				}
				t.Errorf("%s: %s reaches %s state from outside %s; give %s a method instead",
					fset.Position(n.Pos()), types.ExprString(n), owner, seamFileFor(owner), owner)
			case *ast.TypeSpec:
				if n.Name.Name == "ConversationWorker" {
					sawWorker = true
					checkWorkerHoldsSeams(t, fset, n)
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

// seamFileFor returns the owner file of the seam whose type is typeName.
func seamFileFor(typeName string) string {
	for _, seam := range workerSeams {
		if strings.TrimPrefix(seam.typeName, "*") == typeName {
			return seam.ownerFile
		}
	}
	return ""
}

// checkWorkerHoldsSeams fails unless ConversationWorker embeds nothing, holds
// every seam under its named field, and declares none of a seam's former names.
func checkWorkerHoldsSeams(t *testing.T, fset *token.FileSet, spec *ast.TypeSpec) {
	t.Helper()
	st, ok := spec.Type.(*ast.StructType)
	if !ok {
		t.Fatal("ConversationWorker is not a struct")
	}
	banned := map[string]string{}
	for _, seam := range workerSeams {
		for _, name := range seam.legacy {
			banned[name] = seam.typeName
		}
	}
	held := map[string]bool{}
	for _, field := range st.Fields.List {
		typ := types.ExprString(field.Type)
		if len(field.Names) == 0 {
			t.Errorf("%s: ConversationWorker embeds %s, which puts its fields on the worker's receiver; hold it by name",
				fset.Position(field.Pos()), typ)
		}
		for _, name := range field.Names {
			if owner, ok := banned[name.Name]; ok {
				t.Errorf("%s: ConversationWorker declares %s; that state belongs on %s",
					fset.Position(name.Pos()), name.Name, owner)
			}
			for _, seam := range workerSeams {
				if name.Name == seam.workerField && typ == seam.typeName {
					held[seam.typeName] = true
				}
			}
		}
	}
	for _, seam := range workerSeams {
		if !held[seam.typeName] {
			t.Errorf("ConversationWorker has no `%s %s` field", seam.workerField, seam.typeName)
		}
	}
}
