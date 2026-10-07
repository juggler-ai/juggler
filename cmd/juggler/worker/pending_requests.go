//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Worker-side orchestrator for the per-thread `pendingRequests` Y.Array.
// Strategies (running on any client) write request entries; the worker observes
// the array via the normal doc-update hook and drives each entry through
// requested → claimed → completed/error/cancelled.
//
// Storage is PER-THREAD, modelled on pending_items.go: the array hangs off the
// submitting thread's own parent Y.Map (the doc root for the root thread, the
// thread Y.Map for a sub-thread) via pendingParentMapLocked, keyed by
// threadItemID. So two threads' pending requests live in separate arrays and can
// never collide or cross-drive, and a deleted thread's queue is removed with it
// rather than lingering on conversation metadata. The JS submitter
// (thread-orchestrator.js) writes into the same per-thread container.
//
// The worker is the right orchestrator location because:
//   * It is single per-conversation, so claiming needs no CAS dance.
//   * It already holds the doc as the source of truth; clients observe the
//     same doc, so the round-trip latency that an engine-JS orchestrator
//     introduces (viewer cancel → engine writes the cancelled result → viewer
//     observes) collapses to zero hops.
//   * It already owns the create-thread / send-message dispatch paths
//     internally; the orchestrator reuses dispatchThread directly
//     instead of round-tripping through a WS message to itself.

package worker

import (
	"encoding/json"
	"fmt"
	"time"

	ycrdt "github.com/skyterra/y-crdt"

	"juggler/cmd/juggler/ops"
)

const (
	pendingRequestsKey  = "pendingRequests"
	pendingRequestsGCMs = 30000

	// cancelledThreadResult is the outcome text a pending request reports for a
	// sub-thread whose run was cancelled — what a plan driver reads as the
	// step's result.
	cancelledThreadResult = "Cancelled"
)

// pendingEntrySnapshot is a read-only copy of one Y.Map entry, taken under
// the y-crdt mutex so the scan loop can iterate without holding the lock.
type pendingEntrySnapshot struct {
	index            int
	ownerThreadID    string // thread whose own queue holds this entry ("" = root)
	id               string
	kind             string
	status           string
	cancelRequested  bool
	completedAt      float64
	threadItemID     string // set after createThread dispatch so we can find the thread Y.Map
	itemsBefore      int    // set after continue dispatch so we can detect items growth
	goal             string
	prompt           string
	parentThreadID   string
	isContinuation   bool
	continueThreadID string
	deliverTaskID    string // deliverTaskOutput: background task whose output to stream
	deliverLabel     string // deliverTaskOutput: display label shown with each batch
	deliverConvID    string // deliverTaskOutput: conversation that submitted the binding (see deliveryIsForeign)
	strategyID       string // createThread: optional strategy override for the new thread
	modelConfigJSON  string // createThread: optional model-config override (JSON), applied to the new thread
}

// scanPendingRequests is invoked from handleItemsChange. Walks the
// pendingRequests Y.Array and drives every entry one step forward. Runs on
// the worker's run() goroutine; Yjs reads/writes acquire ycrdtMu.
func (r *run) scanPendingRequests() {
	snapshot := r.snapshotPendingEntries()
	if len(snapshot) == 0 {
		return
	}
	nowMs := time.Now().UnixMilli()
	for _, e := range snapshot {
		if e.cancelRequested && (e.status == "requested" || e.status == "claimed") {
			r.cancelPendingEntry(e)
			continue
		}
		switch e.status {
		case "requested":
			r.claimAndDispatchPendingEntry(e)
		case "claimed":
			r.advanceClaimedPendingEntry(e)
		case "completed", "error", "cancelled":
			if e.completedAt > 0 && nowMs-int64(e.completedAt) > pendingRequestsGCMs {
				r.gcPendingEntry(e.ownerThreadID, e.id)
			}
		}
	}
}

// pendingRequestThreadIDsLocked returns the owner threads to scan: root ("")
// plus every sub-thread. MUST be called with ycrdtMu held.
func (w *ConversationWorker) pendingRequestThreadIDsLocked() []string {
	ids := []string{""}
	walkThreads(w.doc.getItems(), func(m *ycrdt.YMap, _ *ycrdt.YArray, _ string) bool {
		if id, _ := m.Get("itemId").(string); id != "" {
			ids = append(ids, id)
		}
		return false
	})
	return ids
}

