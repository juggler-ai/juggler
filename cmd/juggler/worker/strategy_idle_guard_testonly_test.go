//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside strategy_idle_guard_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

func newIdleGuardWorld(t *testing.T, replyFor func(threadID string) string) *idleGuardWorld {
	t.Helper()
	w := NewConversationWorker("test-conv", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })
	initPayload, _ := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: "test-conv"},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	w.currentRun().handleInit(initPayload)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.SetCallback("engine", func([]byte) {})
	w.SetEngineClientID("engine")
	// Answer the worker's context/tools round-trips continuously, as the real
	// engine does — without this every dispatched turn parks in its reply slot
	// and the test hangs.
	feedCompactionContextAndTools(w, ToolDefinition{Name: "bash"})

	world := &idleGuardWorld{t: t, w: w, entered: make(chan string, 8), replyFor: replyFor}
	w.SetLLMCaller(func(_ context.Context, raw json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		// The production request is a map (llm_request.go), so pull the thread id
		// out of the wire shape rather than a struct.
		var req struct {
			ThreadID string `json:"threadId"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Errorf("unmarshal request: %v", err)
			return nil, err
		}
		world.entered <- req.ThreadID
		return &LLMResponse{
			Blocks:     []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: replyFor(req.ThreadID)}},
			StopReason: "end_turn",
		}, nil
	})
	return world
}

// TestFinishStrategyRunWithholdsIdleWhileSiblingRuns is the regression shape: a
// non-llmCreated child's run ends while an llmCreated sibling's run is still
// open. Publishing a resting idle at that boundary is a lie the document's
// readers act on — isTurnActive() reads exactly that field, so a turn-end
// scheduled send fires on it — and the sibling's dispatch only follows on the
// next reconcile tick, which no user event has to hurry along. The guard hands
// the claim to the open sibling instead, so the published status stays busy
// across the boundary and the resting idle comes from the LAST run's
// finishStrategyRun.
func TestFinishStrategyRunWithholdsIdleWhileSiblingRuns(t *testing.T) {
	var openThread string
	releaseSibling := make(chan struct{})
	world := newIdleGuardWorld(t, func(threadID string) string {
		if threadID == openThread {
			<-releaseSibling // hold the sibling's turn mid-flight
			return "sibling done"
		}
		return "done"
	})

	// Create the llm sibling first: spawnThread stamps it and (unlike
	// dispatchThread) returns without dispatching, because its run is driven by
	// the parent's park rather than an explicit request.
	openThread = world.llmThread("sibling")
	if got := world.w.doc.liveThreadCount(); got != 1 {
		t.Fatalf("liveThreadCount = %d with the sibling open, want 1", got)
	}

	// The user child's dispatch cascade (turn → finish → guard → sibling turn)
	// is served by the actor, so run the actor on a goroutine of its own and
	// observe the boundary from this one while the cascade is parked mid-sibling.
	// Only document state is read from here, which is safe beside it.
	world.userThread("user child")
	cascade := make(chan struct{})
	go func() {
		defer close(cascade)
		world.w.quiesce(t)
	}()

	// The user child's turn fires first, inside the createThread cascade; the
	// guard then hands the claim to the sibling, whose turn is parked in
	// replyFor. Both entries are observed here.
	world.waitAnyEntered()
	world.waitEntered(openThread)

	// The user child's run has ended and the sibling's is mid-flight. Across that
	// whole boundary the published status must never read idle — that is the
	// window the scheduled send fires on.
	if s := world.status(); s == "" || s == "idle" {
		t.Fatalf("status = %q while the sibling run is mid-flight, want a busy status", s)
	}
	if got := world.w.doc.liveThreadCount(); got != 1 {
		t.Fatalf("liveThreadCount = %d while the sibling runs, want 1", got)
	}

	// Release the sibling; its answer flows back, the parent's post-handback turn
	// runs, and only then does the resting idle land.
	close(releaseSibling)
	select {
	case <-cascade:
	case <-time.After(idleGuardTimeout):
		t.Fatal("timed out waiting for the cascade to finish")
	}
	if s := world.status(); s != "idle" {
		t.Fatalf("status = %q after every run settled, want idle", s)
	}
	if got := world.w.doc.liveThreadCount(); got != 0 {
		t.Fatalf("liveThreadCount = %d after everything settled, want 0", got)
	}
}

// TestFinishStrategyRunRestsAtIdleWithNoOpenRuns pins the complement: the guard
// must never swallow the resting idle. With nothing else in flight, a completed
// run's finishStrategyRun publishes idle immediately.
func TestFinishStrategyRunRestsAtIdleWithNoOpenRuns(t *testing.T) {
	world := newIdleGuardWorld(t, func(string) string { return "all done" })

	// dispatchThread asks for the reducer pass that starts the run; with no
	// sibling to hold open, quiescing the actor returns once it has rested.
	world.userThread("solo child")
	world.w.quiesce(t)

	if s := world.status(); s != "idle" {
		t.Fatalf("status = %q after the only run settled, want idle", s)
	}
}
