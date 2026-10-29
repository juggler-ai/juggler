//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside tools_request_correlation_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"encoding/json"
	"testing"
)

// TestOnlyOneToolsReplyPerRequestIsAccepted pins the invariant behind the two
// tests above, in the one case their timing cannot reach deterministically: a
// second answer to the request still in flight, arriving after this
// turn has taken its answer. Both replies are valid answers to the current
// request, so no requestId check can tell them apart — what makes the second one
// wrong is only that the first was already accepted. Left unrefused it sits in
// the channel as the next turn's tool list.
//
// Driven at the handler rather than through a turn because which of the two the
// wait loop reaches first is a select race, and a test that reproduces a bug
// half the time cannot show it fixed.
func TestOnlyOneToolsReplyPerRequestIsAccepted(t *testing.T) {
	w := NewConversationWorker("conv-tools-one", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	toolsResult := func(toolName string) json.RawMessage {
		payload, _ := json.Marshal(ToolsResultMessage{
			Type:      "tools-result",
			RequestID: "the-in-flight-request",
			Tools:     []ToolDefinition{{Name: toolName, Category: "read"}},
		})
		return payload
	}

	reply, unregister := w.engine.toolsReply.register("the-in-flight-request")
	defer unregister()
	w.handleToolsResult(toolsResult("first-client"))
	if w.engine.toolsReply.held() != 1 {
		t.Fatal("the first answer to the in-flight request must be accepted")
	}
	<-reply // the turn reads its answer

	w.handleToolsResult(toolsResult("second-client"))

	select {
	case leftover := <-reply:
		t.Fatalf("a second answer to the same request was accepted (%s); the next turn would read it as its own tool list", leftover)
	default:
	}
}
