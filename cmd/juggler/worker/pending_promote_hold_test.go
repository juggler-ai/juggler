//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"go/ast"
	"go/parser"
	"go/token"
	"testing"
)

// A queued message moves from pendingItems to items on a turn's goroutine,
// while the debounced save — and the asset sweep behind it — runs on the run
// loop. Both read or write the document under ycrdtMu, which promises only that
// no two y-crdt calls overlap. So a move made in two holds has a moment when
// the message is in neither array, and a sweep that reads the two arrays in two
// holds can look at each from either side of a move. Either way the message's
// attachment is missing from the live set and its bytes are reclaimed; and a
// thread deleted by a viewer sync in the gap takes the queued messages with it.

// TestPendingMovesAreOneHold pins the two sides of the race to one hold each:
// promotePendingItems moves the queue through a single tracker call and takes
// no lock of its own, and collectLiveAssetIDs reads the whole document through
// a single call.
func TestPendingMovesAreOneHold(t *testing.T) {
	fset := token.NewFileSet()
	fn := func(file, name string) *ast.FuncDecl {
		t.Helper()
		parsed, err := parser.ParseFile(fset, file, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		for _, decl := range parsed.Decls {
			if f, ok := decl.(*ast.FuncDecl); ok && f.Name.Name == name {
				return f
			}
		}
		t.Fatalf("%s: no func %s", file, name)
		return nil
	}

	promote := fn("pending_items.go", "promotePendingItems")
	ast.Inspect(promote.Body, func(n ast.Node) bool {
		if id, ok := n.(*ast.Ident); ok && id.Name == "ycrdtMu" {
			t.Errorf("%s: promotePendingItems takes ycrdtMu itself; the move belongs in one tracker hold",
				fset.Position(id.Pos()))
		}
		return true
	})
	if got := callsOn(promote, "r", "tracker"); got != 1 {
		t.Errorf("promotePendingItems makes %d tracker calls, want exactly 1 (the whole move)", got)
	}

	collect := fn("transaction_gc.go", "collectLiveAssetIDs")
	if got := callsOn(collect, "w", "doc"); got != 1 {
		t.Errorf("collectLiveAssetIDs reads the document in %d calls, want 1: a message moving between "+
			"pendingItems and items can be missed by reads either side of it", got)
	}
}

// callsOn counts calls of the form recv.field.Method(...) in fn.
func callsOn(fn *ast.FuncDecl, recv, field string) int {
	n := 0
	ast.Inspect(fn.Body, func(node ast.Node) bool {
		call, ok := node.(*ast.CallExpr)
		if !ok {
			return true
		}
		method, ok := call.Fun.(*ast.SelectorExpr)
		if !ok {
			return true
		}
		owner, ok := method.X.(*ast.SelectorExpr)
		if !ok || owner.Sel.Name != field {
			return true
		}
		if id, ok := owner.X.(*ast.Ident); ok && id.Name == recv {
			n++
		}
		return true
	})
	return n
}
