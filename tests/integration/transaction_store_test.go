//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

// Per-conversation transaction blob store GC contract.
//
// Every test bypasses the strategy loop and drives the OperationTracker /
// TransactionStore directly so the live-set + undoLog rules can be asserted
// without timer waits or LLM mocks.

package integration_test

import (
	"errors"
	"os"
	"testing"
	"time"

	"juggler/cmd/juggler/worker"
	"juggler/tests/integration/helpers"
)

// runWithTimeout enforces a hard per-test deadline. Tests in this file are
// purely synchronous, but a timeout guards against accidental hangs (e.g.
// future code that introduces channel reads inside a sweep).
func runWithTimeout(t *testing.T, d time.Duration, fn func()) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		defer close(done)
		fn()
	}()
	select {
	case <-done:
	case <-time.After(d):
		t.Fatalf("test exceeded hard timeout %v", d)
	}
}

// blobExists returns true iff a blob file with the given txnID is on disk.
func blobExists(t *testing.T, store *worker.TransactionStore, convID, txnID string) bool {
	t.Helper()
	_, err := store.Load(convID, txnID)
	if err == nil {
		return true
	}
	if errors.Is(err, os.ErrNotExist) {
		return false
	}
	t.Fatalf("unexpected error loading blob %s: %v", txnID, err)
	return false
}

// itemWithTxn builds a stamped user item for use as test data.
func itemWithTxn(itemID, txnID, content string) worker.ConversationItem {
	return worker.ConversationItem{
		Type:          "user",
		ItemID:        itemID,
		Content:       content,
		TransactionID: txnID,
		Timestamp:     time.Now().Format(time.RFC3339),
	}
}

// TestTransactionGC_LiveItemRetainsBlob: an item in the live tree pins its
// blob on disk; sweeping leaves it untouched.
func TestTransactionGC_LiveItemRetainsBlob(t *testing.T) {
	t.Parallel()
	runWithTimeout(t, 5*time.Second, func() {
		ts := helpers.SetupTestSession(t)
		store := worker.NewTransactionStore(helpers.TestPathProvider(ts.TmpDir))

		const txn = "txn_live_1"
		if err := store.Save(ts.ConvID, txn, []byte(`{"id":"txn_live_1"}`)); err != nil {
			t.Fatalf("save blob: %v", err)
		}
		ts.Worker.Tracker().InsertMessage(0, itemWithTxn("u1", txn, "hi"))

		if err := ts.Worker.SweepTransactionsForTest(); err != nil {
			t.Fatalf("sweep: %v", err)
		}
		if !blobExists(t, store, ts.ConvID, txn) {
			t.Fatalf("blob %s should be retained: live item references it", txn)
		}
	})
}

// TestTransactionGC_OrphanBlobIsSwept: a blob with no item AND no undoLog
// entry referencing it is deleted on sweep. This is the core GC guarantee.
func TestTransactionGC_OrphanBlobIsSwept(t *testing.T) {
	t.Parallel()
	runWithTimeout(t, 5*time.Second, func() {
		ts := helpers.SetupTestSession(t)
		store := worker.NewTransactionStore(helpers.TestPathProvider(ts.TmpDir))

		const txn = "txn_orphan"
		if err := store.Save(ts.ConvID, txn, []byte(`{"id":"txn_orphan"}`)); err != nil {
			t.Fatalf("save blob: %v", err)
		}

		if err := ts.Worker.SweepTransactionsForTest(); err != nil {
			t.Fatalf("sweep: %v", err)
		}
		if blobExists(t, store, ts.ConvID, txn) {
			t.Fatalf("orphan blob %s should have been deleted", txn)
		}
	})
}

// TestTransactionGC_UndoLogPinsBlob: when an item is removed from the live
// tree by undo (or delete), the undoLog still holds enough data to resurrect
// it — so its blob MUST stay on disk until that log entry is trimmed.
func TestTransactionGC_UndoLogPinsBlob(t *testing.T) {
	t.Parallel()
	runWithTimeout(t, 5*time.Second, func() {
		ts := helpers.SetupTestSession(t)
		store := worker.NewTransactionStore(helpers.TestPathProvider(ts.TmpDir))
		tracker := ts.Worker.Tracker()

		const txn = "txn_undo"
		if err := store.Save(ts.ConvID, txn, []byte(`{"id":"txn_undo"}`)); err != nil {
			t.Fatalf("save blob: %v", err)
		}
		tracker.InsertMessage(0, itemWithTxn("u1", txn, "hi"))

		// Undo: item leaves the live tree but the insert op stays in the log.
		if !tracker.Undo() {
			t.Fatal("Undo should report success")
		}

		if err := ts.Worker.SweepTransactionsForTest(); err != nil {
			t.Fatalf("sweep: %v", err)
		}
		if !blobExists(t, store, ts.ConvID, txn) {
			t.Fatalf("blob %s should be retained: undoLog still references it (item resurrectable via redo)", txn)
		}

		// Redo restores the item — sweep must still keep the blob.
		if !tracker.Redo() {
			t.Fatal("Redo should report success")
		}
		if err := ts.Worker.SweepTransactionsForTest(); err != nil {
			t.Fatalf("sweep after redo: %v", err)
		}
		if !blobExists(t, store, ts.ConvID, txn) {
			t.Fatalf("blob %s should still exist after redo", txn)
		}
	})
}

