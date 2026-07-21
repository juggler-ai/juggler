//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"path/filepath"
	"testing"
)

func newReg(t *testing.T, root string) *WorkspaceRegistry {
	t.Helper()
	r := NewWorkspaceRegistry(root)
	t.Cleanup(r.Close)
	return r
}

func TestWorkspaceRegistry_UnboundIsIdentity(t *testing.T) {
	r := newReg(t, "/proj")
	if got := r.Root("conv-a"); got != "" {
		t.Errorf("unbound Root = %q, want empty", got)
	}
	if r.Remapper("conv-a") != nil {
		t.Error("unbound Remapper should be nil (identity)")
	}
}

func TestWorkspaceRegistry_BindRemapRedirects(t *testing.T) {
	root := "/proj"
	ws := "/home/u/.juggler/worktrees/proj/conv-a"
	r := newReg(t, root)
	r.Bind("conv-a", ws)

	if got := r.Root("conv-a"); got != ws {
		t.Fatalf("Root = %q, want %q", got, ws)
	}
	remap := r.Remapper("conv-a")
	if remap == nil {
		t.Fatal("bound Remapper is nil")
	}
	cases := map[string]string{
		filepath.Join(root, "src", "main.go"): filepath.Join(ws, "src", "main.go"), // under project → redirected
		root:                                  ws,                                  // the root itself
		"/etc/passwd":                         "/etc/passwd",                       // outside project → unchanged
	}
	for in, want := range cases {
		if got := remap(in); got != want {
			t.Errorf("remap(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestWorkspaceRegistry_PerConversationDistinct(t *testing.T) {
	r := newReg(t, "/proj")
	r.Bind("conv-a", "/wt/a")
	r.Bind("conv-b", "/wt/b")
	if r.Remapper("conv-a")("/proj/x") == r.Remapper("conv-b")("/proj/x") {
		t.Error("two conversations must remap to distinct roots")
	}
}

func TestWorkspaceRegistry_Unbind(t *testing.T) {
	r := newReg(t, "/proj")
	r.Bind("conv-a", "/wt/a")
	r.Unbind("conv-a")
	if r.Root("conv-a") != "" {
		t.Error("Root should be empty after Unbind")
	}
	if r.Remapper("conv-a") != nil {
		t.Error("Remapper should be nil after Unbind")
	}
}

func TestWorkspaceRegistry_Rebind(t *testing.T) {
	r := newReg(t, "/proj")
	r.Bind("conv-a", "/wt/first")
	r.Bind("conv-a", "/wt/second")
	if got := r.Root("conv-a"); got != "/wt/second" {
		t.Errorf("re-bind Root = %q, want /wt/second", got)
	}
}

func TestWorkspaceRegistry_EmptyArgsIgnored(t *testing.T) {
	r := newReg(t, "/proj")
	r.Bind("", "/wt/a")
	r.Bind("conv-a", "")
	if len(r.Tracked()) != 0 {
		t.Errorf("empty-arg binds must be ignored, tracked=%v", r.Tracked())
	}
	if r.Root("") != "" {
		t.Error("empty convID Root must be empty")
	}
}