// snapshotPendingEntries copies the current state of every thread's
// pendingRequests array under the y-crdt lock. The scan loop iterates this
// snapshot rather than the live Y.Arrays so it can re-enter Yjs without nested
// locking. Each entry is tagged with its owner thread so the per-entry writers
// re-resolve it in the correct thread's array.
func (w *ConversationWorker) snapshotPendingEntries() []pendingEntrySnapshot {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	var out []pendingEntrySnapshot
	for _, threadID := range w.pendingRequestThreadIDsLocked() {
		arr := w.pendingRequestsArrayLocked(threadID)
		if arr == nil {
			continue
		}
		n := int(arr.GetLength())
		for i := 0; i < n; i++ {
			ymap, ok := arr.Get(ycrdt.Number(i)).(*ycrdt.YMap)
			if !ok || ymap == nil {
				continue
			}
			snap := pendingEntrySnapshot{index: i, ownerThreadID: threadID}
			snap.id, _ = ymap.Get("id").(string)
			snap.kind, _ = ymap.Get("kind").(string)
			snap.status, _ = ymap.Get("status").(string)
			snap.cancelRequested, _ = ymap.Get("cancelRequested").(bool)
			if v, ok := ymap.Get("completedAt").(ycrdt.Number); ok {
				snap.completedAt = float64(v)
			}
			snap.threadItemID, _ = ymap.Get("threadItemId").(string)
			if v, ok := ymap.Get("itemsBefore").(ycrdt.Number); ok {
				snap.itemsBefore = int(v)
			}
			if req, ok := ymap.Get("request").(*ycrdt.YMap); ok {
				snap.goal, _ = req.Get("goal").(string)
				snap.prompt, _ = req.Get("prompt").(string)
				snap.parentThreadID, _ = req.Get("parentThreadItemId").(string)
				snap.strategyID, _ = req.Get("strategyId").(string)
				snap.modelConfigJSON, _ = req.Get("modelConfig").(string)
				snap.isContinuation, _ = req.Get("isContinuation").(bool)
				snap.continueThreadID, _ = req.Get("threadItemId").(string)
				snap.deliverTaskID, _ = req.Get("taskId").(string)
				snap.deliverLabel, _ = req.Get("label").(string)
				snap.deliverConvID, _ = req.Get("convId").(string)
			}
			out = append(out, snap)
		}
	}
	return out
}

// pendingRequestsArrayLocked returns the pendingRequests Y.Array hanging off the
// given thread's own parent map ("" = root → doc root). MUST be called with
// ycrdtMu held. Returns nil if the array has not been lazily-created by any
// client yet — strategies create it on first write (mirrors pending_items.go).
func (w *ConversationWorker) pendingRequestsArrayLocked(threadItemID string) *ycrdt.YArray {
	parent := w.doc.pendingParentMapLocked(threadItemID)
	if parent == nil {
		return nil
	}
	arr, _ := parent.Get(pendingRequestsKey).(*ycrdt.YArray)
	return arr
}

// ensurePendingRequestsArrayLocked get-or-creates the pendingRequests array on
// the thread's own parent map. MUST be called with ycrdtMu held. Returns nil if
// the thread is gone.
func (w *ConversationWorker) ensurePendingRequestsArrayLocked(threadItemID string) *ycrdt.YArray {
	parent := w.doc.pendingParentMapLocked(threadItemID)
	if parent == nil {
		return nil
	}
	if arr, ok := parent.Get(pendingRequestsKey).(*ycrdt.YArray); ok {
		return arr
	}
	arr := ycrdt.NewYArray()
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		parent.Set(pendingRequestsKey, arr)
	}, w.doc.txOrigin())
	return arr
}

// pendingEntryByIDLocked finds an entry by its stable id field within the owner
// thread's array, returning (index, ymap, true) or (0, nil, false). MUST be
// called with ycrdtMu held. Used to re-resolve entries from the snapshot since
// the index may have shifted between snapshot and write (GC, peer inserts).
func (w *ConversationWorker) pendingEntryByIDLocked(ownerThreadID, id string) (int, *ycrdt.YMap, bool) {
	arr := w.pendingRequestsArrayLocked(ownerThreadID)
	if arr == nil {
		return 0, nil, false
	}
	n := int(arr.GetLength())
	for i := 0; i < n; i++ {
		ymap, ok := arr.Get(ycrdt.Number(i)).(*ycrdt.YMap)
		if !ok || ymap == nil {
			continue
		}
		if v, _ := ymap.Get("id").(string); v == id {
			return i, ymap, true
		}
	}
	return 0, nil, false
}

