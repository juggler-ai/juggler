//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"time"

	ycrdt "github.com/skyterra/y-crdt"
)

// Held sends — a queued message that waits for a time, or for the run to end.
//
// A scheduled send is an ordinary pending-queue entry carrying a hold: keyNotBefore
// (epoch ms) keeps it queued until that moment, and keyHold = pendingHoldRunEnd
// keeps it queued until the thread's run ends or rests. Every entry one send
// wrote shares a keySendID. An entry without either hold key is promoted at the
// first drain, exactly as an untimed queued message always is.

// pendingHoldRunEnd is the keyHold value that holds an entry until the thread's
// run ends or rests. It is the only hold there is.
const pendingHoldRunEnd = "run-end"

// promoteCtx is what a drain site knows that decides which holds have lifted:
// the time it drains at, and whether the thread's run is over (it ended, or
// the thread is resting) rather than between two of its rounds.
type promoteCtx struct {
	now    time.Time
	atRest bool
}

// midRunDrain is a drain between two rounds of a run that goes on: the top of
// every LLM turn. A run-end hold stays queued.
func midRunDrain(now time.Time) promoteCtx {
	return promoteCtx{now: now}
}

// restDrain is a drain where the thread's run ends or rests: the run would
// stop, the thread is idle, or it is being stopped. A run-end hold lifts.
func restDrain(now time.Time) promoteCtx {
	return promoteCtx{now: now, atRest: true}
}

// pendingHold is the hold enqueueHeldSend stamps on a send.
type pendingHold struct {
	// NotBefore keeps the send queued until this moment. Zero is no time gate.
	NotBefore time.Time
	// RunEnd keeps the send queued until the thread's run ends or rests.
	RunEnd bool
}

// stamp returns the keys the hold writes onto each entry of its send.
func (h pendingHold) stamp(sendID string) map[string]any {
	keys := map[string]any{keySendID: sendID}
	if !h.NotBefore.IsZero() {
		// An int, the one number kind a Y.Map takes from Go (convertToYcrdt).
		keys[keyNotBefore] = int(h.NotBefore.UnixMilli())
	}
	if h.RunEnd {
		keys[keyHold] = pendingHoldRunEnd
	}
	return keys
}

// generateSendID mints the id every entry of one send shares.
func generateSendID() string {
	id := idCounter.Add(1)
	return fmt.Sprintf("send_%d_%09d", time.Now().UnixMilli(), id)
}

// enqueueHeldSend appends one held send to the thread's pending queue, in one
// untracked transaction: a skill tool-action per name, then the user message,
// every entry stamped with the hold and a fresh send id — the same order an
// untimed busy send queues in (handleSendMessage). Reports the send id and the
// user message's item id, or ok=false (writing nothing) when the thread is gone
// or the send is empty.
func (w *ConversationWorker) enqueueHeldSend(threadItemID string, input UserMessageInput, skills []string, hold pendingHold) (sendID, userItemID string, ok bool) {
	if input.isEmpty() {
		return "", "", false
	}
	sendID = generateSendID()
	stamp := hold.stamp(sendID)
	entries := make([]ConversationItem, 0, len(skills)+1)
	for _, name := range dedupSkills(skills) {
		entries = append(entries, newSkillToolAction(name))
	}
	user := newUserItem(input)
	entries = append(entries, user)

	if !w.appendStampedPending(threadItemID, entries, stamp) {
		return "", "", false
	}
	w.markHeldStale()
	w.recordPendingEnqueue(threadItemID, user.ItemID)
	return sendID, user.ItemID, true
}

// heldSendHold reads the hold a send-message asks for at now. held is false
// when nothing it asks for still holds: no hold, or only a time already passed
// — and for a continuation or a send with no message, which have nothing to
// queue. Any non-empty Hold is a run-end hold (see entryHold.lifted).
func heldSendHold(msg SendMessageMessage, input UserMessageInput, now time.Time) (hold pendingHold, held bool) {
	if msg.IsContinuation || input.isEmpty() {
		return pendingHold{}, false
	}
	if msg.NotBefore > now.UnixMilli() {
		hold.NotBefore = time.UnixMilli(msg.NotBefore)
	}
	hold.RunEnd = msg.Hold != ""
	return hold, !hold.NotBefore.IsZero() || hold.RunEnd
}

