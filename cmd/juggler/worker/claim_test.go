//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// TestClaimLLM_NullStateClaimsSuccessfully: claiming from a fresh worker
// (no prior processingState) transitions activity from null to
// ActivityCallingLLM.
func TestClaimLLM_NullStateClaimsSuccessfully(t *testing.T) {
	w := NewConversationWorker("test-claim-null", "user:test")

	if w.isLLMClaimed() {
		t.Fatal("fresh worker: expected isLLMClaimed=false")
	}
	if !w.claimLLM("") {
		t.Fatal("fresh worker: expected claim to succeed")
	}
	if !w.isLLMClaimed() {
		t.Fatal("after claim: expected isLLMClaimed=true")
	}
}

// TestClaimLLM_DoubleClaimFails: a second claim against the same
// conversation while the first is still held must return false.
func TestClaimLLM_DoubleClaimFails(t *testing.T) {
	w := NewConversationWorker("test-claim-double", "user:test")

	if !w.claimLLM("") {
		t.Fatal("first claim: expected success")
	}
	if w.claimLLM("") {
		t.Fatal("second claim: expected failure while first is held")
	}
}

// TestReleaseLLM_ClearsClaim: after release, isLLMClaimed reports false
// and a subsequent claim succeeds.
func TestReleaseLLM_ClearsClaim(t *testing.T) {
	w := NewConversationWorker("test-release", "user:test")

	w.claimLLM("")
	if !w.isLLMClaimed() {
		t.Fatal("after claim: expected isLLMClaimed=true")
	}
	w.releaseLLM("")
	if w.isLLMClaimed() {
		t.Fatal("after release: expected isLLMClaimed=false")
	}
	if !w.claimLLM("") {
		t.Fatal("claim after release: expected success")
	}
}

// TestSendStatusIdleClearsActivity: the normal end-of-loop sendStatus
// path must also clear the doc-native claim, so releaseLLM is redundant
// on the happy path.
func TestSendStatusIdleClearsActivity(t *testing.T) {
	w := NewConversationWorker("test-idle-clears", "user:test")

	w.claimLLM("")
	if !w.isLLMClaimed() {
		t.Fatal("after claim: expected isLLMClaimed=true")
	}
	w.currentRun().sendStatus("idle", "")
	if w.isLLMClaimed() {
		t.Fatal("after sendStatus(idle): expected isLLMClaimed=false")
	}
}

// TestSendStatusNonIdleSetsActivity: any non-idle sendStatus (preparing,
// streaming, processing_tools) writes activity so the claim tracks the
// loop's phases.
func TestSendStatusNonIdleSetsActivity(t *testing.T) {
	cases := []string{"preparing", "streaming", "processing_tools"}
	for _, status := range cases {
		t.Run(status, func(t *testing.T) {
			w := NewConversationWorker("test-status-"+status, "user:test")
			w.currentRun().sendStatus(status, "")
			if !w.isLLMClaimed() {
				t.Errorf("after sendStatus(%q): expected isLLMClaimed=true", status)
			}
		})
	}
}

// TestSendStatusErrorReleasesClaim: the terminal-error statuses (error,
// validation-error) are resting states, NOT active operations — they must
// release the doc-native claim like idle, never hold it. Regression test for
// the wedge where a no-model send wrote activity="calling_llm" via
// sendStatus("validation-error", …) and never released it: every subsequent
// send was then parked in the pending queue (getActivity != none) and every
// Continue was silently dropped, even after a model was selected.
func TestSendStatusErrorReleasesClaim(t *testing.T) {
	for _, status := range []string{"error", "validation-error"} {
		t.Run(status, func(t *testing.T) {
			w := NewConversationWorker("test-err-"+status, "user:test")
			w.currentRun().sendStatus(status, "boom")
			if w.getActivity() != ActivityNone {
				t.Fatalf("after sendStatus(%q): expected activity=%q (claim released), got %q", status, ActivityNone, w.getActivity())
			}
			if w.isLLMClaimed() {
				t.Fatalf("after sendStatus(%q): expected isLLMClaimed=false", status)
			}
		})
	}
}

