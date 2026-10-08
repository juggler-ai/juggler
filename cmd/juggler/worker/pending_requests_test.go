//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	ycrdt "github.com/skyterra/y-crdt"
)

// pushRequestedEntry writes a fresh 'requested' entry into the ROOT thread's
// pendingRequests Y.Array. Mirrors what JS strategies do via submitPendingRequest.
func pushRequestedEntry(t *testing.T, w *ConversationWorker, kind, id string, fillReq func(*ycrdt.YMap)) {
	pushRequestedEntryForThread(t, w, "", kind, id, fillReq)
}

// pushRequestedEntryForThread writes a fresh 'requested' entry into the given
// thread's own pendingRequests Y.Array ("" = root). Per-thread storage mirrors
// pending_items.go, hanging the array off the submitting thread's parent map.
func pushRequestedEntryForThread(t *testing.T, w *ConversationWorker, threadItemID, kind, id string, fillReq func(*ycrdt.YMap)) {
	t.Helper()
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := w.ensurePendingRequestsArrayLocked(threadItemID)
	if arr == nil {
		t.Fatalf("no parent map for thread %q", threadItemID)
	}
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		entry := ycrdt.NewYMap(nil)
		entry.Set("id", id)
		entry.Set("kind", kind)
		entry.Set("status", "requested")
		entry.Set("cancelRequested", false)
		entry.Set("createdAt", ycrdt.Number(time.Now().UnixMilli()))
		req := ycrdt.NewYMap(nil)
		if fillReq != nil {
			fillReq(req)
		}
		entry.Set("request", req)
		arr.Insert(ycrdt.Number(int(arr.GetLength())), ycrdt.ArrayAny{entry})
	}, w.doc.authorID)
}

// findEntryStatus looks up an entry by id across every thread's queue (root +
// sub-threads) and returns its status string. Returns "" if the entry is missing.
func findEntryStatus(w *ConversationWorker, id string) string {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	for _, threadID := range w.pendingRequestThreadIDsLocked() {
		if _, ymap, ok := w.pendingEntryByIDLocked(threadID, id); ok {
			s, _ := ymap.Get("status").(string)
			return s
		}
	}
	return ""
}

func pushCancelledClaimedCreateThread(t *testing.T, w *ConversationWorker, id, threadItemID string) {
	t.Helper()
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	arr := w.ensurePendingRequestsArrayLocked("")
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		entry := ycrdt.NewYMap(nil)
		entry.Set("id", id)
		entry.Set("kind", "createThread")
		entry.Set("status", "claimed")
		entry.Set("claimedBy", "worker")
		entry.Set("threadItemId", threadItemID)
		entry.Set("cancelRequested", true)
		entry.Set("createdAt", ycrdt.Number(time.Now().UnixMilli()))
		entry.Set("request", ycrdt.NewYMap(nil))
		arr.Push(ycrdt.ArrayAny{entry})
	}, w.doc.authorID)
}

// TestPendingRequests_SnapshotEmpty confirms an empty / missing
// pendingRequests array snapshots cleanly.
func TestPendingRequests_SnapshotEmpty(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	if snap := w.snapshotPendingEntries(); snap != nil {
		t.Errorf("expected nil snapshot for missing array, got %d entries", len(snap))
	}
}

// TestPendingRequests_SnapshotPopulated confirms the snapshot copies the
// request payload fields the orchestrator dispatches on.
func TestPendingRequests_SnapshotPopulated(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	pushRequestedEntry(t, w, "createThread", "r1", func(req *ycrdt.YMap) {
		req.Set("goal", "Plan step")
		req.Set("prompt", "Do the thing")
		req.Set("isContinuation", false)
	})
	snap := w.snapshotPendingEntries()
	if len(snap) != 1 {
		t.Fatalf("expected 1 entry, got %d", len(snap))
	}
	e := snap[0]
	if e.id != "r1" || e.kind != "createThread" || e.status != "requested" {
		t.Errorf("snapshot fields wrong: %+v", e)
	}
	if e.goal != "Plan step" || e.prompt != "Do the thing" {
		t.Errorf("request payload not copied: %+v", e)
	}
}

// TestPendingRequests_WriteError exercises the error-writer.
func TestPendingRequests_WriteError(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	pushRequestedEntry(t, w, "createThread", "r-err", nil)
	w.writePendingEntryError("", "r-err", "boom")
	if s := findEntryStatus(w, "r-err"); s != "error" {
		t.Errorf("status = %q, want 'error'", s)
	}
}

