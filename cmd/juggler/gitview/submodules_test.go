//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitview

import (
	"strings"
	"testing"
)

// addSubmodule makes a two-commit library outside the project and adds it at
// rel, returning the library's two commits and its branch, which the
// submodule is left on. Git refuses to clone from a plain
// path for a submodule unless told the file transport is allowed, which only
// this test's own command is.
func addSubmodule(t *testing.T, p *gitProject, rel, name string) (first, second, branch string) {
	t.Helper()
	lib := &gitProject{t: t, root: t.TempDir()}
	lib.dir = lib.root
	lib.init()
	lib.write("lib.txt", "one\n")
	lib.commit("one")
	first = strings.TrimSpace(lib.git("rev-parse", "HEAD"))
	lib.write("lib.txt", "two\n")
	lib.commit("two")
	second = strings.TrimSpace(lib.git("rev-parse", "HEAD"))
	branch = strings.TrimSpace(lib.git("symbolic-ref", "--short", "HEAD"))
	p.git("-c", "protocol.file.allow=always", "submodule", "add", "-q", "--name", name, lib.root, rel)
	return first, second, branch
}

func TestReadSubmodules(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write("a.txt", "a\n")
	p.commit("init")
	_, curTip, curBranch := addSubmodule(t, p, "deps/cur", "cur")
	movFirst, movTip, _ := addSubmodule(t, p, "mov", "mov.lib")
	_, unTip, _ := addSubmodule(t, p, "un", "un")
	p.commit("add submodules")

	// mov: its own branch, at the library's first commit rather than the one
	// recorded. un: never checked out here.
	sub := &gitProject{t: t, root: p.root, dir: p.root + "/mov"}
	sub.git("checkout", "-q", "-b", "topic", movFirst)
	p.git("submodule", "deinit", "-q", "-f", "un")

	answer, err := Read(t.Context(), p.root, Query{Kind: QuerySubmodules})
	if err != nil {
		t.Fatal(err)
	}
	got := answer.(Submodules)
	want := []Submodule{
		{Name: "cur", Path: "deps/cur", Recorded: curTip, Head: curTip, Branch: curBranch, State: SubmoduleCurrent},
		{Name: "mov.lib", Path: "mov", Recorded: movTip, Head: movFirst, Branch: "topic", State: SubmoduleMoved},
		{Name: "un", Path: "un", Recorded: unTip, State: SubmoduleUninitialized},
	}
	if len(got.Submodules) != len(want) {
		t.Fatalf("submodules = %+v, want %d of them", got.Submodules, len(want))
	}
	for i, w := range want {
		g := got.Submodules[i]
		w.URL = g.URL
		if g != w || g.URL == "" {
			t.Errorf("submodule %d = %+v, want %+v with its URL", i, g, w)
		}
	}
}

func TestReadSubmodulesOfARepositoryWithNone(t *testing.T) {
	t.Parallel()
	p := newGitProject(t)
	p.write("a.txt", "a\n")
	p.commit("init")
	answer, err := Read(t.Context(), p.root, Query{Kind: QuerySubmodules})
	if err != nil {
		t.Fatal(err)
	}
	if got := answer.(Submodules); got.Submodules == nil || len(got.Submodules) != 0 {
		t.Errorf("submodules = %#v, want an empty list", got.Submodules)
	}
}
