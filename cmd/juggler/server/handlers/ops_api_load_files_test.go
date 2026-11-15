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
	"strings"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/ops"
)

// The reads that save a round trip over a slow link — loadFiles, many paths in
// one request, and loadFile's reportDirectory, a read that answers "that is a
// folder" instead of needing a stat first — must answer exactly what the
// one-path read answers, refusals included. They travel the same route and are
// built by the same workspace, so the tests go through HandleOperationCall: the
// JSON a browser sends, decoded the way the server decodes it.

// opsCall posts one operation and returns the decoded response.
func opsCall(t *testing.T, api *OpsAPI, req OperationRequest) OperationResponse {
	t.Helper()
	body, _ := json.Marshal(req)
	rec := httptest.NewRecorder()
	api.HandleOperationCall(rec, httptest.NewRequest(http.MethodPost, "/api/ops/call", bytes.NewReader(body)))
	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d for %s: %s", rec.Code, req.Operation, rec.Body.String())
	}
	var resp OperationResponse
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode %s: %v", rec.Body.String(), err)
	}
	return resp
}

// loadFilesEntries runs loadFiles over paths and returns its per-path answers.
func loadFilesEntries(t *testing.T, api *OpsAPI, workspaceID string, paths []any) []map[string]any {
	t.Helper()
	resp := opsCall(t, api, OperationRequest{
		ToolID: "read-file", Operation: "loadFiles", WorkspaceID: workspaceID,
		Params: map[string]any{"paths": paths},
	})
	if !resp.Success {
		t.Fatalf("loadFiles failed as a whole: %s", resp.Error)
	}
	data, _ := resp.Data.(map[string]any)
	raw, _ := data["files"].([]any)
	entries := make([]map[string]any, len(raw))
	for i, e := range raw {
		entries[i], _ = e.(map[string]any)
	}
	return entries
}

