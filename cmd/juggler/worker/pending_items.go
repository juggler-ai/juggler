//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	ycrdt "github.com/skyterra/y-crdt"
)

// Queued (pending) messages — "type while busy".
//
// A message sent while a turn is already in flight is not dropped: it is parked
// in a `pendingItems` Y.Array hung off the same parent map that owns `items`
// (the doc root for the root thread, the thread Y.Map for a sub-thread). Because
// it is a sibling of `items` it is NEVER seen by the reducer or the LLM context
// builder until it is promoted.
//
// `promotePendingItems` is the single transition: it moves the queued entries
// into `items` as real user messages (chronologically last) and clears the
// queue. The strategy loop drains at the turn boundary and at end-of-run (drive
// a new turn). On cancel the behaviour splits: when the turn was blocked purely
// by tool approvals, dropping them continues the queued turn (reducer ActionGoIdle
// → dispatch); when real work was executing, Stop promotes the queue and parks
// at idle. All paths call the same primitive — only the continuation differs.

// pendingParentMapLocked returns the Y.Map that owns the pendingItems array for
// the given thread ("" => root). Caller MUST hold ycrdtMu.
func (cd *ConversationDocument) pendingParentMapLocked(threadItemID string) *ycrdt.YMap {
	if threadItemID == "" {
		return cd.root
	}
	return findThreadYMap(cd.getItems(), threadItemID)
}

// getPendingArrayLocked returns the existing pendingItems array for the thread,
// or nil if none has been created. Caller MUST hold ycrdtMu.
func (cd *ConversationDocument) getPendingArrayLocked(threadItemID string) *ycrdt.YArray {
	parent := cd.pendingParentMapLocked(threadItemID)
	if parent == nil {
		return nil
	}
	if arr, ok := parent.Get("pendingItems").(*ycrdt.YArray); ok {
		return arr
	}
	return nil
}

// ensurePendingArrayLocked get-or-creates the pendingItems array on the parent
// map for the thread. Caller MUST hold ycrdtMu. Returns nil if the thread is gone.
func (cd *ConversationDocument) ensurePendingArrayLocked(threadItemID string) *ycrdt.YArray {
	parent := cd.pendingParentMapLocked(threadItemID)
	if parent == nil {
		return nil
	}
	if arr, ok := parent.Get("pendingItems").(*ycrdt.YArray); ok {
		return arr
	}
	arr := ycrdt.NewYArray()
	cd.doc.Transact(func(_ *ycrdt.Transaction) {
		parent.Set("pendingItems", arr)
	}, cd.txOrigin())
	return arr
}

// enqueuePendingMessage appends a user message (text + attachments, as one
// inseparable unit) to the thread's pending queue. Called when a send arrives
// while a turn is already in flight; the strategy loop drains the queue at its
// next boundary, promoting the item verbatim — attachments included.
func (w *ConversationWorker) enqueuePendingMessage(threadItemID string, input UserMessageInput) {
	if input.isEmpty() {
		return
	}
	item := newUserItem(input)

	ycrdtMu.Lock()
	arr := w.doc.ensurePendingArrayLocked(threadItemID)
	if arr == nil {
		ycrdtMu.Unlock()
		return
	}
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr.Insert(arr.GetLength(), ycrdt.ArrayAny{conversationItemToYMap(item)})
	}, w.doc.txOrigin())
	ycrdtMu.Unlock()

	w.tape.Record("pending-enqueue", map[string]any{
		"threadItemId": threadItemID,
		"itemId":       item.ItemID,
	})
	w.batcher.Flush() // surface the queued bubble in the UI immediately
}

// HasPendingItems reports whether the thread ("" => root) has any queued
// (not-yet-promoted) messages. Exported for test observability so a test can
// deterministically wait for a busy-time send to land in the queue before
// releasing the in-flight turn.
func (w *ConversationWorker) HasPendingItems(threadItemID string) bool {
	return w.hasPendingItems(threadItemID)
}

// hasPendingItems reports whether the thread has any queued messages.
func (w *ConversationWorker) hasPendingItems(threadItemID string) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := w.doc.getPendingArrayLocked(threadItemID)
	return arr != nil && arr.GetLength() > 0
}

