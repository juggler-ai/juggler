//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside retirement_test.go that need a test-capable build: they
// read the queue through hasPendingItems.

import (
	"encoding/json"
	"testing"
	"time"
)

// A probe is behind accepted inbox messages even when the actor has not begun
// processing them. A future scheduled send lands in the queue but holds no turn.
func TestRetireProbeOrdersAcceptedInbox(t *testing.T) {
	w := NewConversationWorker("fifo", "user:test")
	init, err := json.Marshal(InitMessage{Conversation: SerializedConversation{ID: "fifo", ModelConfig: testModel}})
	if err != nil {
		t.Fatal(err)
	}
	send, err := json.Marshal(SendMessageMessage{Text: "accepted", NotBefore: time.Now().Add(time.Hour).UnixMilli()})
	if err != nil {
		t.Fatal(err)
	}
	w.Send("init", init)
	w.Send("send-message", send)
	if w.sessionHeld() {
		t.Fatal("fixture already has a claim or live turn before actor startup")
	}
	decision := &retirementDecision{done: make(chan struct{})}
	p := &workerProbe{answer: make(chan bool, 1), decision: decision}
	w.inbox.push(workerMessage{Probe: p})
	w.Start(t.Context())
	defer w.Stop()
	defer close(decision.done)
	select {
	case held := <-p.answer:
		if held {
			t.Error("FIFO probe counted a future scheduled send as held work")
		}
	case <-t.Context().Done():
		t.Fatal("probe never answered")
	}
	if !w.hasPendingItems("") {
		t.Error("send-message did not land ahead of probe")
	}
}

func TestRetireScheduledSendOnlyHoldsWhenDue(t *testing.T) {
	for _, due := range []bool{false, true} {
		name := "future"
		if due {
			name = "due"
		}
		t.Run(name, func(t *testing.T) {
			fc := newFakeClock()
			at := fakeEpoch.Add(time.Hour)
			m := newManager(func(w *ConversationWorker) {
				fc.install(w)
				if _, _, ok := w.enqueueHeldSend("", UserMessageInput{Text: "scheduled"}, nil, pendingHold{NotBefore: at}); !ok {
					panic("failed to queue scheduled fixture")
				}
			})
			defer m.Shutdown()
			w := m.GetOrCreate("scheduled", "user:test")
			fc.awaitArm(t, at)
			if due {
				// Advance time without firing the timer: the FIFO probe must see
				// promotable work even before the timer has dispatched it.
				fc.set(at)
			}
			if w.sessionHeld() {
				t.Fatal("fixture has a claim or live turn; this case must exercise pending work alone")
			}
			if accepted, err := m.TryRetire(); err != nil || accepted == due {
				t.Errorf("TryRetire = %v, %v; want accepted=%v", accepted, err, !due)
			}
			if !w.hasPendingItems("") {
				t.Error("probe consumed the scheduled send")
			}
			if admitted := m.HandleMessage("scheduled", "stop-undo-capturing", nil, nil); admitted != due {
				t.Errorf("admission after retirement = %v, want %v", admitted, due)
			}
			if due {
				if err := w.SendAndWait(t.Context(), "stop-undo-capturing", nil); err != nil {
					t.Fatal(err)
				}
			}
		})
	}
}