// TestTransactionGC_TrimEvictsBlob: once a new operation truncates the redo
// tail (the only way to make the previous insert non-resurrectable), the
// blob is no longer pinned and the next sweep deletes it.
func TestTransactionGC_TrimEvictsBlob(t *testing.T) {
	t.Parallel()
	runWithTimeout(t, 5*time.Second, func() {
		ts := helpers.SetupTestSession(t)
		store := worker.NewTransactionStore(helpers.TestPathProvider(ts.TmpDir))
		tracker := ts.Worker.Tracker()

		const txnA = "txn_a"
		const txnB = "txn_b"
		if err := store.Save(ts.ConvID, txnA, []byte(`{"id":"txn_a"}`)); err != nil {
			t.Fatalf("save txnA: %v", err)
		}
		if err := store.Save(ts.ConvID, txnB, []byte(`{"id":"txn_b"}`)); err != nil {
			t.Fatalf("save txnB: %v", err)
		}

		// Insert A then undo (A is now in the redo tail).
		tracker.InsertMessage(0, itemWithTxn("u1", txnA, "A"))
		if !tracker.Undo() {
			t.Fatal("undo A failed")
		}

		// New op overwrites the redo tail — A's insert log entry is trimmed.
		tracker.InsertMessage(0, itemWithTxn("u2", txnB, "B"))

		if err := ts.Worker.SweepTransactionsForTest(); err != nil {
			t.Fatalf("sweep: %v", err)
		}
		if blobExists(t, store, ts.ConvID, txnA) {
			t.Fatalf("blob %s should have been deleted: its only log entry was trimmed by the new insert", txnA)
		}
		if !blobExists(t, store, ts.ConvID, txnB) {
			t.Fatalf("blob %s should be retained: live item still references it", txnB)
		}
	})
}

// TestTransactionGC_SharedTxnAcrossItems: many items can share one txnID
// (the typical case — assistant message + tool-actions from one round-trip
// all carry the same id). Deleting one of them must not GC the shared blob
// while any other reference (live or undoLog) is alive.
func TestTransactionGC_SharedTxnAcrossItems(t *testing.T) {
	t.Parallel()
	runWithTimeout(t, 5*time.Second, func() {
		ts := helpers.SetupTestSession(t)
		store := worker.NewTransactionStore(helpers.TestPathProvider(ts.TmpDir))
		tracker := ts.Worker.Tracker()

		const txn = "txn_shared"
		if err := store.Save(ts.ConvID, txn, []byte(`{"id":"txn_shared"}`)); err != nil {
			t.Fatalf("save blob: %v", err)
		}

		tracker.InsertMessage(0,
			itemWithTxn("u1", txn, "first"),
			itemWithTxn("u2", txn, "second"),
			itemWithTxn("u3", txn, "third"),
		)

		// Delete one — two siblings still reference txn.
		tracker.DeleteMessages([]int{1})

		if err := ts.Worker.SweepTransactionsForTest(); err != nil {
			t.Fatalf("sweep: %v", err)
		}
		if !blobExists(t, store, ts.ConvID, txn) {
			t.Fatalf("blob %s should be retained: 2 live items still reference it", txn)
		}
	})
}

// TestTransactionGC_DeleteAllOnConversationRemoval: when a conversation file
// is deleted, the entire .txns directory must go with it. Tests the cleanup
// hook in core/session.go:DeleteConversation, which protects against blobs
// outliving their referencing doc.
func TestTransactionGC_DeleteAllOnConversationRemoval(t *testing.T) {
	t.Parallel()
	runWithTimeout(t, 5*time.Second, func() {
		ts := helpers.SetupTestSession(t)
		store := worker.NewTransactionStore(helpers.TestPathProvider(ts.TmpDir))

		for _, id := range []string{"a", "b", "c"} {
			if err := store.Save(ts.ConvID, id, []byte(`{}`)); err != nil {
				t.Fatalf("save %s: %v", id, err)
			}
		}
		if err := store.DeleteAll(ts.ConvID); err != nil {
			t.Fatalf("DeleteAll: %v", err)
		}
		ids, err := store.List(ts.ConvID)
		if err != nil {
			t.Fatalf("List after DeleteAll: %v", err)
		}
		if len(ids) != 0 {
			t.Fatalf("expected no blobs after DeleteAll, got %v", ids)
		}
	})
}

