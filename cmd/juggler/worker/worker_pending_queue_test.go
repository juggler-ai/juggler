//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	ycrdt "github.com/skyterra/y-crdt"
)

// The pending-message queue: messages typed while a turn was in flight, and how
// they are promoted into the thread at the next boundary.

// enqueuePendingItemForTest inserts an arbitrary item onto a thread's pending
// queue, mimicking the client enqueuing an @-mention / dropped-file read
// alongside a message typed while busy (web: MessageThread.enqueuePendingItem).
func enqueuePendingItemForTest(w *ConversationWorker, threadItemID string, item ConversationItem) {
	ycrdtMu.Lock()
	arr := w.doc.ensurePendingArrayLocked(threadItemID)
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr.Insert(arr.GetLength(), ycrdt.ArrayAny{conversationItemToYMap(item)})
	}, w.doc.txOrigin())
	ycrdtMu.Unlock()
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
