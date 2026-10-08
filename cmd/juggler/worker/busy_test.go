//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"go/ast"
	"go/parser"
	"go/token"
	"path/filepath"
	"strings"
	"testing"
)

// isLLMClaimed reports whether some thread is calling the LLM: the projection
// prefers a calling_llm run over an awaiting one, so the top-level activity is
// calling_llm exactly when some thread is. "awaiting_llm" is NOT claimed — it
// means a dispatch is needed. Production never asks this; the claim tests do.
func (w *ConversationWorker) isLLMClaimed() bool {
	return w.getActivity() == ActivityCallingLLM
}

// TestThreadBusyAsksBothRecordsOfOneThread pins the intake gate: a thread is
// busy if it holds a claim in the document OR a live turn is writing to it,
// and a sibling being busy by either record does not make it busy.
func TestThreadBusyAsksBothRecordsOfOneThread(t *testing.T) {
	w := NewConversationWorker("test-thread-busy", "user:test")

	if w.threadBusy("") || w.threadBusy("child-a") {
		t.Fatal("a fresh worker reports a busy thread")
	}

	// The claim alone, with no turn running: a queued dispatch.
	if !w.requestLLM("child-a") {
		t.Fatal("requestLLM refused on a fresh worker")
	}
	if !w.threadBusy("child-a") {
		t.Error("a thread awaiting dispatch is not busy")
	}
	if w.threadBusy("") || w.threadBusy("child-b") {
		t.Error("a claim on child-a made a sibling busy")
	}

	// A live turn alone, with no claim: the window between a pickup taking the
	// thread and its first status frame.
	tr := w.currentRun().beginTurn("child-b")
	if w.threadBusy("child-b") {
		t.Error("a registered turn that has not started is busy")
	}
	tr.storeState(StateProcessing)
	if w.threadActivity("child-b") != ActivityNone {
		t.Fatal("the turn took a claim; this case needs it unclaimed")
	}
	if !w.threadBusy("child-b") {
		t.Error("a thread with a live turn and no claim is not busy")
	}
	if w.threadBusy("") {
		t.Error("a live turn on child-b made the root busy")
	}

	// The ambient turn answers for its own thread, the root.
	w.currentRun().storeState(StateProcessing)
	if !w.threadBusy("") {
		t.Error("the ambient turn running at the root does not make the root busy")
	}
	if w.threadBusy("child-c") {
		t.Error("the ambient turn made an unrelated thread busy")
	}
}

// busyQuestions are the answers to "is something running here?". Each is
// declared in busy.go and nowhere else, so the set can be read in one place and
// a new one cannot be added beside a caller without the file that explains
// which record it reads.
var busyQuestions = []string{
	"threadActivity", "threadActivityLocked", "getActivity", "hasActiveRun",
	"subtreeHasActiveRun", "isActivelyRunning", "anyRunState", "threadBusy",
}

// retiredBusyQuestions were merged away and may not come back in production
// code: threadRunState is threadBusy's live-turn half, and isLLMClaimed has no
// production caller (it is the claim tests' helper above).
var retiredBusyQuestions = []string{"threadRunState", "isLLMClaimed"}

// TestBusyQuestionsLiveInBusyGo pins where the worker's busy answers are
// declared and that the per-thread intake gate is asked by name: no production
// file other than busy.go may declare one of busyQuestions or a retired one,
// or combine a thread's claim with a live-turn read in a condition of its own.
//
// A source walk, so it needs nothing of the types it names to compile.
func TestBusyQuestionsLiveInBusyGo(t *testing.T) {
	want := map[string]bool{}
	for _, name := range busyQuestions {
		want[name] = true
	}
	retired := map[string]bool{}
	for _, name := range retiredBusyQuestions {
		retired[name] = true
	}

	files, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	fset := token.NewFileSet()
	declaredInBusy := map[string]bool{}
	scanned := 0
	for _, f := range files {
		if strings.HasSuffix(f, "_test.go") {
			continue
		}
		file, err := parser.ParseFile(fset, f, nil, 0)
		if err != nil {
			t.Fatalf("parsing %s: %v", f, err)
		}
		scanned++
		for _, decl := range file.Decls {
			fn, ok := decl.(*ast.FuncDecl)
			if !ok || fn.Recv == nil {
				continue
			}
			name := fn.Name.Name
			switch {
			case retired[name]:
				t.Errorf("%s: %s is declared again; it was merged into busy.go (see retiredBusyQuestions)",
					fset.Position(fn.Pos()), name)
			case want[name] && f == "busy.go":
				declaredInBusy[name] = true
			case want[name]:
				t.Errorf("%s: %s is a busy question declared outside busy.go", fset.Position(fn.Pos()), name)
			}
		}
		if f != "busy.go" {
			checkNoHandRolledThreadBusy(t, fset, file)
		}
	}
	if scanned < 20 {
		t.Fatalf("scanned only %d production files — the walk is not seeing the package", scanned)
	}
	for _, name := range busyQuestions {
		if !declaredInBusy[name] {
			t.Errorf("busy.go does not declare %s", name)
		}
	}
}

// checkNoHandRolledThreadBusy fails on an `||` whose operands ask one thread's
// claim (threadActivity) and a live turn's state of a thread (threadRunState,
// a .loadState() or a turn's state.Load()) — threadBusy, written out again, in
// the spelling it replaced or inline. The fold gate in
// compaction.go pairs the root claim with anyRunState, a conversation-wide
// question, and is not this shape.
func checkNoHandRolledThreadBusy(t *testing.T, fset *token.FileSet, file *ast.File) {
	t.Helper()
	ast.Inspect(file, func(n ast.Node) bool {
		bin, ok := n.(*ast.BinaryExpr)
		if !ok || bin.Op != token.LOR {
			return true
		}
		if callsAny(bin, "threadActivity") && callsAny(bin, "threadRunState", "loadState", "Load") {
			t.Errorf("%s: a thread's claim and a live turn's state asked together; call threadBusy",
				fset.Position(bin.Pos()))
		}
		return true
	})
}

// callsAny reports whether n contains a call to a method or function with one
// of the given names.
func callsAny(n ast.Node, names ...string) bool {
	found := false
	ast.Inspect(n, func(m ast.Node) bool {
		call, ok := m.(*ast.CallExpr)
		if !ok {
			return !found
		}
		var name string
		switch fn := call.Fun.(type) {
		case *ast.SelectorExpr:
			name = fn.Sel.Name
		case *ast.Ident:
			name = fn.Name
		}
		for _, want := range names {
			if name == want {
				found = true
			}
		}
		return !found
	})
	return found
}
