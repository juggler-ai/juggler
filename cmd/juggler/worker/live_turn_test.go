//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// A dispatched turn executes on a goroutine of its own, which is what lets the
// loop keep serving the mailbox while the turn streams. These tests Start the
// real run loop and act on the worker through its mailbox while a turn is live —
// what the rest of the package's tests, which act as the actor themselves and
// quiesce it between steps (actor_quiesce_test.go), never do.

import (
	"context"
	"encoding/json"
	"fmt"
	"testing"
	"time"

	ycrdt "github.com/skyterra/y-crdt"

	"juggler/cmd/juggler/providers/provider"
)

// startTurningWorker returns a running, initialized worker with a model
// configured and one scripted response that pauses before returning, so a test
// can act at a known point inside a live turn.
func startTurningWorker(t *testing.T, mc *msgChan) *ConversationWorker {
	t.Helper()
	return startDelegatingWorker(t, mc, nil, nil)
}

// startDelegatingWorker is startTurningWorker with the delegation round-trip
// wired up: the engine offers the given tools and answers each
// build-subthread-spec with the next spec in specs. Passing neither leaves the
// plain harness, which offers no tools and is never asked for a spec.
//
// A delegated child is dispatched by the reducer's walk-down, not by
// checkForNewThreads, so a test about siblings running side by side has to come
// through here: the doc-driven pickup path fans out on its own and would prove
// nothing about the walk-down.
func startDelegatingWorker(t *testing.T, mc *msgChan, tools []ToolDefinition, specs []*SubthreadSpec) *ConversationWorker {
	t.Helper()
	w := NewConversationWorker("conv-live-turn", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	// Held as a channel for the same reason the mock LLM's script is: the engine
	// callback is run by the callback registry, so a script consumed by several
	// delegating calls is ordered without a cursor anyone has to guard. Running
	// dry answers with no spec, which is the engine's "run this tool inline" —
	// a test that scripts too few specs fails on the tool, not on the harness.
	queued := make(chan *SubthreadSpec, len(specs)+1)
	for _, s := range specs {
		queued <- s
	}
	nextSpec := func() *SubthreadSpec {
		select {
		case s := <-queued:
			return s
		default:
			return nil
		}
	}

	initPayload, err := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: "conv-live-turn"},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	if err != nil {
		t.Fatalf("marshalling init: %v", err)
	}
	w.currentRun().handleInit(initPayload)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.setMockResponses([]MockResponse{{
		Blocks:            []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "an answer"}},
		StopReason:        "end_turn",
		PauseBeforeReturn: true,
	}})

	// A turn asks the engine for its context and tools before it calls the model,
	// so it needs something on the other end or it simply waits out the timeout.
	// Answered from the callback registry's goroutine, exactly as a real client's
	// reply arrives.
	w.SetCallback("engine", func(b []byte) {
		var head struct {
			Type      string `json:"type"`
			RequestID string `json:"requestId"`
		}
		if json.Unmarshal(b, &head) != nil {
			return
		}
		switch head.Type {
		case "request-tools":
			payload, _ := json.Marshal(ToolsResultMessage{
				Type: "tools-result", RequestID: head.RequestID, Tools: tools,
			})
			w.handleToolsResult(payload)
		case "render-context-items-request":
			payload, _ := json.Marshal(RenderContextItemsResponse{
				Type: "render-context-items-response", RequestID: head.RequestID,
			})
			w.handleRenderContextItemsResponse(payload)
		case "build-subthread-spec":
			payload, _ := json.Marshal(BuildSubthreadSpecResponse{
				Type:      "build-subthread-spec-response",
				RequestID: head.RequestID,
				Spec:      nextSpec(),
			})
			w.engine.subthreadSpecReply.inject(w.done, payload)
		}
	})
	w.SetEngineClientID("engine")

	w.SetCallback("client", mc.callback)
	w.currentRun().Start(context.Background())
	t.Cleanup(w.currentRun().Stop)
	return w
}

