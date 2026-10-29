//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

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
	"juggler/cmd/juggler/server/handlers"
	"juggler/tests/helpers"

	"github.com/gorilla/mux"
)

// renameTestRig spins up a SessionManager + HTTP router with the rename
// route bound, returns the manager and a serve function.
func renameTestRig(t *testing.T) (*core.SessionManager, func(method, path string, body []byte) *httptest.ResponseRecorder) {
	t.Helper()
	projectDir := helpers.CreateTempDir(t)
	t.Cleanup(func() { os.RemoveAll(projectDir) })

	manager, err := core.NewSessionManagerForPath(projectDir)
	helpers.AssertNoError(t, err)
	t.Cleanup(func() { manager.Shutdown() })

	api := handlers.NewSessionAPI(func() *core.SessionManager { return manager }, nil, nil, nil, nil)
	r := mux.NewRouter()
	r.HandleFunc("/api/session/conversations/{convId}/name", api.HandleRenameConversation).Methods("PATCH")

	serve := func(method, path string, body []byte) *httptest.ResponseRecorder {
		var reader *bytes.Reader
		if body != nil {
			reader = bytes.NewReader(body)
		} else {
			reader = bytes.NewReader(nil)
		}
		req := httptest.NewRequest(method, path, reader)
		req.Header.Set("Content-Type", "application/json")
		rr := httptest.NewRecorder()
		r.ServeHTTP(rr, req)
		return rr
	}

	return manager, serve
}

// TestRenameAPI_Succeeds: a PATCH with a valid name renames the on-disk
// folder and the new name shows up via ConvNames().
func TestRenameAPI_Succeeds(t *testing.T) {
	manager, serve := renameTestRig(t)
	const convID = "conv_test_rename"

	helpers.AssertNoError(t, manager.SaveConversationBinary(convID, []byte("yjs-data")))

	body, _ := json.Marshal(map[string]string{"name": "My New Title"})
	rr := serve("PATCH", "/api/session/conversations/"+convID+"/name", body)
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp struct {
		Name string `json:"name"`
	}
	helpers.AssertNoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	if resp.Name != "My New Title" {
		t.Fatalf("canonical name: got %q want %q", resp.Name, "My New Title")
	}
	if got := manager.ConvNames()[convID]; got != "My New Title" {
		t.Fatalf("ConvNames after rename: got %q want %q", got, "My New Title")
	}
	dir, ok := manager.ConvDir(convID)
	if !ok || filepath.Base(dir) != core.BuildDirName("My New Title", convID) {
		t.Fatalf("dir on disk: got %q want suffix %q", dir, core.BuildDirName("My New Title", convID))
	}
}

// TestRenameAPI_CollisionReturns409: renaming to a name another conv
// already uses (case-folded) is rejected.
func TestRenameAPI_CollisionReturns409(t *testing.T) {
	manager, serve := renameTestRig(t)
	const convA = "conv_test_a"
	const convB = "conv_test_b"
	helpers.AssertNoError(t, manager.SaveConversationBinary(convA, []byte("a")))
	helpers.AssertNoError(t, manager.SaveConversationBinary(convB, []byte("b")))

	rr := serve("PATCH", "/api/session/conversations/"+convA+"/name", mustJSON(map[string]string{"name": "Same"}))
	if rr.Code != http.StatusOK {
		t.Fatalf("first rename failed: %d %s", rr.Code, rr.Body.String())
	}

	// Same casing → collision
	rr = serve("PATCH", "/api/session/conversations/"+convB+"/name", mustJSON(map[string]string{"name": "Same"}))
	if rr.Code != http.StatusConflict {
		t.Fatalf("expected 409, got %d: %s", rr.Code, rr.Body.String())
	}
	// Different casing → still a collision (case-folded check)
	rr = serve("PATCH", "/api/session/conversations/"+convB+"/name", mustJSON(map[string]string{"name": "SAME"}))
	if rr.Code != http.StatusConflict {
		t.Fatalf("expected case-folded 409, got %d: %s", rr.Code, rr.Body.String())
	}
}

// TestRenameAPI_EmptyName400: a whitespace-only name is rejected.
func TestRenameAPI_EmptyName400(t *testing.T) {
	manager, serve := renameTestRig(t)
	const convID = "conv_test_empty"
	helpers.AssertNoError(t, manager.SaveConversationBinary(convID, []byte("yjs")))

	rr := serve("PATCH", "/api/session/conversations/"+convID+"/name", mustJSON(map[string]string{"name": "   "}))
	if rr.Code != http.StatusBadRequest {
		t.Fatalf("expected 400, got %d: %s", rr.Code, rr.Body.String())
	}
}

// TestRenameAPI_UnknownConv404: PATCH against a conv that doesn't exist.
func TestRenameAPI_UnknownConv404(t *testing.T) {
	_, serve := renameTestRig(t)
	rr := serve("PATCH", "/api/session/conversations/conv_does_not_exist/name", mustJSON(map[string]string{"name": "Foo"}))
	if rr.Code != http.StatusNotFound {
		t.Fatalf("expected 404, got %d: %s", rr.Code, rr.Body.String())
	}
}

// TestRenameAPI_Sanitizes: characters illegal in filenames get replaced
// before the folder rename. The canonical name returned reflects that.
func TestRenameAPI_Sanitizes(t *testing.T) {
	manager, serve := renameTestRig(t)
	const convID = "conv_test_sanitize"
	helpers.AssertNoError(t, manager.SaveConversationBinary(convID, []byte("yjs")))

	rr := serve("PATCH", "/api/session/conversations/"+convID+"/name", mustJSON(map[string]string{"name": "weird/name:with*chars?"}))
	if rr.Code != http.StatusOK {
		t.Fatalf("expected 200, got %d: %s", rr.Code, rr.Body.String())
	}
	var resp struct {
		Name string `json:"name"`
	}
	helpers.AssertNoError(t, json.Unmarshal(rr.Body.Bytes(), &resp))
	if strings.ContainsAny(resp.Name, `/\:*?"<>|`) {
		t.Fatalf("canonical name still contains forbidden chars: %q", resp.Name)
	}
	if manager.ConvNames()[convID] != resp.Name {
		t.Fatalf("ConvNames disagrees with response: %q vs %q", manager.ConvNames()[convID], resp.Name)
	}
}

func mustJSON(v any) []byte {
	b, err := json.Marshal(v)
	if err != nil {
		panic(err)
	}
	return b
}
