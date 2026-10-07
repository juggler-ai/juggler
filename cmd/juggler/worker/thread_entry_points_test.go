//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"testing"
)

// threadFlags reads the origin flags stamped on a thread's Y.Map.
func threadFlags(t *testing.T, w *ConversationWorker, threadItemID string) (llmCreated, strategyCreated bool) {
	t.Helper()
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	m := findThreadYMap(w.doc.getItems(), threadItemID)
	if m == nil {
		t.Fatalf("thread %s not found", threadItemID)
	}
	llmCreated, _ = m.Get("llmCreated").(bool)
	strategyCreated, _ = m.Get("strategyCreated").(bool)
	return llmCreated, strategyCreated
}

// TestThreadEntryPointsKeepTheirOwnPolicy pins what separates the two ways a
// thread is opened, which threadSpec/toolSpawn and the two entry points keep
// apart: a spawn is stamped llmCreated and opens even while a run is live (it is
// made from inside one), while a dispatch is stamped strategyCreated and refuses
// a busy conversation or one with no model.
func TestThreadEntryPointsKeepTheirOwnPolicy(t *testing.T) {
	t.Run("spawn", func(t *testing.T) {
		var calls []autoNameCall
		w := newDispatchWorker(t, "conv-spawn-origin", &calls)
		w.currentRun().storeState(StateProcessing)

		id, err := w.currentRun().spawnThread(threadSpec{Goal: "child", Prompt: "work"}, toolSpawn{})
		if err != nil {
			t.Fatalf("spawnThread during a live run: %v", err)
		}
		if llm, strategy := threadFlags(t, w, id); !llm || strategy {
			t.Fatalf("spawned thread flags llmCreated=%v strategyCreated=%v, want true/false", llm, strategy)
		}
	})

	t.Run("dispatch", func(t *testing.T) {
		var calls []autoNameCall
		w := newDispatchWorker(t, "conv-dispatch-origin", &calls)

		id, err := w.currentRun().dispatchThread(threadSpec{Goal: "child", Prompt: "work"})
		if err != nil {
			t.Fatalf("dispatchThread: %v", err)
		}
		if llm, strategy := threadFlags(t, w, id); llm || !strategy {
			t.Fatalf("dispatched thread flags llmCreated=%v strategyCreated=%v, want false/true", llm, strategy)
		}
		w.quiesce(t)
	})

	t.Run("dispatch refuses a busy conversation", func(t *testing.T) {
		var calls []autoNameCall
		w := newDispatchWorker(t, "conv-dispatch-busy", &calls)
		w.currentRun().storeState(StateProcessing)

		if _, err := w.currentRun().dispatchThread(threadSpec{Goal: "child", Prompt: "work"}); err == nil {
			t.Fatal("dispatchThread opened a thread while a run was live")
		}
	})

	t.Run("dispatch refuses with no model", func(t *testing.T) {
		w := NewConversationWorker("conv-dispatch-no-model", "user:test")
		t.Cleanup(func() { w.doc.Destroy() })
		w.doc.ensureItems()

		if _, err := w.currentRun().dispatchThread(threadSpec{Goal: "child", Prompt: "work"}); err == nil {
			t.Fatal("dispatchThread opened a thread with no model to run it")
		}
	})
}
