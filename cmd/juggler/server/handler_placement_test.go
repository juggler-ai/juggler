//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"sort"
	"strings"
	"testing"
)

// pageServingHandlers serve pages and static assets, which handlers/doc.go
// keeps in package server whatever they read.
var pageServingHandlers = map[string]string{
	"serveTestPool":      "the browser-test pool's host page",
	"handleWailsRuntime": "the embedded @wailsio/runtime bundle",
}

// handlerPlacementExceptions are the *Server route handlers that read no server
// state and have not yet moved to package handlers. Entries may be removed,
// never added: a new handler that reads nothing the server owns is written in
// handlers from the start.
var handlerPlacementExceptions = map[string]string{
	"handleListLogs":   "lays out the log directory itself; the listing belongs in internal/logpaths first",
	"handleLogContent": "resolves and windows log files itself; that belongs in internal/logpaths first",
	"handleVersion":    "needs RendezvousProtocolVersion injected",
	"handleDefaultModel": "needs only resolveDefaultModel, which SessionAPI already receives; " +
		"wants a model-preferences API together with the four below",
	"handleSetDefaultModel":  "reads only defaultModelStore",
	"handleSetCheapModel":    "reads only cheapModelStore",
	"handleRecentModels":     "reads only recentModelsStore",
	"handleRecentModelsGet":  "reads only recentModelsStore",
	"handleRecentModelsPost": "reads only recentModelsStore",
}

