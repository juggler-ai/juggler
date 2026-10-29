//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package handlers

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"testing"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/core"
)

// hasActiveConvFolder reports whether a `<name>--<id>` folder for convID exists
// in the ACTIVE .juggler/ dir (not trash) — i.e. whether a ghost folder was
// fabricated for it.
func hasActiveConvFolder(t *testing.T, projectDir, convID string) bool {
	t.Helper()
	idx, err := core.ScanConvDirs(filepath.Join(projectDir, ".juggler"))
	if err != nil {
		t.Fatalf("scan conv dirs: %v", err)
	}
	_, ok := idx.ByID[convID]
	return ok
}

// TestHandleUpdateConversation_DoesNotResurrectBinnedConv is the regression
// guard for the "Untitled ghost" race. A late binary PUT for a conversation that
// has been binned must NOT fabricate an `Untitled--<id>` folder back into the
// active .juggler/ dir.
//
// The dangerous window is a store RELOAD. ensureConvDir refuses to recreate a
// folder for an id in the store's in-memory deletedIDs set, but deletedIDs is
// per-store-lifetime state that Load never repopulates. So after a project
// switch / restart / "an update triggered" reload, a late PUT for a binned id
// trips neither the ownership check nor the deletedIDs guard, and the
// fabricating SaveConversationBinary writes a ghost folder whose empty name
// renders as an "Untitled" phantom tab (content intact, name self-corrects on
// select). The handler must refuse an id this project no longer owns — matching
// the worker persistence seam (SetSaveBinary → SaveConversationBinaryIfOwned).
func TestHandleUpdateConversation_DoesNotResurrectBinnedConv(t *testing.T) {
	projectDir := t.TempDir()

	// Lifetime 1: create a conversation, give it real content, then bin it.
	mgr1, err := core.NewSessionManagerForPath(projectDir)
	if err != nil {
		t.Fatal(err)
	}
	id, _, err := mgr1.CreateConversation("Important Notes")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := mgr1.SaveConversationBinaryIfOwned(id, []byte("real-yjs-doc")); err != nil {
		t.Fatal(err)
	}
	if err := mgr1.BinConversation(id); err != nil {
		t.Fatal(err)
	}
	mgr1.Shutdown()

	// Lifetime 2: a fresh store/manager over the same project — models a project
	// switch / server restart / reload. deletedIDs starts empty here, so the
	// guard that protected lifetime 1 is gone; the binned folder still sits in
	// .juggler/trash/, so the id is simply "not owned".
	mgr2, err := core.NewSessionManagerForPath(projectDir)
	if err != nil {
		t.Fatal(err)
	}
	defer mgr2.Shutdown()

	api := &SessionAPI{managerProvider: func() *core.SessionManager { return mgr2 }}

	// A late binary PUT lands for the binned id (a lagging view flushing its doc).
	req := httptest.NewRequest(http.MethodPut,
		"/api/session/conversations/"+id, bytes.NewReader([]byte("late-yjs-doc")))
	req.Header.Set("Content-Type", "application/octet-stream")
	req = mux.SetURLVars(req, map[string]string{"convId": id})
	rr := httptest.NewRecorder()

	api.HandleUpdateConversation(rr, req)

	// The write must be a benign no-op, not an error, and above all must NOT
	// resurrect the conversation as an active folder.
	if rr.Code >= 500 {
		t.Fatalf("late PUT for binned conv returned server error %d, want a benign no-op", rr.Code)
	}
	if hasActiveConvFolder(t, projectDir, id) {
		t.Fatalf("ghost: binned conv %s was resurrected as an active .juggler/ folder by a late PUT", id)
	}
}