// sendUserMessage posts an ordinary root-thread send through the mailbox.
func sendUserMessage(t *testing.T, w *ConversationWorker, text string) {
	t.Helper()
	payload, err := json.Marshal(SendMessageMessage{Type: "send-message", Text: text})
	if err != nil {
		t.Fatalf("marshalling send-message: %v", err)
	}
	w.Send("send-message", payload)
}

// awaitLiveRun waits for the dispatched turn to be published in the registry.
func awaitLiveRun(t *testing.T, w *ConversationWorker) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for !w.sched.hasLive() {
		select {
		case <-deadline:
			t.Fatal("no turn was ever published as live")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

// gateNextMockPause holds the mock's delivery goroutine just before it
// announces the next paused response, and returns the release. Waiting for the
// returned function to be called is the goroutine's only ordering with the test,
// so whatever the test does between the two calls is concurrent with everything
// the announcement goes on to do.
func gateNextMockPause(t *testing.T, w *ConversationWorker) (release func()) {
	t.Helper()
	gate := &announceGate{arrived: make(chan struct{}), release: make(chan struct{})}
	w.mock.gate.Store(gate)
	t.Cleanup(func() {
		// A test that never got there must not leave the goroutine parked.
		if w.mock.gate.Swap(nil) != nil {
			return
		}
		select {
		case <-gate.release:
		default:
			close(gate.release)
		}
	})

	select {
	case <-gate.arrived:
	case <-time.After(5 * time.Second):
		t.Fatal("the mock's delivery goroutine never reached the pause announcement")
	}
	return func() { close(gate.release) }
}

// awaitNoLiveRun waits for the registry to empty again.
func awaitNoLiveRun(t *testing.T, w *ConversationWorker) {
	t.Helper()
	deadline := time.After(5 * time.Second)
	for w.sched.hasLive() {
		select {
		case <-deadline:
			t.Fatal("the finished turn was never retired from the live-run registry")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

func TestLiveRunAdmissionAllowsOneWriterWithReadOnlySiblings(t *testing.T) {
	w := NewConversationWorker("conv-live-admission", "user:test")
	t.Cleanup(func() {
		w.sched.releaseActivity()
		w.doc.Destroy()
	})
	r := w.currentRun()
	initPayload, err := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: "conv-live-admission"},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	if err != nil {
		t.Fatalf("marshalling init: %v", err)
	}
	r.handleInit(initPayload)

	readA, err := r.spawnThread(threadSpec{Goal: "read a", Prompt: "read"}, toolSpawn{ReadOnly: true})
	if err != nil {
		t.Fatalf("creating first read-only thread: %v", err)
	}
	readB, err := r.spawnThread(threadSpec{Goal: "read b", Prompt: "read"}, toolSpawn{ReadOnly: true})
	if err != nil {
		t.Fatalf("creating second read-only thread: %v", err)
	}
	writer, err := r.spawnThread(threadSpec{Goal: "write", Prompt: "write"}, toolSpawn{})
	if err != nil {
		t.Fatalf("creating write-capable thread: %v", err)
	}

	w.registerLiveRun("", newTurnState())
	if !w.canAdmitThread(readA) || !w.canAdmitThread(readB) {
		t.Fatal("a read-only child was refused beside the root writer")
	}
	if w.canAdmitThread(writer) {
		t.Fatal("a second write-capable run was admitted")
	}

	w.registerLiveRun(readA, newTurnState())
	if w.canAdmitThread(readA) {
		t.Fatal("the same thread was admitted twice")
	}
	if !w.canAdmitThread(readB) {
		t.Fatal("a read-only sibling was refused")
	}
}

// TestReadOnlyAdmissionCeiling pins the bound on how many read-only children may
// run AT ONCE. Sharing the writer slot was all-or-nothing: every read-only
// sibling the reducer offered was admitted, so a turn that called four sub-agents
// ran four agent loops simultaneously, each growing its own context at full
// speed, and nine at once was legal.
//
// The ceiling costs nothing and loses nothing, which is why it is silent. A
// refused child is not turned away — it keeps its place and is dispatched the
// moment a sibling retires, so the same work happens, in the same order, spread
// out enough to watch and to stop. That is the whole property: refused now,
// admitted later, and the test asserts both halves because a ceiling that
// refused permanently would strand the child.
func TestReadOnlyAdmissionCeiling(t *testing.T) {
	w := NewConversationWorker("conv-readonly-ceiling", "user:test")
	t.Cleanup(func() {
		w.sched.releaseActivity()
		w.doc.Destroy()
	})
	r := w.currentRun()
	initPayload, err := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: "conv-readonly-ceiling"},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	if err != nil {
		t.Fatalf("marshalling init: %v", err)
	}
	r.handleInit(initPayload)

	// One more read-only child than may run together — the shape a single turn
	// calling several sub-agents produces.
	ids := make([]string, 0, maxConcurrentReadOnlyThreads+1)
	for i := 0; i <= maxConcurrentReadOnlyThreads; i++ {
		id, err := r.spawnThread(threadSpec{Goal: fmt.Sprintf("read %d", i), Prompt: "read"}, toolSpawn{ReadOnly: true})
		if err != nil {
			t.Fatalf("creating read-only thread %d: %v", i, err)
		}
		ids = append(ids, id)
	}

	turns := make([]*turnState, 0, maxConcurrentReadOnlyThreads)
	for i := 0; i < maxConcurrentReadOnlyThreads; i++ {
		if !w.canAdmitThread(ids[i]) {
			t.Fatalf("read-only child %d of %d was refused below the ceiling", i+1, maxConcurrentReadOnlyThreads)
		}
		ts := newTurnState()
		turns = append(turns, ts)
		w.registerLiveRun(ids[i], ts)
	}

	last := ids[maxConcurrentReadOnlyThreads]
	if w.canAdmitThread(last) {
		t.Fatalf("a read-only child was admitted with %d already running: the ceiling is what stops a turn's "+
			"whole fan-out from running at once", maxConcurrentReadOnlyThreads)
	}

	// Nothing is lost: the refusal is a wait, not a rejection.
	w.sched.unregister(turns[0])
	if !w.canAdmitThread(last) {
		t.Fatal("the queued child was still refused after a sibling retired — the ceiling must be a queue, " +
			"not a wall")
	}
}

func TestToolDriveSkipsLiveThreadAndDrivesIdleSibling(t *testing.T) {
	h := newReattachHarness(t, "conv-live-tool-drive")
	w := h.w
	threadID := insertThreadReturningID(t, w, "live child")
	threadItems := w.doc.GetThreadItemsArray(threadID)
	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "root-tool", ToolUseID: "root-use",
		ToolName: "bash", State: StateApproved,
	})
	w.doc.InsertMessageIntoArray(threadItems, 0, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "child-tool", ToolUseID: "child-use",
		ToolName: "bash", State: StateApproved,
	})

	w.driveToolActionsExcept(map[string]bool{threadID: true})
	h.flush(t)
	if got := h.executeCount("root-use"); got != 1 {
		t.Fatalf("idle root execute count = %d, want 1", got)
	}
	if got := h.executeCount("child-use"); got != 0 {
		t.Fatalf("live child execute count = %d, want 0", got)
	}

	w.driveToolActionsExcept(nil)
	h.flush(t)
	if got := h.executeCount("child-use"); got != 1 {
		t.Fatalf("retired child execute count = %d, want 1", got)
	}
}

