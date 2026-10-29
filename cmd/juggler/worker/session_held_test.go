//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "testing"

func TestSessionHeldBothRecords(t *testing.T) {
	w := NewConversationWorker("hold", "user:test")
	check := func(want bool) {
		t.Helper()
		if got := w.sessionHeld(); got != want {
			t.Fatalf("sessionHeld = %v, want %v", got, want)
		}
	}
	check(false)
	for _, thread := range []string{"", "child"} {
		if !w.requestLLM(thread) {
			t.Fatal("queued claim refused")
		}
		check(true)
		w.releaseLLM(thread)
		check(false)
		if !w.claimLLM(thread) {
			t.Fatal("LLM claim refused")
		}
		check(true)
		w.releaseLLM(thread)
		check(false)
	}

	// Registry membership covers dispatch before the busy frame, and finalization
	// after the terminal frame. Neither has to carry a document claim.
	tr := w.currentRun().beginTurn("child")
	defer w.sched.releaseActivity()
	check(true)
	for _, state := range []WorkerState{StateProcessing, StateCancelling, StateIdle} {
		tr.storeState(state)
		check(true)
	}
	w.sched.unregister(tr.t)
	check(false)
	w.currentRun().storeState(StateProcessing)
	check(true)
	w.currentRun().storeState(StateIdle)
	check(false)
}
