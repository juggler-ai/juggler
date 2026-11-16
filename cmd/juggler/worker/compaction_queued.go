//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"juggler/cmd/juggler/msg"

	ycrdt "github.com/skyterra/y-crdt"
)

// A /compact typed while a turn runs.
//
// It waits in the thread's pending queue ("type while busy", pending_items.go)
// as a user message reading "/compact" or "/compact all", marked with
// keyQueuedCompaction. The queued zone shows it like any queued message, and
// Remove takes it out. Unlike a message it is never promoted
// (groupIndicesLocked skips it), so the model never reads it.
//
// It fires at the end of a reducer drain once the whole conversation is at rest:
// no live turn, no claim on any thread, no pass pending, and no tool call still
// in flight in the thread it folds. From there it is /compact typed into an idle
// conversation: the same fold, the same summary run, the same one-step undo.
//
// It was asked for on the understanding that the turn would finish first, so
// whatever ends the turn otherwise withdraws it (dropQueuedCompactions): Stop,
// Pause, undo or redo, and a restart of the server. A duplicate of the
// conversation does not inherit it (dropHeldSends). One left inside a thread a
// later fold archived is dropped as found: it could only fold history nothing
// reads.

// The keyQueuedCompaction values: the fold the queued /compact asks for.
const (
	queuedCompactRecent = "recent" // /compact: the recent conversation stays verbatim
	queuedCompactAll    = "all"    // /compact all: everything after the standing context folds
)

// queueCompaction queues a /compact on threadItemID. One already waiting there
// takes this one's mode instead, so the last asked for is the one that runs.
// Reports false when the thread is gone. Actor only.
func (r *run) queueCompaction(threadItemID string, keepRecent bool) bool {
	text, mode := "/compact", queuedCompactRecent
	if !keepRecent {
		text, mode = "/compact all", queuedCompactAll
	}
	ok := false
	withYDoc(func() {
		queue := r.doc.ensurePendingArrayLocked(threadItemID)
		if queue == nil {
			return
		}
		ok = true
		for i, e := range readPendingEntriesLocked(queue) {
			if !e.compaction {
				continue
			}
			if m, isMap := queue.Get(ycrdt.Number(i)).(*ycrdt.YMap); isMap {
				r.doc.doc.Transact(func(_ *ycrdt.Transaction) {
					m.Set(keyQueuedCompaction, mode)
					m.Set(keyContent, text)
				}, r.doc.txOrigin())
			}
			return
		}
		stamp := map[string]any{keySendID: generateSendID(), keyQueuedCompaction: mode}
		r.appendPendingItemsLocked(queue, stamp, newUserItem(UserMessageInput{Text: text}))
	})
	if ok {
		r.noQueuedCompaction = false
		r.batcher.Flush()
	}
	return ok
}

// fireQueuedCompaction folds the first queued /compact whose thread is ready,
// once nothing in the conversation is running. Called at the end of every
// reducer drain. A fold that finds nothing to take, or fails, says so: the
// command that queued it has long since returned. Actor only.
func (r *run) fireQueuedCompaction() {
	if r.noQueuedCompaction || r.sched.hasLive() || r.sched.reconcilePending() ||
		r.anyRunState() != StateIdle || r.hasActiveRun() {
		return
	}
	threadItemID, mode, found := r.takeQueuedCompaction()
	if !found {
		return
	}
	dest, ok := r.resolveThread(threadItemID)
	if !ok {
		return
	}
	r.log.Info("[compact] folding the /compact queued on thread %q", threadItemID)
	keepRecent := mode != queuedCompactAll
	r.compactNow(dest, compactFoldOptions{keepRecent: keepRecent}, func(folded bool, err error) {
		switch {
		case err != nil:
			r.sendStatusText(string(statusValidationError), msg.New("Couldn't compact: {error}", "error", err.Error()))
		case folded:
		case keepRecent:
			r.sendStatusText(string(statusValidationError), msg.New("Nothing to compact yet — only recent turns. /compact all folds them too."))
		default:
			r.sendStatusText(string(statusValidationError), msg.New("Nothing to compact yet."))
		}
	})
}