func TestRetiredTurnBoundariesRemainThreadOwned(t *testing.T) {
	w := NewConversationWorker("conv-live-boundary", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })
	r := w.currentRun()

	first := newTurnState()
	first.thread.itemID = "thread-a"
	first.processingStartedAt.Store(101)
	first.lastProviderNotice = "provider-a"
	second := newTurnState()
	second.thread.itemID = "thread-b"
	second.processingStartedAt.Store(202)
	second.lastProviderNotice = "provider-b"
	// Registered as beginTurn registers them: the registry entry is what names
	// the thread a retired turn's boundary belongs to.
	w.registerLiveRun("thread-a", first)
	w.registerLiveRun("thread-b", second)

	r.finishRetiredTurn(second)
	r.finishRetiredTurn(first)

	continuedA := newTurnState()
	r.sched.seedBoundary("thread-a", continuedA)
	continuedB := newTurnState()
	r.sched.seedBoundary("thread-b", continuedB)
	if got := continuedA.processingStartedAt.Load(); got != 101 {
		t.Fatalf("thread-a boundary start = %d, want 101", got)
	}
	if got := continuedA.lastProviderNotice; got != "provider-a" {
		t.Fatalf("thread-a provider notice = %q, want provider-a", got)
	}
	if got := continuedB.processingStartedAt.Load(); got != 202 {
		t.Fatalf("thread-b boundary start = %d, want 202", got)
	}
	if got := continuedB.lastProviderNotice; got != "provider-b" {
		t.Fatalf("thread-b provider notice = %q, want provider-b", got)
	}
}