// TestPendingRequests_WriteCancelled exercises the cancel-writer.
func TestPendingRequests_WriteCancelled(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	pushRequestedEntry(t, w, "createThread", "r-cancel", nil)
	w.writePendingEntryCancelled("", "r-cancel", "Cancelled by user")
	if s := findEntryStatus(w, "r-cancel"); s != "cancelled" {
		t.Errorf("status = %q, want 'cancelled'", s)
	}
}

// TestPendingRequests_WriteCompletedThread exercises the success-writer
// for createThread, including the nested result Y.Map.
func TestPendingRequests_WriteCompletedThread(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	pushRequestedEntry(t, w, "createThread", "r-done", nil)
	w.writePendingEntryCompletedThread("", "r-done", "thread-abc", "the result")
	if s := findEntryStatus(w, "r-done"); s != "completed" {
		t.Fatalf("status = %q, want 'completed'", s)
	}
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	_, ymap, ok := w.pendingEntryByIDLocked("", "r-done")
	if !ok {
		t.Fatal("entry vanished")
	}
	r, ok := ymap.Get("result").(*ycrdt.YMap)
	if !ok {
		t.Fatal("result is not a Y.Map")
	}
	if v, _ := r.Get("threadItemId").(string); v != "thread-abc" {
		t.Errorf("result.threadItemId = %q, want 'thread-abc'", v)
	}
	if v, _ := r.Get("result").(string); v != "the result" {
		t.Errorf("result.result = %q, want 'the result'", v)
	}
}

// TestPendingRequests_GC confirms gcPendingEntry removes by id.
func TestPendingRequests_GC(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	pushRequestedEntry(t, w, "createThread", "r-gc", nil)
	w.gcPendingEntry("", "r-gc")
	if s := findEntryStatus(w, "r-gc"); s != "" {
		t.Errorf("entry should be deleted; status = %q", s)
	}
}

// TestPendingRequests_ScanClaimsWhenIdle drives a 'requested' entry through
// scanPendingRequests and asserts the worker claimed it. Use an unknown
// kind so dispatch returns quickly with an error status — exercises the
// claim path without spinning up the LLM machinery.
func TestPendingRequests_ScanClaimsWhenIdle(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	pushRequestedEntry(t, w, "bogus-kind", "r-claim", nil)

	// Worker starts in StateIdle (the default zero value), so the scan
	// must claim. Dispatch fails on unknown kind and writes status='error'.
	w.currentRun().scanPendingRequests()
	if s := findEntryStatus(w, "r-claim"); s != "error" {
		t.Errorf("status = %q, want 'error' (claim + dispatch reject)", s)
	}
}

// TestPendingRequests_ScanSkipsWhenBusy confirms that when the worker is
// not idle, the scan leaves 'requested' entries alone for a later retry.
// This is important to prevent claiming requests we can't service.
func TestPendingRequests_ScanSkipsWhenBusy(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	pushRequestedEntry(t, w, "createThread", "r-busy", nil)
	w.currentRun().scanPendingRequests()
	if s := findEntryStatus(w, "r-busy"); s != "requested" {
		t.Errorf("status = %q, want 'requested' (busy worker shouldn't claim)", s)
	}
}

// TestPendingRequests_CancelRequestedFlag verifies that flipping
// cancelRequested on a 'requested' (unclaimed) entry transitions it
// straight to 'cancelled' without dispatching.
func TestPendingRequests_CancelRequestedFlag(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	pushRequestedEntry(t, w, "createThread", "r-pre-cancel", nil)

	// Flip cancelRequested before scanning.
	ycrdtMu.Lock()
	_, ymap, _ := w.pendingEntryByIDLocked("", "r-pre-cancel")
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		ymap.Set("cancelRequested", true)
	}, w.doc.authorID)
	ycrdtMu.Unlock()

	w.currentRun().scanPendingRequests()
	if s := findEntryStatus(w, "r-pre-cancel"); s != "cancelled" {
		t.Errorf("status = %q, want 'cancelled'", s)
	}
}

