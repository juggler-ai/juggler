//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"juggler/cmd/juggler/gitattr"
	"juggler/cmd/juggler/workspace"
)

// attribute posts one attribution as the engine does and returns the status.
func attribute(t *testing.T, s *Server, workspaceID, body string) int {
	t.Helper()
	rec := httptest.NewRecorder()
	req := httptest.NewRequest(http.MethodPost, "/api/git/attribute?workspace="+workspaceID, strings.NewReader(body)).WithContext(t.Context())
	s.handleGitAttribute(rec, req)
	return rec.Code
}

// A write's attribution records the file as the git views name it, with the
// blob id of what is on disk, against the workspace it was written in and in
// the project's index. A file in no repository records nothing, quietly.
func TestGitAttributeRoute(t *testing.T) {
	if _, err := exec.LookPath("git"); err != nil {
		t.Skipf("git is not installed here: %v", err)
	}
	t.Setenv("GIT_CONFIG_NOSYSTEM", "1")
	t.Setenv("HOME", t.TempDir())
	t.Setenv("XDG_CONFIG_HOME", t.TempDir())

	repo := t.TempDir()
	gitIn(t, repo, "init", "-q")
	if err := os.MkdirAll(filepath.Join(repo, "dir"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(repo, "dir", "a.txt"), []byte("as written\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	loose := t.TempDir()
	if err := os.WriteFile(filepath.Join(loose, "b.txt"), []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	tree := func(root string) workspace.Workspace {
		ws, err := workspace.NewResolver(func() string { return root }, nil, nil).Resolve("")
		if err != nil {
			t.Fatal(err)
		}
		return ws
	}
	s := newTestServerStateWithProject(t)
	s.gitWatchResolve = resolveTrees(map[string]workspace.Workspace{"ws_tree": tree(repo), "ws_loose": tree(loose)})
	index := gitattr.ForProject(s.ProjectPath())

	if code := attribute(t, s, "ws_tree", `{"path":"dir/a.txt","conv":"c1","thread":"th1","item":"tu1"}`); code != http.StatusNoContent {
		t.Fatalf("attributing a relative path = %d, want 204", code)
	}
	blob := gitIn(t, repo, "hash-object", "dir/a.txt")
	got := index.Lookup("ws_tree", "", "dir/a.txt", blob)
	if len(got) != 1 || got[0].Conv != "c1" || got[0].Thread != "th1" || got[0].Item != "tu1" || got[0].Strength != gitattr.Strong {
		t.Fatalf("records of dir/a.txt at %s = %+v, want c1's strong record from th1/tu1", blob, got)
	}

	if code := attribute(t, s, "ws_tree", `{"path":"`+filepath.ToSlash(filepath.Join(repo, "dir", "a.txt"))+`","conv":"c2"}`); code != http.StatusNoContent {
		t.Fatalf("attributing an absolute path = %d, want 204", code)
	}
	if got := index.Lookup("ws_tree", "", "dir/a.txt", blob); len(got) != 2 || got[0].Conv != "c2" {
		t.Errorf("after c2 wrote the same bytes by absolute path = %+v, want c2 then c1", got)
	}

	if code := attribute(t, s, "ws_loose", `{"path":"b.txt","conv":"c1"}`); code != http.StatusNoContent {
		t.Errorf("attributing a file in no repository = %d, want 204", code)
	}
	if got := index.ForPaths("ws_loose", "", nil); len(got) != 0 {
		t.Errorf("a file in no repository was recorded: %+v", got)
	}

	if code := attribute(t, s, "ws_tree", `{"path":"dir/a.txt"}`); code != http.StatusBadRequest {
		t.Errorf("an attribution naming no conversation = %d, want 400", code)
	}
	if code := attribute(t, s, "ws_gone", `{"path":"dir/a.txt","conv":"c1"}`); code != http.StatusBadRequest {
		t.Errorf("an attribution in a workspace that does not resolve = %d, want 400", code)
	}
}
