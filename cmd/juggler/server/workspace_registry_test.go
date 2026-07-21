//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"path/filepath"
	"testing"
)

func newReg(t *testing.T) *WorkspaceRegistry {
	t.Helper()
	r := NewWorkspaceRegistry("/proj")
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

func TestWorkspaceRegistry_EmptyArgsIgnored(t *testing.T) {
	r := newReg(t)
	r.Bind("", "/proj", "/wt/a")
	r.Bind("conv-a", "", "/wt/a")
	r.Bind("conv-a", "/proj", "")
	if len(r.Bindings("conv-a")) != 0 {
		t.Errorf("empty-arg binds must be ignored, bindings=%v", r.Bindings("conv-a"))
	}
}
