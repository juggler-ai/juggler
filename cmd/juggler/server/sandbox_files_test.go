//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"bytes"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gorilla/mux"

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

// deniedSendfileWriter stands in for net/http's response under a sandbox that
// denies sendfile: ReadFrom copies sniff bytes the ordinary way, then fails with
// EPERM. A zero sniff is the denial arriving before any byte moved.
type deniedSendfileWriter struct {
	*httptest.ResponseRecorder
	sniff int64
}

func (w *deniedSendfileWriter) ReadFrom(r io.Reader) (int64, error) {
	n, err := io.Copy(w.ResponseRecorder, io.LimitReader(r, w.sniff))
	if err != nil {
		return n, err
	}
	return n, &os.SyscallError{Syscall: "sendfile", Err: fs.ErrPermission}
}

// A module served to the sandbox must arrive whole when sendfile is denied, or
// its import fails on a truncated script.
func TestSandboxImportSurvivesSendfileDenial(t *testing.T) {
	s := newWorkspaceTurnServer(t)
	body := []byte("export const lines = [\n" + strings.Repeat("  'source line héllo',\n", 4096) + "];\n")
	abs := filepath.Join(s.ProjectPath(), "big.js")
	if err := os.WriteFile(abs, body, 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	mod, ok := s.sandboxImportFile(sandboxURLPath(abs))
	if !ok {
		t.Fatalf("%s was not resolved", abs)
	}
	for _, sniff := range []int64{0, 512} {
		t.Run(fmt.Sprintf("sniff=%d", sniff), func(t *testing.T) {
			w := &deniedSendfileWriter{ResponseRecorder: httptest.NewRecorder(), sniff: sniff}
			serveSandboxImportFile(w, httptest.NewRequest(http.MethodGet, sandboxURLPath(abs), nil), mod)
			if w.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200", w.Code)
			}
			if !bytes.Equal(w.Body.Bytes(), body) {
				t.Errorf("body differs: got %d bytes, want %d", w.Body.Len(), len(body))
			}
		})
	}
}

// The route answers every origin (ACAO=*, CORP cross-origin), because the
// sandbox that imports through it has an opaque one. So it must be a capability:
// a page that knows the port and a project path learns nothing without it, and
// even with it, nothing under a dot-directory (.juggler holds the session and
// every transcript) or behind a symlink out of the tree comes back.
func TestSandboxImportRouteIsACapability(t *testing.T) {
	s := newWorkspaceTurnServer(t)
	s.apiToken = testAPIToken
	s.router = mux.NewRouter()
	s.registerSandboxImportRoutes(nil)
	s.router.Use(corsMiddleware)

	project := s.ProjectPath()
	module := writeSandboxFile(t, project, "module.js")
	if err := os.MkdirAll(filepath.Join(project, ".juggler"), 0o700); err != nil {
		t.Fatal(err)
	}
	session := filepath.Join(project, ".juggler", "session.json")
	if err := os.WriteFile(session, []byte(`{"secret":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	outside := filepath.Join(t.TempDir(), "outside.json")
	if err := os.WriteFile(outside, []byte(`{"secret":true}`), 0o600); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(project, "planted.json")
	if err := os.Symlink(outside, link); err != nil {
		t.Skipf("symlinks unavailable: %v", err)
	}

	// The JavaScript hosts derive this independently; web/engine_sandbox_node_test.go
	// pins them to the same vector.
	capability := "342cc23b510fab8fa687b3051f08a8801a0caf3a283d6432dc652c9041fb5638"
	if got := sandboxImportCapability(testAPIToken); got != capability {
		t.Fatalf("sandboxImportCapability = %s, want %s", got, capability)
	}

	get := func(urlPath string) int {
		rec := httptest.NewRecorder()
		s.router.ServeHTTP(rec, httptest.NewRequest(http.MethodGet, urlPath, nil))
		return rec.Code
	}
	for _, tc := range []struct {
		name string
		url  string
		want int
	}{
		{"a module, with the capability", "/sandbox-import/" + capability + sandboxURLPath(module), http.StatusOK},
		{"a module, by bare path", sandboxURLPath(module), http.StatusNotFound},
		{"a module, with the wrong capability", "/sandbox-import/" + strings.Repeat("0", 64) + sandboxURLPath(module), http.StatusNotFound},
		{"a module, with the API token itself", "/sandbox-import/" + testAPIToken + sandboxURLPath(module), http.StatusNotFound},
		{"the session file, by bare path", sandboxURLPath(session), http.StatusNotFound},
		{"the session file, with the capability", "/sandbox-import/" + capability + sandboxURLPath(session), http.StatusNotFound},
		{"a symlink out of the project, by bare path", sandboxURLPath(link), http.StatusNotFound},
		{"a symlink out of the project, with the capability", "/sandbox-import/" + capability + sandboxURLPath(link), http.StatusNotFound},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := get(tc.url); got != tc.want {
				t.Fatalf("GET %s = %d, want %d", tc.url, got, tc.want)
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
