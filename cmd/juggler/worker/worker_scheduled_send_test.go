//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"slices"
	"sync/atomic"
	"testing"
	"time"
)

// Held sends over the wire: a send-message carrying a time or a run-end hold is
// queued at intake, and the worker fires it itself — at its time, on an idle
// thread, with or without a client attached.

// fakeClock stands in for the worker's clock. The test sets the time, and every
// timer the worker arms is handed to the test to fire.
type fakeClock struct {
	ms   atomic.Int64 // the time, in epoch milliseconds
	arms chan *fakeTimer
}

// fakeTimer is one timer the worker armed: the moment it is due, and the
// channel the worker waits on.
type fakeTimer struct {
	at      time.Time
	c       chan time.Time
	stopped atomic.Bool
}

// fakeEpoch is a whole-second instant, so every time built from it survives the
// epoch-millisecond round trip a notBefore makes.
var fakeEpoch = time.UnixMilli(1_800_000_000_000)

func newFakeClock() *fakeClock {
	f := &fakeClock{arms: make(chan *fakeTimer, 64)}
	f.set(fakeEpoch)
	return f
}

func (f *fakeClock) now() time.Time { return time.UnixMilli(f.ms.Load()) }

func (f *fakeClock) set(t time.Time) { f.ms.Store(t.UnixMilli()) }

// install gives the worker this clock. Before the worker runs.
func (f *fakeClock) install(w *ConversationWorker) {
	w.clock = workerClock{
		now: f.now,
		newTimer: func(d time.Duration) (<-chan time.Time, func() bool) {
			ft := &fakeTimer{at: f.now().Add(d), c: make(chan time.Time, 1)}
			f.arms <- ft
			return ft.c, func() bool { return !ft.stopped.Swap(true) }
		},
	}
}

// awaitArm waits for the worker to arm a live timer due at at, and returns it.
// Timers armed for any other moment, or since stopped, are passed over.
func (f *fakeClock) awaitArm(t *testing.T, at time.Time) *fakeTimer {
	t.Helper()
	deadline := time.After(quiesceTimeout)
	for {
		select {
		case ft := <-f.arms:
			if !ft.stopped.Load() && ft.at.Equal(at) {
				return ft
			}
		case <-deadline:
			t.Fatalf("the worker never armed a timer for %v", at.Sub(fakeEpoch))
			return nil
		}
	}
}

// fire moves the clock to the timer's moment and fires it.
func (f *fakeClock) fire(ft *fakeTimer) {
	f.set(ft.at)
	ft.c <- ft.at
}

// noArmFor reports whether no live timer due at at is waiting, without blocking.
func (f *fakeClock) noArmFor(at time.Time) bool {
	for {
		select {
		case ft := <-f.arms:
			if !ft.stopped.Load() && ft.at.Equal(at) {
				return false
			}
		default:
			return true
		}
	}
}

// transcript lists the root items as type:content.
func transcript(w *ConversationWorker) []string {
	var out []string
	for _, it := range w.doc.GetItems() {
		out = append(out, it.Type+":"+it.Content)
	}
	return out
}

// awaitTranscript waits for a running worker's root transcript to read want.
func awaitTranscript(t *testing.T, w *ConversationWorker, want []string) {
	t.Helper()
	deadline := time.Now().Add(quiesceTimeout)
	for {
		got := transcript(w)
		if slices.Equal(got, want) {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("transcript = %q, want %q", got, want)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

func sendFromClient(t *testing.T, w *ConversationWorker, msg SendMessageMessage) {
	t.Helper()
	msg.Type = "send-message"
	payload, err := json.Marshal(msg)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	w.SendFromClient("client-A", "send-message", payload)
}

// idleWorkerOn returns a never-started worker on fc with a model configured and
// the test goroutine as its actor, for the synchronous driver.
func idleWorkerOn(t *testing.T, convID string, fc *fakeClock) *ConversationWorker {
	t.Helper()
	w := NewConversationWorker(convID, "user:test")
	t.Cleanup(func() { w.doc.Destroy() })
	fc.install(w)
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.actor.bind()
	return w
}

// seedCompletedToolBatch leaves the root mid-run: a tool batch has completed and
// the thread awaits the turn that answers it.
func seedCompletedToolBatch(w *ConversationWorker) {
	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "run bash", TransactionID: "txn-0", Timestamp: fakeEpoch.Format(time.RFC3339),
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeAssistant, ItemID: "a-1", Content: "I'll run that.", TransactionID: "txn-0", Timestamp: fakeEpoch.Format(time.RFC3339),
	})
	w.doc.InsertMessage(2, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "tu-1", ToolName: "bash", State: StateCompleted,
		Result: resultJSON("ok"), TransactionID: "txn-0",
	})
	w.doc.SetMetadata("processingState", map[string]any{
		"activity": ActivityAwaitingLLM, "threadItemId": "", "status": "processing_tools",
	})
}

// TestHeldSendLeavesARetryBackoffAlone: an untimed send cuts a retry backoff
// short, because it supersedes the request being retried. A held send asks for
// nothing now, so the backoff runs on.
func TestHeldSendLeavesARetryBackoffAlone(t *testing.T) {
	fc := newFakeClock()
	w := idleWorkerOn(t, "conv-held-backoff", fc)
	if !w.currentRun().claimLLM("") {
		t.Fatal("could not claim the root")
	}
	tr := w.ownedRun(t)
	tr.storeState(StateProcessing)
	tr.t.retryWaiting.Store(true)

	sendMsg(t, w, SendMessageMessage{Type: "send-message", Text: "later", NotBefore: fakeEpoch.Add(time.Hour).UnixMilli()})
	sendMsg(t, w, SendMessageMessage{Type: "send-message", Text: "after the run", Hold: pendingHoldRunEnd})
	if n := len(tr.t.interject); n != 0 {
		t.Fatalf("a held send woke the retry backoff")
	}
	requireLabels(t, "queue", queuedLabels(t, w, ""), []string{"later", "after the run"})

	sendMsg(t, w, SendMessageMessage{Type: "send-message", Text: "now"})
	if n := len(tr.t.interject); n != 1 {
		t.Fatalf("an untimed send did not wake the retry backoff; the probe proves nothing")
	}
}
