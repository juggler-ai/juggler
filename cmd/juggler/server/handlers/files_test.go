//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"bytes"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
)

// newFilesTestAPI builds a FilesAPI rooted at a temp project containing a text
// file, a nested file, and a directory, plus a secret file OUTSIDE the project
// that traversal attempts target.
func newFilesTestAPI(t *testing.T) (*FilesAPI, string, string) {
	t.Helper()
	base := t.TempDir()
	project := filepath.Join(base, "project")
	if err := os.MkdirAll(filepath.Join(project, "src"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(project, "a.txt"), []byte("hello world"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	if err := os.WriteFile(filepath.Join(project, "src", "app.js"), []byte("const a = 1;\n"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	secret := filepath.Join(base, "secret.txt")
	if err := os.WriteFile(secret, []byte("TOP SECRET"), 0o600); err != nil {
		t.Fatalf("write: %v", err)
	}
	return NewFilesAPI(func() string { return project }), project, secret
}

func serveFileContent(api *FilesAPI, rawPath string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, "/api/session/files/content?path="+rawPath, nil)
	rec := httptest.NewRecorder()
	api.HandleGetFileContent(rec, req)
	return rec
}

// TestFileContentServesProjectFile is the happy path: a file inside the project
// streams with its bytes, an explicit content type, and nosniff.
func TestFileContentServesProjectFile(t *testing.T) {
	api, project, _ := newFilesTestAPI(t)

	rec := serveFileContent(api, filepath.Join(project, "src", "app.js"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != "const a = 1;\n" {
		t.Errorf("body = %q, want the file's bytes", got)
	}
	if got := rec.Header().Get("Content-Type"); got != "text/javascript" {
		t.Errorf("Content-Type = %q, want text/javascript", got)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
	}
	// A live file must never be cached like an immutable asset.
	if cc := rec.Header().Get("Cache-Control"); !strings.Contains(cc, "no-cache") {
		t.Errorf("Cache-Control = %q, want no-cache", cc)
	}
	// Range support is what lets a viewer fetch a large file incrementally.
	if got := rec.Header().Get("Accept-Ranges"); got != "bytes" {
		t.Errorf("Accept-Ranges = %q, want bytes", got)
	}
}

// TestFileContentAcceptsRelativePath confirms a project-relative path resolves
// against the project root, matching how the read op reports paths.
func TestFileContentAcceptsRelativePath(t *testing.T) {
	api, _, _ := newFilesTestAPI(t)

	rec := serveFileContent(api, "a.txt")
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != "hello world" {
		t.Errorf("body = %q, want the file's bytes", got)
	}
}

// TestFileContentRejectsTraversal is the load-bearing security test: no spelling
// of a path outside the project may stream. This route's token can ride in the
// query string, so containment is its own boundary rather than a second line of
// defence.
func TestFileContentRejectsTraversal(t *testing.T) {
	api, project, secret := newFilesTestAPI(t)

	cases := []struct {
		name string
		path string
	}{
		{"relative dot-dot", "../secret.txt"},
		{"nested dot-dot", "src/../../secret.txt"},
		{"absolute outside", secret},
		{"absolute parent", filepath.Join(project, "..", "secret.txt")},
		{"deep dot-dot", "../../../../../../etc/passwd"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := serveFileContent(api, tc.path)
			if rec.Code == http.StatusOK {
				t.Fatalf("path %q streamed with status 200 and body %q; want refusal",
					tc.path, rec.Body.String())
			}
			if strings.Contains(rec.Body.String(), "TOP SECRET") {
				t.Fatalf("path %q leaked out-of-project content", tc.path)
			}
		})
	}
}

// TestFileContentRejectsSymlinkEscape covers the traversal case a lexical path
// check would miss: a symlink inside the project pointing out of it.
func TestFileContentRejectsSymlinkEscape(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("symlink creation requires elevation on Windows")
	}
	api, project, secret := newFilesTestAPI(t)

	link := filepath.Join(project, "escape.txt")
	if err := os.Symlink(secret, link); err != nil {
		t.Skipf("symlink unsupported here: %v", err)
	}

	rec := serveFileContent(api, link)
	if rec.Code == http.StatusOK && strings.Contains(rec.Body.String(), "TOP SECRET") {
		t.Fatalf("a symlink out of the project streamed its target's content")
	}
}

// TestFileContentRejectsDirectory and the missing/empty cases: each failure mode
// gets its own status so a viewer can tell "not found" from "refused".
func TestFileContentRejectsDirectory(t *testing.T) {
	api, project, _ := newFilesTestAPI(t)

	rec := serveFileContent(api, filepath.Join(project, "src"))
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for a directory", rec.Code)
	}
}

func TestFileContentMissingFile(t *testing.T) {
	api, project, _ := newFilesTestAPI(t)

	rec := serveFileContent(api, filepath.Join(project, "nope.txt"))
	if rec.Code != http.StatusNotFound {
		t.Fatalf("status = %d, want 404", rec.Code)
	}
}

// serveFileTree requests absPath through the tree route, spelled as the client
// spells it: the token, then the absolute path without its leading slash.
func serveFileTree(api *FilesAPI, absPath string) *httptest.ResponseRecorder {
	p := strings.TrimPrefix(filepath.ToSlash(absPath), "/")
	req := httptest.NewRequest(http.MethodGet, FileTreePrefix+"tok/"+p, nil)
	rec := httptest.NewRecorder()
	api.HandleGetFileTree(rec, req)
	return rec
}

// TestFileTreeServesProjectFile is the tree route's happy path: the same bytes
// and headers as the query route, from a path a page's relative links can reach.
func TestFileTreeServesProjectFile(t *testing.T) {
	api, project, _ := newFilesTestAPI(t)

	rec := serveFileTree(api, filepath.Join(project, "src", "app.js"))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != "const a = 1;\n" {
		t.Errorf("body = %q, want the file's bytes", got)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
	}
}

// TestFileTreeRejectsTraversal: a page's `../` links are exactly how this route
// is asked for a path outside the project, so it must refuse them as the query
// route does.
func TestFileTreeRejectsTraversal(t *testing.T) {
	api, project, secret := newFilesTestAPI(t)

	for _, p := range []string{secret, filepath.Join(project, "src") + "/../../secret.txt"} {
		rec := serveFileTree(api, p)
		if rec.Code == http.StatusOK || strings.Contains(rec.Body.String(), "TOP SECRET") {
			t.Fatalf("path %q streamed (status %d); want refusal", p, rec.Code)
		}
	}
	req := httptest.NewRequest(http.MethodGet, FileTreePrefix+"tok", nil)
	rec := httptest.NewRecorder()
	api.HandleGetFileTree(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 when no path follows the token", rec.Code)
	}
}

func TestFileContentRequiresPath(t *testing.T) {
	api, _, _ := newFilesTestAPI(t)

	req := httptest.NewRequest(http.MethodGet, "/api/session/files/content", nil)
	rec := httptest.NewRecorder()
	api.HandleGetFileContent(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 when path is absent", rec.Code)
	}
}

// TestFileContentNoProject: with no project open there is no containment root,
// so the route refuses rather than falling back to the process cwd.
func TestFileContentNoProject(t *testing.T) {
	api := NewFilesAPI(func() string { return "" })

	rec := serveFileContent(api, "a.txt")
	if rec.Code != http.StatusConflict {
		t.Fatalf("status = %d, want 409 with no project loaded", rec.Code)
	}
}

func serveFileBytes(api *FilesAPI, body FileBytesRequest) *httptest.ResponseRecorder {
	encoded, _ := json.Marshal(body)
	req := httptest.NewRequest(http.MethodPost, "/api/session/files/bytes", bytes.NewReader(encoded))
	rec := httptest.NewRecorder()
	api.HandlePostFileBytes(rec, req)
	return rec
}

// TestFileBytesServesProjectFile is the happy path shared with the GET route.
func TestFileBytesServesProjectFile(t *testing.T) {
	api, project, _ := newFilesTestAPI(t)

	rec := serveFileBytes(api, FileBytesRequest{Path: filepath.Join(project, "src", "app.js")})
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
	}
	if got := rec.Body.String(); got != "const a = 1;\n" {
		t.Errorf("body = %q, want the file's bytes", got)
	}
	if got := rec.Header().Get("X-Content-Type-Options"); got != "nosniff" {
		t.Errorf("X-Content-Type-Options = %q, want nosniff", got)
	}
}

// TestFileBytesContainsByDefault: with no escape hatch asserted, this route is
// contained exactly like the GET one — the hatches are opt-in per request, not a
// property of being a POST.
func TestFileBytesContainsByDefault(t *testing.T) {
	api, _, secret := newFilesTestAPI(t)

	for _, path := range []string{secret, "../secret.txt", "../../../../../../etc/passwd"} {
		rec := serveFileBytes(api, FileBytesRequest{Path: path})
		if rec.Code == http.StatusOK {
			t.Fatalf("path %q streamed unflagged with body %q; want refusal", path, rec.Body.String())
		}
		if strings.Contains(rec.Body.String(), "TOP SECRET") {
			t.Fatalf("path %q leaked out-of-project content", path)
		}
	}
}

// TestFileBytesHonoursEscapeHatches is the reason this route exists: a file the
// user @-mentioned (userInitiated) or approved a read of (outOfRootApproved)
// resolves outside the project, so its viewer can render bytes the streaming URL
// would refuse.
func TestFileBytesHonoursEscapeHatches(t *testing.T) {
	api, _, secret := newFilesTestAPI(t)

	cases := []struct {
		name string
		req  FileBytesRequest
	}{
		{"user-initiated", FileBytesRequest{Path: secret, UserInitiated: true}},
		{"approved read", FileBytesRequest{Path: secret, OutOfRootApproved: true}},
		{"granted root", FileBytesRequest{Path: secret, AllowedPaths: []string{filepath.Dir(secret)}}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			rec := serveFileBytes(api, tc.req)
			if rec.Code != http.StatusOK {
				t.Fatalf("status = %d, want 200 (body %q)", rec.Code, rec.Body.String())
			}
			if got := rec.Body.String(); got != "TOP SECRET" {
				t.Errorf("body = %q, want the out-of-project file's bytes", got)
			}
		})
	}
}

// TestFileBytesFailureModes: each refusal keeps its own status so a viewer can
// tell "not found" from "refused" from "no project".
func TestFileBytesFailureModes(t *testing.T) {
	api, project, _ := newFilesTestAPI(t)

	cases := []struct {
		name string
		api  *FilesAPI
		req  FileBytesRequest
		want int
	}{
		{"empty path", api, FileBytesRequest{}, http.StatusBadRequest},
		{"directory", api, FileBytesRequest{Path: filepath.Join(project, "src")}, http.StatusBadRequest},
		{"missing file", api, FileBytesRequest{Path: filepath.Join(project, "nope.txt")}, http.StatusNotFound},
		{"no project", NewFilesAPI(func() string { return "" }), FileBytesRequest{Path: "a.txt"}, http.StatusConflict},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if rec := serveFileBytes(tc.api, tc.req); rec.Code != tc.want {
				t.Fatalf("status = %d, want %d", rec.Code, tc.want)
			}
		})
	}
}

// TestFileBytesRejectsMalformedBody: a body that is not a descriptor is a 400,
// not a panic.
func TestFileBytesRejectsMalformedBody(t *testing.T) {
	api, _, _ := newFilesTestAPI(t)

	req := httptest.NewRequest(http.MethodPost, "/api/session/files/bytes", strings.NewReader("not json"))
	rec := httptest.NewRecorder()
	api.HandlePostFileBytes(rec, req)
	if rec.Code != http.StatusBadRequest {
		t.Fatalf("status = %d, want 400 for a malformed body", rec.Code)
	}
}
