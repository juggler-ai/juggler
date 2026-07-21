//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"os"
	"path/filepath"
	"testing"
)

func newReg(t *testing.T) *WorkspaceRegistry {
	t.Helper()
	// Persist under a temp project so mutations exercise the on-disk path.
	r := NewWorkspaceRegistry(t.TempDir())
	t.Cleanup(r.Close)
	return r
}

func TestWorkspaceRegistry_UnboundIsIdentity(t *testing.T) {
	r := newReg(t)
	if r.Remapper("conv-a") != nil {
		t.Error("unbound Remapper should be nil (identity)")
	}
	if len(r.Bindings("conv-a")) != 0 {
		t.Error("unbound conversation should have no bindings")
	}
}

func TestWorkspaceRegistry_BindRemapRedirects(t *testing.T) {
	src := "/proj"
	ws := "/home/u/.juggler/worktrees/proj/conv-a"
	r := newReg(t)
	r.Bind("conv-a", src, ws)

	remap := r.Remapper("conv-a")
	if remap == nil {
		t.Fatal("bound Remapper is nil")
	}
	cases := map[string]string{
		filepath.Join(src, "src", "main.go"): filepath.Join(ws, "src", "main.go"), // under source → redirected
		src:                                  ws,                                  // the source itself
		"/etc/passwd":                        "/etc/passwd",                       // outside any source → unchanged
	}
	for in, want := range cases {
		if got := remap(in); got != want {
			t.Errorf("remap(%q) = %q, want %q", in, got, want)
		}
	}
}