// TestClaimLLM_ReloadScenario: worker dies mid-operation → fresh worker
// starts, reads stale processingState from disk → sendStatus("idle") on
// init clears the stale claim → next claim succeeds.
func TestClaimLLM_ReloadScenario(t *testing.T) {
	w := NewConversationWorker("test-reload", "user:test")
	w.claimLLM("")
	if !w.isLLMClaimed() {
		t.Fatal("initial claim: expected isLLMClaimed=true")
	}

	w.currentRun().sendStatus("idle", "")
	if w.isLLMClaimed() {
		t.Fatal("after init sendStatus(idle): expected stale claim cleared")
	}

	if !w.claimLLM("") {
		t.Fatal("post-reload claim: expected success")
	}
}

// TestRequestLLM_SetsAwaitingActivity: requestLLM transitions activity
// from null → "awaiting_llm".
func TestRequestLLM_SetsAwaitingActivity(t *testing.T) {
	w := NewConversationWorker("test-request", "user:test")

	if !w.requestLLM("") {
		t.Fatal("requestLLM: expected success from null activity")
	}
	if w.getActivity() != ActivityAwaitingLLM {
		t.Fatalf("after requestLLM: expected activity=%q, got %q", ActivityAwaitingLLM, w.getActivity())
	}
	// "awaiting_llm" is NOT "claimed" — the reducer should still act.
	if w.isLLMClaimed() {
		t.Fatal("awaiting_llm should NOT report isLLMClaimed=true")
	}
}

// TestRequestLLM_FailsWhenThreadIsCallingLLM: a thread mid-turn is the one state
// a queued dispatch cannot be added to. A REPEAT request on a thread already
// awaiting dispatch is an idempotent success instead — the return value reports
// the postcondition ("this thread is queued"), which already holds.
func TestRequestLLM_FailsWhenThreadIsCallingLLM(t *testing.T) {
	w := NewConversationWorker("test-request-busy", "user:test")

	w.claimLLM("")
	if w.requestLLM("") {
		t.Fatal("requestLLM during calling_llm: expected failure")
	}

	w2 := NewConversationWorker("test-request-double", "user:test")
	w2.requestLLM("")
	if !w2.requestLLM("") {
		t.Fatal("repeat requestLLM on an awaiting thread: expected idempotent success")
	}
}

// TestRunRegistry_ThreadsClaimIndependently: the claim is per-thread, so a busy
// thread never refuses an idle sibling. This is the property the read-only
// sub-agent fan-out is built on; before the run registry, processingState held
// one conversation-wide claim and the second thread was refused.
func TestRunRegistry_ThreadsClaimIndependently(t *testing.T) {
	w := NewConversationWorker("test-run-registry", "user:test")

	if !w.claimLLM("thread-a") {
		t.Fatal("precondition: first claim should succeed")
	}
	if !w.claimLLM("thread-b") {
		t.Fatal("claiming an idle sibling should succeed while thread-a is calling")
	}
	if w.claimLLM("thread-a") {
		t.Fatal("re-claiming a thread already calling the LLM should fail")
	}

	if got := w.threadActivity("thread-a"); got != ActivityCallingLLM {
		t.Fatalf("thread-a activity = %q, want %q", got, ActivityCallingLLM)
	}
	if got := w.threadActivity("thread-b"); got != ActivityCallingLLM {
		t.Fatalf("thread-b activity = %q, want %q", got, ActivityCallingLLM)
	}
	if got := w.threadActivity("thread-c"); got != ActivityNone {
		t.Fatalf("untouched thread activity = %q, want idle", got)
	}

	// Releasing one leaves the other running, and the projection follows the
	// survivor rather than reporting the conversation idle.
	w.releaseLLM("thread-a")
	if got := w.threadActivity("thread-a"); got != ActivityNone {
		t.Fatalf("after release, thread-a activity = %q, want idle", got)
	}
	if !w.hasActiveRun() {
		t.Fatal("thread-b still holds a claim: expected hasActiveRun=true")
	}
	if got := w.getActivity(); got != ActivityCallingLLM {
		t.Fatalf("projection activity = %q, want %q", got, ActivityCallingLLM)
	}
	if got := w.getProcessingThreadItemID(); got != "thread-b" {
		t.Fatalf("projection threadItemId = %q, want thread-b", got)
	}

	w.releaseLLM("thread-b")
	if w.hasActiveRun() {
		t.Fatal("after releasing both: expected hasActiveRun=false")
	}
	if got := w.getActivity(); got != ActivityNone {
		t.Fatalf("projection activity = %q, want idle", got)
	}
}

