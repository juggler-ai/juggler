//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"

	ycrdt "github.com/skyterra/y-crdt"
)

// Polite stop (Pause) in a conversation holding more than one thread.
//
// Every case in polite_stop_test.go drives a single thread, so nothing pins what
// the latch means when several runs are live — which is the ordinary shape of any
// turn that spawned sub-agents.

// appendToThread pushes items onto a thread's nested items array in one
// transaction, the way a run appends to the thread it is working in.
func appendToThread(w *ConversationWorker, threadItemID string, items ...ConversationItem) {
	arr := w.doc.GetThreadItemsArray(threadItemID)
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		for _, it := range items {
			arr.Push(ycrdt.ArrayAny{conversationItemToYMap(it)})
		}
	}, w.doc.authorID)
}

// feedContextAndTools answers the context/tools round-trips a dispatched turn
// makes, so a turn that wrongly dispatches COMPLETES — leaving evidence in the
// mock queue — instead of hanging the test on a reply channel.
func feedContextAndTools(t *testing.T, w *ConversationWorker) {
	t.Helper()
	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	ctxResp, _ := json.Marshal(map[string]any{
		"type": "render-context-items-result", "systemPrompt": "sys", "contexts": []any{},
	})
	toolsResp, _ := json.Marshal(map[string]any{"type": "tools-result", "tools": []any{}})
	go func() {
		for {
			if !w.engine.contextReply.inject(stop, ctxResp) {
				return
			}
		}
	}()
	go func() {
		for {
			if !w.engine.toolsReply.inject(stop, toolsResp) {
				return
			}
		}
	}()
}

// TestPoliteStop_RestsOneThreadAndLetsItsSiblingCallTheModel is the multi-thread
// version of TestPoliteStop_ReducerRestsBeforeNextTurn, and the reported problem
// inside one pass of the reducer.
//
// Two sub-threads are parked on completed tool batches — two sub-agents that have
// each just finished a tool call and are about to ask the model what to do with
// it. One reconcile pass therefore holds two ActionCallLLM targets, and
// dispatchCallLLMOnThread consumes the latch with Swap(false) as its first
// statement. The first thread the walk reaches spends the latch and rests; every
// thread behind it finds the latch already unset and calls the provider.
//
// A pause is a statement about the CONVERSATION — nothing goes to the model until
// the user says so — so both scripted turns must be left unspent.
func TestPoliteStop_RestsOneThreadAndLetsItsSiblingCallTheModel(t *testing.T) {
	w := NewConversationWorker("test-polite-siblings", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// The root turn that spawned them, parked on both children.
	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "look at a and b",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "I'll send two agents.",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})

	// Two children, each mid-run with a completed tool batch awaiting the model.
	children := []string{
		insertThreadWithOpts(w, threadOpts{goal: "read a", userMessage: "look at a", llmCreated: true, delegated: true}),
		insertThreadWithOpts(w, threadOpts{goal: "read b", userMessage: "look at b", llmCreated: true, delegated: true}),
	}
	for i, id := range children {
		appendToThread(w, id,
			ConversationItem{Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "I'll grep for it."},
			ConversationItem{
				Type: ItemTypeToolAction, ItemID: generateItemID(),
				ToolUseID: "tu-" + string(rune('a'+i)), ToolName: "grep",
				State: StateCompleted, Result: resultJSON("ok"),
			},
		)
	}

	w.doc.SetMetadata("processingState", map[string]any{
		"activity": ActivityAwaitingLLM, "threadItemId": "", "status": "processing_tools",
	})

	// The user pressed Pause on the root column while both children were in flight.
	w.markPoliteStop("")

	// One scripted turn per child. Every one consumed is a provider request the
	// pause was supposed to prevent.
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "SHOULD NOT RUN (a)"}}, StopReason: "end_turn"},
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "SHOULD NOT RUN (b)"}}, StopReason: "end_turn"},
	})
	feedContextAndTools(t, w)

	// Drive the reducer exactly as the event loop would once the tools complete.
	w.sched.markReconcile()
	w.quiesce(t)

	if left := w.mock.remaining(); left != 2 {
		t.Fatalf("Pause let %d of 2 sub-threads call the provider anyway (%d scripted turns left, want 2): "+
			"the latch is conversation-wide but Swap(false) hands it to whichever run reaches a boundary "+
			"first, so one thread rests and every other live thread carries on", 2-left, left)
	}
}

