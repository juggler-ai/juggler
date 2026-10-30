//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// tinyPNG is the smallest valid 1x1 PNG, used so AssetStore.Save can decode
// real dimensions (the store runs image.DecodeConfig).
var tinyPNG = []byte{
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
	0x49, 0x48, 0x44, 0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
	0x08, 0x06, 0x00, 0x00, 0x00, 0x1f, 0x15, 0xc4, 0x89, 0x00, 0x00, 0x00,
	0x0d, 0x49, 0x44, 0x41, 0x54, 0x78, 0x9c, 0x62, 0x00, 0x01, 0x00, 0x00,
	0x05, 0x00, 0x01, 0x0d, 0x0a, 0x2d, 0xb4, 0x00, 0x00, 0x00, 0x00, 0x49,
	0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
}

func testAssetStore(t *testing.T) (*AssetStore, string) {
	t.Helper()
	dir := t.TempDir()
	return NewAssetStore(func(string) (string, bool) { return dir, true }), dir
}

// TestSweepAssets_ReclaimsOnlyUnreferenced is B3: an asset referenced by a live
// user item survives the sweep; an asset with no live reference is reclaimed.
// Drives the real GC logic — collectAssetIDsFromItems builds the live set, and
// AssetStore.Sweep deletes everything outside it.
func TestSweepAssets_ReclaimsOnlyUnreferenced(t *testing.T) {
	store, _ := testAssetStore(t)
	const convID = "conv-gc"

	// Two distinct assets. `kept` is referenced by a live item below;
	// `orphan` has different bytes (so a different sha) and no reference.
	kept, err := store.Save(convID, tinyPNG, "image/png")
	if err != nil {
		t.Fatalf("save kept: %v", err)
	}
	orphanBytes := append([]byte{}, tinyPNG...)
	orphanBytes[len(orphanBytes)-1] ^= 0xff // perturb → different content hash
	orphan, err := store.Save(convID, orphanBytes, "image/png")
	if err != nil {
		t.Fatalf("save orphan: %v", err)
	}
	if kept.ID == orphan.ID {
		t.Fatal("test setup bug: kept and orphan hashed identically")
	}

	// Live doc: one user item references `kept`, plus a thread item whose
	// nested user item references `kept` too (exercises the recursive walk).
	nested, _ := json.Marshal([]ConversationItem{
		{Type: ItemTypeUser, ItemID: "nested-user", Attachments: []AssetRef{kept}},
	})
	items := []ConversationItem{
		{Type: ItemTypeUser, ItemID: "u1", Attachments: []AssetRef{kept}},
		{Type: ItemTypeThread, ItemID: "t1", Items: nested},
	}

	live := make(map[string]bool)
	collectAssetIDsFromItems(items, live)
	if !live[kept.ID] {
		t.Fatalf("collectAssetIDsFromItems missed the referenced asset; live=%v", live)
	}
	if live[orphan.ID] {
		t.Fatalf("collectAssetIDsFromItems wrongly marked the orphan live; live=%v", live)
	}

	if err := store.Sweep(convID, live, 0); err != nil {
		t.Fatalf("sweep: %v", err)
	}

	// Referenced asset must remain readable.
	if _, _, err := store.Get(convID, kept.ID); err != nil {
		t.Errorf("referenced asset was swept (should survive): %v", err)
	}
	// Orphan must be gone.
	if _, _, err := store.Get(convID, orphan.ID); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("orphan asset survived the sweep (want os.ErrNotExist), got err=%v", err)
	}
}

// TestSweepAssets_RemovesAllWhenNothingReferenced confirms an empty live set
// reclaims every asset (the "conversation cleared of all attachments" case).
func TestSweepAssets_RemovesAllWhenNothingReferenced(t *testing.T) {
	store, _ := testAssetStore(t)
	const convID = "conv-gc-empty"

	ref, err := store.Save(convID, tinyPNG, "image/png")
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	if err := store.Sweep(convID, map[string]bool{}, 0); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if _, _, err := store.Get(convID, ref.ID); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("asset survived sweep with empty live set, err=%v", err)
	}
}