// TestRunRegistry_ExplicitContinuationIsPerThread: a Continue on one thread must
// not be consumed by another thread's dispatch.
func TestRunRegistry_ExplicitContinuationIsPerThread(t *testing.T) {
	w := NewConversationWorker("test-run-continuation", "user:test")

	w.markExplicitContinuation("thread-a")
	if !w.isExplicitContinuation("thread-a") {
		t.Fatal("thread-a: expected the continuation marker to be set")
	}
	if w.isExplicitContinuation("thread-b") {
		t.Fatal("thread-b: continuation marker must not leak across threads")
	}

	if w.consumeExplicitContinuation("thread-b") {
		t.Fatal("consuming an unmarked thread should report false")
	}
	if !w.consumeExplicitContinuation("thread-a") {
		t.Fatal("consuming the marked thread should report true")
	}
	if w.isExplicitContinuation("thread-a") {
		t.Fatal("the marker is one-shot: expected it cleared after consumption")
	}
}

// TestRunRegistry_RestSweepsEveryClaim: a resting status ends the conversation,
// not just the thread that rested — today's single-turn semantics, preserved
// while the registry underneath learns to hold several runs.
func TestRunRegistry_RestPreservesSiblingClaim(t *testing.T) {
	w := NewConversationWorker("test-run-rest", "user:test")

	w.claimLLM("")
	w.requestLLM("thread-b")
	w.currentRun().sendStatus("idle", "")

	if got := w.threadActivity(""); got != ActivityNone {
		t.Fatalf("root activity = %q, want idle", got)
	}
	if got := w.threadActivity("thread-b"); got != ActivityAwaitingLLM {
		t.Fatalf("thread-b activity = %q, want sibling claim preserved", got)
	}
	if !w.hasActiveRun() {
		t.Fatal("resting root swept an unrelated sibling claim")
	}
}

// TestClaimLLM_FromAwaitingSucceeds: claimLLM should transition from
// "awaiting_llm" → "calling_llm" (the reducer dispatching the LLM call).
func TestClaimLLM_FromAwaitingSucceeds(t *testing.T) {
	w := NewConversationWorker("test-claim-awaiting", "user:test")

	w.requestLLM("")
	if w.getActivity() != ActivityAwaitingLLM {
		t.Fatal("precondition: expected awaiting_llm")
	}

	if !w.claimLLM("") {
		t.Fatal("claimLLM from awaiting: expected success")
	}
	if w.getActivity() != ActivityCallingLLM {
		t.Fatalf("after claim: expected activity=%q, got %q", ActivityCallingLLM, w.getActivity())
	}
}

func TestRetryToolMarksExplicitContinuation(t *testing.T) {
	w := NewConversationWorker("test-retry-continuation", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })
	w.doc.InsertMessage(0,
		ConversationItem{Type: ItemTypeToolAction, ItemID: "tool", ToolUseID: "call-1", ToolName: "batch_grep", State: StateCompleted, Result: json.RawMessage(`{"content":"first"}`)},
		ConversationItem{Type: ItemTypeAssistant, ItemID: "answer", Content: "Found it."},
	)

	w.handleRetryToolAction(json.RawMessage(`{"toolUseId":"call-1"}`))

	if got := w.threadActivity(""); got != ActivityAwaitingLLM {
		t.Fatalf("retry activity = %q, want %q", got, ActivityAwaitingLLM)
	}
	if !w.isExplicitContinuation("") {
		t.Fatal("retry of an older tool did not preserve continuation intent")
	}
}

