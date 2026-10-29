//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"go/ast"
	"go/build/constraint"
	"go/parser"
	"go/token"
	"path/filepath"
	"strings"
	"testing"
)

// testOnlyNames are declarations that exist for tests to reach into a worker.
// They belong behind the !production build tag, beside worker_test_support.go,
// so a release binary carries neither them nor the branches that consult them.
var testOnlyNames = map[string]bool{
	"HasPendingItems":      true, // a test's wait for a busy-time send to queue
	"hasPendingItems":      true,
	"mockLLMCaller":        true, // the scripted provider
	"callLLMMockWithSink":  true,
	"popMockResponse":      true,
	"announceMockPause":    true,
	"setMockResponses":     true,
	"handleSetMockMessage": true,
}

// processSwitches are package-level variables that are the process's by
// design, which a test may set (and restores). tracingEnabled is JUGGLER_TRACE:
// a switch for the whole process, read once at start.
var processSwitches = map[string]bool{
	"tracingEnabled": true,
}

// TestTestHooksStayOutOfProductionBuilds pins the line between the worker and
// its test hooks. In the files a production build compiles it finds no
// declaration named for tests (…ForTest, or one listed in testOnlyNames), and no
// package-level time.Duration variable — a timeout that is a var is a knob a
// test can turn for every worker in the process at once, so it is a const, or a
// field of the worker that wants it changed. And no test assigns a
// package-level variable that production code declares.
//
// A source walk: build constraints are evaluated with the production tag set.
func TestTestHooksStayOutOfProductionBuilds(t *testing.T) {
	fset := token.NewFileSet()
	paths, err := filepath.Glob("*.go")
	if err != nil {
		t.Fatal(err)
	}
	productionVars := map[string]string{} // name → file
	var tests []*ast.File
	scanned := 0
	for _, p := range paths {
		f, err := parser.ParseFile(fset, p, nil, parser.ParseComments)
		if err != nil {
			t.Fatalf("parsing %s: %v", p, err)
		}
		if strings.HasSuffix(p, "_test.go") {
			tests = append(tests, f)
			continue
		}
		if !builtInProduction(t, f) {
			continue
		}
		scanned++
		for _, d := range f.Decls {
			switch d := d.(type) {
			case *ast.FuncDecl:
				checkTestOnlyName(t, fset, d.Name)
			case *ast.GenDecl:
				for _, spec := range d.Specs {
					switch s := spec.(type) {
					case *ast.TypeSpec:
						checkTestOnlyName(t, fset, s.Name)
					case *ast.ValueSpec:
						for i, name := range s.Names {
							checkTestOnlyName(t, fset, name)
							if d.Tok != token.VAR {
								continue
							}
							productionVars[name.Name] = p
							if isDurationVar(s, i) {
								t.Errorf("%s: %s is a package-level time.Duration var; make it a const, or a field of the worker that needs it changed",
									fset.Position(name.Pos()), name.Name)
							}
						}
					}
				}
			}
		}
	}
	if scanned < 50 {
		t.Fatalf("scanned only %d production files; the glob is not seeing the package", scanned)
	}

	for _, f := range tests {
		ast.Inspect(f, func(n ast.Node) bool {
			as, ok := n.(*ast.AssignStmt)
			if !ok || as.Tok != token.ASSIGN {
				return true
			}
			for _, lhs := range as.Lhs {
				if id, ok := lhs.(*ast.Ident); ok && productionVars[id.Name] != "" && !processSwitches[id.Name] {
					t.Errorf("%s: a test assigns %s, which %s declares at package level and every worker in the process reads",
						fset.Position(id.Pos()), id.Name, productionVars[id.Name])
				}
			}
			return true
		})
	}
}

// builtInProduction reports whether f is compiled into a production build.
func builtInProduction(t *testing.T, f *ast.File) bool {
	t.Helper()
	for _, group := range f.Comments {
		if group.Pos() >= f.Package {
			break
		}
		for _, c := range group.List {
			if !constraint.IsGoBuild(c.Text) {
				continue
			}
			expr, err := constraint.Parse(c.Text)
			if err != nil {
				t.Fatalf("parsing build constraint %q: %v", c.Text, err)
			}
			return expr.Eval(func(tag string) bool { return tag == "production" })
		}
	}
	return true
}

func checkTestOnlyName(t *testing.T, fset *token.FileSet, name *ast.Ident) {
	t.Helper()
	if strings.HasSuffix(name.Name, "ForTest") || testOnlyNames[name.Name] {
		t.Errorf("%s: %s is a test hook compiled into production builds; move it behind the !production build tag",
			fset.Position(name.Pos()), name.Name)
	}
}

// isDurationVar reports whether the i'th name of s is declared as a
// time.Duration, by type or by a value written as a multiple of a time unit.
func isDurationVar(s *ast.ValueSpec, i int) bool {
	if s.Type != nil {
		sel, ok := s.Type.(*ast.SelectorExpr)
		return ok && sel.Sel.Name == "Duration"
	}
	if i >= len(s.Values) {
		return false
	}
	found := false
	ast.Inspect(s.Values[i], func(n ast.Node) bool {
		if sel, ok := n.(*ast.SelectorExpr); ok {
			if x, ok := sel.X.(*ast.Ident); ok && x.Name == "time" {
				switch sel.Sel.Name {
				case "Nanosecond", "Microsecond", "Millisecond", "Second", "Minute", "Hour":
					found = true
				}
			}
		}
		return !found
	})
	return found
}