// TestSettledRunFilesItsBoundaryUnderItsOwnThread drives a sub-thread run to
// settlement through the real dispatch and retire path. finishStrategyRun clears
// the turn's thread as the run ends, so a boundary keyed by whatever the turn
// names at retirement is filed under the root: the root's next turn then inherits
// a sibling's approval edge and notice dedupe, and the thread keeps the boundary
// of its last parked dispatch, elapsed anchor included, for its next run to start
// from.
func TestSettledRunFilesItsBoundaryUnderItsOwnThread(t *testing.T) {
	w := NewConversationWorker("conv-settled-boundary", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	child := insertThreadWithOpts(w, threadOpts{goal: "read a", userMessage: "look at a"})
	w.turn.thread.itemID = child
	w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(child)

	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "Found it."}}, StopReason: "end_turn"},
	})
	feedContextAndTools(t, w)
	w.driveStrategyLoop(t, "", true)

	if left := w.mock.remaining(); left != 0 {
		t.Fatalf("the child's turn did not run (%d scripted turns left)", left)
	}
	if _, ok := w.sched.turnBoundaries[child]; !ok {
		t.Errorf("the settled run filed no boundary under its own thread %q", child)
	}
	if _, ok := w.sched.turnBoundaries[""]; ok {
		t.Errorf("a sub-thread run filed its boundary under the root; boundaries: %v", boundaryKeys(w))
	}
}

func boundaryKeys(w *ConversationWorker) []string {
	keys := make([]string, 0, len(w.sched.turnBoundaries))
	for k := range w.sched.turnBoundaries {
		keys = append(keys, fmt.Sprintf("%q", k))
	}
	return keys
}

// TestDispatchedTurnRunsOffTheRunLoop pins the arrangement everything else in
// this phase rests on: the turn is somewhere other than the loop, the loop is
// still going, and the conversation reads as busy throughout — because a gate
// that read it as idle would dispatch a second turn on top of this one.
func TestDispatchedTurnRunsOffTheRunLoop(t *testing.T) {
	mc := newMsgChan()
	w := startTurningWorker(t, mc)

	sendUserMessage(t, w, "hello")
	awaitLiveRun(t, w)

	if got := w.anyRunState(); got != StateProcessing {
		t.Fatalf("conversation state during a live turn = %v, want %v", got, StateProcessing)
	}
	// The ambient turn is NOT the one running: it holds the turn's boundary
	// state between dispatches and nothing more.
	if got := w.currentRun().loadState(); got != StateIdle {
		t.Fatalf("ambient turn state during a live turn = %v, want %v", got, StateIdle)
	}
	// The loop is still serving the mailbox — that is the whole point of moving
	// the turn off it — so a request that goes through it is answered mid-turn.
	if err := w.SendAndWait(context.Background(), "unpause", json.RawMessage(`{}`)); err != nil {
		t.Fatalf("the run loop stopped serving the mailbox during a turn: %v", err)
	}

	w.mock.release()
	awaitNoLiveRun(t, w)

	if got := w.anyRunState(); got != StateIdle {
		t.Fatalf("conversation state after the turn = %v, want %v", got, StateIdle)
	}
}