// promotePendingItems moves every queued message for the thread into its items
// array as a user message (chronologically last) and clears the queue. The
// promoted items are left UNSTAMPED (no transactionId) so the strategy loop's
// findUnstampedUserMsgID picks up the last one for the next round-trip. Returns
// the number promoted.
func (w *ConversationWorker) promotePendingItems(threadItemID string) int {
	ycrdtMu.Lock()
	arr := w.doc.getPendingArrayLocked(threadItemID)
	if arr == nil || arr.GetLength() == 0 {
		ycrdtMu.Unlock()
		return 0
	}
	pending := w.doc.getItemsFromArrayLocked(arr)
	length := int(arr.GetLength())
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr.Delete(ycrdt.Number(0), length)
	}, w.doc.txOrigin())
	ycrdtMu.Unlock()

	for i := range pending {
		// Next turn's user input — must not carry the previous round-trip's id.
		pending[i].TransactionID = ""
	}

	if threadItemID == "" {
		// Root: tracker insert keeps undo parity with a normal user send.
		w.tracker.InsertMessage(w.doc.GetItemsLength(), pending...)
	} else {
		target := w.doc.GetThreadItemsArray(threadItemID)
		if target == nil {
			return 0
		}
		// Tracker insert, mirroring the root branch: a promotion into a sub-thread
		// is undoable just like a normal user send. (The pending-queue clear above
		// stays untracked — queuing is not conversation content.)
		w.tracker.InsertMessageIntoArray(target, w.doc.GetItemsLengthFromArray(target), pending...)
	}

	w.tape.Record("pending-promote", map[string]any{
		"threadItemId": threadItemID,
		"count":        len(pending),
	})
	w.batcher.Flush()
	w.handleItemsChange()
	return len(pending)
}

// CollectPendingAssetIDs adds every asset id referenced by a QUEUED (pending)
// user message — the root queue and every thread container's queue — to dst. A
// queued message lives in a `pendingItems` sibling array, NOT in `items`, so
// the committed-item walk in collectAssetIDsFromItems never sees it; without
// this a queued attachment's bytes could be reclaimed by the asset sweep before
// the message is promoted, landing a broken image. Mirrors CollectDraftAssetIDs.
func (cd *ConversationDocument) CollectPendingAssetIDs(dst map[string]bool) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	collectPendingAssetIDsFromMap(cd.root, dst)
	if arr := cd.getItems(); arr != nil {
		collectPendingAssetIDsFromArray(arr, dst)
	}
}

// collectPendingAssetIDsFromMap adds the attachment ids of every queued user
// item in the parent map's pendingItems array to dst. Callers MUST hold ycrdtMu.
func collectPendingAssetIDsFromMap(parent *ycrdt.YMap, dst map[string]bool) {
	if parent == nil {
		return
	}
	arr, ok := parent.Get("pendingItems").(*ycrdt.YArray)
	if !ok {
		return
	}
	length := int(arr.GetLength())
	for i := 0; i < length; i++ {
		m, ok := arr.Get(ycrdt.Number(i)).(*ycrdt.YMap)
		if !ok {
			continue
		}
		for _, att := range yMapToConversationItem(m).Attachments {
			if att.ID != "" {
				dst[att.ID] = true
			}
		}
	}
}

// collectPendingAssetIDsFromArray walks an items Y.Array (recursing into each
// thread's nested "items") collecting each thread container's queued-attachment
// ids. Callers MUST hold ycrdtMu.
func collectPendingAssetIDsFromArray(arr *ycrdt.YArray, dst map[string]bool) {
	length := int(arr.GetLength())
	for i := 0; i < length; i++ {
		m, ok := arr.Get(ycrdt.Number(i)).(*ycrdt.YMap)
		if !ok {
			continue
		}
		collectPendingAssetIDsFromMap(m, dst)
		if nested, ok := m.Get("items").(*ycrdt.YArray); ok {
			collectPendingAssetIDsFromArray(nested, dst)
		}
	}
}

// clearPendingItems empties the thread's pending queue without promoting. Used
// by /clear, the one thread-wide mutator that must remember the staging array.
func (w *ConversationWorker) clearPendingItems(threadItemID string) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := w.doc.getPendingArrayLocked(threadItemID)
	if arr == nil {
		return
	}
	length := int(arr.GetLength())
	if length == 0 {
		return
	}
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr.Delete(ycrdt.Number(0), length)
	}, w.doc.txOrigin())
	w.log.Info("Cleared %d pending message(s) for thread %q", length, threadItemID)
}