// TestPendingRequests_AdvanceClaimedCreateThreadCompletes wires up a
// claimed createThread entry with a threadItemId, writes a result onto
// the thread Y.Map, and asserts the scan picks it up and transitions the
// entry to 'completed'.
func TestPendingRequests_AdvanceClaimedCreateThreadCompletes(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	// Create a real thread item so findThreadYMap can locate it.
	threadItemsArr := w.doc.InsertThread(0, "Goal X")
	_ = threadItemsArr
	items := w.doc.GetItems()
	if len(items) != 1 || items[0].Type != ItemTypeThread {
		t.Fatalf("expected one thread item, got %d items", len(items))
	}
	threadItemID := items[0].ItemID

	// Build a 'claimed' entry pointing at that thread.
	ycrdtMu.Lock()
	arr := w.ensurePendingRequestsArrayLocked("")
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		entry := ycrdt.NewYMap(nil)
		entry.Set("id", "r-adv")
		entry.Set("kind", "createThread")
		entry.Set("status", "claimed")
		entry.Set("claimedBy", "worker")
		entry.Set("threadItemId", threadItemID)
		entry.Set("cancelRequested", false)
		entry.Set("createdAt", ycrdt.Number(time.Now().UnixMilli()))
		entry.Set("request", ycrdt.NewYMap(nil))
		arr.Insert(ycrdt.Number(0), ycrdt.ArrayAny{entry})
	}, w.doc.authorID)
	// Write a result onto the thread Y.Map directly (simulating the LLM
	// finishing the sub-thread).
	threadYMap := findThreadYMap(w.doc.getItems(), threadItemID)
	if threadYMap == nil {
		ycrdtMu.Unlock()
		t.Fatal("could not find thread Y.Map")
	}
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		threadYMap.Set("result", "Did the thing")
	}, w.doc.authorID)
	ycrdtMu.Unlock()

	w.currentRun().scanPendingRequests()
	if s := findEntryStatus(w, "r-adv"); s != "completed" {
		t.Errorf("status = %q, want 'completed' after result was written to thread Y.Map", s)
	}
}

// TestPendingRequests_ContinueCompletesOnTheContinuedThread drives the SDK's
// continueConversation({threadItemId}) aimed at a sub-thread. The entry
// completes when the continued thread's response starts landing, which is in
// that thread's own items array, so that is the array whose growth is measured.
// Measuring the root instead leaves the request claimed for ever, and the
// strategy awaiting it with it.
func TestPendingRequests_ContinueCompletesOnTheContinuedThread(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	child := insertThreadReturningID(t, w, "phase one")
	pushRequestedEntry(t, w, "continue", "r-cont", func(req *ycrdt.YMap) {
		req.Set("threadItemId", child)
	})

	w.currentRun().scanPendingRequests()
	if s := findEntryStatus(w, "r-cont"); s != "claimed" {
		t.Fatalf("status = %q after dispatch, want 'claimed'", s)
	}

	// The continued thread's response starts streaming into it.
	appendToThread(w, child, ConversationItem{
		Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "Phase one summary.",
	})
	w.currentRun().scanPendingRequests()
	if s := findEntryStatus(w, "r-cont"); s != "completed" {
		t.Errorf("status = %q after the continued thread grew, want 'completed'", s)
	}
}

