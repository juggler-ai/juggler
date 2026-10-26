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
// into `items` as real user messages (chronologically last) and takes them off
// the queue. Each drain says what kind of drain it is (promoteCtx): a mid-run
// drain at the top of every LLM turn, or a rest drain where the run ends or the
// thread rests. An entry held for a time or for the run's end (pending_hold.go)
// stays queued until a drain lifts its hold. The strategy loop drains at the turn
// boundary and at end-of-run (drive a new turn). On cancel the behaviour splits:
// when the turn was blocked purely by tool approvals, dropping them continues
// the queued turn (reducer ActionGoIdle → dispatch); when real work was
// executing, Stop promotes the queue and parks at idle. All paths call the same
// primitive — only the continuation differs.

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
	if arr, ok := yMapArray(parent, keyPendingItems); ok {
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
	if arr, ok := yMapArray(parent, keyPendingItems); ok {
		return arr
	}
	arr := ycrdt.NewYArray()
	cd.doc.Transact(func(_ *ycrdt.Transaction) {
		parent.Set(keyPendingItems, arr)
	}, cd.txOrigin())
	return arr
}

// appendPendingItem appends one item to the end of the thread's pending queue,
// creating the queue if the thread hasn't got one yet. Reports false (and
// writes nothing) when the thread is gone. Untracked (txOrigin): the queue is
// plumbing the strategy loop drains, not an undoable edit — the promotion into
// the thread is what the user undoes.
func (w *ConversationWorker) appendPendingItem(threadItemID string, item ConversationItem) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := w.doc.ensurePendingArrayLocked(threadItemID)
	if arr == nil {
		return false
	}
	w.appendPendingItemsLocked(arr, item)
	return true
}

// appendPendingItemsLocked appends items, in order, to a pending queue in one
// untracked transaction, and marks the held-send timer stale so the held-send
// index learns the queue holds something. Caller MUST hold ycrdtMu.
func (w *ConversationWorker) appendPendingItemsLocked(arr *ycrdt.YArray, items ...ConversationItem) {
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		for _, item := range items {
			arr.Insert(arr.GetLength(), ycrdt.ArrayAny{conversationItemToYMap(item)})
		}
	}, w.doc.txOrigin())
	w.markHeldStale()
}

// queueIfBusy is the intake gate and the enqueue in one hold: it reports whether
// threadItemID is busy (threadBusy) and, when it is, appends what build returns
// to its pending queue. build runs only for a busy thread, under ycrdtMu, so it
// must not take the lock. queued is false when build returned nothing or the
// thread is gone.
//
// One hold because the turn that makes the thread busy can end between a
// separate check and the append. It decides to stop with its queue empty, then
// releases its claim. A message that saw the claim and was appended after that
// decision would sit in the queue under an idle thread, with no boundary left to
// drain it. Here the append either lands before the release, where the turn's
// last look (requestLLMIfQueued) finds it, or the gate sees the thread idle and
// the send takes the idle path itself.
func (w *ConversationWorker) queueIfBusy(threadItemID string, build func() []ConversationItem) (busy, queued bool) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	if !w.threadBusyLocked(threadItemID) {
		return false, false
	}
	items := build()
	if len(items) == 0 {
		return true, false
	}
	arr := w.doc.ensurePendingArrayLocked(threadItemID)
	if arr == nil {
		return true, false
	}
	w.appendPendingItemsLocked(arr, items...)
	return true, true
}

// enqueuePendingMessage appends a user message (text + attachments, as one
// inseparable unit) to the thread's pending queue. The strategy loop drains the
// queue at its next boundary, promoting the item verbatim — attachments
// included. Intake asks queueIfBusy instead, which decides and appends in one
// hold.
func (w *ConversationWorker) enqueuePendingMessage(threadItemID string, input UserMessageInput) {
	if input.isEmpty() {
		return
	}
	item := newUserItem(input)
	if !w.appendPendingItem(threadItemID, item) {
		return
	}
	w.recordPendingEnqueue(threadItemID, item.ItemID)
}