// TestSweepAssets_GraceProtectsFreshlyStaged is the regression for the broken
// image link on send: an attachment's bytes land on disk at upload, BEFORE the
// user message that references it is committed to the doc. An unrelated
// debounced save in that window runs the sweep with an empty live set; without
// a grace window it reclaims the staged bytes and the just-sent <img> 404s.
//
// A freshly-written, unreferenced asset must survive a graced sweep, and the
// same asset, once aged past the grace window and still unreferenced, must then
// be reclaimed. mtime is backdated via os.Chtimes so the test is deterministic
// (no sleeps).
func TestSweepAssets_GraceProtectsFreshlyStaged(t *testing.T) {
	store, _ := testAssetStore(t)
	const convID = "conv-gc-grace"
	const grace = 5 * time.Minute

	ref, err := store.Save(convID, tinyPNG, "image/png")
	if err != nil {
		t.Fatalf("save: %v", err)
	}

	// Just-uploaded, not yet referenced: a graced sweep must keep it.
	if err := store.Sweep(convID, map[string]bool{}, grace); err != nil {
		t.Fatalf("graced sweep: %v", err)
	}
	if _, _, err := store.Get(convID, ref.ID); err != nil {
		t.Fatalf("freshly-staged asset was reclaimed within grace window: %v", err)
	}

	// Backdate the file's mtime to before the grace cutoff. Still unreferenced,
	// so the next graced sweep must now reclaim it.
	p, ok := store.Path(convID, ref.ID)
	if !ok {
		t.Fatal("asset path not found after save")
	}
	old := time.Now().Add(-2 * grace)
	if err := os.Chtimes(p, old, old); err != nil {
		t.Fatalf("backdate mtime: %v", err)
	}
	if err := store.Sweep(convID, map[string]bool{}, grace); err != nil {
		t.Fatalf("graced sweep after aging: %v", err)
	}
	if _, _, err := store.Get(convID, ref.ID); !errors.Is(err, os.ErrNotExist) {
		t.Errorf("aged unreferenced asset survived graced sweep (want os.ErrNotExist), got err=%v", err)
	}
}

// TestCollectLiveAssetIDs_IncludesDraftAttachments is the regression for the
// lost-draft-attachment bug: an image staged on an UNSENT draft (text +
// attachments) must keep its bytes alive across sweeps. A draft's attachments
// live on container/metadata state, not on a committed item, so the item walk
// in collectAssetIDsFromItems never sees them — without draft-awareness the
// staged bytes are reclaimed and the persisted draft ref dangles after restart.
//
// Covers both draft locations: the root draft (conversation metadata) and a
// thread container's draft.
func TestCollectLiveAssetIDs_IncludesDraftAttachments(t *testing.T) {
	w := NewConversationWorker("conv-draft-gc", "user:test")

	const rootAsset = "root-draft-sha"
	const threadAsset = "thread-draft-sha"

	// Root draft (conversation metadata) references rootAsset.
	w.doc.SetMetadata("draft", map[string]any{
		"text": "unsent at root",
		"attachments": []any{
			map[string]any{"id": rootAsset, "mime": "image/png", "filename": "r.png", "bytes": 10, "width": 1, "height": 1},
		},
	})

	// A thread item whose container draft references threadAsset.
	w.doc.AppendMessage(ConversationItem{Type: ItemTypeThread, ItemID: "t1"})
	if err := w.doc.UpdateItemByID("t1", "draft", map[string]any{
		"text": "unsent in thread",
		"attachments": []any{
			map[string]any{"id": threadAsset, "mime": "image/png", "filename": "t.png", "bytes": 20, "width": 1, "height": 1},
		},
	}); err != nil {
		t.Fatalf("set thread draft: %v", err)
	}

	live, keepAll := w.collectLiveAssetIDs()
	if keepAll {
		t.Fatal("collectLiveAssetIDs returned keepAll=true; want a concrete live set")
	}
	if !live[rootAsset] {
		t.Errorf("root draft attachment missing from live set; live=%v", live)
	}
	if !live[threadAsset] {
		t.Errorf("thread draft attachment missing from live set; live=%v", live)
	}
}