// TestCancelDuringADispatchedTurnUnblocksIt is the behaviour the wait loops used
// to get by reading the mailbox themselves. They no longer do: the loop handles
// the cancel, resolves the run it applies to, and wakes it.
func TestCancelDuringADispatchedTurnUnblocksIt(t *testing.T) {
	mc := newMsgChan()
	w := startTurningWorker(t, mc)

	sendUserMessage(t, w, "hello")
	awaitLiveRun(t, w)

	w.Send("cancel", json.RawMessage(`{"reason":"test"}`))

	// The turn is released by the cancel, not by the mock — nothing releases the
	// paused response, so a turn still waiting on it never retires.
	awaitNoLiveRun(t, w)

	if got := w.anyRunState(); got != StateIdle {
		t.Fatalf("conversation state after a cancelled turn = %v, want %v", got, StateIdle)
	}
	if w.hasActiveRun() {
		t.Fatal("a cancelled turn left a claim behind")
	}
}

// TestAPausedMockOutlivingItsTurnReadsNoTurnState pins the rule live_runs.go
// states and mock_llm.go has to keep: a run's thread field is plain memory the
// turn goroutine owns, so anything running elsewhere carries its own copy, taken
// before it left.
//
// The mock's delivery goroutine is the one thing that routinely outlives the
// turn that started it: parked on releaseCh, it is still there when a cancel
// wakes the turn, and the turn's unwind through finishStrategyRun clears the
// field underneath it. Run without the copy, this fails under -race with a
// write/read report naming resetThreadContext and announceMockPause.
//
// The order of the two matters, which is why the sleep below is load-bearing and
// must not become a wait on anything. Announcement first is not a race and never
// reports as one: the announcement's patch takes ycrdtMu, and the unwind takes it
// afterwards, so the lock orders the read ahead of the write. Only unwind-first
// is unsynchronized. Learning that the unwind has happened is exactly what the
// test may not do — every route to that knowledge (the live-run registry's
// atomic, an idle frame off the client channel) is itself the edge that would
// order the pair and bury the bug again. So the test waits out a period far
// longer than an unwind takes and then releases, which orders nothing. Should
// the machine be slow enough to defeat that, the two land in the harmless order
// and the test passes without catching: it can fail to detect, but it cannot
// fail spuriously.
func TestAPausedMockOutlivingItsTurnReadsNoTurnState(t *testing.T) {
	mc := newMsgChan()
	w := startTurningWorker(t, mc)

	sendUserMessage(t, w, "hello")
	releaseAnnouncement := gateNextMockPause(t, w)

	// Cancel, never release the response: the turn unwinds while the mock's
	// goroutine is held one statement short of the announcement.
	w.Send("cancel", json.RawMessage(`{"reason":"test"}`))
	time.Sleep(300 * time.Millisecond)
	releaseAnnouncement()

	awaitNoLiveRun(t, w)

	if got := w.anyRunState(); got != StateIdle {
		t.Fatalf("conversation state after a cancelled turn = %v, want %v", got, StateIdle)
	}
}

// insertReadOnlyChild adds a read-only child thread carrying a seed message and
// the one-shot run trigger, in a single transaction, and leaves the pickup to
// the worker's own observer. Deliberately not insertThreadWithOpts: that one
// fires handleItemsChange inline, which is the actor's work, not a test
// goroutine's, while the loop is running.
func insertReadOnlyChild(w *ConversationWorker, goal, seed string) string {
	threadItemID := generateItemID()
	// Under the document lock, like every production write: the actor loop is
	// reading the same items while this lands.
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		ymap := conversationItemToYMap(ConversationItem{
			Type:   ItemTypeThread,
			ItemID: threadItemID,
			Goal:   goal,
		})
		items := ycrdt.NewYArray()
		ymap.Set("items", items)
		ymap.Set("needsStrategyRun", true)
		ymap.Set("llmCreated", true)
		ymap.Set("delegated", true)
		ymap.Set("readOnly", true)
		items.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{
			Type:    ItemTypeUser,
			ItemID:  generateItemID(),
			Content: seed,
		})})
		w.doc.ensureItems().Push(ycrdt.ArrayAny{ymap})
	}, w.doc.authorID)
	return threadItemID
}

