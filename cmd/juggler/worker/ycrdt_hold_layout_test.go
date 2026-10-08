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

// blindRetakes are the calls that act on the doc without looking at it again:
// taking ycrdtMu by hand, and the by-id tool-action write, which sets its fields
// on whatever it finds. Each is fine on its own. After a released hold it acts
// on a decision that hold made, and a sync update can have landed in between: a
// result written (so a reset re-runs a finished tool), an approval given (so a
// reset wipes it), a resolved map tombstoned.
var blindRetakes = map[string]bool{
	"UpdateToolActionFieldsRecursive": true,
}

// TestYcrdtHoldIsNotReleasedAndRetaken pins the rule that a decision about the
// doc and the write that acts on it share one ycrdtMu hold. A function that
// checks under the lock, releases it, and then writes blind has acted on a hold
// that has ended. The cure is to check again where the write happens:
// updateToolActionsWhere decides and writes in one hold, and so does
// finalizeStuckRunningToolOnField, which is why calling either after a release
// is not a retake. A lock-held variant (stopCapturingLocked) serves a call that
// would otherwise force the release.
//
// A source walk. A release is a plain ycrdtMu.Unlock() statement that is not the
// early exit of its block (an Unlock directly followed by return); a retake is
// any later ycrdtMu.Lock() or call named in blindRetakes.
func TestYcrdtHoldIsNotReleasedAndRetaken(t *testing.T) {
	fset := token.NewFileSet()
	paths, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	scanned := 0
	for _, p := range paths {
		if strings.HasSuffix(p, "_test.go") {
			continue
		}
		f, err := parser.ParseFile(fset, p, nil, 0)
		if err != nil {
			t.Fatalf("parsing %s: %v", p, err)
		}
		scanned++
		for _, d := range f.Decls {
			fn, ok := d.(*ast.FuncDecl)
			if !ok || fn.Body == nil {
				continue
			}
			first := firstFallThroughUnlock(fn.Body)
			if first == token.NoPos {
				continue
			}
			ast.Inspect(fn.Body, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok || call.Pos() <= first {
					return true
				}
				if isYcrdtMuCall(call, "Lock") || blindRetakes[calleeName(call)] {
					t.Errorf("%s: %s releases ycrdtMu at %s and then writes blind (%s); "+
						"decide and write in one hold",
						fset.Position(call.Pos()), fn.Name.Name, fset.Position(first), calleeName(call))
					return false
				}
				return true
			})
		}
	}
	if scanned < 50 {
		t.Fatalf("scanned only %d production files; the glob is not seeing the package", scanned)
	}
}

// firstFallThroughUnlock returns the position of the earliest ycrdtMu.Unlock()
// statement in body after which execution carries on, or token.NoPos. An Unlock
// followed directly by a return is an early exit and does not count.
func firstFallThroughUnlock(body *ast.BlockStmt) token.Pos {
	first := token.NoPos
	ast.Inspect(body, func(n ast.Node) bool {
		var list []ast.Stmt
		switch n := n.(type) {
		case *ast.BlockStmt:
			list = n.List
		case *ast.CaseClause:
			list = n.Body
		case *ast.CommClause:
			list = n.Body
		case *ast.FuncLit:
			return false // a closure's hold is its own
		default:
			return true
		}
		for i, s := range list {
			es, ok := s.(*ast.ExprStmt)
			if !ok {
				continue
			}
			call, ok := es.X.(*ast.CallExpr)
			if !ok || !isYcrdtMuCall(call, "Unlock") {
				continue
			}
			if i+1 < len(list) {
				if _, ret := list[i+1].(*ast.ReturnStmt); ret {
					continue
				}
			}
			if first == token.NoPos || call.Pos() < first {
				first = call.Pos()
			}
		}
		return true
	})
	return first
}

func isYcrdtMuCall(call *ast.CallExpr, method string) bool {
	sel, ok := call.Fun.(*ast.SelectorExpr)
	if !ok || sel.Sel.Name != method {
		return false
	}
	id, ok := sel.X.(*ast.Ident)
	return ok && id.Name == "ycrdtMu"
}
