//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/server/handlers"
	"juggler/tests/helpers"

	"github.com/gorilla/mux"
)

// emptyBinRig binds the empty-bin route over a real SessionManager and returns
// the manager plus a serve function.
func emptyBinRig(t *testing.T) (*core.SessionManager, func(path string) *httptest.ResponseRecorder) {
	t.Helper()
	projectDir := helpers.CreateTempDir(t)
	t.Cleanup(func() { os.RemoveAll(projectDir) })

	manager, err := core.NewSessionManagerForPath(projectDir)
	helpers.AssertNoError(t, err)
	t.Cleanup(func() { manager.Shutdown() })

	api := handlers.NewSessionAPI(func() *core.SessionManager { return manager }, nil, nil, nil, nil)
	r := mux.NewRouter()
	r.HandleFunc("/api/session/binned-conversations", api.HandleEmptyBin).Methods("DELETE")

	serve := func(path string) *httptest.ResponseRecorder {
		rr := httptest.NewRecorder()
		r.ServeHTTP(rr, httptest.NewRequest("DELETE", path, nil))
		return rr
	}
	return manager, serve
}

// binAged creates a conversation, back-dates its last activity by age, and bins
// it — age is what the cutoff is measured against (see lastActivityTime).
func binAged(t *testing.T, manager *core.SessionManager, convID string, age time.Duration) {
	t.Helper()
	helpers.AssertNoError(t, manager.SaveConversationBinary(convID, []byte("yjs-data")))

	dir, ok := manager.ConvDir(convID)
	if !ok {
		t.Fatalf("no folder for %s", convID)
	}
	txn := filepath.Join(dir, "txns", "txn_0.json")
	helpers.AssertNoError(t, os.MkdirAll(filepath.Dir(txn), 0o755))
	helpers.AssertNoError(t, os.WriteFile(txn, []byte("{}"), 0o644))
	when := time.Now().Add(-age)
	helpers.AssertNoError(t, os.Chtimes(txn, when, when))
	helpers.AssertNoError(t, manager.BinConversation(convID))
}

// TestEmptyBinAPI_OlderThanDays: the cutoff empties only what it names, a bare
// DELETE empties everything, and a nonsense cutoff is refused rather than
// guessed at.
func TestEmptyBinAPI_OlderThanDays(t *testing.T) {
	manager, serve := emptyBinRig(t)
	const path = "/api/session/binned-conversations"
	day := 24 * time.Hour

	binAged(t, manager, "conv_stale", 31*day)
	binAged(t, manager, "conv_fresh", 2*day)

	for _, bad := range []string{"?olderThanDays=0", "?olderThanDays=-5", "?olderThanDays=soon"} {
		if rr := serve(path + bad); rr.Code != http.StatusBadRequest {
			t.Fatalf("DELETE %s%s: got %d, want 400", path, bad, rr.Code)
		}
	}
	if list := manager.ListBinnedConversations(); len(list) != 2 {
		t.Fatalf("a rejected request emptied something: %d binned, want 2", len(list))
	}

	if rr := serve(path + "?olderThanDays=30"); rr.Code != http.StatusNoContent {
		t.Fatalf("DELETE with cutoff: got %d, want 204: %s", rr.Code, rr.Body.String())
	}
	list := manager.ListBinnedConversations()
	if len(list) != 1 || list[0].ID != "conv_fresh" {
		t.Fatalf("after the 30-day empty: %+v, want only conv_fresh", list)
	}

	if rr := serve(path); rr.Code != http.StatusNoContent {
		t.Fatalf("DELETE without cutoff: got %d, want 204: %s", rr.Code, rr.Body.String())
	}
	if list := manager.ListBinnedConversations(); len(list) != 0 {
		t.Fatalf("after emptying everything: %+v, want nothing", list)
	}
}
