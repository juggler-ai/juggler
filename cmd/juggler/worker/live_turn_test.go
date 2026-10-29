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
	"encoding/json"
	"fmt"
	"testing"
	"time"

	ycrdt "github.com/skyterra/y-crdt"
)

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

func boundaryKeys(w *ConversationWorker) []string {
	keys := make([]string, 0, len(w.sched.turnBoundaries))
	for k := range w.sched.turnBoundaries {
		keys = append(keys, fmt.Sprintf("%q", k))
	}
	return keys
}

// signalItemsChange drives handleItemsChange on the run loop, the way the
// document observer does.
func signalItemsChange(w *ConversationWorker) {
	select {
	case w.docChangeChan <- struct{}{}:
	default:
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