// TestTransactionGC_NestedThreadItemRetainsBlob: blobs referenced by items
// inside a thread's nested items array must be retained — sweep recurses
// into thread items, not just root items.
func TestTransactionGC_NestedThreadItemRetainsBlob(t *testing.T) {
	t.Parallel()
	runWithTimeout(t, 5*time.Second, func() {
		ts := helpers.SetupTestSession(t)
		store := worker.NewTransactionStore(helpers.TestPathProvider(ts.TmpDir))
		tracker := ts.Worker.Tracker()

		const txn = "txn_nested"
		if err := store.Save(ts.ConvID, txn, []byte(`{"id":"txn_nested"}`)); err != nil {
			t.Fatalf("save blob: %v", err)
		}

		// Build a thread item whose nested items array contains a stamped
		// user item. Use the same JSON shape the worker writes for threads
		// (Items field is a JSON-encoded array of nested items).
		nestedItemsJSON := []byte(`[{"type":"user","itemId":"nested-1","content":"inside","transactionId":"txn_nested"}]`)
		thread := worker.ConversationItem{
			Type:   "thread",
			ItemID: "thread-1",
			Goal:   "test",
			Items:  nestedItemsJSON,
		}
		tracker.InsertMessage(0, thread)

		if err := ts.Worker.SweepTransactionsForTest(); err != nil {
			t.Fatalf("sweep: %v", err)
		}
		if !blobExists(t, store, ts.ConvID, txn) {
			t.Fatalf("blob %s should be retained: nested thread item references it", txn)
		}
	})
}

// TestTransactionGC_ReplaceForwardAndInverseBothPin: an items:replace op
// stores both the old and new item in the log. Both txnIDs must pin their
// blobs until the replace entry is trimmed.
func TestTransactionGC_ReplaceForwardAndInverseBothPin(t *testing.T) {
	t.Parallel()
	runWithTimeout(t, 5*time.Second, func() {
		ts := helpers.SetupTestSession(t)
		store := worker.NewTransactionStore(helpers.TestPathProvider(ts.TmpDir))
		tracker := ts.Worker.Tracker()

		const txnOld = "txn_replace_old"
		const txnNew = "txn_replace_new"
		for _, id := range []string{txnOld, txnNew} {
			if err := store.Save(ts.ConvID, id, []byte(`{}`)); err != nil {
				t.Fatalf("save %s: %v", id, err)
			}
		}

		tracker.InsertMessage(0, itemWithTxn("u1", txnOld, "old"))
		if err := tracker.ReplaceMessage(0, itemWithTxn("u1", txnNew, "new")); err != nil {
			t.Fatalf("replace: %v", err)
		}

		if err := ts.Worker.SweepTransactionsForTest(); err != nil {
			t.Fatalf("sweep: %v", err)
		}
		// New is in the live tree.
		if !blobExists(t, store, ts.ConvID, txnNew) {
			t.Fatalf("blob %s should be retained: live item carries it", txnNew)
		}
		// Old is in the undoLog (inverse + the original insert's forward).
		if !blobExists(t, store, ts.ConvID, txnOld) {
			t.Fatalf("blob %s should be retained: replace inverse + insert forward both reference it", txnOld)
		}
	})
}

// TestTransactionGC_ClearHistoryEvictsAll: clearing the undo history removes
// every log entry, so any blob no longer referenced by a live item must be
// swept on the next pass.
func TestTransactionGC_ClearHistoryEvictsAll(t *testing.T) {
	t.Parallel()
	runWithTimeout(t, 5*time.Second, func() {
		ts := helpers.SetupTestSession(t)
		store := worker.NewTransactionStore(helpers.TestPathProvider(ts.TmpDir))
		tracker := ts.Worker.Tracker()

		const txn = "txn_cleared"
		if err := store.Save(ts.ConvID, txn, []byte(`{}`)); err != nil {
			t.Fatalf("save: %v", err)
		}
		tracker.InsertMessage(0, itemWithTxn("u1", txn, "x"))
		tracker.DeleteMessages([]int{0})

		// Before clear: undoLog still holds both ops, blob retained.
		if err := ts.Worker.SweepTransactionsForTest(); err != nil {
			t.Fatalf("sweep before clear: %v", err)
		}
		if !blobExists(t, store, ts.ConvID, txn) {
			t.Fatalf("blob %s should be retained while undoLog holds insert/delete ops", txn)
		}

		// After clear: log gone, item not in live tree → blob is swept.
		tracker.ClearHistory()
		if err := ts.Worker.SweepTransactionsForTest(); err != nil {
			t.Fatalf("sweep after clear: %v", err)
		}
		if blobExists(t, store, ts.ConvID, txn) {
			t.Fatalf("blob %s should be swept after ClearHistory drops the only references", txn)
		}
	})
}