// TestPoliteStop_PausedChildNeitherSettlesNorReDrivesItsParent pins the second
// half of the problem: a pause must not merely fail to stop the conversation, it
// must not START a provider request.
//
// A sub-agent is mid-run when the pause arrives, so the mark is read at
// runOneTurn's top rather than in the reducer. That is a clean ending, not a
// cancellation — so a run that settled here would reach signalParentThread and
// queue the parent for a turn, which is a fresh provider request caused by
// pressing Pause. A paused run is not a finished one: it keeps its open run
// record, the parent stays parked on it, and the thread carries on from exactly
// there when the pause is lifted.
func TestPoliteStop_PausedChildNeitherSettlesNorReDrivesItsParent(t *testing.T) {
	w := NewConversationWorker("test-polite-redrive", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "look at a",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "I'll send an agent.",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})
	child := insertThreadWithOpts(w, threadOpts{
		goal: "read a", userMessage: "look at a", llmCreated: true, delegated: true,
	})
	appendToThread(w, child, ConversationItem{
		Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "Found it in main.go.",
	})

	// The parent is parked on the child, and the child holds a live claim: the
	// state a conversation is in while a sub-agent works.
	w.doc.SetMetadata("processingState", map[string]any{
		"activity": ActivityAwaitingLLM, "threadItemId": "", "status": "processing_tools",
	})
	w.currentRun().claimLLM(child)
	w.turn.thread.itemID = child
	w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(child)

	// One scripted turn, for the parent. Consuming it is the regression: the user
	// asked the conversation to stop, and it issued a request instead.
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "SHOULD NOT RUN (parent)"}}, StopReason: "end_turn"},
	})
	feedContextAndTools(t, w)

	// The user pressed Pause on the child's own column while it was mid-run.
	w.markPoliteStop(child)

	// The child's next turn begins: the top-of-turn boundary consumes the latch
	// and ends the run.
	w.driveStrategyLoop(t, "", true)

	w.quiesce(t)

	if left := w.mock.remaining(); left != 1 {
		t.Fatalf("a Pause caused a fresh provider request on the parent (%d scripted turns left, want 1): "+
			"the child rested cleanly on the pause, so its run settled and signalParentThread "+
			"queued the parent for a turn the pause exists to prevent", left)
	}

	// The child's run is still open — that is what keeps the parent parked.
	ycrdtMu.Lock()
	status, _ := latestRunOutcomeLocked(findThreadYMap(w.doc.getItems(), child))
	ycrdtMu.Unlock()
	if status != "" {
		t.Errorf("the paused child's run settled as %q; a paused run is not a finished one, "+
			"and settling it answers a caller the thread was stopped before answering", status)
	}
}

// TestPoliteStop_HumanIntentEntryPointsLiftTheMark pins the classification every
// work-starter has to answer to. A send lifts the marks standing over its thread
// because a mark outlives the rest it caused and would otherwise suppress the
// very turn the user just asked for (D6, §10.5) — and every other button that
// starts work is the same act by a different name. The failure is worse than a
// suppressed turn: each of these commits something to the document first (a fold,
// a cleared summary, a reset tool, a new thread) and then rests, leaving work
// nothing will ever drive.
func TestPoliteStop_HumanIntentEntryPointsLiftTheMark(t *testing.T) {
	cases := []struct {
		name  string
		drive func(t *testing.T, w *ConversationWorker)
	}{{
		name: "re-summarise a fold",
		drive: func(t *testing.T, w *ConversationWorker) {
			t.Helper()
			id := insertThreadWithOpts(w, threadOpts{
				goal: "compacted", boundedCompaction: true, userMessage: "the folded history", result: `"stale"`,
			})
			w.markPoliteStop("")
			payload, _ := json.Marshal(map[string]any{"threadItemId": id, "ackId": "r1"})
			w.currentRun().handleResummarizeCompactionThread(payload)
		},
	}, {
		name: "retry a tool",
		drive: func(t *testing.T, w *ConversationWorker) {
			t.Helper()
			w.doc.InsertMessage(0, ConversationItem{
				Type: ItemTypeToolAction, ItemID: generateItemID(),
				ToolUseID: "tu-retry", ToolName: "bash",
				State: StateCompleted, Result: resultJSON("boom"),
			})
			w.markPoliteStop("")
			payload, _ := json.Marshal(map[string]any{"toolUseId": "tu-retry"})
			w.handleRetryToolAction(payload)
		},
	}, {
		name: "create a thread from the browser",
		drive: func(t *testing.T, w *ConversationWorker) {
			t.Helper()
			w.doc.InsertMessage(0, ConversationItem{
				Type: ItemTypeUser, ItemID: "u-1", Content: "look at a",
				TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
			})
			w.markPoliteStop("")
			payload, _ := json.Marshal(map[string]any{
				"goal": "look at a", "prompt": "look at a", "threadItemId": "", "requestId": "q1",
			})
			w.currentRun().handleCreateThread(payload)
		},
	}}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := NewConversationWorker("test-polite-intent", "user:test")
			defer w.doc.Destroy()
			w.currentRun().storeState(StateIdle)
			w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
			// Whatever each entry point starts is allowed to run to completion here:
			// the question is whether the mark is still standing, and a starved turn
			// would hang the test rather than answer it.
			feedCompactionContextAndTools(w)
			w.setMockResponses([]MockResponse{
				{Blocks: []LLMResponseBlock{{Type: "text", Content: "ok"}}, StopReason: "end_turn"},
				{Blocks: []LLMResponseBlock{{Type: "text", Content: "ok"}}, StopReason: "end_turn"},
			})

			tc.drive(t, w)
			w.quiesce(t)

			if w.hasPoliteStops() {
				t.Errorf("%s left the pause standing (marks = %v): the work it committed to the "+
					"document rests at its first boundary and nothing re-drives it", tc.name, w.politeStopMarks())
			}
		})
	}
}

