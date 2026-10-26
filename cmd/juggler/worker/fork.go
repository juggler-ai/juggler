//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import ycrdt "github.com/skyterra/y-crdt"

// metaForkParked is a one-shot doc-metadata marker stamped on a conversation
// copied from a running source. It tells the clone's first init to load stopped
// (rest instead of auto-resuming an in-flight tool); reconcileProcessingStateOnLoad
// consumes it so a later reload behaves like any normal conversation.
const metaForkParked = "forkParked"

// SnapshotParkedState returns an independent, race-free doc-state snapshot of a
// conversation whose turn is actively running, marked so the clone that loads it
// rests instead of auto-resuming the in-flight turn. ok=true ONLY when a loaded
// worker has a turn owning the run loop (loadState != idle) — precisely the case
// where a flush would block. ok=false otherwise (no worker, or a settled/
// approval-parked source): the caller then flushes + copies the on-disk doc,
// whose persisted state is authoritative and whose clone must re-drive normally.
// Confining the marker to a running source is what keeps a clone of an
// approval-parked conversation re-establishing awaiting_llm on load rather than
// being wrongly parked.
func (m *Manager) SnapshotParkedState(conversationID string) ([]byte, bool) {
	w := m.Get(conversationID)
	if w == nil || w.anyRunState() == StateIdle {
		return nil, false
	}
	return w.snapshotParked(), true
}

// snapshotParked builds a standalone copy of the live doc and stamps the parked
// marker on the COPY — never the live source, whose running turn must not be
// perturbed. ToState is taken under ycrdtMu, so it interleaves at a transaction
// boundary: a complete, internally-consistent CRDT state even mid-turn, with no
// dependence on the (turn-blocked) run loop. Marking a throwaway doc keeps the
// source's in-flight state pristine.
func (w *ConversationWorker) snapshotParked() []byte {
	state := w.doc.ToState() // race-free snapshot of the running doc

	tmp := NewConversationDocument(w.doc.ConversationID(), w.doc.AuthorID())
	defer tmp.Destroy()
	if err := tmp.LoadFromState(state); err != nil {
		// The state is the live doc's own encoding, so this is a y-crdt fault.
		// The clone gets it unmarked — it may resume the in-flight turn when it
		// loads — which is a lesser failure than a clone of nothing.
		w.log.Error("[fork] the running doc's state could not be copied to mark it parked (%v); the clone is unmarked", err)
		return state
	}
	tmp.SetMetadata(metaForkParked, true)
	return tmp.ToState()
}

// WithoutHeldSends returns a conversation's document state with every held
// send — a queued send waiting for a time or for the end of a run, with the
// entries queued ahead of it — taken out of its queues, for a copy of the
// conversation: the copy would otherwise fire each one a second time. A message
// queued untimed stays, like the rest of what is copied. changed is false when
// there was nothing to take out, and state is then returned as given.
func WithoutHeldSends(state []byte) (out []byte, changed bool, err error) {
	doc := NewConversationDocument("clone", "server:clone")
	defer doc.Destroy()
	if err := doc.LoadFromState(state); err != nil {
		return nil, false, err
	}
	if !doc.dropHeldSends() {
		return state, false, nil
	}
	return doc.ToState(), true, nil
}

// dropHeldSends deletes every held send from every thread's queue, in one
// untracked transaction per queue. Reports whether it deleted any.
func (cd *ConversationDocument) dropHeldSends() bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	dropped := false
	visit := func(_ string, parent *ycrdt.YMap) {
		queue, ok := yMapArray(parent, keyPendingItems)
		if !ok {
			return
		}
		held := heldIndicesLocked(queue)
		if len(held) == 0 {
			return
		}
		cd.doc.Transact(func(_ *ycrdt.Transaction) {
			for i := len(held) - 1; i >= 0; i-- {
				queue.Delete(ycrdt.Number(held[i]), 1)
			}
		}, cd.txOrigin())
		dropped = true
	}
	visit("", cd.root)
	if arr := cd.getItems(); arr != nil {
		walkThreadContainersLocked(arr, visit)
	}
	return dropped
}

// heldIndicesLocked returns the queue positions of every member of each send
// that carries a hold, ascending. Caller MUST hold ycrdtMu.
func heldIndicesLocked(queue *ycrdt.YArray) []int {
	raw := queue.ToArray()
	entries := make([]pendingEntry, len(raw))
	for i, v := range raw {
		entries[i] = readPendingEntry(v)
	}
	var out []int
	for _, g := range pendingGroups(entries) {
		if !groupHold(entries[g[0]:g[1]]).stamped() {
			continue
		}
		for i := g[0]; i < g[1]; i++ {
			out = append(out, i)
		}
	}
	return out
}
