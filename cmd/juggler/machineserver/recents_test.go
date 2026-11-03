//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/internal/userpaths/userpathstest"
)

// TestResolveProjectTakesOnlyAbsoluteAndHomePaths: a typed path means the same
// thing wherever it was typed, so the control API accepts an absolute path or
// one under ~ and refuses a relative one, which would otherwise resolve against
// whatever folder `juggler serve` happened to start in.
func TestResolveProjectTakesOnlyAbsoluteAndHomePaths(t *testing.T) {
	home := userpathstest.Isolate(t)
	proj := filepath.Join(home, "proj")
	if err := os.Mkdir(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(home, "file.txt")
	if err := os.WriteFile(file, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	t.Chdir(home)

	for _, in := range []string{proj, "~/proj", "~"} {
		want := proj
		if in == "~" {
			want = home
		}
		got, err := resolveProject(in)
		if err != nil || got != want {
			t.Errorf("resolveProject(%q) = %q, %v; want %q", in, got, err, want)
		}
	}
	for _, in := range []string{"", "proj", "./proj", "../proj", "~other/proj", filepath.Join(home, "missing"), file} {
		if got, err := resolveProject(in); err == nil {
			t.Errorf("resolveProject(%q) = %q, want an error", in, got)
		}
	}
}

// TestOpenSessionRefusesARelativePath: the refusal reaches a caller as 400,
// before any child is spawned, even when the folder exists relative to the
// server's own working directory.
func TestOpenSessionRefusesARelativePath(t *testing.T) {
	cwd := t.TempDir()
	if err := os.MkdirAll(filepath.Join(cwd, "some", "folder"), 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(cwd)
	useHelperChildren(t)
	s := &Server{reg: newRegistry(), token: testToken}
	t.Cleanup(s.stopAllChildren)
	front := httptest.NewServer(s.routes())
	defer front.Close()
	if code := send(t, "POST", front.URL+"/api/server/sessions", testToken, `{"project":"some/folder"}`); code != http.StatusBadRequest {
		t.Fatalf("relative project: status %d, want 400", code)
	}
	if n := len(s.reg.snapshot()); n != 0 {
		t.Fatalf("a refused open left %d sessions in the registry", n)
	}
}

// useHelperChildren makes every spawn in this test start the stand-in session
// child (TestHelperSessionChild) instead of a real juggler.
func useHelperChildren(t *testing.T) {
	t.Helper()
	t.Setenv("JUGGLER_LOG_DIR", t.TempDir())
	orig := newChildCommand
	newChildCommand = func(string, string, []string) *exec.Cmd {
		cmd := exec.Command(os.Args[0], "-test.run=^TestHelperSessionChild$") //nolint:gosec // this test binary
		cmd.Env = append(os.Environ(), helperChildEnv+"=1")
		return cmd
	}
	t.Cleanup(func() { newChildCommand = orig })
}

// getRecents fetches the control API's recents list.
func getRecents(t *testing.T, base string) []string {
	t.Helper()
	req, _ := http.NewRequest("GET", base+"/api/server/recents", nil)
	req.Header.Set(TokenHeader, testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET recents: status %d", resp.StatusCode)
	}
	var body struct {
		Paths []string `json:"paths"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		t.Fatal(err)
	}
	return body.Paths
}

// TestOpenedSessionsBecomeRecents: every project a session is opened for goes
// to the front of the machine's recents, so the sessions page offers it again,
// and the list served drops folders that have since gone.
func TestOpenedSessionsBecomeRecents(t *testing.T) {
	home := userpathstest.Isolate(t)
	useHelperChildren(t)
	store, err := core.NewRecentsStore()
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{reg: newRegistry(), token: testToken, recents: store}
	t.Cleanup(s.stopAllChildren)
	front := httptest.NewServer(s.routes())
	defer front.Close()

	a, b, gone := filepath.Join(home, "a"), filepath.Join(home, "b"), filepath.Join(home, "gone")
	for _, p := range []string{a, b, gone} {
		if err := os.Mkdir(p, 0o755); err != nil {
			t.Fatal(err)
		}
	}
	if err := store.Add(gone); err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(gone); err != nil {
		t.Fatal(err)
	}

	for _, p := range []string{a, "~/b"} {
		body, _ := json.Marshal(map[string]string{"project": p})
		if code := send(t, "POST", front.URL+"/api/server/sessions", testToken, string(body)); code != http.StatusCreated {
			t.Fatalf("open %s: status %d, want 201", p, code)
		}
	}
	if got, want := getRecents(t, front.URL), []string{b, a}; strings.Join(got, "|") != strings.Join(want, "|") {
		t.Fatalf("recents = %v, want %v", got, want)
	}

	// Each recent, and each session, comes with its project's link — which the
	// page cannot work out for itself: the key's hash needs crypto.subtle, which
	// a plain-http LAN origin does not have.
	var recents struct {
		Links map[string]string `json:"links"`
	}
	getJSON(t, front.URL+"/api/server/recents", &recents)
	for _, p := range []string{a, b} {
		if got := recents.Links[p]; got != projectLink(p) {
			t.Errorf("recents link for %s = %q, want %q", p, got, projectLink(p))
		}
	}
	var sessions []Session
	getJSON(t, front.URL+"/api/server/sessions", &sessions)
	if len(sessions) != 2 {
		t.Fatalf("sessions = %v, want two", sessions)
	}
	for _, sess := range sessions {
		if sess.Link != projectLink(sess.Project) {
			t.Errorf("session %s link = %q, want %q", sess.Project, sess.Link, projectLink(sess.Project))
		}
	}
}

// getJSON GETs a control-API url with the token and decodes its body into v.
func getJSON(t *testing.T, url string, v any) {
	t.Helper()
	req, _ := http.NewRequest("GET", url, nil)
	req.Header.Set(TokenHeader, testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("GET %s: status %d", url, resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(v); err != nil {
		t.Fatal(err)
	}
}