// TestReadOnlyChildrenRunSideBySide is the whole point of the exercise: two
// children whose runs change nothing are admitted together, so both are in
// flight at the same instant, each with its own entry in the registry and its
// own elapsed anchor. Before admission was capability-based, the second waited
// for the first to retire and the registry never held two.
func TestReadOnlyChildrenRunSideBySide(t *testing.T) {
	mc := newMsgChan()
	w := startTurningWorker(t, mc)
	// Two scripted turns, both held at the mock barrier, so the assertion runs
	// while both children are genuinely mid-call.
	w.setMockResponses([]MockResponse{
		{
			Blocks:            []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "found a"}},
			StopReason:        "end_turn",
			PauseBeforeReturn: true,
		},
		{
			Blocks:            []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "found b"}},
			StopReason:        "end_turn",
			PauseBeforeReturn: true,
		},
	})

	readA := insertReadOnlyChild(w, "read a", "look at a")
	readB := insertReadOnlyChild(w, "read b", "look at b")

	// Release whatever is parked once the assertions are done — and on any exit,
	// so a failure doesn't leave two goroutines blocked on the barrier.
	t.Cleanup(func() {
		for i := 0; i < 400 && w.sched.hasLive(); i++ {
			w.mock.release()
			time.Sleep(5 * time.Millisecond)
		}
	})

	// Waited on together, because the three are written a mailbox hop apart: a
	// thread's claim lands in the document at pickup, the registry entry only
	// when the run it was handed to begins its turn, and the top-level projection
	// only once a child publishes a status of its own — the pickup publishes a
	// root-level busy frame in the gap. Sampling any one of them early reads a
	// half-written frame as a missing run, which under load is exactly what it did.
	deadline := time.After(10 * time.Second)
	var state map[string]any
	projected := ""
	for {
		state = w.readProcessingState()
		projected, _ = state["threadItemId"].(string)
		if runEntryOf(state, readA) != nil && runEntryOf(state, readB) != nil &&
			len(w.sched.runs()) == 2 && (projected == readA || projected == readB) {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("the two read-only children never held runs at the same time; runs=%v registry=%d projection=%q",
				state["runs"], len(w.sched.runs()), projected)
		case <-time.After(5 * time.Millisecond):
		}
	}
	entryA, entryB := runEntryOf(state, readA), runEntryOf(state, readB)
	if entryActivity(entryA) != ActivityCallingLLM || entryActivity(entryB) != ActivityCallingLLM {
		t.Fatalf("both children should be calling the LLM; got %q and %q",
			entryActivity(entryA), entryActivity(entryB))
	}
	// Each run carries its own elapsed anchor: the spinner in each column counts
	// from when THAT child started, not from a single conversation-wide stamp.
	for id, entry := range map[string]map[string]any{readA: entryA, readB: entryB} {
		if _, ok := entry["startedAt"]; !ok {
			t.Fatalf("child %s holds a run with no elapsed anchor of its own: %v", id, entry)
		}
		if got, _ := entry["threadItemId"].(string); got != id {
			t.Fatalf("run entry names thread %q, want %q", got, id)
		}
	}
	// The top-level projection names exactly one of them, so the conversation-wide
	// readers see a single coherent frame; the wait above only exits once it does.
}

// delegatedChildIDs returns the ids of the delegated child threads sitting in
// the root thread, in document order.
func delegatedChildIDs(w *ConversationWorker) []string {
	var ids []string
	for _, item := range w.doc.GetItems() {
		if item.Type != ItemTypeThread || item.AliasOf != "" {
			continue
		}
		ids = append(ids, item.ItemID)
	}
	return ids
}

