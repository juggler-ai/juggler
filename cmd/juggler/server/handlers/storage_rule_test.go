//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"os"
	"sort"
	"strconv"
	"strings"
	"testing"
)

// The structural guard on doc.go's rule: a handler writes no file and names no
// storage location. What Juggler keeps on disk is core's to lay out and write.

// writeCalls are the os functions that change the filesystem.
var writeCalls = map[string]bool{
	"WriteFile": true, "Mkdir": true, "MkdirAll": true, "MkdirTemp": true,
	"Create": true, "CreateTemp": true, "OpenFile": true,
	"Remove": true, "RemoveAll": true, "Rename": true,
	"Chmod": true, "Chtimes": true, "Symlink": true, "Link": true, "Truncate": true,
}

// storageRoots are the calls that locate Juggler's own storage outside a
// project: asking for one is the first step of deciding where something lives.
// os.UserHomeDir is not among them, because the handlers ask it to expand a `~`
// in a path the user typed.
var storageRoots = map[string]map[string]bool{
	"userpaths": {"ConfigDir": true, "CacheDir": true},
}

// storageDirNames are the dot-directories Juggler stores things in inside a
// project or a home directory. A handler joining one is laying out storage.
var storageDirNames = map[string]bool{".juggler": true, ".agents": true}

// writeExemptions are the write sites that are not storage, keyed
// "<file>:<func>". Each one writes the thing the request is about.
var writeExemptions = map[string]string{
	// The folder the user typed into the New Project dialog: their project,
	// created because they asked for exactly that folder.
	"project.go:HandleNewProject": "creates the user's own project folder",
}

func TestHandlersHoldNoStorage(t *testing.T) {
	entries, err := os.ReadDir(".")
	if err != nil {
		t.Fatalf("read handlers dir: %v", err)
	}
	fset := token.NewFileSet()
	var violations []string
	files, osReads := 0, 0
	exemptionsSeen := map[string]bool{}

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

		for _, decl := range parsed.Decls {
			funcName := ""
			if fn, ok := decl.(*ast.FuncDecl); ok {
				funcName = fn.Name.Name
			}
			at := func(n ast.Node) string { return fmt.Sprintf("%s:%d", name, fset.Position(n.Pos()).Line) }

			ast.Inspect(decl, func(n ast.Node) bool {
				call, ok := n.(*ast.CallExpr)
				if !ok {
					return true
				}
				sel, ok := call.Fun.(*ast.SelectorExpr)
				if !ok {
					return true
				}
				pkg, ok := sel.X.(*ast.Ident)
				if !ok {
					return true
				}
				switch {
				case pkg.Name == "os" && writeCalls[sel.Sel.Name]:
					key := name + ":" + funcName
					if _, exempt := writeExemptions[key]; exempt {
						exemptionsSeen[key] = true
						return true
					}
					violations = append(violations, fmt.Sprintf(
						"%s (%s) calls os.%s — a handler writes nothing; move the write into core", at(call), funcName, sel.Sel.Name))
				case storageRoots[pkg.Name][sel.Sel.Name]:
					violations = append(violations, fmt.Sprintf(
						"%s (%s) calls %s.%s — where Juggler stores things is core's to say", at(call), funcName, pkg.Name, sel.Sel.Name))
				case pkg.Name == "os":
					osReads++
				case pkg.Name == "filepath" && sel.Sel.Name == "Join":
					for _, arg := range call.Args {
						lit, ok := arg.(*ast.BasicLit)
						if !ok || lit.Kind != token.STRING {
							continue
						}
						if v, err := strconv.Unquote(lit.Value); err == nil && storageDirNames[v] {
							violations = append(violations, fmt.Sprintf(
								"%s (%s) joins %q — a storage path is core's to build", at(lit), funcName, v))
						}
					}
				}
				return true
			})
		}
	}

	sort.Strings(violations)
	for _, v := range violations {
		t.Errorf("%s", v)
	}

	// Every assertion above is a scan finding nothing, so prove the scan reads
	// the package and recognises the calls it is looking for.
	if files < 12 {
		t.Fatalf("only %d production files parsed in handlers/ — the scan has stopped seeing the package", files)
	}
	if osReads < 5 {
		t.Fatalf("saw %d os.* read calls in handlers/ — the files and git handlers make many, so the selector "+
			"match has stopped working and this test passes by not looking", osReads)
	}
	for key, why := range writeExemptions {
		if !exemptionsSeen[key] {
			t.Errorf("exemption %s (%s) matched no write — delete it", key, why)
		}
	}
}
