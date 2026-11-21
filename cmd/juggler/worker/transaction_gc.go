//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"bytes"
	"encoding/json"
	"time"
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

// TxnMaxAgeFunc reports the user's transaction records setting: the age, in
// days, past which a conversation's records are deleted, or 0 to keep them.
// Nil ⇒ 0.
type TxnMaxAgeFunc func() int

// requestTxnTrim asks the transaction store to tidy this conversation's
// records (TransactionStore.RequestTrim): delete those older than the
// transaction records setting allows, and strip the input of every other one
// old enough to have lost it. Each thread's newest round-trip is kept whole
// however old: the footer meter reads its token counts, and the tool-drift
// check the tools it was offered from its input.
//
// Run once a first load has finished, and after every persisted save alongside
// sweepTransactions. The tidying runs in the background; this only builds the
// keep set and reads the setting.
func (w *ConversationWorker) requestTxnTrim() {
	if w.txnStore == nil {
		return
	}
	keep := make(map[string]bool)
	collectLatestRoundTripTxnIDs(w.doc.GetItems(), keep)
	var maxAge time.Duration
	if fn := w.deps().txnMaxAge; fn != nil {
		if days := fn(); days > 0 {
			maxAge = time.Duration(days) * 24 * time.Hour
		}
	}
	w.txnStore.RequestTrim(w.conversationID, keep, maxAge)
}

// collectLatestRoundTripTxnIDs adds to dst the transactionId of each thread's
// newest round-trip — at the root and in every nested thread — reading it off
// the last item a round-trip produced, as the viewer's findLastRoundTripTxnId
// (web/js/utils/transaction-anchor.js) does. The user message that opened a
// round-trip carries its id too but sits on the input side, and is skipped.
func collectLatestRoundTripTxnIDs(items []ConversationItem, dst map[string]bool) {
	found := false
	for i := len(items) - 1; i >= 0; i-- {
		it := items[i]
		if !found && it.TransactionID != "" && isRoundTripOutput(it.Type) {
			dst[it.TransactionID] = true
			found = true
		}
		if it.Type == ItemTypeThread && len(it.Items) > 0 {
			var nested []ConversationItem
			if err := json.Unmarshal(it.Items, &nested); err == nil {
				collectLatestRoundTripTxnIDs(nested, dst)
			}
		}
	}
}

// isRoundTripOutput reports whether an item of this type is something a
// round-trip produced.
func isRoundTripOutput(itemType string) bool {
	return itemType == ItemTypeAssistant || itemType == ItemTypeThinking || itemType == ItemTypeToolAction
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