// TestPoliteStop_PickupLeavesCoveredThreadsArmed pins the gate the pickup has to
// read before it claims, and the resume that pairs with it.
//
// needsStrategyRun is a ONE-SHOT trigger, consumed at pickup and never re-armed.
// A pickup that claims a covered thread therefore spends the only thing that
// would ever start it, publishes a busy frame naming a paused thread (which is
// the "Pausing…" the user sees come back), and hands the run to a boundary that
// rests immediately — leaving a thread nothing can drive again. Resting at the
// pickup instead leaves the thread exactly as it was found, and unpausing offers
// it once more.
func TestPoliteStop_PickupLeavesCoveredThreadsArmed(t *testing.T) {
	w := NewConversationWorker("test-polite-pickup", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	feedContextAndTools(t, w)
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "the summary"}}, StopReason: "end_turn"},
	})

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "do the thing",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})
	// The pause has already landed when the thread appears — the /compact
	// sequence exactly: press Pause, wait, then ask for the fold.
	w.markPoliteStop("")

	// A thread the document says still owes a run — the shape /compact's fold and
	// a re-summarise both leave behind.
	id := insertThreadWithOpts(w, threadOpts{
		goal: "owed a run", needsStrategyRun: true, noAutoSelect: true, userMessage: "summarize this",
	})
	w.currentRun().checkForNewThreads()

	if left := w.mock.remaining(); left != 1 {
		t.Fatalf("the pickup started a covered thread anyway (%d scripted turns left, want 1)", left)
	}
	ymap := w.doc.GetThreadYMap(id)
	ycrdtMu.Lock()
	armed, _ := ymap.Get("needsStrategyRun").(bool)
	ycrdtMu.Unlock()
	if !armed {
		t.Fatal("the pickup consumed needsStrategyRun on a covered thread: the trigger is one-shot, " +
			"so the thread can now never be started, by an unpause or by anything else")
	}
	if w.isLLMClaimed() {
		t.Error("the pickup claimed a covered thread; that claim is the busy frame that puts every " +
			"column back into Pausing… with a spinner on a thread that is going to rest")
	}

	// Lifting the pause is what offers it again.
	w.handleUnpause("")
	w.quiesce(t)

	if left := w.mock.remaining(); left != 0 {
		t.Errorf("unpausing did not resume the thread the pause parked (%d scripted turns left, want 0)", left)
	}
}

// TestPoliteStop_PausedFoldKeepsItsRightToASummary covers the window the pickup
// gate cannot: a pause that arrives while the fold is ALREADY being summarized.
// The trigger was legitimately consumed at pickup, and the reducer's walk offers
// nothing to a thread whose last item is the summarization prompt — so a run that
// simply rested here would leave the folded history behind a tile with no summary
// and nothing left to ask for one. The paused settle re-arms what the pickup
// spent, and lifting the pause summarizes it.
func TestPoliteStop_PausedFoldKeepsItsRightToASummary(t *testing.T) {
	w := NewConversationWorker("test-polite-fold", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	feedCompactionContextAndTools(w)
	w.llmCallFunc = func(_ context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "the summary"}}}, nil
	}

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "do the thing",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})
	// A fold mid-summarization: the pickup has claimed it and consumed its
	// needsStrategyRun, so the thread carries neither.
	fold := insertThreadWithOpts(w, threadOpts{
		goal: "Compacted conversation history", boundedCompaction: true,
		noAutoSelect: true, userMessage: "the folded history",
	})
	w.currentRun().claimLLM(fold)
	w.turn.thread.itemID = fold
	w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(fold)

	// The user presses Pause while the summarizer is working.
	w.markPoliteStop("")
	w.driveStrategyLoop(t, "", true)

	ymap := w.doc.GetThreadYMap(fold)
	ycrdtMu.Lock()
	armed, _ := ymap.Get("needsStrategyRun").(bool)
	summary, _ := ymap.Get("result").(string)
	ycrdtMu.Unlock()
	if summary != "" {
		t.Fatalf("the paused fold summarized anyway (result = %q)", summary)
	}
	if !armed {
		t.Fatal("a fold paused mid-summary lost its needsStrategyRun: the folded history is now behind " +
			"a tile with no summary, and nothing — not even an unpause — can ask for one")
	}

	w.handleUnpause("")
	w.quiesce(t)

	ycrdtMu.Lock()
	summary, _ = ymap.Get("result").(string)
	ycrdtMu.Unlock()
	if summary == "" {
		t.Error("lifting the pause did not summarize the fold it parked")
	}
}