// TestDelegatedReadOnlySiblingsRunSideBySide is the same claim as
// TestReadOnlyChildrenRunSideBySide, made of the path a real sub-agent takes.
// That test seeds its children with needsStrategyRun, so checkForNewThreads
// picks them up — and that path fans out on its own, one pickup per reconcile
// pass. A Research or Explore call spawns its child through tryDelegateTool,
// which sets no such trigger: the parent parks on its incomplete threads and the
// reducer's WALK-DOWN is the only thing that ever dispatches them.
//
// So this is the test that speaks for what the user sees. One parent turn calls
// the same read-only delegating tool twice; both children must be in flight at
// once. When the walk-down could only descend into the first unsettled child and
// dispatched at most one thread per pass, the second child sat unstarted for as
// long as the first ran — the tile reading "Waiting for its turn…" — while the
// capability admission that was supposed to license it was never consulted.
func TestDelegatedReadOnlySiblingsRunSideBySide(t *testing.T) {
	mc := newMsgChan()
	tool := ToolDefinition{
		Name:                 "Research",
		Category:             "read",
		DelegatesToSubthread: true,
		ReadOnlySubthread:    true,
		InputSchema:          json.RawMessage(`{"type":"object","properties":{"task":{"type":"string"}},"required":["task"]}`),
	}
	specs := []*SubthreadSpec{
		{Goal: "read a", Prompt: "look at a"},
		{Goal: "read b", Prompt: "look at b"},
	}
	w := startDelegatingWorker(t, mc, []ToolDefinition{tool}, specs)
	// One parent turn calling the tool twice, then a held turn for each child, so
	// the assertion runs while both are genuinely mid-call.
	w.setMockResponses([]MockResponse{
		{
			Blocks: []LLMResponseBlock{
				{Type: provider.ContentBlockTypeToolUse, ID: "tu-1", Name: "Research", Input: json.RawMessage(`{"task":"a"}`)},
				{Type: provider.ContentBlockTypeToolUse, ID: "tu-2", Name: "Research", Input: json.RawMessage(`{"task":"b"}`)},
			},
			StopReason: "tool_use",
		},
		{
			Blocks:            []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "found a"}},
			StopReason:        "end_turn",
			PauseBeforeReturn: true,
		},
		{
			Blocks:            []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "found b"}},
			StopReason:        "end_turn",
			PauseBeforeReturn: true,
		},
	})

	// Release whatever is parked once the assertions are done — and on any exit,
	// so a failure doesn't leave two goroutines blocked on the barrier.
	t.Cleanup(func() {
		for i := 0; i < 400 && w.sched.hasLive(); i++ {
			w.mock.release()
			time.Sleep(5 * time.Millisecond)
		}
	})

	sendUserMessage(t, w, "research a and b")

	deadline := time.After(15 * time.Second)
	var state map[string]any
	var children []string
	for {
		children = delegatedChildIDs(w)
		if len(children) == 2 {
			state = w.readProcessingState()
			if runEntryOf(state, children[0]) != nil && runEntryOf(state, children[1]) != nil {
				break
			}
		}
		select {
		case <-deadline:
			t.Fatalf("the two delegated children never held runs at the same time; children=%v runs=%v",
				children, state["runs"])
		case <-time.After(5 * time.Millisecond):
		}
	}

	entryA, entryB := runEntryOf(state, children[0]), runEntryOf(state, children[1])
	if entryActivity(entryA) != ActivityCallingLLM || entryActivity(entryB) != ActivityCallingLLM {
		t.Fatalf("both delegated children should be calling the LLM; got %q and %q",
			entryActivity(entryA), entryActivity(entryB))
	}
	// Each child was stamped from the tool's own claim, which is what admitted the
	// second one beside the first. Asserted here because the whole result rests on
	// it: an unstamped child is write-capable, and two of those serialise.
	for _, id := range children {
		if !w.threadIsReadOnly(id) {
			t.Fatalf("child %s carries no readOnly stamp, so nothing licensed it to run beside its sibling", id)
		}
	}
}

