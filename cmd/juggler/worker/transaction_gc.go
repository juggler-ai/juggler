//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"bytes"
	"encoding/json"
)

// sweepTransactions deletes any transaction blob whose id is no longer
// reachable from the live items tree or the undo/redo stacks.
//
// Items in the live tree are scanned directly. Items that were deleted but
// are kept alive by UndoManager (for potential undo restoration) are scanned
// via the tracker's undo/redo stacks.
//
// Run after every persisted save (and on shutdown).
func (w *ConversationWorker) sweepTransactions() error {
	if w.txnStore == nil {
		return nil
	}

	live := make(map[string]bool)
	collectTxnIDsFromItems(w.doc.GetItems(), live)

	for _, id := range w.tracker.undoableTransactionIDs() {
		if id != "" {
			live[id] = true
		}
	}

	return w.txnStore.Sweep(w.conversationID, live)
}

// sweepAssets reclaims content-addressed asset blobs (attached images, etc.)
// under <convDir>/assets/ that are no longer referenced by the live doc.
//
// Run after every persisted save, alongside sweepTransactions.
func (w *ConversationWorker) sweepAssets() error {
	if w.assetStore == nil {
		return nil
	}
	live, keepAll := w.collectLiveAssetIDs()
	if keepAll {
		return nil
	}
	return w.assetStore.Sweep(w.conversationID, live, AssetStagingGrace)
}

// sweepPrograms drops the snapshot of every program that can no longer resume
// from it: its tool-action has settled (completed, or cancelled — a denial), or
// is gone from the document. One still unsettled — pending on the user, or
// running — keeps its snapshot, at root or in any thread.
//
// A thread whose items cannot be read hides what is unsettled in it, so then
// nothing is swept (as collectLiveAssetIDs' keepAll does for assets).
//
// Run after every persisted save, alongside sweepAssets.
func (w *ConversationWorker) sweepPrograms() error {
	if w.programStore == nil {
		return nil
	}
	live := make(map[string]bool)
	if keepAll := collectUnsettledToolUseIDs(w.doc.GetItems(), live); keepAll {
		return nil
	}
	return w.programStore.Sweep(w.conversationID, live)
}

// collectUnsettledToolUseIDs walks items recursively (into nested thread
// items) adding the tool-use id of every tool-action not yet settled. It
// returns keepAll when a thread's items fail to unmarshal: dst is then
// incomplete, and a sweep against it would drop live snapshots.
func collectUnsettledToolUseIDs(items []ConversationItem, dst map[string]bool) (keepAll bool) {
	for _, it := range items {
		if it.Type == ItemTypeToolAction && it.ToolUseID != "" && !isToolTerminal(it) {
			dst[it.ToolUseID] = true
		}
		if it.Type == ItemTypeThread && len(it.Items) > 0 {
			var nested []ConversationItem
			if err := json.Unmarshal(it.Items, &nested); err != nil {
				keepAll = true
				continue
			}
			if collectUnsettledToolUseIDs(nested, dst) {
				keepAll = true
			}
		}
	}
	return keepAll
}

// collectLiveAssetIDs returns the set of asset shas referenced by the live doc,
// plus keepAll: when true the sweep is skipped entirely (nothing is deleted).
//
// Collects every attachment id the document refers to (CollectAssetIDs), then
// folds in ids restorable via the undo/redo stacks — mirroring sweepTransactions
// (collectTxnIDsFromItems + undoableTransactionIDs) so a just-deleted-but-undoable
// attachment is not GC'd prematurely. The undo stacks are read after the items:
// an item a turn deletes moves from the one to the other, so reading them in
// that order sees it in at least one.
func (w *ConversationWorker) collectLiveAssetIDs() (live map[string]bool, keepAll bool) {
	live = make(map[string]bool)
	w.doc.CollectAssetIDs(live)

	for _, id := range w.tracker.undoableAssetIDs() {
		if id != "" {
			live[id] = true
		}
	}

	return live, false
}

// CollectAssetIDs adds to dst every attachment id the document refers to:
// committed items (root and nested threads), unsent drafts, and queued
// ("type while busy") messages, which live in pendingItems sibling arrays.
//
// One hold for all three. A turn promotes a queued message from pendingItems
// to items on its own goroutine while the sweep runs on the run loop, so reads
// in separate holds could each land on the wrong side of the move and miss it.
func (cd *ConversationDocument) CollectAssetIDs(dst map[string]bool) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	collectAssetIDsFromItems(cd.getConversationItems(), dst)
	cd.collectDraftAssetIDsLocked(dst)
	cd.collectPendingAssetIDsLocked(dst)
}

// collectTxnIDsFromItems walks items recursively (into nested thread items)
// adding every TransactionID it encounters to dst.
func collectTxnIDsFromItems(items []ConversationItem, dst map[string]bool) {
	for _, it := range items {
		if it.TransactionID != "" {
			dst[it.TransactionID] = true
		}
		// Threads carry their nested items in Items as JSON.
		if it.Type == ItemTypeThread && len(it.Items) > 0 {
			var nested []ConversationItem
			if err := json.Unmarshal(it.Items, &nested); err == nil {
				collectTxnIDsFromItems(nested, dst)
			}
		}
	}
}

// collectAssetIDsFromItems walks items recursively (into nested thread items)
// adding every attachment id it encounters to dst. Mirrors collectTxnIDsFromItems.
func collectAssetIDsFromItems(items []ConversationItem, dst map[string]bool) {
	for _, it := range items {
		for _, att := range it.Attachments {
			if att.ID != "" {
				dst[att.ID] = true
			}
		}
		// A hold lasts only while the item is at work. One that settled without
		// running again to let go (a denial cancels it from outside the tool)
		// holds nothing, and what a finished item shows is in its Attachments,
		// written in the same transaction as its state.
		if !isToolTerminal(it) {
			for _, id := range it.HeldAssets {
				if id != "" {
					dst[id] = true
				}
			}
		}
		// An edit's diff names the two sides it stores as assets.
		for _, id := range diffSnapshotAssetIDs(it.DisplayData) {
			dst[id] = true
		}
		// Threads carry their nested items in Items as JSON.
		if it.Type == ItemTypeThread && len(it.Items) > 0 {
			var nested []ConversationItem
			if err := json.Unmarshal(it.Items, &nested); err == nil {
				collectAssetIDsFromItems(nested, dst)
			}
		}
	}
}

// diffSnapshotAssetIDs returns the asset ids a tool-action's displayData names
// for the two sides of an edit's diff (diffData.oldRef / diffData.newRef). The
// files themselves are stored as text assets, out of the document. Display data
// that names neither costs a byte scan, not a parse.
func diffSnapshotAssetIDs(displayData []byte) []string {
	if !bytes.Contains(displayData, []byte(`"oldRef"`)) && !bytes.Contains(displayData, []byte(`"newRef"`)) {
		return nil
	}
	var parsed struct {
		DiffData struct {
			OldRef string `json:"oldRef"`
			NewRef string `json:"newRef"`
		} `json:"diffData"`
	}
	if json.Unmarshal(displayData, &parsed) != nil {
		return nil
	}
	var ids []string
	for _, id := range []string{parsed.DiffData.OldRef, parsed.DiffData.NewRef} {
		if id != "" {
			ids = append(ids, id)
		}
	}
	return ids
}
