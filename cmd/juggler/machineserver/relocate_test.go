//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/userpaths/userpathstest"
	"juggler/web"
)

// A project asked to move waits for its session to let go — a turn still
// running refuses — then moves, and opens again where it went; its old link
// and the control API both say where that is.
func TestRelocationWaitsForTheSessionThenMovesAndReopens(t *testing.T) {
	home := userpathstest.Isolate(t)
	t.Setenv("JUGGLER_LOG_DIR", t.TempDir())
	hold := filepath.Join(t.TempDir(), "hold")
	if err := os.WriteFile(hold, nil, 0o644); err != nil {
		t.Fatal(err)
	}
	orig := newChildCommand
	newChildCommand = func(string, string, []string) *exec.Cmd {
		cmd := exec.Command(os.Args[0], "-test.run=^TestHelperSessionChild$") //nolint:gosec // this test binary
		cmd.Env = append(os.Environ(), helperChildEnv+"=1", helperRetireEnv+"="+hold)
		return cmd
	}
	t.Cleanup(func() { newChildCommand = orig })
	store, err := core.NewRecentsStore()
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{reg: newRegistry(), assets: web.Files, token: testToken, recents: store, uiLocale: func() string { return "" }}
	t.Cleanup(s.stopAllChildren)
	front := httptest.NewServer(s.routes())
	defer front.Close()

	from, to := filepath.Join(home, "old"), filepath.Join(home, "new")
	if err := os.Mkdir(from, 0o755); err != nil {
		t.Fatal(err)
	}
	opened := s.openSession(t.Context(), from, false)
	if opened.status != http.StatusCreated {
		t.Fatalf("open: status %d", opened.status)
	}
	relocate := func(dest string) int {
		t.Helper()
		body, _ := json.Marshal(map[string]string{"project": dest})
		return send(t, "POST", front.URL+"/api/server/sessions/"+opened.sess.ID+"/relocate", testToken, string(body))
	}

	for _, bad := range []string{filepath.Join(from, "inside"), home, "relative"} {
		if code := relocate(bad); code != http.StatusBadRequest {
			t.Errorf("relocate to %s: status %d, want 400", bad, code)
		}
	}
	if code := relocate(to); code != http.StatusAccepted {
		t.Fatalf("relocate: status %d, want 202", code)
	}
	if code := relocate(filepath.Join(home, "other")); code != http.StatusConflict {
		t.Errorf("a second relocation while one waits: status %d, want 409", code)
	}

	// Held: asked, refused, and nothing has moved.
	for {
		if data, _ := os.ReadFile(hold); len(data) > 0 {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if sess, ok := s.reg.get(opened.sess.ID); !ok || sess.State == SessionError {
		t.Fatalf("the held session = %+v (listed %v), want it still there", sess, ok)
	}
	mustBeDir(t, from)

	if err := os.Remove(hold); err != nil {
		t.Fatal(err)
	}
	dest, ok := s.movedTo(from)
	if !ok || dest != to {
		t.Fatalf("movedTo = %q, %v; want %q", dest, ok, to)
	}
	mustBeDir(t, to)
	if _, err := os.Stat(from); err == nil {
		t.Error("the old folder is still there")
	}
	if _, ok := s.reg.get(opened.sess.ID); ok {
		t.Error("the old session is still listed")
	}
	var running []string
	for _, sess := range s.reg.snapshot() {
		running = append(running, sess.Project)
	}
	if len(running) != 1 || running[0] != to {
		t.Errorf("sessions = %v, want one for %s", running, to)
	}

	var where relocationResponse
	getJSON(t, front.URL+"/api/server/relocations?project="+url.QueryEscape(from), &where)
	if where.Project != to || where.Link != projectLink(to) {
		t.Errorf("relocation = %+v, want %s at %s", where, to, projectLink(to))
	}
	if code := send(t, "GET", front.URL+"/api/server/relocations?project="+url.QueryEscape(to), testToken, ""); code != http.StatusNotFound {
		t.Errorf("relocation of a project that has not moved: status %d, want 404", code)
	}

	req, _ := http.NewRequest("GET", front.URL+projectLink(from), nil)
	req.Header.Set("Sec-Fetch-Dest", "document")
	req.Header.Set("Accept", "text/html")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(resp.Body)
	_ = resp.Body.Close()
	if cfg := decodePageConfig(t, string(body)); resp.StatusCode != http.StatusOK || cfg["open"] != to {
		t.Errorf("old link: status %d, config %v; want the opener for %s", resp.StatusCode, cfg, to)
	}
}

func mustBeDir(t *testing.T, p string) {
	t.Helper()
	if info, err := os.Stat(p); err != nil || !info.IsDir() {
		t.Fatalf("want folder %s: %v", p, err)
	}
}