// acceptHeldSend queues a held send that arrived over the wire. A send held
// only for the end of the run, sent to a thread with no run, has nothing left
// to wait for: it fires now (fireHeldSend). A send with a time waits for it,
// which the held-send timer brings (held_send_timer.go). Actor only.
func (r *run) acceptHeldSend(threadItemID string, input UserMessageInput, skills []string, hold pendingHold) {
	if _, _, ok := r.enqueueHeldSend(threadItemID, input, skills, hold); !ok {
		r.sendError(threadNotFoundError(threadItemID))
		return
	}
	if !hold.NotBefore.IsZero() || r.threadBusy(threadItemID) {
		return
	}
	r.fireHeldSend(threadItemID, restDrain(r.clock.Now()))
}

// appendStampedPending appends entries, in order and each with stamp's keys, to
// the thread's pending queue in one untracked transaction. Reports false (and
// writes nothing) when the thread is gone.
func (w *ConversationWorker) appendStampedPending(threadItemID string, entries []ConversationItem, stamp map[string]any) bool {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := w.doc.ensurePendingArrayLocked(threadItemID)
	if arr == nil {
		return false
	}
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		for _, item := range entries {
			arr.Insert(arr.GetLength(), ycrdt.ArrayAny{stampedItemYMap(item, stamp)})
		}
	}, w.doc.txOrigin())
	return true
}

// entryHold is the hold one queue entry, or one group, carries.
type entryHold struct {
	notBefore    int64 // epoch ms; meaningful when hasNotBefore
	hasNotBefore bool
	hold         string
}

func (h entryHold) stamped() bool { return h.hasNotBefore || h.hold != "" }

// lifted reports whether a drain under pc may promote what h holds. A time
// gate lifts once pc.now reaches it; a hold lifts only at a rest drain. A hold
// value this worker does not know is read as run-end: it was written to hold
// the send back, and the end of the run is the latest point every drain path
// still reaches. Both gates must lift when a send carries both.
func (h entryHold) lifted(pc promoteCtx) bool {
	if h.hasNotBefore && pc.now.UnixMilli() < h.notBefore {
		return false
	}
	return h.hold == "" || pc.atRest
}

// pendingEntry is one queue entry as grouping reads it.
type pendingEntry struct {
	isUser bool
	sendID string
	hold   entryHold
}

// readPendingEntry reads one queue element. Anything but a Y.Map is an
// unstamped non-user entry. Caller MUST hold ycrdtMu.
func readPendingEntry(v any) pendingEntry {
	m, ok := v.(*ycrdt.YMap)
	if !ok {
		return pendingEntry{}
	}
	e := pendingEntry{isUser: yMapString(m, keyType) == ItemTypeUser, sendID: yMapString(m, keySendID)}
	e.hold.notBefore, e.hold.hasNotBefore = yMapInt64(m, keyNotBefore)
	e.hold.hold = yMapString(m, keyHold)
	return e
}

// pendingGroups splits the queue into the sends it holds, each returned as
// [start, end) positions, in queue order. A send is promoted or held whole.
//
// A group ends at a user message and takes in the entries queued before it
// since the previous group: the context items the browser queues ahead of a
// message (an @-mention's read, a dropped file) and the skill loads the worker
// queues ahead of it. Those entries are tied to their message only by
// adjacency — the browser's carry no send id — so adjacency is the rule.
// Send ids refine it: two neighbours stamped with different send ids belong to
// different sends, so a send that queued no user message (a context item, a
// skills-only send) is not swept into the held send behind it. Entries after the
// last user message form a final group of their own.
func pendingGroups(entries []pendingEntry) [][2]int {
	var groups [][2]int
	start := 0
	for i, e := range entries {
		if i > start && e.sendID != "" && entries[i-1].sendID != "" && e.sendID != entries[i-1].sendID {
			groups = append(groups, [2]int{start, i})
			start = i
		}
		if e.isUser {
			groups = append(groups, [2]int{start, i + 1})
			start = i + 1
		}
	}
	if start < len(entries) {
		groups = append(groups, [2]int{start, len(entries)})
	}
	return groups
}

// groupHold is the hold a group carries: its user message's when that is
// stamped, otherwise the first stamped member's, otherwise none. The user
// message is the send; its members only ride with it.
func groupHold(members []pendingEntry) entryHold {
	for _, e := range members {
		if e.isUser && e.hold.stamped() {
			return e.hold
		}
	}
	for _, e := range members {
		if e.hold.stamped() {
			return e.hold
		}
	}
	return entryHold{}
}

// promotableIndicesLocked returns the queue positions a drain under pc
// promotes, ascending: every member of each group whose hold has lifted. A held
// group keeps its place and does not stop the groups behind it. Caller MUST
// hold ycrdtMu.
func promotableIndicesLocked(queue *ycrdt.YArray, pc promoteCtx) []int {
	raw := queue.ToArray()
	entries := make([]pendingEntry, len(raw))
	for i, v := range raw {
		entries[i] = readPendingEntry(v)
	}
	var out []int
	for _, g := range pendingGroups(entries) {
		if !groupHold(entries[g[0]:g[1]]).lifted(pc) {
			continue
		}
		for i := g[0]; i < g[1]; i++ {
			out = append(out, i)
		}
	}
	return out
}

