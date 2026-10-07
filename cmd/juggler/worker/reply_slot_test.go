//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
	"time"
)

// TestEveryReplySlotRoutesConcurrentRequestsByID walks every request/reply kind
// and proves that two outstanding requests remain independent. The first answer
// per id wins; unknown, malformed, duplicate, and late answers go nowhere.
func TestEveryReplySlotRoutesConcurrentRequestsByID(t *testing.T) {
	w := NewConversationWorker("conv-slots", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	if len(w.engine.replySlots()) == 0 {
		t.Fatal("the worker registered no reply slots; this test would pass by vacuum")
	}

	for _, slot := range w.engine.replySlots() {
		t.Run(slot.name, func(t *testing.T) {
			answer := func(requestID, client string) json.RawMessage {
				payload, _ := json.Marshal(map[string]any{
					"requestId": requestID,
					"answers":   slot.name,
					"client":    client,
				})
				return payload
			}

			first, unregisterFirst := slot.register("req-1")
			defer unregisterFirst()
			second, unregisterSecond := slot.register("req-2")
			defer unregisterSecond()

			slot.deliver(answer("unknown", "client"))
			slot.deliver(json.RawMessage(`{"result":"no id here"}`))
			if slot.held() != 0 {
				t.Fatal("accepted a reply that names no outstanding request")
			}

			// Deliver in the opposite order to registration. Each waiter must get
			// only its own answer, never whichever payload happened to arrive first.
			slot.deliver(answer("req-2", "first-client"))
			slot.deliver(answer("req-1", "first-client"))
			if got := requestIDFromReply(t, <-first); got != "req-1" {
				t.Fatalf("first waiter received %q, want req-1", got)
			}
			if got := requestIDFromReply(t, <-second); got != "req-2" {
				t.Fatalf("second waiter received %q, want req-2", got)
			}

			slot.deliver(answer("req-1", "second-client"))
			slot.deliver(answer("req-2", "second-client"))
			if slot.held() != 0 {
				t.Fatal("accepted a duplicate after the request's first answer")
			}

			unregisterFirst()
			slot.deliver(answer("req-1", "late-client"))
			if slot.held() != 0 {
				t.Fatal("accepted a reply after its round-trip ended")
			}
		})
	}
}

// TestInjectQueuesAtMostOneUnclaimedReply proves the test-only inject applies
// backpressure. Feeder harnesses call it in an unbounded loop; if a slot accepted
// every injection while nothing registered, each feeder would spin and grow the
// queue until the worker closed, which most tests never do.
func TestInjectQueuesAtMostOneUnclaimedReply(t *testing.T) {
	w := NewConversationWorker("conv-inject-bound", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })
	abort := make(chan struct{})
	t.Cleanup(func() { close(abort) })

	slot := w.engine.contextReply
	accepted := make(chan struct{}, 100)
	go func() {
		for i := 0; i < cap(accepted); i++ {
			if !slot.inject(abort, json.RawMessage(`{"requestId":"injected"}`)) {
				return
			}
			accepted <- struct{}{}
		}
	}()

	waitAccepted := func(want int) {
		t.Helper()
		deadline := time.After(5 * time.Second)
		for len(accepted) < want {
			select {
			case <-deadline:
				t.Fatalf("inject accepted %d replies, want %d", len(accepted), want)
			case <-time.After(time.Millisecond):
			}
		}
		// Give an unbounded slot ample opportunity to accept more than it should.
		time.Sleep(100 * time.Millisecond)
		if got := len(accepted); got != want {
			t.Fatalf("inject accepted %d replies, want %d", got, want)
		}
	}

	waitAccepted(1)

	response, unregister := slot.register("req-1")
	defer unregister()
	select {
	case <-response:
	case <-time.After(5 * time.Second):
		t.Fatal("the registration never received the queued injection")
	}
	waitAccepted(2)
}

func requestIDFromReply(t *testing.T, payload json.RawMessage) string {
	t.Helper()
	var head struct {
		RequestID string `json:"requestId"`
	}
	if err := json.Unmarshal(payload, &head); err != nil {
		t.Fatalf("unmarshal reply: %v", err)
	}
	return head.RequestID
}
