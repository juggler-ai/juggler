//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"os"
	"path/filepath"
	"testing"

	"juggler/cmd/juggler/server/handlers"
	"juggler/web"
)

// serverWithUserExt builds a Server whose ExtensionsAPI points at userDir, the
// way createExtensionsAPI wires the real one. web.Files supplies the embedded
// SDK version read at construction.
func serverWithUserExt(userDir string) *Server {
	return &Server{extensionsAPI: handlers.NewExtensionsAPI(web.Files, "", userDir)}
}

// TestReadWorkerModuleUserExtension is the core regression for issue #34: a
// ContextItem discovered under /user-extensions/ must be readable through the
// worker-module loader (the engine's only import path), not just the static
// route. Before the fix readWorkerModule only consulted the embedded/static
// assets, so this 404'd and the capability never loaded in the engine.
func TestReadWorkerModuleUserExtension(t *testing.T) {
	userDir := t.TempDir()
	rel := "my-ext/context-items/example-context-item.js"
	full := filepath.Join(userDir, filepath.FromSlash(rel))
	if err := os.MkdirAll(filepath.Dir(full), 0o755); err != nil {
		t.Fatal(err)
	}
	const body = "import ContextItem from 'juggler/context-item';\nexport default {};\n"
	if err := os.WriteFile(full, []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}

	s := serverWithUserExt(userDir)
	got, err := s.readWorkerModule("/user-extensions/" + rel)
	if err != nil {
		t.Fatalf("readWorkerModule: %v", err)
	}
	if string(got) != body {
		t.Errorf("body = %q, want %q", got, body)
	}
}

// TestReadWorkerModuleLinkedExtension covers the `juggler ext link` dev
// workflow: the extension *subdirectory* is a symlink out of the container
// (~/.juggler/extensions/<name> -> /path/to/dev/src). The /user-extensions/
// static route serves it via http.Dir, which follows the symlink; the
// worker-module loader must accept exactly the same files so engine-mode and
// viewer-mode agree. A containment check that rejects paths resolving outside
// the container would break this — reintroducing the discovery/loading split.
func TestReadWorkerModuleLinkedExtension(t *testing.T) {
	root := t.TempDir()
	userDir := filepath.Join(root, "extensions")
	devSrc := filepath.Join(root, "dev", "my-ext")
	if err := os.MkdirAll(filepath.Join(devSrc, "context-items"), 0o755); err != nil {
		t.Fatal(err)
	}
	const body = "export default { linked: true };\n"
	if err := os.WriteFile(filepath.Join(devSrc, "context-items", "example-context-item.js"), []byte(body), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(userDir, 0o755); err != nil {
		t.Fatal(err)
	}
	// ext link symlinks the whole subdir into the container, pointing outside it.
	if err := os.Symlink(devSrc, filepath.Join(userDir, "my-ext")); err != nil {
		t.Skipf("symlinks unsupported: %v", err)
	}

	s := serverWithUserExt(userDir)
	got, err := s.readWorkerModule("/user-extensions/my-ext/context-items/example-context-item.js")
	if err != nil {
		t.Fatalf("readWorkerModule (linked extension): %v", err)
	}
	if string(got) != body {
		t.Errorf("body = %q, want %q", got, body)
	}
}

// TestReadWorkerModuleUserExtensionRejectsTraversal keeps readWorkerModule
// self-defensive: it is also called directly from engine_snapshot.go, not only
// behind serveWorkerModule's own ".." guard. A ".." segment must never escape
// the container, mirroring http.Dir's lexical rejection.
func TestReadWorkerModuleUserExtensionRejectsTraversal(t *testing.T) {
	root := t.TempDir()
	userDir := filepath.Join(root, "extensions")
	if err := os.MkdirAll(userDir, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "secret.js"), []byte("stolen"), 0o644); err != nil {
		t.Fatal(err)
	}

	s := serverWithUserExt(userDir)
	if _, err := s.readWorkerModule("/user-extensions/my-ext/../../secret.js"); err == nil {
		t.Fatal("expected traversal outside the container to be rejected")
	}
}