// TestPendingRequests_CancelClaimedAwaitingLLMCleansUpBeforeSettlement verifies
// cancellation of a claimed createThread whose active descendant is parked on a
// running tool. Full worker cleanup must finish before the run and request settle.
func TestPendingRequests_CancelClaimedAwaitingLLMCleansUpBeforeSettlement(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	threadItemID := insertThreadWithOpts(w, threadOpts{goal: "Goal Y", userMessage: "do the thing"})
	threadItems := w.doc.GetThreadItemsArray(threadItemID)
	descendantItems := w.doc.InsertThreadIntoArray(threadItems, w.doc.GetItemsLengthFromArray(threadItems), "Nested work")
	descendant := w.doc.GetItemsFromArray(threadItems)[1]
	w.doc.InsertMessageIntoArray(descendantItems, 0,
		ConversationItem{Type: ItemTypeUser, ItemID: "nested-user", Content: "run it"},
		ConversationItem{
			Type: ItemTypeToolAction, ItemID: "nested-tool", ToolUseID: "nested-tool-use",
			ToolName: "bash", State: StateRunning,
		},
	)
	pushCancelledClaimedCreateThread(t, w, "r-cancel-claimed", threadItemID)

	var released bool
	w.SetCancelLLMSession(func(_, _ string) { released = true })
	w.doc.SetMetadata("processingState", map[string]any{
		"activity":     ActivityAwaitingLLM,
		"threadItemId": descendant.ItemID,
		"status":       "processing_tools",
	})
	w.currentRun().storeState(StateIdle)

	w.currentRun().scanPendingRequests()

	if !released {
		t.Error("expected cancellation to release the provider session")
	}
	if got := w.getActivity(); got != ActivityNone {
		t.Errorf("activity = %q, want %q after cancellation cleanup", got, ActivityNone)
	}
	descendantAfter := w.doc.GetItemsFromArray(descendantItems)
	tool, ok := findToolItem(descendantAfter, "nested-tool-use")
	if !ok {
		t.Fatal("running descendant tool disappeared")
	}
	if tool.State != StateCancelled {
		t.Errorf("descendant tool state = %q, want %q", tool.State, StateCancelled)
	}
	if s := findEntryStatus(w, "r-cancel-claimed"); s != "cancelled" {
		t.Errorf("request status = %q, want cancelled", s)
	}
	ycrdtMu.Lock()
	threadYMap := findThreadYMap(w.doc.getItems(), threadItemID)
	status, _ := latestRunOutcomeLocked(threadYMap)
	settled := threadRunSettledLocked(threadYMap)
	result, _ := threadYMap.Get("result").(string)
	ycrdtMu.Unlock()
	if status != runStatusCancelled || !settled {
		t.Errorf("run = (%q, settled=%v), want (%q, true)", status, settled, runStatusCancelled)
	}
	if result != "" {
		t.Errorf("thread result = %q, want no summary for a cancelled run", result)
	}
}

// TestPendingRequests_CancelClaimedDoesNotCancelUnrelatedProcessing verifies a
// pending request can only cancel work in its own thread subtree.
func TestPendingRequests_CancelClaimedDoesNotCancelUnrelatedProcessing(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	cancelledThreadID := insertThreadWithOpts(w, threadOpts{goal: "Cancel me", userMessage: "first"})
	activeThreadID := insertThreadWithOpts(w, threadOpts{goal: "Keep working", userMessage: "second"})
	pushCancelledClaimedCreateThread(t, w, "r-unrelated", cancelledThreadID)

	llmCancelled := false
	var cancel context.CancelFunc = func() { llmCancelled = true }
	w.turn.cancelLLM.Store(&cancel)
	providerReleased := false
	w.SetCancelLLMSession(func(_, _ string) { providerReleased = true })
	w.doc.SetMetadata("processingState", map[string]any{
		"activity":     ActivityCallingLLM,
		"threadItemId": activeThreadID,
		"status":       "calling_llm",
	})
	w.currentRun().storeState(StateProcessing)

	w.currentRun().scanPendingRequests()

	if llmCancelled {
		t.Error("unrelated active LLM was cancelled")
	}
	if providerReleased {
		t.Error("unrelated provider session was released")
	}
	if got := w.currentRun().loadState(); got != StateProcessing {
		t.Errorf("worker state = %v, want StateProcessing", got)
	}
	if got := w.getProcessingThreadItemID(); got != activeThreadID {
		t.Errorf("processing thread = %q, want unrelated active thread %q", got, activeThreadID)
	}
	if s := findEntryStatus(w, "r-unrelated"); s != "cancelled" {
		t.Errorf("request status = %q, want cancelled", s)
	}
}

// TestPendingRequests_GCSweepsOldCompleted confirms that terminal entries
// older than pendingRequestsGCMs are removed by the scan, but recent ones
// are kept.
func TestPendingRequests_GCSweepsOldCompleted(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	now := time.Now().UnixMilli()
	ycrdtMu.Lock()
	arr := w.ensurePendingRequestsArrayLocked("")
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		// Old completed entry — should be swept.
		old := ycrdt.NewYMap(nil)
		old.Set("id", "old")
		old.Set("kind", "createThread")
		old.Set("status", "completed")
		old.Set("completedAt", ycrdt.Number(now-pendingRequestsGCMs-1000))
		old.Set("cancelRequested", false)
		arr.Insert(ycrdt.Number(0), ycrdt.ArrayAny{old})

		// Recent completed entry — should remain.
		fresh := ycrdt.NewYMap(nil)
		fresh.Set("id", "fresh")
		fresh.Set("kind", "createThread")
		fresh.Set("status", "completed")
		fresh.Set("completedAt", ycrdt.Number(now-100))
		fresh.Set("cancelRequested", false)
		arr.Insert(ycrdt.Number(int(arr.GetLength())), ycrdt.ArrayAny{fresh})
	}, w.doc.authorID)
	ycrdtMu.Unlock()

	w.currentRun().scanPendingRequests()

	if s := findEntryStatus(w, "old"); s != "" {
		t.Errorf("old entry should have been GC'd; status = %q", s)
	}
	if s := findEntryStatus(w, "fresh"); s != "completed" {
		t.Errorf("fresh entry should remain; status = %q", s)
	}
}

