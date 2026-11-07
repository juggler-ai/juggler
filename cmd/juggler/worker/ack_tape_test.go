//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
	"time"
)

// An ack the worker sends is on its tape. The viewer's tape has the request
// leaving and the ack arriving; this is the moment between, and without it a
// client's ack timeout cannot say whether the worker answered late, answered
// someone else, or never answered at all.
func TestAnAckIsOnTheTape(t *testing.T) {
	enableEventTape(t)
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	w.handleClearUndoStacks(json.RawMessage(`{"ackId":"wm_test_ack_1"}`))

	sent := tapeEventsOfKind(w.tape.DumpAll(), "ack-sent")
	if len(sent) != 1 {
		t.Fatalf("the tape holds %d ack-sent events, want 1", len(sent))
	}
	if got := sent[0].Summary["ackId"]; got != "wm_test_ack_1" {
		t.Errorf("ack-sent names ackId %v, want wm_test_ack_1", got)
	}
}

// A test message reaching its handler is on the tape too, with how long it
// queued in the inbox — the rest of a late setup ack's story.
func TestATestMessageReachingItsHandlerIsOnTheTape(t *testing.T) {
	enableEventTape(t)
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	w.handleTestMessage(workerMessage{
		Type:       "set-mock-responses",
		Payload:    json.RawMessage(`{"responses":[],"ackId":"wm_test_ack_2"}`),
		EnqueuedAt: time.Now().Add(-1500 * time.Millisecond),
	})

	handled := tapeEventsOfKind(w.tape.DumpAll(), "test-msg-handled")
	if len(handled) != 1 {
		t.Fatalf("the tape holds %d test-msg-handled events, want 1", len(handled))
	}
	if got := handled[0].Summary["type"]; got != "set-mock-responses" {
		t.Errorf("test-msg-handled names type %v, want set-mock-responses", got)
	}
	var ms float64
	switch v := handled[0].Summary["inboxMs"].(type) {
	case int64:
		ms = float64(v)
	case float64:
		ms = v
	}
	if ms < 1500 {
		t.Errorf("test-msg-handled inboxMs = %v, want at least 1500", handled[0].Summary["inboxMs"])
	}
}

// Every test message that acks puts its ack on the tape, so a late setup ack
// has both halves: the message reaching its handler, and the answer leaving.
func TestATestMessagesAckIsOnTheTape(t *testing.T) {
	for _, typ := range []string{"set-mock-responses", "queue-mocks-for-name", "ping", "get-yjs-state"} {
		t.Run(typ, func(t *testing.T) {
			enableEventTape(t)
			w := NewConversationWorker("test-conv", "user:test")
			defer w.doc.Destroy()

			w.handleTestMessage(workerMessage{
				Type:    typ,
				Payload: json.RawMessage(`{"responses":[],"name":"n","ackId":"wm_test_ack_3"}`),
			})

			sent := tapeEventsOfKind(w.tape.DumpAll(), "ack-sent")
			if len(sent) != 1 {
				t.Fatalf("the tape holds %d ack-sent events, want 1", len(sent))
			}
			if got := sent[0].Summary["ackId"]; got != "wm_test_ack_3" {
				t.Errorf("ack-sent names ackId %v, want wm_test_ack_3", got)
			}
		})
	}
}
