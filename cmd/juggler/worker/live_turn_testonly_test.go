//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside live_turn_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"context"
	"encoding/json"
	"fmt"
	"juggler/cmd/juggler/providers/provider"
	"testing"
	"time"

	ycrdt "github.com/skyterra/y-crdt"
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

	answerEngineRequests(w, tools, nextSpec)

	w.SetCallback("client", mc.callback)
	w.currentRun().Start(context.Background())
	t.Cleanup(w.currentRun().Stop)
	return w
}

// gateNextMockPause holds the mock's delivery goroutine just before it
// announces the next paused response, and returns the release. Waiting for the
// returned function to be called is the goroutine's only ordering with the test,
// so whatever the test does between the two calls is concurrent with everything
// the announcement goes on to do.
func gateNextMockPause(t *testing.T, w *ConversationWorker) (release func()) {
	t.Helper()
	gate := &announceGate{arrived: make(chan struct{}), release: make(chan struct{})}
	w.mock().gate.Store(gate)
	t.Cleanup(func() {
		// A test that never got there must not leave the goroutine parked.
		if w.mock().gate.Swap(nil) != nil {
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

	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "Found it."}}, StopReason: "end_turn"},
	})
	feedContextAndTools(t, w)
	w.driveStrategyLoop(t, "", true)

	if left := w.mock().remaining(); left != 0 {
		t.Fatalf("the child's turn did not run (%d scripted turns left)", left)
	}
	if _, ok := w.sched.turnBoundaries[child]; !ok {
		t.Errorf("the settled run filed no boundary under its own thread %q", child)
	}
	if _, ok := w.sched.turnBoundaries[""]; ok {
		t.Errorf("a sub-thread run filed its boundary under the root; boundaries: %v", boundaryKeys(w))
	}
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

	w.mock().release()
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

// TestCancellingAPendingRequestStopsItsLiveTurn cancels a claimed createThread
// whose thread is streaming on its own goroutine. The scan that sees the cancel
// runs on the run loop, whose ambient turn reads Idle throughout, so the cancel
// has to find the live run through the registry to stop it. A cancel that only
// stamped the request and the run record would leave the turn spending.
func TestCancellingAPendingRequestStopsItsLiveTurn(t *testing.T) {
	mc := newMsgChan()
	w := startTurningWorker(t, mc)

	threadItemID := insertReadOnlyChild(w, "Cancel me", "start")
	awaitLiveRun(t, w)
	if w.sched.runOn(threadItemID) == nil {
		t.Fatalf("the live run is not on the requested thread %q", threadItemID)
	}

	pushCancelledClaimedCreateThread(t, w, "r-live", threadItemID)
	// Any items change drives the scan; signal it the way the observer does, so
	// the scan runs on the run loop rather than on this goroutine.
	select {
	case w.docChangeChan <- struct{}{}:
	default:
	}

	// Nothing releases the paused response, so only the cancel can retire it.
	awaitNoLiveRun(t, w)

	deadline := time.After(5 * time.Second)
	for findEntryStatus(w, "r-live") != "cancelled" {
		select {
		case <-deadline:
			t.Fatalf("request status = %q, want cancelled", findEntryStatus(w, "r-live"))
		case <-time.After(5 * time.Millisecond):
		}
	}
	if w.hasActiveRun() {
		t.Fatal("the cancelled request's turn left a claim behind")
	}
}

// releaseParkedRuns releases the mock's barrier until nothing is live, so a
// failed test doesn't leave turn goroutines parked on it.
func releaseParkedRuns(t *testing.T, w *ConversationWorker) {
	t.Cleanup(func() {
		for i := 0; i < 400 && w.sched.hasLive(); i++ {
			w.mock().release()
			time.Sleep(5 * time.Millisecond)
		}
	})
}

// pausedResponses scripts n turns, each held at the mock barrier.
func pausedResponses(n int) []MockResponse {
	out := make([]MockResponse, n)
	for i := range out {
		out[i] = MockResponse{
			Blocks:            []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: fmt.Sprintf("answer %d", i)}},
			StopReason:        "end_turn",
			PauseBeforeReturn: true,
		}
	}
	return out
}