// TestCollectLiveAssetIDs_IncludesPendingAttachments is the regression for the
// lost-queued-attachment bug: an image attached to a message sent WHILE THE
// WORKER IS BUSY is parked in a `pendingItems` sibling array, not in `items`,
// so the committed-item walk never sees it. Without queue-awareness the staged
// bytes are reclaimed and the message promotes to a broken image.
//
// Covers both queue locations: the root queue and a thread container's queue.
func TestCollectLiveAssetIDs_IncludesPendingAttachments(t *testing.T) {
	w := NewConversationWorker("conv-pending-gc", "user:test")

	const rootAsset = "root-pending-sha"
	const threadAsset = "thread-pending-sha"

	// A queued message at root carrying an image.
	w.enqueuePendingMessage("", UserMessageInput{
		Text:        "queued at root",
		Attachments: []AssetRef{{ID: rootAsset, Mime: "image/png", Filename: "r.png", Bytes: 10, Width: 1, Height: 1}},
	})

	// A thread whose queue carries an image.
	w.doc.AppendMessage(ConversationItem{Type: ItemTypeThread, ItemID: "t1"})
	w.enqueuePendingMessage("t1", UserMessageInput{
		Text:        "queued in thread",
		Attachments: []AssetRef{{ID: threadAsset, Mime: "image/png", Filename: "t.png", Bytes: 20, Width: 1, Height: 1}},
	})

	live, keepAll := w.collectLiveAssetIDs()
	if keepAll {
		t.Fatal("collectLiveAssetIDs returned keepAll=true; want a concrete live set")
	}
	if !live[rootAsset] {
		t.Errorf("root pending attachment missing from live set; live=%v", live)
	}
	if !live[threadAsset] {
		t.Errorf("thread pending attachment missing from live set; live=%v", live)
	}
}

// TestCollectLiveAssetIDs_IncludesHeldAssets pins that an item still at work
// can keep an asset alive that nothing yet attaches: a tool that has stored an
// image it may attach once it finishes names it in `heldAssets`, which the
// sweep counts like an attachment. Without it, a tool that waits on the user
// for longer than the staging grace finds its image reclaimed. Covers an item
// at root and one inside a thread.
func TestCollectLiveAssetIDs_IncludesHeldAssets(t *testing.T) {
	w := NewConversationWorker("conv-held-gc", "user:test")

	const rootAsset = "root-held-sha"
	const threadAsset = "thread-held-sha"

	w.doc.AppendMessage(ConversationItem{Type: ItemTypeToolAction, ItemID: "a1", ToolUseID: "call_1"})
	if err := w.doc.UpdateItemByID("a1", "heldAssets", []any{rootAsset}); err != nil {
		t.Fatalf("set root heldAssets: %v", err)
	}
	nested, _ := json.Marshal([]map[string]any{{
		"type": ItemTypeToolAction, "itemId": "a2", "toolUseId": "call_2", "heldAssets": []string{threadAsset},
	}})
	w.doc.AppendMessage(ConversationItem{Type: ItemTypeThread, ItemID: "t1", Items: nested})

	live, keepAll := w.collectLiveAssetIDs()
	if keepAll {
		t.Fatal("collectLiveAssetIDs returned keepAll=true; want a concrete live set")
	}
	if !live[rootAsset] {
		t.Errorf("root held asset missing from live set; live=%v", live)
	}
	if !live[threadAsset] {
		t.Errorf("thread held asset missing from live set; live=%v", live)
	}
}