// One answer per path, in the order asked, each the answer a single loadFile
// gives for that path: content for a file, exists:false for nothing there, and
// for a folder or a path outside the tree the very error the single read
// refuses it with. One path failing never fails the others.
func TestLoadFilesAnswersEachPathAsLoadFileWould(t *testing.T) {
	project, _ := projectAndWorkspace(t)
	if err := os.MkdirAll(filepath.Join(project, "dir"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("secret\n"), 0o644); err != nil {
		t.Fatalf("write outside file: %v", err)
	}
	api := opsAPIForTest(project, nil)

	paths := []string{"in-project.txt", "missing.md", "dir", outside, "../project/in-project.txt", "../escape.txt"}
	asked := make([]any, len(paths))
	for i, p := range paths {
		asked[i] = p
	}
	entries := loadFilesEntries(t, api, "", asked)
	if len(entries) != len(paths) {
		t.Fatalf("got %d answers for %d paths", len(entries), len(paths))
	}

	for i, path := range paths {
		single := opsCall(t, api, OperationRequest{ToolID: "read-file", Operation: "loadFile", Params: map[string]any{"path": path}})
		got := entries[i]
		if got["path"] != path {
			t.Errorf("answer %d is for %v, want %q — answers must keep the order asked", i, got["path"], path)
		}
		if !single.Success {
			if got["error"] != single.Error {
				t.Errorf("%s: batched error %q, single read refused with %q", path, got["error"], single.Error)
			}
			if _, leaked := got["content"]; leaked {
				t.Errorf("%s: refused by a single read, yet the batch returned content", path)
			}
			continue
		}
		want, _ := single.Data.(map[string]any)
		for _, key := range []string{"content", "exists", "contentHash", "size", "totalLines"} {
			if got[key] != want[key] {
				t.Errorf("%s: %s = %v, single read says %v", path, key, got[key], want[key])
			}
		}
	}

	// The cases that make this test worth having, stated outright rather than
	// left to whatever the single read happens to say.
	if entries[0]["content"] != "project\n" {
		t.Errorf("the project file came back as %v", entries[0])
	}
	if entries[1]["exists"] != false {
		t.Errorf("a missing file came back as %v, want exists:false", entries[1])
	}
	for _, i := range []int{2, 3, 5} {
		if msg, _ := entries[i]["error"].(string); msg == "" {
			t.Errorf("%s was answered without an error: %v", paths[i], entries[i])
		}
	}
	if !strings.Contains(entries[3]["error"].(string), "outside") {
		t.Errorf("a path outside the project was refused for the wrong reason: %v", entries[3]["error"])
	}
}

// A batch names no flag that widens its reach: userInitiated and
// outOfRootApproved, which let one read leave the project, are not read by
// loadFiles, so a batch is held to the tree whatever its params say.
func TestLoadFilesIgnoresScopeWideningFlags(t *testing.T) {
	project, _ := projectAndWorkspace(t)
	outside := filepath.Join(t.TempDir(), "secret.txt")
	if err := os.WriteFile(outside, []byte("secret\n"), 0o644); err != nil {
		t.Fatalf("write outside file: %v", err)
	}
	api := opsAPIForTest(project, nil)
	resp := opsCall(t, api, OperationRequest{
		ToolID: "read-file", Operation: "loadFiles",
		Params: map[string]any{"paths": []any{outside}, "userInitiated": true, "outOfRootApproved": true},
	})
	data, _ := resp.Data.(map[string]any)
	files, _ := data["files"].([]any)
	if len(files) != 1 {
		t.Fatalf("want one answer, got %s", resp.Error)
	}
	entry, _ := files[0].(map[string]any)
	if entry["content"] != nil || entry["error"] == nil {
		t.Fatalf("a batch read left the project on a flag it should not honour: %v", entry)
	}
}

// The batch runs in the workspace the request names, as a single read does.
func TestLoadFilesRunsInTheNamedWorkspace(t *testing.T) {
	project, workspace := projectAndWorkspace(t)
	api := opsAPIForTest(project, map[string]core.Workspace{
		"ws_1": {ID: "ws_1", Kind: core.WorkspaceKindLocal, Root: workspace, State: core.WorkspaceStateReady},
	})
	entries := loadFilesEntries(t, api, "ws_1", []any{"in-workspace.txt", "in-project.txt"})
	if entries[0]["content"] != "workspace\n" {
		t.Errorf("a workspace-relative path read %v, want the workspace's file", entries[0])
	}
	if entries[1]["exists"] != false {
		t.Errorf("a relative path resolved outside the workspace: %v", entries[1])
	}
}

// The batch is bounded: at the cap it runs, past it the whole call is refused
// before anything is read, and a malformed list is refused the same way.
func TestLoadFilesIsCapped(t *testing.T) {
	project, _ := projectAndWorkspace(t)
	api := opsAPIForTest(project, nil)
	call := func(paths any) OperationResponse {
		return opsCall(t, api, OperationRequest{ToolID: "read-file", Operation: "loadFiles", Params: map[string]any{"paths": paths}})
	}
	full := make([]any, ops.MaxLoadFilesPaths)
	for i := range full {
		full[i] = "in-project.txt"
	}
	if resp := call(full); !resp.Success {
		t.Fatalf("a batch at the cap was refused: %s", resp.Error)
	}
	if resp := call(append(full, "in-project.txt")); resp.Success {
		t.Fatalf("a batch past the cap (%d paths) was run", ops.MaxLoadFilesPaths+1)
	}
	for _, bad := range []any{nil, "in-project.txt", []any{"in-project.txt", 5}, []any{""}} {
		if resp := call(bad); resp.Success {
			t.Errorf("paths = %#v was accepted", bad)
		}
	}
	if resp := call([]any{}); !resp.Success {
		t.Errorf("an empty batch failed: %s", resp.Error)
	}
}

// reportDirectory turns the read's "path is a directory" refusal into an
// answer, so a caller that cannot tell a file from a folder by its name reads
// once instead of asking stat first. Without the flag the refusal stands, and
// the flag reaches no further than stat does: outside the tree it is refused.
func TestLoadFileReportDirectory(t *testing.T) {
	project, _ := projectAndWorkspace(t)
	if err := os.MkdirAll(filepath.Join(project, "dir"), 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	api := opsAPIForTest(project, nil)
	read := func(path string, report bool) OperationResponse {
		params := map[string]any{"path": path}
		if report {
			params["reportDirectory"] = true
		}
		return opsCall(t, api, OperationRequest{ToolID: "read-file", Operation: "loadFile", Params: params})
	}

	resp := read("dir", true)
	data, _ := resp.Data.(map[string]any)
	if !resp.Success || data["isDirectory"] != true || data["exists"] != true {
		t.Fatalf("a folder read with reportDirectory answered %+v", resp)
	}
	if resp := read("dir", false); resp.Success {
		t.Errorf("a folder read without reportDirectory succeeded: %+v", resp)
	}
	resp = read("in-project.txt", true)
	data, _ = resp.Data.(map[string]any)
	if !resp.Success || data["content"] != "project\n" || data["isDirectory"] == true {
		t.Errorf("a file read with reportDirectory answered %+v", resp)
	}
	if resp := read(t.TempDir(), true); resp.Success {
		t.Errorf("reportDirectory answered for a folder outside the project: %+v", resp)
	}
}