// TestParentWaitsForEveryDelegatedSibling is the half that running the children
// at once is worth nothing without: a parent that called two sub-agents is owed
// two answers, so it must stay parked until BOTH have settled — the same rule a
// batch of bash commands has always had.
//
// Driven through the mock's barrier one release at a time, so one child settles
// while the other is provably still running. The parent's continuation is the
// last scripted response and nothing may take it in that window: a parent that
// resumes here sends a turn with the second child's result simply missing.
//
// What this does NOT pin is WHICH child settles first — the barrier releases
// whichever goroutine happens to be waiting on it. So it holds the general
// invariant ("no child live ⇒ no parent turn") end to end, and it is
// TestDecideNextAction_WaitsForEverySibling that pins the ordering case the
// reducer actually got wrong, where the child that answers first is the LAST one
// in the transcript.
func TestParentWaitsForEveryDelegatedSibling(t *testing.T) {
	mc := newMsgChan()
	tool := ToolDefinition{
		Name:                 "Research",
		Category:             "read",
		DelegatesToSubthread: true,
		ReadOnlySubthread:    true,
		InputSchema:          json.RawMessage(`{"type":"object","properties":{"task":{"type":"string"}},"required":["task"]}`),
	}
	specs := []*SubthreadSpec{
		{Goal: "read a", Prompt: "look at a"},
		{Goal: "read b", Prompt: "look at b"},
	}
	w := startDelegatingWorker(t, mc, []ToolDefinition{tool}, specs)
	w.setMockResponses([]MockResponse{
		{
			Blocks: []LLMResponseBlock{
				{Type: provider.ContentBlockTypeToolUse, ID: "tu-1", Name: "Research", Input: json.RawMessage(`{"task":"a"}`)},
				{Type: provider.ContentBlockTypeToolUse, ID: "tu-2", Name: "Research", Input: json.RawMessage(`{"task":"b"}`)},
			},
			StopReason: "tool_use",
		},
		{
			Blocks:            []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "found a"}},
			StopReason:        "end_turn",
			PauseBeforeReturn: true,
		},
		{
			Blocks:            []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "found b"}},
			StopReason:        "end_turn",
			PauseBeforeReturn: true,
		},
		// The parent's continuation. Nothing may take this until both children
		// are done, so its presence in the queue IS the assertion.
		{
			Blocks:     []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "both answered"}},
			StopReason: "end_turn",
		},
	})
	t.Cleanup(func() {
		for i := 0; i < 400 && w.sched.hasLive(); i++ {
			w.mock.release()
			time.Sleep(5 * time.Millisecond)
		}
	})

	sendUserMessage(t, w, "research a and b")

	// Both children in flight and each parked on its own scripted response. A
	// run is live from the moment its goroutine starts, which is before its turn
	// reaches the mock, so the run count alone would let the second child pop
	// after the release below — leaving a response in the queue that reads
	// exactly like a parent that never resumed at all.
	deadline := time.After(15 * time.Second)
	for len(w.sched.runs()) < 2 || w.mock.remaining() > 1 {
		select {
		case <-deadline:
			t.Fatalf("the two delegated children never ran together; runs=%v scripted responses left=%d",
				w.readProcessingState()["runs"], w.mock.remaining())
		case <-time.After(5 * time.Millisecond):
		}
	}

	// Let exactly one of them through. Which one is not the point — whichever it
	// is, the other is still running, and that is what the parent owes an answer.
	w.mock.release()
	for len(w.sched.runs()) > 1 {
		select {
		case <-deadline:
			t.Fatal("neither child finished after a release")
		case <-time.After(5 * time.Millisecond):
		}
	}

	// Hold here long enough for a wrongly-resumed parent to have taken its turn.
	// The surviving child keeps running throughout: this is the window in which
	// the reducer used to read the transcript's last item, find it settled, and
	// continue.
	for i := 0; i < 60; i++ {
		if remaining := w.mock.remaining(); remaining != 1 {
			t.Fatalf("the parent resumed with a child still running: %d scripted responses left, want 1", remaining)
		}
		if !w.sched.hasLive() {
			t.Fatal("the second child stopped running, so the window this asserts over is gone")
		}
		time.Sleep(5 * time.Millisecond)
	}

	// Once the second child settles the parent is owed nothing more, and takes
	// its continuation.
	w.mock.release()
	for w.mock.remaining() > 0 {
		select {
		case <-deadline:
			t.Fatal("the parent never resumed once every child had settled")
		case <-time.After(5 * time.Millisecond):
		}
	}
}