// TestCollectLiveAssetIDs_SettledItemHoldsNothing pins that `heldAssets` keeps
// an asset only while its item is at work. An item that settled without being
// run again to clear the field (a denial cancels it from outside the tool)
// would otherwise keep what it held for good; what a settled item does show is
// in its own attachments. Covers both settled states, at root and in a thread,
// beside a pending item whose hold still counts.
func TestCollectLiveAssetIDs_SettledItemHoldsNothing(t *testing.T) {
	w := NewConversationWorker("conv-held-settled", "user:test")

	w.doc.AppendMessage(ConversationItem{Type: ItemTypeToolAction, ItemID: "a1", ToolUseID: "call_1", State: StateCancelled})
	if err := w.doc.UpdateItemByID("a1", "heldAssets", []any{"denied-sha"}); err != nil {
		t.Fatalf("set heldAssets: %v", err)
	}
	w.doc.AppendMessage(ConversationItem{Type: ItemTypeToolAction, ItemID: "a2", ToolUseID: "call_2", State: StatePending})
	if err := w.doc.UpdateItemByID("a2", "heldAssets", []any{"suspended-sha"}); err != nil {
		t.Fatalf("set heldAssets: %v", err)
	}
	nested, _ := json.Marshal([]map[string]any{{
		"type": ItemTypeToolAction, "itemId": "a3", "toolUseId": "call_3", "state": StateCompleted,
		"heldAssets": []string{"completed-sha"}, "attachments": []map[string]any{{"id": "shown-sha", "mime": "image/png"}},
	}})
	w.doc.AppendMessage(ConversationItem{Type: ItemTypeThread, ItemID: "t1", Items: nested})

	live, _ := w.collectLiveAssetIDs()
	for _, id := range []string{"denied-sha", "completed-sha"} {
		if live[id] {
			t.Errorf("%s is held by a settled item but was kept; live=%v", id, live)
		}
	}
	for _, id := range []string{"suspended-sha", "shown-sha"} {
		if !live[id] {
			t.Errorf("%s missing from live set; live=%v", id, live)
		}
	}
}

// TestAssetStore_SaveIsContentAddressedDedup confirms saving identical bytes
// twice yields one stable id and one on-disk file — the property the sweep's
// content-hash live set relies on.
func TestAssetStore_SaveIsContentAddressedDedup(t *testing.T) {
	store, _ := testAssetStore(t)
	const convID = "conv-dedup"

	a, err := store.Save(convID, tinyPNG, "image/png")
	if err != nil {
		t.Fatalf("save 1: %v", err)
	}
	b, err := store.Save(convID, tinyPNG, "image/png")
	if err != nil {
		t.Fatalf("save 2: %v", err)
	}
	if a.ID != b.ID {
		t.Fatalf("identical bytes hashed to different ids: %q vs %q", a.ID, b.ID)
	}
	if a.Width != 1 || a.Height != 1 {
		t.Errorf("decoded dims = %dx%d, want 1x1", a.Width, a.Height)
	}
	shas, err := store.List(convID)
	if err != nil {
		t.Fatalf("list: %v", err)
	}
	if len(shas) != 1 {
		t.Fatalf("dedup failed: %d files on disk, want 1 (%v)", len(shas), shas)
	}
}

// diffRefDisplayData is a tool-action's displayData for an edit whose two sides
// are stored as text assets: the document carries their ids, not the files.
func diffRefDisplayData(oldID, newID string) json.RawMessage {
	raw, _ := json.Marshal(map[string]any{"diffData": map[string]any{
		"path": "src/a.go", "startLineNumber": 1, "oldRef": oldID, "newRef": newID, "added": 1, "removed": 1,
	}})
	return raw
}