// TestPoliteStop_MachineContinuationLeavesTheMarkStanding is the other half of
// the classification, and the reason it is not simply "anything that starts work
// lifts the pause". Delivered task output and a thread the MODEL asked for are
// the conversation carrying on by itself, which is exactly what a pause is a
// statement about — so the mark stands and the work waits.
func TestPoliteStop_MachineContinuationLeavesTheMarkStanding(t *testing.T) {
	w := NewConversationWorker("test-polite-machine", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	feedContextAndTools(t, w)
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "SHOULD NOT RUN"}}, StopReason: "end_turn"},
	})

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "watch the build",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})
	w.markPoliteStop("")

	// A background task delivering output into the paused conversation.
	payload, _ := json.Marshal(injectThreadMessageMsg{
		ThreadItemID: "", Text: "build failed", TaskID: "t-1",
	})
	w.currentRun().handleInjectThreadMessage(payload)

	w.quiesce(t)

	if !w.politeStopCovers("") {
		t.Fatal("delivered task output lifted the pause; nobody asked for that turn")
	}
	if left := w.mock.remaining(); left != 1 {
		t.Errorf("delivered task output called the provider under a pause (%d scripted turns left, want 1)", left)
	}
	// The output itself must survive: the pause defers the answer, it does not
	// discard the question.
	found := false
	for _, it := range w.doc.GetItems() {
		if it.Type == ItemTypeUser && strings.Contains(it.Content, "build failed") {
			found = true
		}
	}
	if !found {
		t.Error("the delivered task output was dropped; it must be waiting to be answered when the pause lifts")
	}
	// And no claim left behind: a claim is the busy frame, and a busy frame naming
	// a covered thread is what puts every column back into "Pausing…" behind a
	// spinner for a turn that is never going to run.
	if w.isLLMClaimed() {
		t.Error("delivered task output left a claim standing under a pause")
	}
}

// TestPoliteStop_StoppingOneThreadLeavesTheConversationPaused is the reported
// sequence, and the one place Pause and Stop meet.
//
// The user pauses the conversation, sees nothing happen for long enough to
// disbelieve it, and presses Stop on the sub-agent to make something happen. A
// hard cancel supersedes a pause (D7) — but only inside what it stops. Lifting
// the ancestor's mark instead hands the parent the turn the pause was holding
// back: the cancelled child reports its outcome to the parent whatever the
// ending, the reducer sees a batch that is now complete, and the parent calls the
// model. That is the "the parent woke up and continued, while still saying
// Pausing…" the user reported.
func TestPoliteStop_StoppingOneThreadLeavesTheConversationPaused(t *testing.T) {
	w := NewConversationWorker("test-polite-stop-child", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "look at a",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "I'll send an agent.",
		TransactionID: "txn-0", Timestamp: time.Now().Format(time.RFC3339),
	})
	child := insertThreadWithOpts(w, threadOpts{
		goal: "read a", userMessage: "look at a", llmCreated: true, delegated: true,
	})
	appendToThread(w, child, ConversationItem{
		Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "Half way through.",
	})

	w.doc.SetMetadata("processingState", map[string]any{
		"activity": ActivityAwaitingLLM, "threadItemId": "", "status": "processing_tools",
	})
	w.currentRun().claimLLM(child)

	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "SHOULD NOT RUN (parent)"}}, StopReason: "end_turn"},
	})
	feedContextAndTools(t, w)

	// Pause the conversation from the root column, then stop the sub-agent.
	w.markPoliteStop("")
	w.currentRun().handleCancel(cancelReasonUnspecified)

	if !w.politeStopCovers("") {
		t.Fatal("stopping one thread lifted the pause standing over the whole conversation")
	}

	// The stopped child reports its outcome to its caller, as it does at every
	// ending — so the parent's batch is complete and the reducer would drive it.
	w.settleThreadRun(child, true)
	w.sched.markReconcile()
	w.quiesce(t)

	if left := w.mock.remaining(); left != 1 {
		t.Fatalf("the parent carried on after a sub-thread was stopped under a pause "+
			"(%d scripted turns left, want 1): a Stop scoped to one thread must not resume the conversation", left)
	}
}