// queuedGroupLocked finds the send a queued user message belongs to: the
// [start, end) positions of its group in queue (pendingGroups). ok is false
// when no user entry in queue has itemID. Caller MUST hold ycrdtMu.
func queuedGroupLocked(queue *ycrdt.YArray, itemID string) (start, end int, ok bool) {
	raw := queue.ToArray()
	entries := make([]pendingEntry, len(raw))
	at := -1
	for i, v := range raw {
		entries[i] = readPendingEntry(v)
		if m, isMap := v.(*ycrdt.YMap); isMap && entries[i].isUser && yMapString(m, keyItemID) == itemID {
			at = i
		}
	}
	if at < 0 || itemID == "" {
		return 0, 0, false
	}
	for _, g := range pendingGroups(entries) {
		if at >= g[0] && at < g[1] {
			return g[0], g[1], true
		}
	}
	return 0, 0, false
}

// releaseQueuedLocked drops the hold from every entry of the send itemID
// belongs to, in one untracked transaction. Reports whether it found the send.
// Caller MUST hold ycrdtMu.
func (w *ConversationWorker) releaseQueuedLocked(threadItemID, itemID string) bool {
	queue := w.doc.getPendingArrayLocked(threadItemID)
	if queue == nil {
		return false
	}
	start, end, ok := queuedGroupLocked(queue, itemID)
	if !ok {
		return false
	}
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		for i := start; i < end; i++ {
			if m, isMap := queue.Get(ycrdt.Number(i)).(*ycrdt.YMap); isMap {
				m.Delete(keyNotBefore)
				m.Delete(keyHold)
			}
		}
	}, w.doc.txOrigin())
	return true
}

// handleReleaseQueued is Send now on a queued message: its send loses its hold
// and is from then on an untimed queued message. On an idle thread it fires at
// once, as a held send whose time came would (fireHeldSend), with any other send
// already due there; on a busy thread the run's next drain takes it in.
//
// The release and the busy check are one hold, for queueIfBusy's reason: a run
// ending between them would take its last look before the hold dropped and
// leave the send queued under an idle thread. Actor only.
func (r *run) handleReleaseQueued(payload json.RawMessage) {
	var msg QueuedEntryMessage
	if !r.decodePayload(string(msgReleaseQueued), payload, &msg) {
		return
	}
	var found, busy bool
	withYDoc(func() {
		found = r.releaseQueuedLocked(msg.ThreadItemID, msg.ItemID)
		busy = found && r.threadBusyLocked(msg.ThreadItemID)
	})
	if !found {
		return
	}
	r.markHeldStale()
	r.batcher.Flush()
	if busy {
		r.offerDueSendToBusyThread(msg.ThreadItemID)
		return
	}
	r.fireHeldSend(msg.ThreadItemID, restDrain(r.clock.Now()))
}

// handleRemoveQueued is Remove on a queued message: its whole send leaves the
// queue in one untracked transaction, the context items and skill loads queued
// for it included, which would otherwise be promoted on their own at the next
// drain. Actor only.
func (r *run) handleRemoveQueued(payload json.RawMessage) {
	var msg QueuedEntryMessage
	if !r.decodePayload(string(msgRemoveQueued), payload, &msg) {
		return
	}
	found := false
	withYDoc(func() {
		queue := r.doc.getPendingArrayLocked(msg.ThreadItemID)
		if queue == nil {
			return
		}
		var start, end int
		if start, end, found = queuedGroupLocked(queue, msg.ItemID); found {
			r.doc.doc.Transact(func(_ *ycrdt.Transaction) {
				queue.Delete(ycrdt.Number(start), end-start)
			}, r.doc.txOrigin())
		}
	})
	if !found {
		return
	}
	r.markHeldStale()
	r.batcher.Flush()
}

// stampedItemYMap is conversationItemToYMap with extra keys written alongside
// the item's own.
func stampedItemYMap(item ConversationItem, extra map[string]any) *ycrdt.YMap {
	data, err := json.Marshal(item)
	if err != nil {
		return ycrdt.NewYMap(nil)
	}
	var m map[string]any
	if err := json.Unmarshal(data, &m); err != nil {
		return ycrdt.NewYMap(nil)
	}
	for k, v := range extra {
		m[k] = v
	}
	return itemMapToYMap(m)
}
