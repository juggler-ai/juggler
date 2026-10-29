//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"juggler/internal/userpaths/userpathstest"
)

// postFolder asks front's control API to create a folder and returns the
// status and the decoded body.
func postFolder(t *testing.T, front, parent, name string) (int, map[string]any) {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"parent": parent, "name": name})
	req, err := http.NewRequest(http.MethodPost, front+"/api/server/folders", strings.NewReader(string(body)))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(TokenHeader, testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("response is not JSON (status %d): %q", resp.StatusCode, raw)
	}
	return resp.StatusCode, got
}

// folderServer is a control API with no sessions, for the folder routes.
func folderServer(t *testing.T) (*Server, string) {
	t.Helper()
	s := &Server{reg: newRegistry(), token: testToken}
	front := httptest.NewServer(s.routes())
	t.Cleanup(front.Close)
	return s, front.URL
}

// TestCreateFolderMakesItAndSaysWhere: the folder appears directly inside the
// parent and its absolute path comes back. Creating it opens nothing — the
// page opens its session next, as it would any folder.
func TestCreateFolderMakesItAndSaysWhere(t *testing.T) {
	s, front := folderServer(t)
	parent := t.TempDir()

	code, body := postFolder(t, front, parent, "  myapp ")
	if code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body %v)", code, body)
	}
	want := filepath.Join(parent, "myapp")
	if info, err := os.Stat(want); err != nil || !info.IsDir() {
		t.Fatalf("stat %q: %v", want, err)
	}
	if body["path"] != want {
		t.Errorf("path = %v, want %q", body["path"], want)
	}
	if n := len(s.reg.snapshot()); n != 0 {
		t.Errorf("creating a folder opened %d sessions", n)
	}
}

// TestCreateFolderExpandsTilde: a parent under ~ means the home of the user the
// server runs as, as a project path does.
func TestCreateFolderExpandsTilde(t *testing.T) {
	home := userpathstest.Isolate(t)
	_, front := folderServer(t)

	code, body := postFolder(t, front, "~", "myapp")
	if code != http.StatusCreated {
		t.Fatalf("status = %d, want 201 (body %v)", code, body)
	}
	if want := filepath.Join(home, "myapp"); body["path"] != want {
		t.Errorf("path = %v, want %q", body["path"], want)
	}
}

// TestCreateFolderRefusesUnusableNames covers every name that must never reach
// os.Mkdir. A separator is the dangerous one: it would create (or target)
// somewhere other than directly inside the parent the user named.
func TestCreateFolderRefusesUnusableNames(t *testing.T) {
	_, front := folderServer(t)
	for label, name := range map[string]string{
		"empty": "", "whitespace only": "   ", "current dir": ".", "parent dir": "..",
		"forward slash": "sub/app", "backslash": `sub\app`, "leading slash": "/app", "trailing slash": "app/",
	} {
		t.Run(label, func(t *testing.T) {
			parent := t.TempDir()
			if code, body := postFolder(t, front, parent, name); code != http.StatusBadRequest {
				t.Errorf("status = %d, want 400 (body %v)", code, body)
			}
			if entries, _ := os.ReadDir(parent); len(entries) != 0 {
				t.Errorf("parent gained %d entries, want it left untouched", len(entries))
			}
		})
	}
}

// TestCreateFolderRefusesAParentItCannotUse: no parent, a relative one (which
// would resolve against wherever serve started), a missing one — which must not
// be conjured, as os.MkdirAll would from a typo — and a file.
func TestCreateFolderRefusesAParentItCannotUse(t *testing.T) {
	_, front := folderServer(t)
	base := t.TempDir()
	file := filepath.Join(base, "notadir.txt")
	if err := os.WriteFile(file, []byte("x"), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Chdir(base)
	for _, parent := range []string{"", "   ", ".", "sub", filepath.Join(base, "typo", "deeper"), file} {
		if code, body := postFolder(t, front, parent, "myapp"); code != http.StatusBadRequest {
			t.Errorf("parent %q: status = %d, want 400 (body %v)", parent, code, body)
		}
	}
	if _, err := os.Stat(filepath.Join(base, "typo")); !os.IsNotExist(err) {
		t.Error("the missing parent was created; a mistyped parent must fail")
	}
	if _, err := os.Stat(filepath.Join(base, "myapp")); !os.IsNotExist(err) {
		t.Error("a relative parent created a folder in the server's working directory")
	}
}

// TestCreateFolderRefusesAnExistingOne: asking to create something new never
// quietly becomes adopting a folder already there, and the refusal carries its
// message for the page to show translated.
func TestCreateFolderRefusesAnExistingOne(t *testing.T) {
	_, front := folderServer(t)
	parent := t.TempDir()
	existing := filepath.Join(parent, "myapp")
	if err := os.Mkdir(existing, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(existing, "keep.txt"), []byte("mine"), 0o600); err != nil {
		t.Fatal(err)
	}

	code, body := postFolder(t, front, parent, "myapp")
	if code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 (body %v)", code, body)
	}
	m, _ := body["message"].(map[string]any)
	if m == nil || m["key"] != "there is already something called {name} in {parent}" {
		t.Errorf("message = %v, want the template", body["message"])
	}
	if _, err := os.Stat(filepath.Join(existing, "keep.txt")); err != nil {
		t.Errorf("existing contents disturbed: %v", err)
	}
}