// claimAndDispatchPendingEntry marks the entry as claimed and triggers
// the kind-specific dispatch. The dispatch may complete synchronously
// (createThread returns a threadItemId immediately; the actual thread runs
// async on the worker and is detected by advanceClaimedPendingEntry on
// subsequent scans).
func (r *run) claimAndDispatchPendingEntry(e pendingEntrySnapshot) {
	if e.kind == "createThread" || e.kind == "continue" {
		if r.anyRunState() != StateIdle {
			// Worker is busy with something else; leave entry in 'requested'
			// for a later scan to re-attempt. Don't claim — claiming locks
			// the entry to this worker boot, and we don't yet know we can
			// service it.
			return
		}
	}

	ycrdtMu.Lock()
	_, ymap, ok := r.pendingEntryByIDLocked(e.ownerThreadID, e.id)
	if !ok {
		ycrdtMu.Unlock()
		return
	}
	if v, _ := ymap.Get("status").(string); v != "requested" {
		ycrdtMu.Unlock()
		return
	}
	r.doc.transactTracked(func(t *ycrdt.Transaction) {
		ymap.Set("status", "claimed")
		ymap.Set("claimedBy", "worker")
	})
	ycrdtMu.Unlock()

	switch e.kind {
	case "createThread":
		threadItemID, err := r.dispatchThread(threadSpec{
			Goal:               e.goal,
			Prompt:             e.prompt,
			IsContinuation:     e.isContinuation,
			ParentThreadItemID: e.parentThreadID,
			StrategyID:         e.strategyID,
			ModelConfigJSON:    e.modelConfigJSON,
		})
		if err != nil {
			r.writePendingEntryError(e.ownerThreadID, e.id, err.Error())
			return
		}
		r.setPendingEntryThreadID(e.ownerThreadID, e.id, threadItemID)
	case "continue":
		r.dispatchPendingContinue(e)
	case "deliverTaskOutput":
		if r.deliveryIsForeign(e) {
			r.writePendingEntryCompletedThread(e.ownerThreadID, e.id, "", "")
			return
		}
		// Long-lived: the entry stays "claimed" while the pump streams the
		// task's output; the pump completes the entry when the task exits.
		r.startTaskDeliveryPump(e.id, e.ownerThreadID, e.deliverTaskID, e.deliverLabel)
	default:
		r.writePendingEntryError(e.ownerThreadID, e.id, fmt.Sprintf("unknown kind: %s", e.kind))
	}
}

// dispatchPendingContinue triggers a continuation turn. Captures the continued
// thread's items length before so advanceClaimedPendingEntry can detect when the
// response starts streaming into it.
func (r *run) dispatchPendingContinue(e pendingEntrySnapshot) {
	r.setPendingEntryItemsBefore(e.ownerThreadID, e.id, r.continuedItemsLength(e))

	// Build a synthetic send-message payload and enqueue it on the worker's
	// own inbound channel. Going through the normal message path keeps the
	// state machine consistent.
	sm := SendMessageMessage{
		Type:           "send-message",
		Text:           "",
		IsContinuation: true,
		ThreadItemID:   e.continueThreadID,
	}
	payload, err := json.Marshal(sm)
	if err != nil {
		r.writePendingEntryError(e.ownerThreadID, e.id, err.Error())
		return
	}
	r.Send("send-message", payload)
}

// continuedItemsLength is the length of the items array a continue entry's
// response lands in: the continued thread's, or the root's when the entry names
// none. A thread that has gone reads as empty, so its entry never completes on
// growth that is not its own.
func (w *ConversationWorker) continuedItemsLength(e pendingEntrySnapshot) int {
	dest, ok := w.resolveThread(e.continueThreadID)
	if !ok {
		return 0
	}
	return w.itemsLengthIn(dest)
}

