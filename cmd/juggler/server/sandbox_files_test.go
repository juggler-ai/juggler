//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
)

// writeSandboxFile writes a file the sandbox import route can be asked for.
func writeSandboxFile(t *testing.T, dir, name string) string {
	t.Helper()
	p := filepath.Join(dir, name)
	if err := os.WriteFile(p, []byte("export const where = '"+dir+"';\n"), 0o600); err != nil {
		t.Fatalf("write %s: %v", p, err)
	}
	return p
}

// sandboxURLPath is the URL a sandboxed `import('<abs path>')` arrives as: the
// worker resolves the specifier against its own http origin, so a POSIX path is
// already the URL path, and a Windows one gains a leading slash (sandbox.html's
// `origin + '/' + spec`).
func sandboxURLPath(abs string) string {
	p := filepath.ToSlash(abs)
	if !strings.HasPrefix(p, "/") {
		p = "/" + p
	}
	return p
}

// A conversation bound to a workspace is handed ITS root as the sandbox's
// `projectRoot`, so the absolute module paths its scripts build point into the
// workspace — and this route is what turns one of those back into a file. Left
// clamped to the project, every such import would 404 and query_code's promise
// that it can import any module in the tree you are working in would hold only
// for unbound conversations.
func TestSandboxImportServesWorkspaceModules(t *testing.T) {
	s := newWorkspaceTurnServer(t)

	inProject := writeSandboxFile(t, s.ProjectPath(), "in-project.js")

	workspaceRoot := t.TempDir()
	inWorkspace := writeSandboxFile(t, workspaceRoot, "in-workspace.js")
	if _, err := s.SessionManager().RegisterWorkspace(core.Workspace{
		Kind: core.WorkspaceKindLocal, Root: workspaceRoot, Label: "feat/tunnels",
		State: core.WorkspaceStateReady,
	}); err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}

	for _, tc := range []struct {
		name string
		abs  string
	}{
		{"the project's own module", inProject},
		{"a ready workspace's module", inWorkspace},
	} {
		t.Run(tc.name, func(t *testing.T) {
			mod, ok := s.sandboxImportFile(sandboxURLPath(tc.abs))
			if !ok {
				t.Fatalf("%s was not served; want it resolved to %s", tc.abs, tc.abs)
			}
			if got := filepath.Join(mod.tree.Root(), filepath.FromSlash(mod.rel)); got != filepath.FromSlash(tc.abs) {
				t.Fatalf("resolved to %q, want %q", got, tc.abs)
			}
		})
	}
}

// The route widens to the workspaces the user registered and to nothing else.
// It answers with ACAO=*, so every refusal here is the difference between a
// module loader and a cross-origin reader for anything on the machine.
func TestSandboxImportRefusesWhatIsNotAWorkspace(t *testing.T) {
	s := newWorkspaceTurnServer(t)

	elsewhere := t.TempDir()
	stray := writeSandboxFile(t, elsewhere, "stray.js")

	readyRoot := t.TempDir()
	secret := filepath.Join(readyRoot, "secrets.env")
	if err := os.WriteFile(secret, []byte("TOKEN=hunter2\n"), 0o600); err != nil {
		t.Fatalf("write %s: %v", secret, err)
	}
	if _, err := s.SessionManager().RegisterWorkspace(core.Workspace{
		Kind: core.WorkspaceKindLocal, Root: readyRoot, State: core.WorkspaceStateReady,
	}); err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}

	halfBuiltRoot := t.TempDir()
	halfBuilt := writeSandboxFile(t, halfBuiltRoot, "half-built.js")
	if _, err := s.SessionManager().RegisterWorkspace(core.Workspace{
		Kind: core.WorkspaceKindLocal, Root: halfBuiltRoot, Label: "half-built",
		State: core.WorkspaceStateProvisioning,
	}); err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}

	closedRoot := t.TempDir()
	closed := writeSandboxFile(t, closedRoot, "finished-with.js")
	if _, err := s.SessionManager().RegisterWorkspace(core.Workspace{
		Kind: core.WorkspaceKindLocal, Root: closedRoot, Label: "finished-with",
		State: core.WorkspaceStateClosed,
	}); err != nil {
		t.Fatalf("RegisterWorkspace: %v", err)
	}

	for _, tc := range []struct {
		name string
		abs  string
	}{
		{"a module under no root at all", stray},
		{"a non-module file inside a workspace", secret},
		{"a workspace still being created", halfBuilt},
		{"a workspace that was closed", closed},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if mod, ok := s.sandboxImportFile(sandboxURLPath(tc.abs)); ok {
				t.Fatalf("%s was served as %s in %s; want it refused", tc.abs, mod.rel, mod.tree.Root())
			}
		})
	}
}
