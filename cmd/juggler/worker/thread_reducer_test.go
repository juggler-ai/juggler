//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
)

// These tests cover the pure decideNextAction function — the reducer's
// core. One test per row of the decision table in the MessageThread
// state machine plan.
//
// decideNextAction reads only its arguments — it does not touch any
// worker in-memory state — so these tests do not need a worker instance.

// resultJSON builds a json.RawMessage for a tool result, used to mark a
// tool-action as terminal (state alone isn't enough; the Result field
// must also be non-nil for the reducer's hasResult-style checks).
func resultJSON(content string) json.RawMessage {
	b, _ := json.Marshal(map[string]any{"content": content})
	return b
}

// userMsg returns a user-type conversation item with the given content.
func userMsg(content string) ConversationItem {
	return ConversationItem{Type: ItemTypeUser, Content: content}
}

// assistantMsg returns an assistant text-only message.
func assistantMsg(content string) ConversationItem {
	return ConversationItem{Type: ItemTypeAssistant, Content: content}
}

// toolAction returns a tool-action item in the given lifecycle state.
// If state is StateCompleted or StateCancelled, a non-empty result is
// attached so isToolTerminal / hasResult checks pass.
func toolAction(id, state string) ConversationItem {
	item := ConversationItem{
		Type:      ItemTypeToolAction,
		ToolUseID: id,
		ToolName:  "bash",
		State:     state,
	}
	if state == StateCompleted {
		item.Result = resultJSON("ok")
	}
	if state == StateCancelled {
		item.Result = resultJSON("cancelled")
	}
	return item
}

// refusedToolAction returns a tool-action a strategy refused on an absent
// user's behalf: a FAILED call (completed, isError), never a cancelled one.
func refusedToolAction(id string) ConversationItem {
	b, _ := json.Marshal(map[string]any{"content": "Refused: nobody here can approve that.", "isError": true})
	return ConversationItem{
		Type:      ItemTypeToolAction,
		ToolUseID: id,
		ToolName:  "bash",
		State:     StateCompleted,
		Result:    b,
	}
}

// threadMsg returns a thread item. If result is non-empty, the thread
// is considered complete (hasThreadResult returns true).
func threadMsg(itemID, result string) ConversationItem {
	item := ConversationItem{
		Type:   ItemTypeThread,
		ItemID: itemID,
		Goal:   "test thread",
	}
	if result != "" {
		item.Result = json.RawMessage(`"` + result + `"`)
	}
	return item
}

// TestDecideNextAction_Empty: no items → None regardless of root/activity.
func TestDecideNextAction_Empty(t *testing.T) {
	if got := decideNextAction(nil, ActivityNone, true, false); got != ActionNone {
		t.Errorf("empty/root: expected None, got %s", got)
	}
	if got := decideNextAction(nil, ActivityNone, false, false); got != ActionNone {
		t.Errorf("empty/nested: expected None, got %s", got)
	}
}

// TestDecideNextAction_CallingLLM: any state → None if an LLM call is in progress.
func TestDecideNextAction_CallingLLM(t *testing.T) {
	items := []ConversationItem{userMsg("hi")}
	if got := decideNextAction(items, ActivityCallingLLM, true, false); got != ActionNone {
		t.Errorf("calling_llm guard: expected None, got %s", got)
	}
}

// TestDecideNextAction_LastIsUser: user message → CallLLM only when activity="awaiting_llm".
func TestDecideNextAction_LastIsUser(t *testing.T) {
	items := []ConversationItem{userMsg("hello")}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionCallLLM {
		t.Errorf("user/root/awaiting: expected CallLLM, got %s", got)
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, false, false); got != ActionCallLLM {
		t.Errorf("user/nested/awaiting: expected CallLLM, got %s", got)
	}
	if got := decideNextAction(items, ActivityNone, true, false); got != ActionNone {
		t.Errorf("user/root/idle: expected None, got %s", got)
	}
}