// TestCancellingAPendingRequestStopsItsRunBesideASibling cancels a claimed
// createThread whose thread streams beside a read-only sibling, and is not the
// one the top-level processing projection names. The projection names one live
// run, so a cancel that starts from it finds the sibling, decides the request's
// thread owns no active work, and stamps the request cancelled while its turn
// streams on.
func TestCancellingAPendingRequestStopsItsRunBesideASibling(t *testing.T) {
	mc := newMsgChan()
	w := startTurningWorker(t, mc)
	w.setMockResponses(pausedResponses(2))
	releaseParkedRuns(t, w)

	readA := insertReadOnlyChild(w, "read a", "look at a")
	readB := insertReadOnlyChild(w, "read b", "look at b")

	deadline := time.After(10 * time.Second)
	projected := ""
	for {
		projected, _ = w.readProcessingState()["threadItemId"].(string)
		if len(w.sched.runs()) == 2 && w.mock().remaining() == 0 && (projected == readA || projected == readB) {
			break
		}
		select {
		case <-deadline:
			t.Fatalf("the two children never ran together; registry=%d projection=%q", len(w.sched.runs()), projected)
		case <-time.After(5 * time.Millisecond):
		}
	}
	cancelled, sibling := readA, readB
	if projected == readA {
		cancelled, sibling = readB, readA
	}

	pushCancelledClaimedCreateThread(t, w, "r-unnamed", cancelled)
	signalItemsChange(w)

	// Nothing releases the paused responses, so only the cancel can retire it.
	for w.sched.runOn(cancelled) != nil {
		select {
		case <-deadline:
			t.Fatalf("the cancelled request's turn is still live (request status %q)", findEntryStatus(w, "r-unnamed"))
		case <-time.After(5 * time.Millisecond):
		}
	}
	if w.sched.runOn(sibling) == nil {
		t.Fatal("cancelling one request stopped its sibling's turn")
	}
	for findEntryStatus(w, "r-unnamed") != "cancelled" {
		select {
		case <-deadline:
			t.Fatalf("request status = %q, want cancelled", findEntryStatus(w, "r-unnamed"))
		case <-time.After(5 * time.Millisecond):
		}
	}
}

// TestDeletingAThreadStopsItsLiveTurn deletes a thread while its turn streams on
// a goroutine of its own. The items observer runs on the run loop, whose ambient
// turn reads Idle throughout, so it has to find the turn through the registry:
// one that asked the ambient turn left the deleted thread's call spending.
func TestDeletingAThreadStopsItsLiveTurn(t *testing.T) {
	mc := newMsgChan()
	w := startTurningWorker(t, mc)
	releaseParkedRuns(t, w)

	threadItemID := insertReadOnlyChild(w, "Delete me", "start")
	awaitLiveRun(t, w)
	if w.sched.runOn(threadItemID) == nil {
		t.Fatalf("the live run is not on the inserted thread %q", threadItemID)
	}

	func() {
		ycrdtMu.Lock()
		defer ycrdtMu.Unlock()
		items := w.doc.ensureItems()
		for i := 0; i < int(items.GetLength()); i++ {
			if m, ok := items.Get(ycrdt.Number(i)).(*ycrdt.YMap); ok && m.Get("itemId") == threadItemID {
				w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
					items.Delete(ycrdt.Number(i), 1)
				}, w.doc.authorID)
				return
			}
		}
		t.Fatalf("thread %q not found in the root items", threadItemID)
	}()
	signalItemsChange(w)

	// Nothing releases the paused response, so only a cancel can retire it.
	awaitNoLiveRun(t, w)
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
			w.mock().release()
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
	if entryA.activity() != ActivityCallingLLM || entryB.activity() != ActivityCallingLLM {
		t.Fatalf("both children should be calling the LLM; got %q and %q",
			entryA.activity(), entryB.activity())
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
			w.mock().release()
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
	if entryA.activity() != ActivityCallingLLM || entryB.activity() != ActivityCallingLLM {
		t.Fatalf("both delegated children should be calling the LLM; got %q and %q",
			entryA.activity(), entryB.activity())
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
			w.mock().release()
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
	for len(w.sched.runs()) < 2 || w.mock().remaining() > 1 {
		select {
		case <-deadline:
			t.Fatalf("the two delegated children never ran together; runs=%v scripted responses left=%d",
				w.readProcessingState()["runs"], w.mock().remaining())
		case <-time.After(5 * time.Millisecond):
		}
	}

	// Let exactly one of them through. Which one is not the point — whichever it
	// is, the other is still running, and that is what the parent owes an answer.
	w.mock().release()
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
		if remaining := w.mock().remaining(); remaining != 1 {
			t.Fatalf("the parent resumed with a child still running: %d scripted responses left, want 1", remaining)
		}
		if !w.sched.hasLive() {
			t.Fatal("the second child stopped running, so the window this asserts over is gone")
		}
		time.Sleep(5 * time.Millisecond)
	}

	// Once the second child settles the parent is owed nothing more, and takes
	// its continuation.
	w.mock().release()
	for w.mock().remaining() > 0 {
		select {
		case <-deadline:
			t.Fatal("the parent never resumed once every child had settled")
		case <-time.After(5 * time.Millisecond):
		}
	}
}

// answerEngineRequests attaches an engine that answers every context and tools
// request — offering tools — and every build-subthread-spec with nextSpec. A turn
// asks the engine for its context and tools before it calls the model, so it
// needs something on the other end or it simply waits out the timeout. Answered
// from the callback registry's goroutine, exactly as a real client's reply
// arrives.
func answerEngineRequests(w *ConversationWorker, tools []ToolDefinition, nextSpec func() *SubthreadSpec) {
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
}