// advanceClaimedPendingEntry drives a claimed entry toward completion by
// inspecting its underlying side effect: for createThread, look at how the
// thread's run settled; for continue, watch the items length.
func (r *run) advanceClaimedPendingEntry(e pendingEntrySnapshot) {
	switch e.kind {
	case "createThread":
		if e.threadItemID == "" {
			return // dispatch hasn't recorded the threadItemId yet
		}
		ycrdtMu.Lock()
		threadYMap := findThreadYMap(r.doc.getItems(), e.threadItemID)
		if threadYMap == nil {
			ycrdtMu.Unlock()
			return
		}
		settled := threadRunSettledLocked(threadYMap)
		status, runResult := latestRunOutcomeLocked(threadYMap)
		summary, _ := threadYMap.Get("result").(string)
		ycrdtMu.Unlock()
		if !settled {
			return
		}
		if status == runStatusCancelled {
			r.writePendingEntryCancelled(e.ownerThreadID, e.id, cancelledThreadResult)
			return
		}
		// The run's own result is what this request asked for; a thread with no
		// run record at all (nothing stamped it) reports its summary instead.
		result := runResult
		if result == "" {
			result = summary
		}
		r.writePendingEntryCompletedThread(e.ownerThreadID, e.id, e.threadItemID, result)
	case "continue":
		if r.continuedItemsLength(e) > e.itemsBefore {
			r.writePendingEntryCompletedThread(e.ownerThreadID, e.id, "", "")
		}
	case "deliverTaskOutput":
		if _, running := r.deliveryPumps[e.id]; running {
			return // the pump owns this entry's lifecycle
		}
		if r.deliveryIsForeign(e) {
			// A binding copied in from another conversation: the task belongs to
			// the submitter, so retire the inherited entry instead of adopting it.
			r.writePendingEntryCompletedThread(e.ownerThreadID, e.id, "", "")
			return
		}
		// Claimed but no pump — e.g. the worker was recreated mid-delivery.
		// Restart the pump if the task is still alive; otherwise the task is
		// gone (a server restart drops in-process tasks), so complete the entry.
		if snap := ops.TaskState(e.deliverTaskID); snap.Found && snap.Status == "running" {
			r.startTaskDeliveryPump(e.id, e.ownerThreadID, e.deliverTaskID, e.deliverLabel)
		} else {
			r.writePendingEntryCompletedThread(e.ownerThreadID, e.id, "", "")
		}
	}
}

// deliveryIsForeign reports whether a deliverTaskOutput entry was submitted by a
// conversation other than this worker's, meaning it reached this doc as state
// copied by a clone (/duplicate, /handoff) rather than being requested here.
//
// The distinction matters because background tasks live in a process-global
// registry keyed by task id alone, while the binding is doc state that a clone
// inherits verbatim. Re-adopting an inherited binding would attach a SECOND pump
// to the source's still-running task: both conversations would receive every
// line, the clone would replay the whole accumulated backlog as one injected
// batch (waking a fork that is meant to load resting), and a Stop in either
// would kill the task for both. Only the submitting conversation re-adopts, so
// a worker restart still recovers its own live task.
//
// An unstamped entry (no convId) is treated as native, since a producer is free
// to omit the field; refusing those would strand a genuine restart's binding.
func (w *ConversationWorker) deliveryIsForeign(e pendingEntrySnapshot) bool {
	return e.deliverConvID != "" && e.deliverConvID != w.conversationID
}

// cancelPendingEntry transitions a requested/claimed entry to cancelled when its
// cancelRequested flag flips. An active createThread is cancelled through the
// worker's normal cancellation path; its pending result remains claimed until
// that path has made the thread quiescent and settled its run.
func (r *run) cancelPendingEntry(e pendingEntrySnapshot) {
	if e.kind == "deliverTaskOutput" {
		// Stop the pump and kill the task; do NOT forward to handleCancel (a
		// delivery cancel must not abort an unrelated in-flight turn).
		r.stopDeliveryPump(e.id)
		r.writePendingEntryCancelled(e.ownerThreadID, e.id, "")
		return
	}
	if e.kind != "createThread" || e.threadItemID == "" {
		r.writePendingEntryCancelled(e.ownerThreadID, e.id, "")
		return
	}

	if r.pendingThreadOwnsActiveWork(e.threadItemID) {
		switch r.loadState() {
		case StateProcessing:
			// finishStrategyRun settles the active run and finalizeCancellation
			// completes cleanup. A later scan publishes the pending result.
			r.handleCancel(cancelReasonPendingRequest)
			return
		case StateCancelling:
			return
		}
		if r.getActivity() == ActivityAwaitingLLM {
			// The parked-tool branch completes synchronously: tools are cancelled,
			// the provider session is released, and activity is cleared first.
			r.handleCancel(cancelReasonPendingRequest)
		}
	}

	r.settleThreadRun(e.threadItemID, true)
	r.writePendingEntryCancelled(e.ownerThreadID, e.id, cancelledThreadResult)
}