// TestDecideNextAction_LastIsAssistantText_Root: resting unless an explicit
// continuation was requested.
func TestDecideNextAction_LastIsAssistantText_Root(t *testing.T) {
	items := []ConversationItem{
		userMsg("hi"),
		assistantMsg("hello there"),
	}
	if got := decideNextAction(items, ActivityNone, true, false); got != ActionNone {
		t.Errorf("assistant-text/root: expected None, got %s", got)
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, true); got != ActionCallLLM {
		t.Errorf("assistant-text/root/explicit-continuation: expected CallLLM, got %s", got)
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionGoIdle {
		t.Errorf("assistant-text/root/stale-awaiting: expected GoIdle, got %s", got)
	}
}

// TestDecideNextAction_LastIsAssistantText_Nested: a nested thread ending in
// an assistant message rests, exactly like root. Resting settles the run — that
// text is what the run returns — but it ends nothing, so the reducer returns
// ActionNone and never drives the thread further on its own. With
// activity="awaiting_llm",
// the earlier guard treats trailing assistant text as a stale awaiting marker
// (tools were deleted) and returns GoIdle unless this is an explicit user
// continuation.
func TestDecideNextAction_LastIsAssistantText_Nested(t *testing.T) {
	items := []ConversationItem{
		userMsg("do thing"),
		assistantMsg("did thing"),
	}
	if got := decideNextAction(items, ActivityNone, false, false); got != ActionNone {
		t.Errorf("assistant-text/nested/idle: expected None, got %s", got)
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, false, false); got != ActionGoIdle {
		t.Errorf("assistant-text/nested/stale-awaiting: expected GoIdle, got %s", got)
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, false, true); got != ActionCallLLM {
		t.Errorf("assistant-text/nested/explicit-continuation: expected CallLLM, got %s", got)
	}
}

// TestDecideNextAction_BatchPending: any pending tool → rest.
func TestDecideNextAction_BatchPending(t *testing.T) {
	items := []ConversationItem{
		userMsg("run ls"),
		assistantMsg("running"),
		toolAction("call_1", StatePending),
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionNone {
		t.Errorf("pending tool/root: expected None, got %s", got)
	}
}

// TestDecideNextAction_BatchApproved: approved/running → rest (tool-action
// reducer is handling it).
func TestDecideNextAction_BatchApproved(t *testing.T) {
	items := []ConversationItem{
		userMsg("run ls"),
		assistantMsg("running"),
		toolAction("call_1", StateApproved),
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionNone {
		t.Errorf("approved tool/root: expected None, got %s", got)
	}

	items[2].State = StateRunning
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionNone {
		t.Errorf("running tool/root: expected None, got %s", got)
	}
}

// TestDecideNextAction_BatchUnsetState: state="" → rest (new tool-action
// not yet evaluated by the tool-action reducer).
func TestDecideNextAction_BatchUnsetState(t *testing.T) {
	items := []ConversationItem{
		userMsg("run ls"),
		assistantMsg("running"),
		{Type: ItemTypeToolAction, ToolUseID: "call_1", ToolName: "bash"}, // State=""
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionNone {
		t.Errorf("unset-state tool/root: expected None, got %s", got)
	}
}

// TestDecideNextAction_BatchAllCompleted_Awaiting: all tools completed +
// activity="awaiting_llm" → continue the LLM.
func TestDecideNextAction_BatchAllCompleted_Awaiting(t *testing.T) {
	items := []ConversationItem{
		userMsg("run ls and pwd"),
		assistantMsg("running both"),
		toolAction("call_1", StateCompleted),
		toolAction("call_2", StateCompleted),
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionCallLLM {
		t.Errorf("all-completed/awaiting: expected CallLLM, got %s", got)
	}
}

// TestDecideNextAction_BatchAllCompleted_Idle: all tools completed +
// activity="" → None (tools already consumed by a previous LLM turn).
func TestDecideNextAction_BatchAllCompleted_Idle(t *testing.T) {
	items := []ConversationItem{
		userMsg("run ls and pwd"),
		assistantMsg("running both"),
		toolAction("call_1", StateCompleted),
		toolAction("call_2", StateCompleted),
	}
	if got := decideNextAction(items, ActivityNone, true, false); got != ActionNone {
		t.Errorf("all-completed/idle: expected None, got %s", got)
	}
}

// TestDecideNextAction_BatchAllCompleted_CallingLLM: all tools completed +
// activity="calling_llm" → None (LLM call already in progress).
func TestDecideNextAction_BatchAllCompleted_CallingLLM(t *testing.T) {
	items := []ConversationItem{
		userMsg("run ls"),
		assistantMsg("running"),
		toolAction("call_1", StateCompleted),
	}
	if got := decideNextAction(items, ActivityCallingLLM, true, false); got != ActionNone {
		t.Errorf("all-completed/calling: expected None, got %s", got)
	}
}

// TestDecideNextAction_BatchMixed: some completed, some cancelled +
// activity="awaiting_llm" → any denial stops the turn → GoIdle.
func TestDecideNextAction_BatchMixed(t *testing.T) {
	items := []ConversationItem{
		userMsg("run two things"),
		assistantMsg("running"),
		toolAction("call_1", StateCompleted),
		toolAction("call_2", StateCancelled),
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionGoIdle {
		t.Errorf("mixed batch/awaiting: expected GoIdle, got %s", got)
	}
}

// TestDecideNextAction_BatchMixedExplicitContinue: same mixed batch as above,
// but the user explicitly clicked Continue (explicitContinuation=true). An
// explicit Continue means "proceed anyway despite the denial" → CallLLM, not
// GoIdle. Mirrors the assistant-last branch which already honours the flag.
func TestDecideNextAction_BatchMixedExplicitContinue(t *testing.T) {
	items := []ConversationItem{
		userMsg("run two things"),
		assistantMsg("running"),
		toolAction("call_1", StateCompleted),
		toolAction("call_2", StateCancelled),
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, true); got != ActionCallLLM {
		t.Errorf("mixed batch/explicit continue: expected CallLLM, got %s", got)
	}
}

// TestDecideNextAction_BatchAllCancelledExplicitContinue: user denied every
// tool in the batch, then explicitly clicked Continue → CallLLM (proceed with
// the cancelled results), not GoIdle.
func TestDecideNextAction_BatchAllCancelledExplicitContinue(t *testing.T) {
	items := []ConversationItem{
		userMsg("run two things"),
		assistantMsg("running"),
		toolAction("call_1", StateCancelled),
		toolAction("call_2", StateCancelled),
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, true); got != ActionCallLLM {
		t.Errorf("all-cancelled/explicit continue: expected CallLLM, got %s", got)
	}
}

// TestDecideNextAction_Receipt rests on an unrequested child run unless the
// user explicitly clicks Continue. A receipt is news rather than a trigger, but
// it must not make the parent thread impossible to continue.
func TestDecideNextAction_Receipt(t *testing.T) {
	items := []ConversationItem{
		userMsg("delegate this"),
		threadMsg("thread-1", "first result"),
		{
			Type:      ItemTypeThread,
			ItemID:    "receipt-1",
			AliasOf:   "thread-1",
			RunItemID: "human-run-1",
		},
	}

	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionGoIdle {
		t.Errorf("receipt/awaiting: expected GoIdle, got %s", got)
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, true); got != ActionCallLLM {
		t.Errorf("receipt/explicit continue: expected CallLLM, got %s", got)
	}
}

// TestDecideNextAction_BatchAllCancelled_Root: user denied everything +
// activity="awaiting_llm" → GoIdle (clear the awaiting marker).
func TestDecideNextAction_BatchAllCancelled_Root(t *testing.T) {
	items := []ConversationItem{
		userMsg("run two things"),
		assistantMsg("running"),
		toolAction("call_1", StateCancelled),
		toolAction("call_2", StateCancelled),
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionGoIdle {
		t.Errorf("all-cancelled/root: expected GoIdle, got %s", got)
	}
}

// TestDecideNextAction_BatchAllCancelled_Nested: nested thread with all
// tools denied + activity="awaiting_llm" → GoIdle (denial is not a
// completion — just clear the marker and rest).
func TestDecideNextAction_BatchAllCancelled_Nested(t *testing.T) {
	items := []ConversationItem{
		userMsg("run things"),
		assistantMsg("running"),
		toolAction("call_1", StateCancelled),
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, false, false); got != ActionGoIdle {
		t.Errorf("all-cancelled/nested: expected GoIdle, got %s", got)
	}
}

// TestDecideNextAction_BatchStrategyRefused pins the distinction the sub-agent
// no-hang invariant rests on. A call a strategy refused because there is no
// human to ask is recorded as a failed tool, so the loop carries on and the
// agent can work around it. Recorded as CANCELLED it would land in the denial
// branch instead and end the run at the first call the permission system would
// have put to a person — which for a delegated agent is most of them.
func TestDecideNextAction_BatchStrategyRefused(t *testing.T) {
	refused := []ConversationItem{
		userMsg("investigate"),
		assistantMsg("looking"),
		toolAction("call_1", StateCompleted),
		refusedToolAction("call_2"),
	}
	if got := decideNextAction(refused, ActivityAwaitingLLM, false, false); got != ActionCallLLM {
		t.Errorf("a strategy refusal must not stop the loop: expected CallLLM, got %s", got)
	}

	// The contrast, on an otherwise identical batch: a human denial still rests.
	denied := []ConversationItem{
		userMsg("investigate"),
		assistantMsg("looking"),
		toolAction("call_1", StateCompleted),
		toolAction("call_2", StateCancelled),
	}
	if got := decideNextAction(denied, ActivityAwaitingLLM, false, false); got != ActionGoIdle {
		t.Errorf("a human denial must still stop the loop: expected GoIdle, got %s", got)
	}
}

// TestDecideNextAction_BatchAllCancelled_Idle: all cancelled + activity=""
// → None (not awaiting, so don't act).
func TestDecideNextAction_BatchAllCancelled_Idle(t *testing.T) {
	items := []ConversationItem{
		userMsg("run things"),
		assistantMsg("running"),
		toolAction("call_1", StateCancelled),
	}
	if got := decideNextAction(items, ActivityNone, false, false); got != ActionNone {
		t.Errorf("all-cancelled/idle: expected None, got %s", got)
	}
}

// TestDecideNextAction_OldIncompleteToolBlocksNewLLMCall: the reducer
// must not CallLLM while ANY tool in the thread (not just the current
// batch) is still in flight.
func TestDecideNextAction_OldIncompleteToolBlocksNewLLMCall(t *testing.T) {
	items := []ConversationItem{
		userMsg("turn 1"),
		assistantMsg("used tool"),
		toolAction("old", StateApproved), // user-retried old tool, still in flight
		userMsg("turn 2"),                // new user message
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionNone {
		t.Errorf("old incomplete tool: expected None, got %s", got)
	}
}

// TestDecideNextAction_ThreadItemWithResult_Awaiting: parent sees a nested
// thread with a result + activity="awaiting_llm" → CallLLM.
func TestDecideNextAction_ThreadItemWithResult_Awaiting(t *testing.T) {
	items := []ConversationItem{
		userMsg("start"),
		assistantMsg("delegating"),
		threadMsg("child-1", "child is done"),
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionCallLLM {
		t.Errorf("thread-with-result/awaiting: expected CallLLM, got %s", got)
	}
}

// TestDecideNextAction_ThreadItemWithResult_Idle: parent sees a nested
// thread with a result + activity="" → None (already consumed).
func TestDecideNextAction_ThreadItemWithResult_Idle(t *testing.T) {
	items := []ConversationItem{
		userMsg("start"),
		assistantMsg("delegating"),
		threadMsg("child-1", "child is done"),
	}
	if got := decideNextAction(items, ActivityNone, true, false); got != ActionNone {
		t.Errorf("thread-with-result/idle: expected None, got %s", got)
	}
}

// TestDecideNextAction_ThreadItemNoResult: parent sees a nested thread
// still running → rest; the child's reducer is handling it.
func TestDecideNextAction_ThreadItemNoResult(t *testing.T) {
	items := []ConversationItem{
		userMsg("start"),
		assistantMsg("delegating"),
		threadMsg("child-1", ""),
	}
	if got := decideNextAction(items, ActivityNone, true, false); got != ActionNone {
		t.Errorf("thread-no-result: expected None, got %s", got)
	}
}

// stoppedThreadMsg returns the parent's view of a delegated call whose run was
// STOPPED: the call's coordinates on the item, and a transcript whose run record
// says it was cancelled. This is what settleThreadRun leaves behind when a
// sub-agent is stopped from its own column.
func stoppedThreadMsg(itemID, toolUseID string) ConversationItem {
	nested, _ := json.Marshal([]ConversationItem{{
		Type: ItemTypeUser, ItemID: itemID + "-u1", Content: "go and look",
		RunToolUseID: toolUseID, RunStatus: runStatusCancelled,
		RunResult: "[The run was cancelled before it finished.]",
	}})
	return ConversationItem{
		Type: ItemTypeThread, ItemID: itemID, Goal: "test thread",
		RunToolUseID: toolUseID, Items: nested,
	}
}

// TestDecideNextAction_ThreadRunCancelled: a sub-agent the user STOPPED does not
// drive the caller parked on it. The run settles so the caller stops waiting —
// its Continue comes back — but a stop is not an answer, and resuming on one
// spends a turn on "[The run was cancelled before it finished.]" while the work
// sits undone. Same rule as a denied tool: the automatic loop ends, an explicit
// Continue still proceeds.
func TestDecideNextAction_ThreadRunCancelled(t *testing.T) {
	items := []ConversationItem{
		userMsg("research it"),
		assistantMsg("sending an agent"),
		stoppedThreadMsg("child-1", "call_1"),
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionGoIdle {
		t.Errorf("stopped sub-agent/awaiting: expected GoIdle, got %s", got)
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, true); got != ActionCallLLM {
		t.Errorf("stopped sub-agent/explicit continue: expected CallLLM, got %s", got)
	}
}

// TestDecideNextAction_ThreadItemExplicitNull: a thread.Result set to
// literal JSON null should NOT count as a result.
func TestDecideNextAction_ThreadItemExplicitNull(t *testing.T) {
	items := []ConversationItem{
		userMsg("start"),
		assistantMsg("delegating"),
		{
			Type:   ItemTypeThread,
			ItemID: "child-1",
			Result: json.RawMessage("null"),
		},
	}
	if got := decideNextAction(items, ActivityNone, true, false); got != ActionNone {
		t.Errorf("thread null-result: expected None, got %s", got)
	}
}

// TestDecideNextAction_MetaToolResult: a meta-tool result triggers CallLLM
// only when activity="awaiting_llm".
func TestDecideNextAction_MetaToolResult(t *testing.T) {
	items := []ConversationItem{
		userMsg("compact"),
		{Type: ItemTypeMetaToolResult, Content: "compacted"},
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionCallLLM {
		t.Errorf("meta-tool-result/awaiting: expected CallLLM, got %s", got)
	}
	if got := decideNextAction(items, ActivityNone, true, false); got != ActionNone {
		t.Errorf("meta-tool-result/idle: expected None, got %s", got)
	}
}

// TestDecideNextAction_IgnoresThinkingAndErrors: thinking blocks and
// error items are skipped; decision falls through to the previous
// conversation item.
func TestDecideNextAction_IgnoresThinkingAndErrors(t *testing.T) {
	items := []ConversationItem{
		userMsg("hi"),
		{Type: ItemTypeThinking, Content: "hmm"},
		{Type: ItemTypeError, Content: "something weird"},
	}
	// Effective last item is the user → CallLLM when awaiting, None when idle.
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionCallLLM {
		t.Errorf("trailing thinking+error/root/awaiting: expected CallLLM, got %s", got)
	}
	if got := decideNextAction(items, ActivityNone, true, false); got != ActionNone {
		t.Errorf("trailing thinking+error/root/idle: expected None, got %s", got)
	}
}

// TestDecideNextAction_IgnoresContextItems: context items like
// system-prompt, rule, tree must not drive the decision.
func TestDecideNextAction_IgnoresContextItems(t *testing.T) {
	items := []ConversationItem{
		{Type: "system-prompt", Content: "you are helpful"},
		{Type: "rule", Content: "be terse"},
		{Type: "tree", Content: "project tree"},
		userMsg("hi"),
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionCallLLM {
		t.Errorf("context-items + user/awaiting: expected CallLLM, got %s", got)
	}
	if got := decideNextAction(items, ActivityNone, true, false); got != ActionNone {
		t.Errorf("context-items + user/idle: expected None, got %s", got)
	}
}

// TestDecideNextAction_OnlyContextItems: a conversation with only
// context items and no conversation flow is at rest.
func TestDecideNextAction_OnlyContextItems(t *testing.T) {
	items := []ConversationItem{
		{Type: "system-prompt", Content: "you are helpful"},
	}
	if got := decideNextAction(items, ActivityNone, true, false); got != ActionNone {
		t.Errorf("only context items: expected None, got %s", got)
	}
}

// TestCurrentBatch: walks back from the end collecting consecutive dispatched
// work, stopping at the assistant message that asked for it.
func TestCurrentBatch(t *testing.T) {
	items := []ConversationItem{
		userMsg("hi"),
		assistantMsg("a1"),
		toolAction("t1", StateCompleted),
		toolAction("t2", StateCompleted),
		assistantMsg("a2"),
		toolAction("t3", StateCompleted),
		toolAction("t4", StateCompleted),
	}
	batch := currentBatch(items)
	if len(batch) != 2 {
		t.Fatalf("expected 2 tools in batch, got %d", len(batch))
	}
	if batch[0].ToolUseID != "t3" || batch[1].ToolUseID != "t4" {
		t.Errorf("expected batch [t3 t4], got [%s %s]", batch[0].ToolUseID, batch[1].ToolUseID)
	}
}

// TestCurrentBatch_NoTrailingWork: last item isn't dispatched work → empty batch.
func TestCurrentBatch_NoTrailingWork(t *testing.T) {
	items := []ConversationItem{
		userMsg("hi"),
		assistantMsg("hello"),
	}
	if batch := currentBatch(items); len(batch) != 0 {
		t.Errorf("expected empty batch, got %+v", batch)
	}
}

// TestCurrentBatch_MixesToolsAndThreads: one turn calling two sub-agents either
// side of a bash command is waiting on all three, so all three are in the batch.
// Threads were not members while children could only run one at a time, and a
// batch that stopped at the nearest thread would let the parent resume on a
// half-finished turn.
func TestCurrentBatch_MixesToolsAndThreads(t *testing.T) {
	items := []ConversationItem{
		userMsg("research a and b, and list the files"),
		assistantMsg("on it"),
		threadMsg("child-a", ""),
		toolAction("t1", StateCompleted),
		threadMsg("child-b", "found b"),
	}
	batch := currentBatch(items)
	if len(batch) != 3 {
		t.Fatalf("expected the two threads and the tool in the batch, got %d: %+v", len(batch), batch)
	}
}

// inTxn stamps an item with the round-trip that produced it, as
// appendTargetMessage does for everything a turn inserts.
func inTxn(item ConversationItem, txnID string) ConversationItem {
	item.TransactionID = txnID
	return item
}

// TestCurrentBatch_StopsAtEarlierRoundTrip: a turn that answers with tool calls
// alone inserts no assistant item, so its tools sit directly after the previous
// turn's. The batch is this round-trip's work only — an earlier turn's tool
// already went to the model and is not waited on or judged again.
func TestCurrentBatch_StopsAtEarlierRoundTrip(t *testing.T) {
	items := []ConversationItem{
		userMsg("hi"),
		assistantMsg("a1"),
		inTxn(toolAction("t1", StateCancelled), "txn-1"),
		inTxn(toolAction("t2", StateCompleted), "txn-2"),
		inTxn(toolAction("t3", StateCompleted), "txn-2"),
	}
	batch := currentBatch(items)
	if len(batch) != 2 || batch[0].ToolUseID != "t2" || batch[1].ToolUseID != "t3" {
		t.Fatalf("expected batch [t2 t3], got %+v", batch)
	}
}

// TestCurrentBatch_ReceiptDoesNotBoundTheBatch: a receipt is appended after the
// batch by a run nobody here asked for, so whatever round-trip it carries says
// nothing about where this turn's work begins.
func TestCurrentBatch_ReceiptDoesNotBoundTheBatch(t *testing.T) {
	items := []ConversationItem{
		userMsg("delegate this"),
		assistantMsg("on it"),
		inTxn(threadMsg("thread-1", "first result"), "txn-1"),
		inTxn(toolAction("t1", StateCompleted), "txn-1"),
		inTxn(ConversationItem{Type: ItemTypeThread, ItemID: "receipt-1", AliasOf: "thread-1", RunItemID: "human-run-1"}, "txn-9"),
	}
	if batch := currentBatch(items); len(batch) != 3 {
		t.Fatalf("expected the thread, the tool and the receipt in the batch, got %d: %+v", len(batch), batch)
	}
}

// TestDecideNextAction_CancelledToolFromEarlierTurnDoesNotStopLoop: the user
// stopped a hung tool, then pressed Continue. Continue inserts no user item and
// the model replied with a tool call alone, so the cancelled tool and the new
// one are adjacent. The new round-trip's tool finishing must resume the loop;
// the earlier cancellation was already answered by the Continue.
func TestDecideNextAction_CancelledToolFromEarlierTurnDoesNotStopLoop(t *testing.T) {
	items := []ConversationItem{
		userMsg("rebase it"),
		assistantMsg("checking remotes"),
		inTxn(toolAction("hung", StateCancelled), "txn-1"),
		inTxn(toolAction("next", StateCompleted), "txn-2"),
	}
	if got := decideNextAction(items, ActivityAwaitingLLM, true, false); got != ActionCallLLM {
		t.Errorf("expected CallLLM, got %s", got)
	}
}

// TestReducerViewCarriesTransactionID: the batch boundary is read from the
// reducer's view of the document, not from the full item, so the view must
// carry the round-trip id or the boundary never forms outside these tests.
func TestReducerViewCarriesTransactionID(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")
	doc.AppendMessage(inTxn(toolAction("t1", StateCompleted), "txn-1"))
	items := doc.GetReducerItems()
	if len(items) != 1 || items[0].TransactionID != "txn-1" {
		t.Fatalf("expected the reducer view to carry transactionId txn-1, got %+v", items)
	}
}

// TestDecideNextAction_WaitsForEverySibling is the property that broke when
// read-only children started running side by side: a parent parked on several
// sub-agents must wait for ALL of them, and the one that answers first is not
// necessarily the last one in the transcript.
//
// The reducer used to ask only whether the FINAL item had settled. Under serial
// dispatch that was the same question — the last-spawned child was necessarily
// the last to finish — so once children ran together, a batch whose LAST child
// answered first resumed the parent with its earlier siblings still running and
// their results missing from the turn.
func TestDecideNextAction_WaitsForEverySibling(t *testing.T) {
	cases := []struct {
		name  string
		items []ConversationItem
		want  ThreadAction
	}{
		{
			// The quickest child is the last in the transcript: the tail reads
			// "finished" while the batch has not.
			name: "last child settled, earlier sibling still running",
			items: []ConversationItem{
				userMsg("research a and b"),
				assistantMsg("on it"),
				threadMsg("child-a", ""),
				threadMsg("child-b", "found b"),
			},
			want: ActionNone,
		},
		{
			name: "every child settled",
			items: []ConversationItem{
				userMsg("research a and b"),
				assistantMsg("on it"),
				threadMsg("child-a", "found a"),
				threadMsg("child-b", "found b"),
			},
			want: ActionCallLLM,
		},
		{
			// A bash command among the sub-agents is waited on by the same rule,
			// from either side of it.
			name: "bash still running between two settled children",
			items: []ConversationItem{
				userMsg("research a and b, and list the files"),
				assistantMsg("on it"),
				threadMsg("child-a", "found a"),
				toolAction("t1", StateRunning),
				threadMsg("child-b", "found b"),
			},
			want: ActionNone,
		},
		{
			name: "child still running behind a finished bash",
			items: []ConversationItem{
				userMsg("research a, and list the files"),
				assistantMsg("on it"),
				threadMsg("child-a", ""),
				toolAction("t1", StateCompleted),
			},
			want: ActionNone,
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := decideNextAction(tc.items, ActivityAwaitingLLM, true, false); got != tc.want {
				t.Errorf("decideNextAction = %s, want %s", got, tc.want)
			}
		})
	}
}

// TestSelectThreadFallbackResult covers the pure picker that promotes a run's
// trailing assistant text as the thread result, or returns "" when there is no
// clean trailing assistant reply to promote.
func TestSelectThreadFallbackResult(t *testing.T) {
	cases := []struct {
		name  string
		items []ConversationItem
		want  string
	}{
		{
			name: "qualifying assistant text wins",
			items: []ConversationItem{
				userMsg("hi"),
				assistantMsg("here is the summary"),
			},
			want: "here is the summary",
		},
		{
			name: "preamble before tool call is rejected",
			items: []ConversationItem{
				userMsg("hi"),
				assistantMsg("I'll search for it..."),
				toolAction("t1", StateCompleted),
			},
			want: "",
		},
		{
			name: "last qualifying text wins, intermediate preambles ignored",
			items: []ConversationItem{
				userMsg("hi"),
				assistantMsg("I'll search..."),
				toolAction("t1", StateCompleted),
				assistantMsg("found it: foo"),
			},
			want: "found it: foo",
		},
		{
			name: "meta-tool-result also disqualifies preceding text",
			items: []ConversationItem{
				userMsg("hi"),
				assistantMsg("calling a meta tool"),
				{Type: ItemTypeMetaToolResult, ToolUseID: "m1", ToolName: "drop_context_items"},
			},
			want: "",
		},
		{
			name: "empty content is skipped",
			items: []ConversationItem{
				userMsg("hi"),
				assistantMsg(""),
				assistantMsg("real text"),
			},
			want: "real text",
		},
		{
			name:  "no items returns empty",
			items: nil,
			want:  "",
		},
		{
			name: "trailing user message means thread isn't done",
			items: []ConversationItem{
				assistantMsg("earlier reply"),
				userMsg("but wait, also..."),
			},
			want: "",
		},
		{
			name: "trailing incomplete tool-action means thread isn't done",
			items: []ConversationItem{
				assistantMsg("earlier reply"),
				userMsg("do a thing"),
				assistantMsg("ok"),
				toolAction("t1", StateRunning),
			},
			want: "",
		},
		{
			name: "trailing thread item means thread isn't done",
			items: []ConversationItem{
				assistantMsg("earlier reply"),
				{Type: ItemTypeThread, ItemID: "child"},
			},
			want: "",
		},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			got := selectThreadFallbackResult(tc.items)
			if got != tc.want {
				t.Errorf("selectThreadFallbackResult = %q, want %q", got, tc.want)
			}
		})
	}
}