func TestAmbientActorIdleCompletesTurnFence(t *testing.T) {
	w := NewConversationWorker("test-ambient-idle-fence", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })
	w.requestLLM("")

	w.currentRun().sendStatus("idle", "")

	if got := w.docTurnCounter(); got != 1 {
		t.Fatalf("completed turn fence = %d, want 1", got)
	}
	if w.hasActiveRun() {
		t.Fatal("ambient idle left an active run entry")
	}
}

// TestSendStatusIdleClearsAwaiting: sendStatus("idle") clears any
// activity value, including "awaiting_llm" (crash recovery path).
func TestSendStatusIdleClearsAwaiting(t *testing.T) {
	w := NewConversationWorker("test-idle-awaiting", "user:test")

	w.requestLLM("")
	w.currentRun().sendStatus("idle", "")
	if w.getActivity() != ActivityNone {
		t.Fatalf("after sendStatus(idle): expected activity cleared, got %q", w.getActivity())
	}
}

// TestRestPromotingQueueReleasesNamedThread: the reducer rests threads it is not
// itself running, from an ambient run that carries no thread context. The idle
// frame it publishes names the root, so the rest has to drop the named thread's
// entry itself — otherwise the projection keeps reporting that thread, the next
// reconcile pass decides the same rest again, and the pair spins writing
// processing-state frames forever.
func TestRestPromotingQueueReleasesNamedThread(t *testing.T) {
	w := NewConversationWorker("test-rest-named-thread", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })
	w.requestLLM("thread-a")

	w.currentRun().restPromotingQueue("thread-a")

	if got := w.threadActivity("thread-a"); got != ActivityNone {
		t.Fatalf("thread-a activity = %q, want idle", got)
	}
	if w.hasActiveRun() {
		t.Fatal("resting a named thread left an active run entry")
	}
	if got := w.getActivity(); got != ActivityNone {
		t.Fatalf("projection activity = %q, want idle", got)
	}
}

// TestReconcileProcessingStateOnLoadSweepsEveryClaim: a doc persisted mid-turn
// can carry claims on several threads at once. A load is not one run resting, it
// is the whole registry being stale, so every entry goes — an idle frame alone
// would drop only the root's.
func TestReconcileProcessingStateOnLoadSweepsEveryClaim(t *testing.T) {
	w := NewConversationWorker("test-load-sweep", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })
	w.claimLLM("")
	w.claimLLM("thread-a")
	w.requestLLM("thread-b")

	w.currentRun().reconcileProcessingStateOnLoad()

	for _, threadID := range []string{"", "thread-a", "thread-b"} {
		if got := w.threadActivity(threadID); got != ActivityNone {
			t.Fatalf("thread %q activity after load = %q, want idle", threadID, got)
		}
	}
	if w.hasActiveRun() {
		t.Fatal("load left an active run entry")
	}
}