// TestPendingRequests_PerThreadIsolation is the Issue-3 proof: pendingRequests
// are stored PER-THREAD (each thread's own Y.Map), not in one shared
// conversation-metadata array. Two sub-threads' queues must be independent — an
// entry submitted from thread A lives in A's array, is driven from A's queue, and
// never leaks into thread B's queue (and vice-versa); the root keeps its own
// queue too. Before the fix every entry lived in a single metadata array, so the
// orchestrator could not scan a thread-scoped queue and entries from different
// threads shared one slot.
func TestPendingRequests_PerThreadIsolation(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	threadA := insertThreadReturningID(t, w, "Thread A")
	threadB := insertThreadReturningID(t, w, "Thread B")

	// Each thread (and root) gets its OWN requested entry. Use an unknown kind so
	// the claim+dispatch path resolves quickly to status='error' per queue.
	pushRequestedEntryForThread(t, w, threadA, "bogus-kind", "a1", nil)
	pushRequestedEntryForThread(t, w, threadB, "bogus-kind", "b1", nil)
	pushRequestedEntryForThread(t, w, "", "bogus-kind", "root1", nil)

	// Storage isolation: each entry lives in its own thread's array, nowhere else,
	// and NOT on conversation metadata.
	ycrdtMu.Lock()
	if _, _, ok := w.pendingEntryByIDLocked(threadA, "a1"); !ok {
		ycrdtMu.Unlock()
		t.Fatal("a1 must live in thread A's own pendingRequests array")
	}
	if _, _, ok := w.pendingEntryByIDLocked(threadA, "b1"); ok {
		ycrdtMu.Unlock()
		t.Fatal("b1 must NOT appear in thread A's array (cross-thread leak)")
	}
	if _, _, ok := w.pendingEntryByIDLocked(threadB, "b1"); !ok {
		ycrdtMu.Unlock()
		t.Fatal("b1 must live in thread B's own pendingRequests array")
	}
	if w.doc.metadata.Get(pendingRequestsKey) != nil {
		ycrdtMu.Unlock()
		t.Fatal("pendingRequests must NOT be stored on conversation metadata anymore")
	}
	ycrdtMu.Unlock()

	// Drive every thread's queue (worker idle by default).
	w.currentRun().scanPendingRequests()

	// Each entry was driven from its own queue → all reached 'error'.
	for _, id := range []string{"a1", "b1", "root1"} {
		if s := findEntryStatus(w, id); s != "error" {
			t.Errorf("entry %q status = %q, want 'error' (its own thread queue must be scanned/driven)", id, s)
		}
	}

	// Post-drive: entries are still scoped to their own thread, no cross-drive.
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	if _, _, ok := w.pendingEntryByIDLocked(threadB, "a1"); ok {
		t.Error("a1 leaked into thread B's array after driving")
	}
	if _, _, ok := w.pendingEntryByIDLocked(threadA, "a1"); !ok {
		t.Error("a1 must remain in thread A's array after driving")
	}
}