// TestServerHandlersReadServerState is the structural guard on the placement
// rule in handlers/doc.go: a route handler is a method on *Server only when it
// reads the server's own running state. A handler whose every use of the
// receiver is a serverStores field, or a member the server already hands to a
// handlers constructor, could be built in handlers with those injected, so it
// belongs there.
//
// Both sets are derived from the code rather than listed here: the stores are
// the fields of serverStores, and the injected members are every s.X passed as
// an argument to a handlers.New* call. A handler that calls another handler
// method is judged on the union of what both read.
func TestServerHandlersReadServerState(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read server dir: %v", err)
	}
	fset := token.NewFileSet()

	stores := map[string]bool{}
	injected := map[string]bool{}
	// uses holds, per handler, the receiver members it selects; calls the
	// handler-shaped methods it reaches through the receiver.
	uses := map[string]map[string]bool{}
	files := 0

	var decls []*ast.FuncDecl
	for _, entry := range entries {
		name := entry.Name()
		if entry.IsDir() || !strings.HasSuffix(name, ".go") || strings.HasSuffix(name, "_test.go") {
			continue
		}
		parsed, err := parser.ParseFile(fset, name, nil, 0)
		if err != nil {
			t.Fatalf("parse %s: %v", name, err)
		}
		files++
		ast.Inspect(parsed, func(n ast.Node) bool {
			switch n := n.(type) {
			case *ast.TypeSpec:
				if st, ok := n.Type.(*ast.StructType); ok && n.Name.Name == "serverStores" {
					for _, f := range st.Fields.List {
						for _, id := range f.Names {
							stores[id.Name] = true
						}
					}
				}
			case *ast.CallExpr:
				sel, ok := n.Fun.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				if pkg, ok := sel.X.(*ast.Ident); !ok || pkg.Name != "handlers" || !strings.HasPrefix(sel.Sel.Name, "New") {
					return true
				}
				for _, arg := range n.Args {
					if c, ok := arg.(*ast.CallExpr); ok {
						arg = c.Fun
					}
					if s, ok := arg.(*ast.SelectorExpr); ok {
						if _, ok := s.X.(*ast.Ident); ok {
							injected[s.Sel.Name] = true
						}
					}
				}
			case *ast.FuncDecl:
				if isServerHandler(n) {
					decls = append(decls, n)
				}
			}
			return true
		})
	}

	handlerNames := map[string]bool{}
	for _, fn := range decls {
		handlerNames[fn.Name.Name] = true
	}
	for _, fn := range decls {
		recv := fn.Recv.List[0].Names[0].Name
		set := map[string]bool{}
		ast.Inspect(fn.Body, func(n ast.Node) bool {
			if sel, ok := n.(*ast.SelectorExpr); ok {
				if id, ok := sel.X.(*ast.Ident); ok && id.Name == recv {
					set[sel.Sel.Name] = true
				}
			}
			return true
		})
		uses[fn.Name.Name] = set
	}

	// readsState reports whether the handler, or a handler it calls, selects a
	// receiver member that is neither a store nor already injected.
	var readsState func(name string, seen map[string]bool) bool
	readsState = func(name string, seen map[string]bool) bool {
		if seen[name] {
			return false
		}
		seen[name] = true
		for member := range uses[name] {
			if handlerNames[member] {
				if readsState(member, seen) {
					return true
				}
				continue
			}
			if !stores[member] && !injected[member] {
				return true
			}
		}
		return false
	}

	var violations []string
	exceptionsSeen := map[string]bool{}
	for _, fn := range decls {
		name := fn.Name.Name
		if _, ok := pageServingHandlers[name]; ok || readsState(name, map[string]bool{}) {
			continue
		}
		if _, ok := handlerPlacementExceptions[name]; ok {
			exceptionsSeen[name] = true
			continue
		}
		violations = append(violations, fset.Position(fn.Pos()).String()+" "+name+
			" reads no server state — build it in package handlers (see handlers/doc.go)")
	}
	sort.Strings(violations)
	for _, v := range violations {
		t.Error(v)
	}
	for name, why := range handlerPlacementExceptions {
		if !exceptionsSeen[name] {
			t.Errorf("exception %s (%s) no longer matches a handler that reads no server state — delete it", name, why)
		}
	}
	for name, what := range pageServingHandlers {
		if !handlerNames[name] {
			t.Errorf("page-serving entry %s (%s) names no *Server handler — delete it", name, what)
		}
	}

	// Every assertion above is a scan finding nothing, so prove the scan sees
	// the package, the two derived sets, and a handler that does read state.
	if files < 30 || len(decls) < 30 {
		t.Fatalf("parsed %d files and %d *Server handlers — the scan has stopped seeing the package", files, len(decls))
	}
	if !stores["defaultModelStore"] {
		t.Fatalf("serverStores fields not found (got %v) — the store set has stopped being derived", stores)
	}
	if !injected["ProjectPath"] {
		t.Fatalf("s.ProjectPath not seen as a handlers.New* argument (got %v) — the injected set has stopped being derived", injected)
	}
	if !handlerNames["handleEngineStatus"] || !readsState("handleEngineStatus", map[string]bool{}) {
		t.Fatalf("handleEngineStatus, which reads the engine client, was not judged to read server state")
	}
}

// isServerHandler reports whether fn is a method on *Server with the
// http.HandlerFunc signature.
func isServerHandler(fn *ast.FuncDecl) bool {
	if fn.Recv == nil || len(fn.Recv.List) != 1 || len(fn.Recv.List[0].Names) != 1 {
		return false
	}
	star, ok := fn.Recv.List[0].Type.(*ast.StarExpr)
	if !ok {
		return false
	}
	if id, ok := star.X.(*ast.Ident); !ok || id.Name != "Server" {
		return false
	}
	params := fn.Type.Params.List
	if len(params) != 2 || fn.Type.Results != nil {
		return false
	}
	return selectorIs(params[0].Type, "http", "ResponseWriter") && isStarSelector(params[1].Type, "http", "Request")
}

func selectorIs(e ast.Expr, pkg, name string) bool {
	sel, ok := e.(*ast.SelectorExpr)
	if !ok {
		return false
	}
	id, ok := sel.X.(*ast.Ident)
	return ok && id.Name == pkg && sel.Sel.Name == name
}

func isStarSelector(e ast.Expr, pkg, name string) bool {
	star, ok := e.(*ast.StarExpr)
	return ok && selectorIs(star.X, pkg, name)
}