// pendingThreadOwnsActiveWork reports whether the worker's active thread is the
// pending request's thread or one of its descendants. The ownership check gates
// conversation-wide cancellation, so one request cannot stop an unrelated turn.
func (w *ConversationWorker) pendingThreadOwnsActiveWork(pendingThreadID string) bool {
	activeThreadID := w.getProcessingThreadItemID()
	if pendingThreadID == "" || activeThreadID == "" {
		return false
	}
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	for threadID := activeThreadID; threadID != ""; threadID = w.doc.findParentThreadID(threadID) {
		if threadID == pendingThreadID {
			return true
		}
	}
	return false
}

// updatePendingEntry locks the CRDT, resolves the pending entry by id, and runs
// mutate inside a single transaction. It is a no-op if the entry no longer
// exists (already GC'd).
func (w *ConversationWorker) updatePendingEntry(ownerThreadID, id string, mutate func(ymap *ycrdt.YMap)) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	_, ymap, ok := w.pendingEntryByIDLocked(ownerThreadID, id)
	if !ok {
		return
	}
	w.doc.transactTracked(func(t *ycrdt.Transaction) {
		mutate(ymap)
	})
}

// setPendingEntryThreadID records the threadItemId on a claimed entry so
// advanceClaimedPendingEntry can find the thread Y.Map on the next scan.
func (w *ConversationWorker) setPendingEntryThreadID(ownerThreadID, id, threadItemID string) {
	w.updatePendingEntry(ownerThreadID, id, func(ymap *ycrdt.YMap) {
		ymap.Set("threadItemId", threadItemID)
	})
}

// setPendingEntryItemsBefore records the items length at dispatch time
// for continue requests.
func (w *ConversationWorker) setPendingEntryItemsBefore(ownerThreadID, id string, itemsBefore int) {
	w.updatePendingEntry(ownerThreadID, id, func(ymap *ycrdt.YMap) {
		ymap.Set("itemsBefore", ycrdt.Number(itemsBefore))
	})
}

func (w *ConversationWorker) writePendingEntryError(ownerThreadID, id, errMsg string) {
	w.updatePendingEntry(ownerThreadID, id, func(ymap *ycrdt.YMap) {
		ymap.Set("error", errMsg)
		ymap.Set("status", "error")
		ymap.Set("completedAt", ycrdt.Number(time.Now().UnixMilli()))
	})
}

func (w *ConversationWorker) writePendingEntryCancelled(ownerThreadID, id, errMsg string) {
	w.updatePendingEntry(ownerThreadID, id, func(ymap *ycrdt.YMap) {
		if errMsg != "" {
			ymap.Set("error", errMsg)
		}
		ymap.Set("status", "cancelled")
		ymap.Set("completedAt", ycrdt.Number(time.Now().UnixMilli()))
	})
}

func (w *ConversationWorker) writePendingEntryCompletedThread(ownerThreadID, id, threadItemID, result string) {
	w.updatePendingEntry(ownerThreadID, id, func(ymap *ycrdt.YMap) {
		resultMap := ycrdt.NewYMap(nil)
		if threadItemID != "" {
			resultMap.Set("threadItemId", threadItemID)
		}
		if result != "" {
			resultMap.Set("result", result)
		}
		ymap.Set("result", resultMap)
		ymap.Set("status", "completed")
		ymap.Set("completedAt", ycrdt.Number(time.Now().UnixMilli()))
	})
}

// gcPendingEntry removes a terminal entry from the Y.Array. The index is
// re-resolved by id since GC of an earlier entry may have shifted it.
func (w *ConversationWorker) gcPendingEntry(ownerThreadID, id string) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	idx, _, ok := w.pendingEntryByIDLocked(ownerThreadID, id)
	if !ok {
		return
	}
	arr := w.pendingRequestsArrayLocked(ownerThreadID)
	if arr == nil {
		return
	}
	w.doc.transactTracked(func(t *ycrdt.Transaction) {
		arr.Delete(ycrdt.Number(idx), ycrdt.Number(1))
	})
	w.log.Debug("[orchestrator] GC'd entry %s", id)
}