// TestPendingRequests_SubmitToTerminalRoundtrip simulates the full
// client-strategy flow: a JS-style submitter writes a request entry, the
// worker scan claims and dispatches it via the real worker code path, the
// thread completes, and the entry transitions to 'completed' with the
// thread's result. This is the highest-confidence regression test for the
// orchestrator end-to-end. Uses the same mock-LLM pattern as
// TestThreadUsesAssistantTextAsResult.
func TestPendingRequests_SubmitToTerminalRoundtrip(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	// Ensure the root items array exists. In production the first message
	// from the client triggers this; in unit tests we have to do it eagerly.
	ycrdtMu.Lock()
	w.doc.ensureItems()
	ycrdtMu.Unlock()
	// dispatchThread asserts the worker is StateIdle (the default
	// zero value of an atomic.Int32 is 0, which equals StateIdle). The
	// nested strategy loop transitions through StateProcessing during the
	// LLM call and back to StateIdle on completion.
	w.setMockResponses([]MockResponse{
		// Thread LLM: its trailing text is what the run returns, and so becomes
		// the thread/pending result.
		{
			Blocks: []LLMResponseBlock{
				{Type: "text", Content: "Sub-thread done."},
			},
			StopReason: "end_turn",
		},
	})

	go func() {
		ctxResponse, _ := json.Marshal(map[string]any{
			"type":         "render-context-items-result",
			"systemPrompt": "You are helpful.",
			"contexts":     []any{},
		})
		toolsResponse, _ := json.Marshal(map[string]any{
			"type":  "tools-result",
			"tools": []any{},
		})
		// One LLM iteration for the thread.
		w.engine.contextReply.inject(w.done, ctxResponse)
		w.engine.toolsReply.inject(w.done, toolsResponse)
	}()

	// Stage a 'requested' createThread entry — the same Y.Map shape that
	// submitPendingRequest writes from the JS side.
	pushRequestedEntry(t, w, "createThread", "rt-1", func(req *ycrdt.YMap) {
		req.Set("goal", "Test")
		req.Set("prompt", "Do something")
		req.Set("isContinuation", false)
	})

	// First scan: claim + dispatch. dispatchThread asks the reducer for
	// the pass that starts the thread; quiescing the actor runs it to completion.
	w.currentRun().scanPendingRequests()
	w.quiesce(t)
	// Second scan: advance the 'claimed' entry once the thread Y.Map's
	// result is populated.
	w.currentRun().scanPendingRequests()

	if s := findEntryStatus(w, "rt-1"); s != "completed" {
		t.Fatalf("status = %q, want 'completed'", s)
	}

	// Verify the entry's result Y.Map carries what the thread produced.
	ycrdtMu.Lock()
	_, ymap, _ := w.pendingEntryByIDLocked("", "rt-1")
	r, _ := ymap.Get("result").(*ycrdt.YMap)
	threadItemID, _ := r.Get("threadItemId").(string)
	result, _ := r.Get("result").(string)
	ycrdtMu.Unlock()
	if threadItemID == "" {
		t.Error("result.threadItemId is empty")
	}
	if result != "Sub-thread done." {
		t.Errorf("result.result = %q, want 'Sub-thread done.'", result)
	}
}

// TestPendingRequests_DeliveryBindingOwnership pins who may adopt a
// deliverTaskOutput binding. Background tasks live in a process-global registry
// keyed by task id, while the binding is doc state a clone (/duplicate,
// /handoff) inherits verbatim, so an inherited binding must be retired, not
// re-adopted, or two conversations would pump the same task (double delivery,
// backlog replay into a fork that should load resting, and a Stop in either
// killing it for both). A binding this conversation submitted, or one carrying
// no owner stamp, is still adopted so a worker restart recovers its own task.
//
// The adopting cases stop their pump before its first tick: this package runs no
// shell-registry goroutine, so any ops call would block. The refusing case
// returns before it reaches ops at all, which is precisely the property under
// test.
func TestPendingRequests_DeliveryBindingOwnership(t *testing.T) {
	cases := []struct {
		name     string
		convID   string // convId stamped on the request ("" = unstamped)
		adopted  bool
		wantStat string
	}{
		{"inherited from another conversation", "conv-source", false, "completed"},
		{"submitted by this conversation", "conv-own", true, "claimed"},
		{"unstamped binding", "", true, "claimed"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := NewConversationWorker("conv-own", "user:test")
			defer w.doc.Destroy()

			pushRequestedEntry(t, w, "deliverTaskOutput", "d-1", func(req *ycrdt.YMap) {
				req.Set("taskId", "bg-task-1")
				req.Set("label", "monitor: build")
				if tc.convID != "" {
					req.Set("convId", tc.convID)
				}
			})

			w.currentRun().scanPendingRequests()

			if s := findEntryStatus(w, "d-1"); s != tc.wantStat {
				t.Errorf("status = %q, want %q", s, tc.wantStat)
			}
			p, running := w.pumps.pumpsByEntry["d-1"]
			if running != tc.adopted {
				t.Fatalf("pump running = %v, want %v", running, tc.adopted)
			}
			if running {
				close(p.stop) // unwind without ops.KillTask (no registry here)
			}
		})
	}
}
