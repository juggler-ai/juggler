//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
	"time"
)

// idleGuardWorld drives real turns through the reducer's dispatch path against a
// scripted model, with an engine callback and a context/tools feed wired so
// dispatched turns don't park on missing round-trips. Shaped after
// compactionWorld. Replies are scripted PER THREAD (matched on the request's
// thread id), because the interesting moment is which thread the reducer
// dispatches next, not the turn count.
type idleGuardWorld struct {
	t *testing.T
	w *ConversationWorker
	// entered fires each time the model is invoked; the payload names the thread.
	entered chan string
	// replyFor supplies the end_turn text for a thread's turn. Called from the
	// driving goroutine; block in it to hold a turn open.
	replyFor func(threadID string) string
}

const idleGuardTimeout = 5 * time.Second

// userThread creates a strategy-dispatched (non-llmCreated) child — the kind
// whose completion declines signalParentThread and so reaches
// finishStrategyRun's idle-publishing branch.
func (world *idleGuardWorld) userThread(goal string) string {
	world.t.Helper()
	threadID, err := world.w.currentRun().dispatchThread(threadSpec{Goal: goal})
	if err != nil {
		world.t.Fatalf("dispatchThread(%s): %v", goal, err)
	}
	return threadID
}

// llmThread creates an llmCreated child with a stamped tool-use coordinate — the
// create_thread/delegation kind, whose open run is work still in flight.
func (world *idleGuardWorld) llmThread(name string) string {
	world.t.Helper()
	threadID, err := world.w.currentRun().spawnThread(threadSpec{
		Goal:   name,
		Prompt: "task for " + name,
	}, toolSpawn{
		ToolUseID: "tu-" + name,
		ToolName:  "Explore",
		ToolInput: json.RawMessage(`{"prompt":"task"}`),
		Delegated: true,
	})
	if err != nil {
		world.t.Fatalf("spawnThread(%s): %v", name, err)
	}
	return threadID
}

func (world *idleGuardWorld) status() string {
	st, _ := world.w.readProcessingState()["status"].(string)
	return st
}

// waitEntered waits for the model to be invoked for threadID.
func (world *idleGuardWorld) waitEntered(want string) {
	world.t.Helper()
	for {
		select {
		case got := <-world.entered:
			if got == want {
				return
			}
		case <-time.After(idleGuardTimeout):
			world.t.Fatalf("timed out waiting for a turn on thread %q", want)
		}
	}
}

// waitAnyEntered waits for the model to be invoked on any thread.
func (world *idleGuardWorld) waitAnyEntered() {
	world.t.Helper()
	select {
	case <-world.entered:
	case <-time.After(idleGuardTimeout):
		world.t.Fatal("timed out waiting for any turn to be dispatched")
	}
}

// TestFirstLiveThreadIDMatchesWalkOrder pins that firstLiveThreadID names the
// thread the reducer would dispatch next (document order), not any live thread,
// and that its exclusion holds. The exclusion is what stops finishStrategyRun
// handing the claim back to the run that just ended: a run that ends without
// settling still reads as live, and re-dispatching it would never terminate.
func TestFirstLiveThreadIDMatchesWalkOrder(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.doc.ensureItems()

	mkThread := func(name string) string {
		threadID, err := w.currentRun().spawnThread(threadSpec{
			Goal:   name,
			Prompt: "task for " + name,
		}, toolSpawn{
			ToolUseID: "tu-" + name,
			ToolName:  "Explore",
			ToolInput: json.RawMessage(`{"prompt":"task"}`),
			Delegated: true,
		})
		if err != nil {
			t.Fatalf("spawnThread(%s): %v", name, err)
		}
		return threadID
	}

	first := mkThread("first")
	second := mkThread("second")

	if id := w.doc.firstLiveThreadID(""); id != first {
		t.Fatalf("firstLiveThreadID = %q, want the document-order first %q", id, first)
	}

	// Excluding a live thread skips past it rather than ending the walk.
	if id := w.doc.firstLiveThreadID(first); id != second {
		t.Fatalf("firstLiveThreadID(excluding %q) = %q, want %q", first, id, second)
	}

	// Settling the first has the same effect as excluding it.
	w.settleThreadRun(first, false)
	if id := w.doc.firstLiveThreadID(""); id != second {
		t.Fatalf("firstLiveThreadID = %q after settling the first, want %q", id, second)
	}

	// Excluding the only remaining live thread leaves no candidate — the case
	// that sends finishStrategyRun down its idle path.
	if id := w.doc.firstLiveThreadID(second); id != "" {
		t.Fatalf("firstLiveThreadID(excluding %q) = %q, want \"\"", second, id)
	}

	w.settleThreadRun(second, false)
	if id := w.doc.firstLiveThreadID(""); id != "" {
		t.Fatalf("firstLiveThreadID = %q after everything settled, want \"\"", id)
	}
	if got := w.doc.liveThreadCount(); got != 0 {
		t.Fatalf("liveThreadCount = %d after settling both, want 0", got)
	}
}