// TestConcurrentRunsCarrySeparateSpinnerFields: the spinner fields belong to the
// run that produced them. Two runs streaming at once each report their own
// status, elapsed anchor and token counts, and the top-level projection
// republishes exactly one of them for the conversation-wide readers.
func TestConcurrentRunsCarrySeparateSpinnerFields(t *testing.T) {
	w := NewConversationWorker("test-two-run-spinner", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	root := w.currentRun()
	child := w.runFor(newTurnState())
	child.t.thread.itemID = "thread-a"

	root.sendStatus("streaming", "")
	child.sendStatus("processing_tools", "")
	root.mergeProcessingTokens(11, 0, 0)
	child.mergeProcessingTokens(22, 0, 0)
	child.mergeProcessingPhase("Reconnecting")

	state := w.readProcessingState()
	rootEntry := runEntryOf(state, "")
	childEntry := runEntryOf(state, "thread-a")

	if got, _ := rootEntry["status"].(string); got != "streaming" {
		t.Fatalf("root entry status = %q, want streaming", got)
	}
	if got, _ := childEntry["status"].(string); got != "processing_tools" {
		t.Fatalf("child entry status = %q, want processing_tools", got)
	}
	if got, _ := rootEntry["outputTokens"].(int); got != 11 {
		t.Fatalf("root entry outputTokens = %v, want 11", rootEntry["outputTokens"])
	}
	if got, _ := childEntry["outputTokens"].(int); got != 22 {
		t.Fatalf("child entry outputTokens = %v, want 22", childEntry["outputTokens"])
	}
	if _, hasPhase := rootEntry["phase"]; hasPhase {
		t.Fatalf("the child's phase leaked onto the root entry: %v", rootEntry["phase"])
	}

	// The projection names the most recently claimed run and republishes its
	// fields, so a conversation-wide reader sees one coherent frame.
	if got, _ := state["threadItemId"].(string); got != "thread-a" {
		t.Fatalf("projected threadItemId = %q, want thread-a", got)
	}
	if got, _ := state["status"].(string); got != "processing_tools" {
		t.Fatalf("projected status = %q, want processing_tools", got)
	}
	if got, _ := state["outputTokens"].(int); got != 22 {
		t.Fatalf("projected outputTokens = %v, want 22", state["outputTokens"])
	}

	// The child resting leaves the root's run — and its counts — untouched, and
	// the projection falls back to it rather than reporting the whole
	// conversation idle.
	child.sendStatus("idle", "")
	state = w.readProcessingState()
	if runEntryOf(state, "thread-a") != nil {
		t.Fatal("the rested child kept a run entry")
	}
	if got, _ := runEntryOf(state, "")["outputTokens"].(int); got != 11 {
		t.Fatalf("root entry outputTokens after sibling rest = %v, want 11", runEntryOf(state, "")["outputTokens"])
	}
	if got, _ := state["status"].(string); got != "streaming" {
		t.Fatalf("projected status after sibling rest = %q, want streaming", got)
	}
}

// TestNewStatusFrameDropsPreviousPhaseFields: a token count belongs to the phase
// that produced it. Moving to the next phase drops the counts and the provider
// activity line with it, rather than captioning tool execution with the last
// stream's digits.
func TestNewStatusFrameDropsPreviousPhaseFields(t *testing.T) {
	w := NewConversationWorker("test-frame-resets-progress", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	r := w.currentRun()
	r.sendStatus("streaming", "")
	r.mergeProcessingTokens(7, 5, 0)
	r.processStreamChunk(StreamChunk{Type: provider.ContentBlockTypeActivity, Content: "Thinking"})

	r.sendStatus("processing_tools", "")

	entry := runEntryOf(w.readProcessingState(), "")
	for _, field := range []string{"outputTokens", "inputTokens", "description"} {
		if _, ok := entry[field]; ok {
			t.Fatalf("%s survived the phase change: %v", field, entry[field])
		}
	}
}

// TestAwaitingToolsRepublishesRunStatus: a turn that ends on async tool calls
// hands the loop back through transitionToAwaitingLLM, and the run's own entry —
// which the UI reads — must say "processing_tools" from then on, without the
// finished stream's token counts or activity line beside it.
func TestAwaitingToolsRepublishesRunStatus(t *testing.T) {
	w := NewConversationWorker("test-awaiting-tools-status", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	r := w.currentRun()
	r.sendStatus("streaming", "")
	r.mergeProcessingTokens(7, 5, 0)
	r.processStreamChunk(StreamChunk{Type: provider.ContentBlockTypeActivity, Content: "Thinking"})

	r.transitionToAwaitingLLM()

	state := w.readProcessingState()
	entry := runEntryOf(state, "")
	if got := entryActivity(entry); got != ActivityAwaitingLLM {
		t.Fatalf("entry activity = %q, want %q", got, ActivityAwaitingLLM)
	}
	if got, _ := entry["status"].(string); got != "processing_tools" {
		t.Fatalf("entry status = %q, want processing_tools", got)
	}
	if got, _ := state["status"].(string); got != "processing_tools" {
		t.Fatalf("projected status = %q, want processing_tools", got)
	}
	if _, ok := entry["startedAt"]; !ok {
		t.Fatal("the elapsed anchor was dropped with the stream fields")
	}
	for _, field := range []string{"outputTokens", "inputTokens", "description", "phase"} {
		if _, ok := entry[field]; ok {
			t.Fatalf("%s survived the hand-off to tools: %v", field, entry[field])
		}
	}
}