// recordPendingEnqueue tapes a queued user message and flushes, so the queued
// bubble surfaces in the UI immediately.
func (w *ConversationWorker) recordPendingEnqueue(threadItemID, itemID string) {
	w.tape.Record("pending-enqueue", map[string]any{
		"threadItemId": threadItemID,
		"itemId":       itemID,
	})
	w.batcher.Flush()
}

// requestLLMIfQueued promotes what pc lets out of threadItemID's pending queue
// and, when that was anything, queues the thread for dispatch. It is a
// finishing run's last look at its own thread, taken after its claim is
// released and its idle frame is out: from then on the intake gate sees the
// thread idle, so nothing can be queued there that this look misses (see
// queueIfBusy). Reports whether it queued a dispatch.
//
// The promotion and the claim are two holds. A send landing between them
// takes the idle path, which appends its message behind the promoted ones and
// asks for the same dispatch; either claim brings the turn that answers both.
// A send whose hold has not lifted promotes nothing and asks for no dispatch,
// so a held send never keeps a resting thread busy.
func (r *run) requestLLMIfQueued(threadItemID string, pc promoteCtx) bool {
	if r.promotePendingItems(threadItemID, pc) == 0 {
		return false
	}
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	return r.patchRunIfLocked(threadItemID,
		entryNotCallingLLM,
		func(entry runEntry, _ map[string]any) { entry.setActivity(ActivityAwaitingLLM) },
	)
}

// hasPendingItems reports whether the thread has any queued entries at all,
// held or not. A decision about driving the thread asks hasPromotablePending.
func (w *ConversationWorker) hasPendingItems(threadItemID string) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := w.doc.getPendingArrayLocked(threadItemID)
	return arr != nil && arr.GetLength() > 0
}

// hasPromotablePending reports whether a drain under pc would promote
// anything from the thread's queue.
func (w *ConversationWorker) hasPromotablePending(threadItemID string, pc promoteCtx) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := w.doc.getPendingArrayLocked(threadItemID)
	return arr != nil && len(promotableIndicesLocked(arr, pc)) > 0
}

// promotePendingItems moves the queued messages whose hold pc lifts into the
// thread's items array as user messages (chronologically last). The
// promoted items are left UNSTAMPED (no transactionId) so the strategy loop's
// findUnstampedUserMsgID picks up the last one for the next round-trip. Returns
// the number promoted. The move itself, and why it is one hold, is
// OperationTracker.PromotePending.
//
// The items-change pass the promotion calls for runs on the actor. A turn
// promotes at every boundary on its own goroutine, and the pass reaches state
// only the actor may touch (the undo grouping, the delivery pumps, the doc-driven
// pickup), so off the actor it is handed over through the items-change signal
// rather than run where it stands. The turn needs nothing from it: what it reads
// next is the promoted items themselves.
func (r *run) promotePendingItems(threadItemID string, pc promoteCtx) int {
	pending := r.tracker.PromotePending(threadItemID, pc)
	if len(pending) == 0 {
		return 0
	}
	// What the held-send timer waits for may have just left the queue.
	r.markHeldStale()

	r.tape.Record("pending-promote", map[string]any{
		"threadItemId": threadItemID,
		"count":        len(pending),
	})
	r.batcher.Flush()
	if r.actor.onActor() {
		r.handleItemsChange()
	} else {
		r.signalItemsChange()
	}
	return len(pending)
}

// collectPendingAssetIDsLocked adds every asset id referenced by a QUEUED
// (pending) user message — the root queue and every thread container's queue —
// to dst. A queued message lives in a `pendingItems` sibling array, NOT in
// `items`, so the committed-item walk in collectAssetIDsFromItems never sees it;
// without this a queued attachment's bytes could be reclaimed by the asset sweep
// before the message is promoted, landing a broken image. Mirrors
// collectDraftAssetIDsLocked. Caller MUST hold ycrdtMu.
func (cd *ConversationDocument) collectPendingAssetIDsLocked(dst map[string]bool) {
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
	arr, ok := yMapArray(parent, keyPendingItems)
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
		if nested, ok := yMapArray(m, keyItems); ok {
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
	w.markHeldStale()
	w.log.Info("Cleared %d pending message(s) for thread %q", length, threadItemID)
}
