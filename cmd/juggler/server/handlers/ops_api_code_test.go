//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

// An operation that fails reports it as a failure: success false, the message
// in `error`, and — when the op gave the failure a code — that code and its
// detail beside it, so a caller can tell the kind apart without reading prose.
// An edit whose old_str matches nothing is the case that needs it: the edit
// tool answers it differently from every other refusal.
func TestOperationErrorCarriesItsCode(t *testing.T) {
	project := t.TempDir()
	content := []byte("hello world\n")
	if err := os.WriteFile(filepath.Join(project, "f.txt"), content, 0o644); err != nil {
		t.Fatalf("write fixture: %v", err)
	}
	api := opsAPIForTest(project, nil)

	body, _ := json.Marshal(OperationRequest{
		ToolID:    "read-file",
		Operation: "editFile",
		Params:    map[string]any{"path": "f.txt", "old_str": "NOT IN THE FILE", "new_str": "x", "dryRun": true},
	})
	rec := httptest.NewRecorder()
	api.HandleOperationCall(rec, httptest.NewRequest(http.MethodPost, "/api/ops/call", bytes.NewReader(body)))

	if rec.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200 (an operation failure is not a server failure)", rec.Code)
	}
	var resp struct {
		Success bool           `json:"success"`
		Data    any            `json:"data"`
		Error   string         `json:"error"`
		Code    string         `json:"code"`
		Detail  map[string]any `json:"detail"`
	}
	if err := json.Unmarshal(rec.Body.Bytes(), &resp); err != nil {
		t.Fatalf("decode %s: %v", rec.Body.String(), err)
	}
	if resp.Success || resp.Data != nil {
		t.Fatalf("a failed match came back as a successful result: %s", rec.Body.String())
	}
	if resp.Code != "SEARCH_NOT_FOUND" {
		t.Errorf("code = %q, want SEARCH_NOT_FOUND", resp.Code)
	}
	if want := "Search failed in 'f.txt'. Re-read file and use exact text including whitespace."; resp.Error != want {
		t.Errorf("error = %q, want %q", resp.Error, want)
	}
	sum := sha256.Sum256(content)
	if resp.Detail["path"] != "f.txt" || resp.Detail["contentHash"] != hex.EncodeToString(sum[:]) {
		t.Errorf("detail = %v, want the path and the file's current hash", resp.Detail)
	}
}
