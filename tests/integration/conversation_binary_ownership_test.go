//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"os"
	"path/filepath"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/tests/helpers"
)

// foreignConvID is a conversation id that project B never created. It stands in
// for a conversation owned by a *different* project whose worker tries to
// persist into project B.
const foreignConvID = "conv_foreign01"

// hasConvFolder reports whether project B fabricated an on-disk folder for
// convID (the "Untitled--<id>" ghost that later gets adopted into
// conversationOrder as a phantom tab).
func hasConvFolder(t *testing.T, projectDir, convID string) bool {
	t.Helper()
	idx, err := core.ScanConvDirs(filepath.Join(projectDir, ".juggler"))
	if err != nil {
		t.Fatalf("scan conv dirs: %v", err)
	}
	_, ok := idx.ByID[convID]
	return ok
}

// TestSaveConversationBinary_RefusesUnownedConv is the regression guard for the
// cross-project leak: a stale worker from project A must never persist its
// conversation into project B just because B is the loaded project when the
// save fires. The save-binary path B uses must refuse an id B does not own and
// must NOT fabricate an "Untitled--<id>" folder (which would then be adopted
// into B's conversationOrder as a phantom tab on the next load).
func TestSaveConversationBinary_RefusesUnownedConv(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	mgr, err := core.NewSessionManagerForPath(projectDir)
	helpers.AssertNoError(t, err)
	defer mgr.Shutdown()

	// A worker from another project tries to persist its conversation into this
	// one. The worker persistence path must refuse it (saved=false, no error —
	// a benign no-op) and leave no trace on disk.
	saved, err := mgr.SaveConversationBinaryIfOwned(foreignConvID, []byte("yjs-from-project-A"))
	helpers.AssertNoError(t, err)
	if saved {
		t.Fatalf("expected save of unowned conv %s to be refused, but it was persisted", foreignConvID)
	}
	if hasConvFolder(t, projectDir, foreignConvID) {
		t.Fatalf("leak: project fabricated a folder for unowned conv %s", foreignConvID)
	}
}

// TestSaveConversationBinary_PersistsOwnedConv pins the positive path: once the
// project owns the conversation (created through the authoritative entry
// point), the owned-only save persists its bytes normally.
func TestSaveConversationBinary_PersistsOwnedConv(t *testing.T) {
	projectDir := helpers.CreateTempDir(t)
	defer os.RemoveAll(projectDir)

	mgr, err := core.NewSessionManagerForPath(projectDir)
	helpers.AssertNoError(t, err)
	defer mgr.Shutdown()

	id, _, err := mgr.CreateConversation("Owned")
	helpers.AssertNoError(t, err)

	data := []byte("yjs-owned")
	saved, err := mgr.SaveConversationBinaryIfOwned(id, data)
	helpers.AssertNoError(t, err)
	if !saved {
		t.Fatalf("expected save of owned conv %s to be persisted, but it was refused", id)
	}

	loaded, err := mgr.LoadConversationBinary(id)
	helpers.AssertNoError(t, err)
	if string(loaded) != string(data) {
		t.Fatalf("round-trip mismatch: wrote %q, read %q", data, loaded)
	}
}
