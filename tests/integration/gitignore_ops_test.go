//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"

	"juggler/cmd/juggler/ops"
)

// buildGitignoreFixture creates a tree exercising nested .gitignore files, a
// negation-free nested pattern, a nested repo (gitfile variant), and a
// node_modules-style ignored dir. Returns the project root.
func buildGitignoreFixture(t *testing.T) string {
	t.Helper()
	root := t.TempDir()
	write := func(rel, content string) {
		abs := filepath.Join(root, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(abs, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
	}

	write(".gitignore", "*.log\nbuild/\nnode_modules/\n")
	write("app.go", "package app\n// NEEDLE marker\nfunc VisibleSym() {}\n")
	write("src/main.go", "package src\nfunc Bar() {}\n")
	write("keep.log", "NEEDLE in ignored log\n")
	write("build/gen.go", "package build\n// NEEDLE\nfunc IgnoredSym() {}\n")
	write("node_modules/pkg/index.js", "// NEEDLE\n")
	write("sub/.gitignore", "secret.txt\n")
	write("sub/secret.txt", "NEEDLE secret\n")
	write("sub/visible.txt", "NEEDLE visible\n")
	// Nested repo via a .git FILE (submodule/worktree form): outer patterns do
	// not reach its contents, so inner.log is NOT ignored despite the outer
	// *.log; the nested repo's own rule still ignores local.txt.
	write("vendored/.git", "gitdir: /elsewhere/.git/modules/vendored\n")
	write("vendored/.gitignore", "local.txt\n")
	write("vendored/inner.log", "NEEDLE inner\n")
	write("vendored/local.txt", "NEEDLE local\n")

	return root
}

// grepFiles runs grep and returns the set of file paths that matched.
func grepFiles(t *testing.T, root string, params map[string]any) map[string]bool {
	t.Helper()
	searchOps := ops.NewSearchOperations(ops.NewPathScope(root, nil))
	res, err := searchOps.Execute(context.Background(), "grep", params)
	if err != nil {
		t.Fatalf("grep failed: %v", err)
	}
	m := res.(map[string]any)
	matches := m["matches"].([]map[string]any)
	files := map[string]bool{}
	for _, match := range matches {
		files[match["file"].(string)] = true
	}
	return files
}

func TestGrepRespectsGitignore(t *testing.T) {
	root := buildGitignoreFixture(t)

	def := grepFiles(t, root, map[string]any{"pattern": "NEEDLE"})
	// Present: not ignored.
	for _, f := range []string{"app.go", "sub/visible.txt", "vendored/inner.log"} {
		if !def[f] {
			t.Errorf("default grep should include %q, got %v", f, def)
		}
	}
	// Absent: ignored by some .gitignore (or the nested repo's own rule).
	for _, f := range []string{"keep.log", "build/gen.go", "sub/secret.txt", "vendored/local.txt", "node_modules/pkg/index.js"} {
		if def[f] {
			t.Errorf("default grep should skip ignored %q", f)
		}
	}

	all := grepFiles(t, root, map[string]any{"pattern": "NEEDLE", "noIgnore": true})
	for _, f := range []string{"keep.log", "build/gen.go", "sub/secret.txt", "vendored/local.txt"} {
		if !all[f] {
			t.Errorf("noIgnore grep should include %q, got %v", f, all)
		}
	}
}

// globFiles runs glob and returns the set of matched paths.
func globFiles(t *testing.T, root string, params map[string]any) map[string]bool {
	t.Helper()
	treeOps := ops.NewTreeOperations(ops.NewPathScope(root, nil))
	res, err := treeOps.Execute(context.Background(), "glob", params)
	if err != nil {
		t.Fatalf("glob failed: %v", err)
	}
	m := res.(map[string]any)
	out := map[string]bool{}
	for _, f := range m["files"].([]string) {
		out[f] = true
	}
	return out
}

func TestGlobRespectsGitignore(t *testing.T) {
	root := buildGitignoreFixture(t)

	// *.go: build/gen.go lives in a pruned directory by default.
	def := globFiles(t, root, map[string]any{"pattern": "**/*.go"})
	if !def["app.go"] || !def["src/main.go"] {
		t.Errorf("default glob should include tracked .go files, got %v", def)
	}
	if def["build/gen.go"] {
		t.Errorf("default glob should prune ignored build/, got %v", def)
	}

	all := globFiles(t, root, map[string]any{"pattern": "**/*.go", "noIgnore": true})
	if !all["build/gen.go"] {
		t.Errorf("noIgnore glob should include build/gen.go, got %v", all)
	}

	// *.log: keep.log is ignored; vendored/inner.log is inside a nested repo so
	// the outer *.log does not reach it.
	logs := globFiles(t, root, map[string]any{"pattern": "**/*.log"})
	if logs["keep.log"] {
		t.Errorf("default glob should skip ignored keep.log, got %v", logs)
	}
	if !logs["vendored/inner.log"] {
		t.Errorf("default glob should include vendored/inner.log (nested repo), got %v", logs)
	}
	logsAll := globFiles(t, root, map[string]any{"pattern": "**/*.log", "noIgnore": true})
	if !logsAll["keep.log"] {
		t.Errorf("noIgnore glob should include keep.log, got %v", logsAll)
	}
}

func getTreeContent(t *testing.T, root string, params map[string]any) string {
	t.Helper()
	treeOps := ops.NewTreeOperations(ops.NewPathScope(root, nil))
	params["depth"] = float64(5)
	params["maxTokens"] = float64(20000)
	res, err := treeOps.Execute(context.Background(), "getTree", params)
	if err != nil {
		t.Fatalf("getTree failed: %v", err)
	}
	return res.(map[string]any)["content"].(string)
}

func TestGetTreeRespectsGitignore(t *testing.T) {
	root := buildGitignoreFixture(t)

	def := getTreeContent(t, root, map[string]any{})
	if !strings.Contains(def, "app.go") {
		t.Error("default getTree should list app.go")
	}
	if strings.Contains(def, "keep.log") {
		t.Error("default getTree should hide gitignored keep.log")
	}

	// noIgnore releases .gitignore filtering (keep.log appears) but hidden
	// files and the hardcoded bloat list (build/) stay hidden.
	ni := getTreeContent(t, root, map[string]any{"noIgnore": true})
	if !strings.Contains(ni, "keep.log") {
		t.Error("noIgnore getTree should list keep.log")
	}

	// showAll shows hidden and ignored entries alike.
	sa := getTreeContent(t, root, map[string]any{"showAll": true})
	if !strings.Contains(sa, "keep.log") || !strings.Contains(sa, "build") {
		t.Errorf("showAll getTree should list keep.log and build")
	}
}

// Naming an ignored directory is asking to see it: everything inside it is
// ignored by git's excluded-parent rule, so filtering against the project root
// would list nothing — a pinned output folder shown as "(empty)".
func TestGetTreeListsAnIgnoredDirectoryItWasAskedFor(t *testing.T) {
	root := buildGitignoreFixture(t)
	if err := os.MkdirAll(filepath.Join(root, "build", "pages"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "build", "pages", "index.html"), []byte("<p>\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	for _, path := range []string{"build", filepath.Join(root, "build")} {
		got := getTreeContent(t, root, map[string]any{"path": path})
		if !strings.Contains(got, "gen.go") || !strings.Contains(got, "index.html") {
			t.Errorf("getTree of ignored %q should list its contents, got %q", path, got)
		}
	}

	// A directory that is not itself ignored still filters what is inside it.
	sub := getTreeContent(t, root, map[string]any{"path": "sub"})
	if !strings.Contains(sub, "visible.txt") || strings.Contains(sub, "secret.txt") {
		t.Errorf("getTree of sub should list visible.txt and hide secret.txt, got %q", sub)
	}
}

func findSymbolCount(t *testing.T, root string, params map[string]any) int {
	t.Helper()
	searchOps := ops.NewSearchOperations(ops.NewPathScope(root, nil))
	res, err := searchOps.Execute(context.Background(), "findSymbol", params)
	if err != nil {
		t.Fatalf("findSymbol failed: %v", err)
	}
	return res.(map[string]any)["count"].(int)
}

func TestFindSymbolRespectsGitignore(t *testing.T) {
	root := buildGitignoreFixture(t)

	if got := findSymbolCount(t, root, map[string]any{"symbol": "VisibleSym"}); got == 0 {
		t.Error("findSymbol should find VisibleSym in a tracked file")
	}
	if got := findSymbolCount(t, root, map[string]any{"symbol": "IgnoredSym"}); got != 0 {
		t.Errorf("findSymbol should skip IgnoredSym in ignored build/, got %d", got)
	}
	if got := findSymbolCount(t, root, map[string]any{"symbol": "IgnoredSym", "noIgnore": true}); got == 0 {
		t.Error("findSymbol with noIgnore should find IgnoredSym")
	}
}

func TestExpandDirectoryUnfiltered(t *testing.T) {
	root := buildGitignoreFixture(t)
	treeOps := ops.NewTreeOperations(ops.NewPathScope(root, nil))
	res, err := treeOps.Execute(context.Background(), "expandDirectory", map[string]any{"path": "."})
	if err != nil {
		t.Fatalf("expandDirectory failed: %v", err)
	}
	names := map[string]bool{}
	for _, it := range res.(map[string]any)["items"].([]map[string]any) {
		names[it["name"].(string)] = true
	}
	// The file panel shows everything, including gitignored entries.
	for _, n := range []string{"keep.log", "build", "node_modules", "app.go"} {
		if !names[n] {
			t.Errorf("expandDirectory should list %q (unfiltered), got %v", n, names)
		}
	}
}

// expandDirectoryDetail lists dir with detail, by name.
func expandDirectoryDetail(t *testing.T, root, dir string) map[string]map[string]any {
	t.Helper()
	treeOps := ops.NewTreeOperations(ops.NewPathScope(root, nil))
	res, err := treeOps.Execute(context.Background(), "expandDirectory", map[string]any{"path": dir, "detail": true})
	if err != nil {
		t.Fatalf("expandDirectory %q failed: %v", dir, err)
	}
	byName := map[string]map[string]any{}
	for _, it := range res.(map[string]any)["items"].([]map[string]any) {
		byName[it["name"].(string)] = it
	}
	return byName
}

// What the file browser draws beside each name. Each of these is silent when
// wrong — a folder's count off by one, a link described as its target, an
// ignored file shown at full strength — so each is asserted.
func TestExpandDirectoryDetail(t *testing.T) {
	root := buildGitignoreFixture(t)
	if err := os.WriteFile(filepath.Join(root, "run.sh"), []byte("#!/bin/sh\n"), 0o755); err != nil {
		t.Fatal(err)
	}
	many := filepath.Join(root, "many")
	if err := os.MkdirAll(many, 0o755); err != nil {
		t.Fatal(err)
	}
	for i := range 1003 {
		if err := os.WriteFile(filepath.Join(many, fmt.Sprintf("f%d", i)), nil, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	linked := os.Symlink("src", filepath.Join(root, "link")) == nil

	items := expandDirectoryDetail(t, root, ".")

	app := items["app.go"]
	if app["kind"] != "file" || app["size"] != int64(len("package app\n// NEEDLE marker\nfunc VisibleSym() {}\n")) {
		t.Errorf("app.go: want kind file with its byte size, got %v", app)
	}
	if ms, _ := app["modified"].(int64); ms <= 0 {
		t.Errorf("app.go: want a modified time in ms, got %v", app["modified"])
	}
	if app["hidden"] != false || app["ignored"] != false {
		t.Errorf("app.go is neither hidden nor ignored, got hidden=%v ignored=%v", app["hidden"], app["ignored"])
	}
	if runtime.GOOS != "windows" {
		if app["mode"] != "rw-r--r--" || app["executable"] != false {
			t.Errorf("app.go: want mode rw-r--r--, not executable, got %v %v", app["mode"], app["executable"])
		}
		if items["run.sh"]["executable"] != true {
			t.Errorf("run.sh is executable, got %v", items["run.sh"])
		}
	}
	if items[".gitignore"]["hidden"] != true {
		t.Errorf(".gitignore is a dot-file, got %v", items[".gitignore"])
	}
	if items["keep.log"]["ignored"] != true || items["build"]["ignored"] != true {
		t.Errorf("keep.log and build/ are gitignored, got %v / %v", items["keep.log"], items["build"])
	}

	src := items["src"]
	if src["kind"] != "dir" || src["entries"] != 1 || src["entriesTruncated"] != nil {
		t.Errorf("src: want a dir of 1 entry, got %v", src)
	}
	if _, has := src["size"]; has {
		t.Errorf("a directory has no size of its own to show, got %v", src["size"])
	}
	if m := items["many"]; m["entries"] != 1000 || m["entriesTruncated"] != true {
		t.Errorf("many: want the count capped at 1000 and marked truncated, got %v", m)
	}

	if linked {
		link := items["link"]
		if link["kind"] != "symlink" || link["target"] != "src" || link["linkDir"] != true || link["isDir"] != false {
			t.Errorf("link: want a symlink to the src dir, described as a link, got %v", link)
		}
	}

	// Inside an ignored directory everything is ignored, as git sees it.
	if gen := expandDirectoryDetail(t, root, "build")["gen.go"]; gen["ignored"] != true {
		t.Errorf("build/gen.go is inside an ignored dir, got %v", gen)
	}
	// A nested .gitignore applies to its own directory.
	sub := expandDirectoryDetail(t, root, "sub")
	if sub["secret.txt"]["ignored"] != true || sub["visible.txt"]["ignored"] != false {
		t.Errorf("sub: want secret.txt ignored and visible.txt not, got %v / %v", sub["secret.txt"], sub["visible.txt"])
	}
}

// Without detail the listing is names alone, as the callers that only want
// names have always had it.
func TestExpandDirectoryWithoutDetailIsNamesOnly(t *testing.T) {
	root := buildGitignoreFixture(t)
	treeOps := ops.NewTreeOperations(ops.NewPathScope(root, nil))
	res, err := treeOps.Execute(context.Background(), "expandDirectory", map[string]any{"path": "."})
	if err != nil {
		t.Fatal(err)
	}
	for _, it := range res.(map[string]any)["items"].([]map[string]any) {
		if len(it) != 3 {
			t.Fatalf("want name, isDir and path only, got %v", it)
		}
	}
}