// takeQueuedCompaction takes the first queued /compact whose thread holds no
// tool call in flight off its queue, and reports its thread and mode. One found
// inside an archived compaction thread is dropped on the way. When the queues
// hold none at all it notes that, so later drains skip the walk. Actor only.
func (r *run) takeQueuedCompaction() (threadItemID, mode string, found bool) {
	withYDoc(func() {
		waiting := false
		walkQueuesLocked(r.doc, func(id string, queue *ycrdt.YArray, archived bool) {
			if found {
				waiting = true
				return
			}
			for i, e := range readPendingEntriesLocked(queue) {
				if !e.compaction {
					continue
				}
				if !archived {
					waiting = true
					if items := r.doc.threadItemsArrayLocked(id); items != nil && toolInFlightLocked(items) {
						return
					}
					m, _ := queue.Get(ycrdt.Number(i)).(*ycrdt.YMap)
					threadItemID, mode, found = id, yMapString(m, keyQueuedCompaction), true
				}
				r.doc.doc.Transact(func(_ *ycrdt.Transaction) {
					queue.Delete(ycrdt.Number(i), 1)
				}, r.doc.txOrigin())
				r.markHeldStale()
				return
			}
		})
		r.noQueuedCompaction = !waiting
	})
	return threadItemID, mode, found
}

// dropQueuedCompactions takes every queued /compact in the conversation off its
// queue. Actor only.
func (w *ConversationWorker) dropQueuedCompactions() {
	if w.noQueuedCompaction {
		return
	}
	dropped := 0
	withYDoc(func() {
		walkQueuesLocked(w.doc, func(_ string, queue *ycrdt.YArray, _ bool) {
			dropped += dropCompactionEntriesLocked(w.doc, queue)
		})
	})
	w.noQueuedCompaction = true
	if dropped > 0 {
		w.markHeldStale()
		w.batcher.Flush()
		w.log.Info("[compact] withdrew %d queued /compact(s)", dropped)
	}
}

// dropCompactionEntriesLocked deletes every queued /compact from queue, each in
// an untracked transaction, and returns how many. Caller MUST hold ycrdtMu.
func dropCompactionEntriesLocked(cd *ConversationDocument, queue *ycrdt.YArray) int {
	entries := readPendingEntriesLocked(queue)
	dropped := 0
	for i := len(entries) - 1; i >= 0; i-- {
		if entries[i].compaction {
			cd.doc.Transact(func(_ *ycrdt.Transaction) {
				queue.Delete(ycrdt.Number(i), 1)
			}, cd.txOrigin())
			dropped++
		}
	}
	return dropped
}

// walkQueuesLocked calls visit for the root's pending queue and every thread's,
// at any depth, saying whether the thread is archived: a compaction thread, or
// inside one, whose items are history no run will touch again. Caller MUST hold
// ycrdtMu.
func walkQueuesLocked(cd *ConversationDocument, visit func(threadItemID string, queue *ycrdt.YArray, archived bool)) {
	var walk func(arr *ycrdt.YArray, archived bool)
	walk = func(arr *ycrdt.YArray, archived bool) {
		for i := 0; i < int(arr.GetLength()); i++ {
			m, ok := arr.Get(ycrdt.Number(i)).(*ycrdt.YMap)
			if !ok {
				continue
			}
			inArchive := archived || yMapBool(m, keyBoundedCompaction)
			if queue, ok := yMapArray(m, keyPendingItems); ok {
				visit(yMapString(m, keyItemID), queue, inArchive)
			}
			if nested, ok := yMapArray(m, keyItems); ok {
				walk(nested, inArchive)
			}
		}
	}
	if queue, ok := yMapArray(cd.root, keyPendingItems); ok {
		visit("", queue, false)
	}
	if arr := cd.getItems(); arr != nil {
		walk(arr, false)
	}
}

// toolInFlightLocked reports whether arr, or any thread nested in it, holds a
// tool call that is not completed or cancelled. A fold takes what it finds as it
// stands, and nothing would ever settle a call it moved. Archived compaction
// threads are not looked into: what they hold is history, never run again.
// Caller MUST hold ycrdtMu.
func toolInFlightLocked(arr *ycrdt.YArray) bool {
	for i := 0; i < int(arr.GetLength()); i++ {
		m, ok := arr.Get(ycrdt.Number(i)).(*ycrdt.YMap)
		if !ok {
			continue
		}
		if yMapString(m, keyType) == ItemTypeToolAction && !isTerminalToolState(yMapString(m, keyState)) {
			return true
		}
		if nested, ok := yMapArray(m, keyItems); ok && !yMapBool(m, keyBoundedCompaction) && toolInFlightLocked(nested) {
			return true
		}
	}
	return false
}

// toolInFlightUnder reports whether threadItemID's items, or any thread nested
// in them, hold a tool call in flight (toolInFlightLocked).
func (r *run) toolInFlightUnder(threadItemID string) bool {
	inFlight := false
	withYDoc(func() {
		if items := r.doc.threadItemsArrayLocked(threadItemID); items != nil {
			inFlight = toolInFlightLocked(items)
		}
	})
	return inFlight
}