// TestSweepAssets_KeepsDiffSnapshotRefs pins that the sides of an edit's diff,
// stored as text assets and named by the tool-action's displayData, count as
// live — at root and inside a thread — and are reclaimed once no item names
// them.
func TestSweepAssets_KeepsDiffSnapshotRefs(t *testing.T) {
	store, _ := testAssetStore(t)
	const convID = "conv-diff-gc"

	save := func(text string) AssetRef {
		ref, err := store.Save(convID, []byte(text), "text/plain")
		if err != nil {
			t.Fatalf("save %q: %v", text, err)
		}
		return ref
	}
	before, after := save("a\nb\n"), save("a\nc\n")
	nestedBefore, nestedAfter := save("x\n"), save("y\n")
	orphan := save("nobody names me\n")

	nested, _ := json.Marshal([]ConversationItem{{
		Type: ItemTypeToolAction, ItemID: "e2", ToolUseID: "call_2", State: StateCompleted,
		DisplayData: diffRefDisplayData(nestedBefore.ID, nestedAfter.ID),
	}})
	items := []ConversationItem{
		{Type: ItemTypeToolAction, ItemID: "e1", ToolUseID: "call_1", State: StateCompleted, DisplayData: diffRefDisplayData(before.ID, after.ID)},
		{Type: ItemTypeThread, ItemID: "t1", Items: nested},
	}

	live := make(map[string]bool)
	collectAssetIDsFromItems(items, live)
	for name, ref := range map[string]AssetRef{"before": before, "after": after, "nested before": nestedBefore, "nested after": nestedAfter} {
		if !live[ref.ID] {
			t.Errorf("the %s side of a diff is missing from the live set; live=%v", name, live)
		}
	}
	if live[orphan.ID] {
		t.Errorf("an asset no item names was marked live; live=%v", live)
	}
	if err := store.Sweep(convID, live, 0); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if _, _, err := store.Get(convID, before.ID); err != nil {
		t.Fatalf("a referenced diff side was swept: %v", err)
	}
	if _, _, err := store.Get(convID, orphan.ID); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("the unreferenced asset survived the sweep: %v", err)
	}

	// The items go: nothing names the sides any more, and they are reclaimed.
	if err := store.Sweep(convID, map[string]bool{}, 0); err != nil {
		t.Fatalf("sweep: %v", err)
	}
	if _, _, err := store.Get(convID, before.ID); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("a diff side outlived the item that named it: %v", err)
	}
}

// TestCollectLiveAssetIDs_KeepsDiffRefsOfUndoableEdits pins that deleting an
// edit's tool-action does not orphan its diff while undo can bring it back: the
// sides it names stay live from the undo stack.
func TestCollectLiveAssetIDs_KeepsDiffRefsOfUndoableEdits(t *testing.T) {
	w := NewConversationWorker("conv-diff-undo", "user:test")
	w.tracker.AppendMessage(ConversationItem{
		Type: ItemTypeToolAction, ItemID: "e1", ToolUseID: "call_1", State: StateCompleted,
		DisplayData: diffRefDisplayData("old-side-sha", "new-side-sha"),
	})
	w.tracker.StopCapturing()
	w.tracker.DeleteMessages([]int{0})
	w.tracker.StopCapturing()

	live, _ := w.collectLiveAssetIDs()
	for _, id := range []string{"old-side-sha", "new-side-sha"} {
		if !live[id] {
			t.Errorf("%s is named by an undoable edit but is missing from the live set; live=%v", id, live)
		}
	}
}

// TestAssetStore_TextKeepsItsTypeThroughACopy pins that a text asset reads back
// as text, so duplicating a conversation (CopyAll) stores it under the same id
// and type rather than as an anonymous binary.
func TestAssetStore_TextKeepsItsTypeThroughACopy(t *testing.T) {
	store, _ := testAssetStore(t)
	ref, err := store.Save("src", []byte("one\ntwo\n"), "text/plain")
	if err != nil {
		t.Fatalf("save: %v", err)
	}
	if _, mime, err := store.Get("src", ref.ID); err != nil || mime != "text/plain" {
		t.Fatalf("Get = %q, %v; want text/plain", mime, err)
	}
	if p, ok := store.Path("src", ref.ID); !ok || filepath.Ext(p) != ".txt" {
		t.Fatalf("stored at %q, want a .txt file", p)
	}
}