// The load-bearing multi-repo case: a conversation binds a repo AND a nested
// repo, and each path routes to its own workspace by longest-prefix match — the
// thing t3code's single-cwd model cannot express.
func TestWorkspaceRegistry_MultiRepoLongestPrefix(t *testing.T) {
	r := newReg(t)
	proj := "/proj"
	nested := "/proj/vendored"
	wsProj := "/wt/proj-a"
	wsNested := "/wt/vendored-a"
	r.Bind("conv-a", proj, wsProj)
	r.Bind("conv-a", nested, wsNested)

	remap := r.Remapper("conv-a")
	cases := map[string]string{
		"/proj/src/a.go":      "/wt/proj-a/src/a.go",  // parent repo
		"/proj/vendored/x.go": "/wt/vendored-a/x.go",  // nested repo → its OWN workspace
		"/proj/vendored":      "/wt/vendored-a",       // nested repo root
		"/proj/README.md":     "/wt/proj-a/README.md", // parent-only file
	}
	for in, want := range cases {
		if got := remap(in); got != want {
			t.Errorf("remap(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestWorkspaceRegistry_PerConversationDistinct(t *testing.T) {
	r := newReg(t)
	r.Bind("conv-a", "/proj", "/wt/a")
	r.Bind("conv-b", "/proj", "/wt/b")
	if r.Remapper("conv-a")("/proj/x") == r.Remapper("conv-b")("/proj/x") {
		t.Error("two conversations must remap to distinct roots")
	}
}

func TestWorkspaceRegistry_UnbindOneAndAll(t *testing.T) {
	r := newReg(t)
	r.Bind("conv-a", "/proj", "/wt/a")
	r.Bind("conv-a", "/proj/vendored", "/wt/v")

	r.Unbind("conv-a", "/proj/vendored")
	if _, ok := r.Bindings("conv-a")["/proj/vendored"]; ok {
		t.Error("nested binding should be gone after Unbind")
	}
	if _, ok := r.Bindings("conv-a")["/proj"]; !ok {
		t.Error("parent binding should remain")
	}

	r.UnbindAll("conv-a")
	if len(r.Bindings("conv-a")) != 0 {
		t.Error("UnbindAll should clear every binding")
	}
	if r.Remapper("conv-a") != nil {
		t.Error("Remapper should be nil after UnbindAll")
	}
}

func TestWorkspaceRegistry_Rebind(t *testing.T) {
	r := newReg(t)
	r.Bind("conv-a", "/proj", "/wt/first")
	r.Bind("conv-a", "/proj", "/wt/second")
	if got := r.WorkspaceFor("conv-a", "/proj"); got != "/wt/second" {
		t.Errorf("re-bind = %q, want /wt/second", got)
	}
}

func TestWorkspaceRegistry_PersistsAcrossReload(t *testing.T) {
	proj := t.TempDir()
	r1 := NewWorkspaceRegistry(proj)
	r1.Bind("conv-a", "/proj/repoA", "/wt/a")
	r1.Bind("conv-a", "/proj/repoB", "/wt/b")
	r1.Bind("conv-c", "/proj/repoA", "/wt/c")
	r1.Close()

	// The file exists under .juggler/.
	if _, err := os.Stat(filepath.Join(proj, ".juggler", "workspaces.json")); err != nil {
		t.Fatalf("persistence file missing: %v", err)
	}

	// A fresh registry (a restart) reloads the bindings.
	r2 := NewWorkspaceRegistry(proj)
	defer r2.Close()
	if got := r2.WorkspaceFor("conv-a", "/proj/repoB"); got != "/wt/b" {
		t.Errorf("reloaded conv-a repoB = %q, want /wt/b", got)
	}
	if got := r2.WorkspaceFor("conv-c", "/proj/repoA"); got != "/wt/c" {
		t.Errorf("reloaded conv-c repoA = %q, want /wt/c", got)
	}
	// And the remap still works after reload.
	if got := r2.Remapper("conv-a")("/proj/repoA/x.go"); got != "/wt/a/x.go" {
		t.Errorf("reloaded remap = %q, want /wt/a/x.go", got)
	}
}

func TestWorkspaceRegistry_UnbindPersists(t *testing.T) {
	proj := t.TempDir()
	r1 := NewWorkspaceRegistry(proj)
	r1.Bind("conv-a", "/proj", "/wt/a")
	r1.UnbindAll("conv-a")
	r1.Close()

	r2 := NewWorkspaceRegistry(proj)
	defer r2.Close()
	if len(r2.Bindings("conv-a")) != 0 {
		t.Error("unbind did not persist across reload")
	}
}

// The cleanup-after-shutdown case: a binding whose conversation no longer exists
// (deleted while down) is surfaced as an orphan on the next launch.
func TestWorkspaceRegistry_Orphans(t *testing.T) {
	proj := t.TempDir()
	r1 := NewWorkspaceRegistry(proj)
	r1.Bind("conv-live", "/proj/repoA", "/wt/live")
	r1.Bind("conv-gone", "/proj/repoA", "/wt/gone")
	r1.Bind("conv-gone", "/proj/repoB", "/wt/gone-b")
	r1.Close()

	// Simulate a restart where conv-live still exists but conv-gone was deleted.
	r2 := NewWorkspaceRegistry(proj)
	defer r2.Close()
	orphans := r2.Orphans(map[string]bool{"conv-live": true})
	if _, ok := orphans["conv-live"]; ok {
		t.Error("live conversation must not be an orphan")
	}
	g, ok := orphans["conv-gone"]
	if !ok {
		t.Fatal("deleted conversation should be an orphan")
	}
	if g["/proj/repoA"] != "/wt/gone" || g["/proj/repoB"] != "/wt/gone-b" {
		t.Errorf("orphan bindings wrong: %v", g)
	}
}

func TestWorkspaceRegistry_EmptyArgsIgnored(t *testing.T) {
	r := newReg(t)
	r.Bind("", "/proj", "/wt/a")
	r.Bind("conv-a", "", "/wt/a")
	r.Bind("conv-a", "/proj", "")
	if len(r.Bindings("conv-a")) != 0 {
		t.Errorf("empty-arg binds must be ignored, bindings=%v", r.Bindings("conv-a"))
	}
}
