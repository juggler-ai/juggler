//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"testing"
)

// newToolsRequestHarness wires a worker whose client answers every request-tools
// the way a real one does: through handleToolsResult, from a goroutine that is
// not the one waiting. Most worker tests inject straight into the slot, but the
// correlation these tests pin lives in that handler, so it is the one thing that
// must not be bypassed.
//
// respond is called once per request-tools with the 1-based turn number and that
// request's id. It runs on the callback registry's goroutine, which serialises
// callbacks, so the turn counter needs no guarding. The returned channel carries
// each request's id for a test that needs to answer one a second time.
func newToolsRequestHarness(t *testing.T, respond func(w *ConversationWorker, turn int, requestID string)) (*ConversationWorker, <-chan string) {
	t.Helper()
	w := NewConversationWorker("conv-tools", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	initPayload, _ := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: "conv-tools"},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	w.currentRun().handleInit(initPayload)
	w.currentRun().storeState(StateProcessing)

	requestIDs := make(chan string, 8)
	turn := 0
	w.SetCallback("engine", func(b []byte) {
		var head struct {
			Type      string `json:"type"`
			RequestID string `json:"requestId"`
		}
		if json.Unmarshal(b, &head) != nil || head.Type != "request-tools" {
			return
		}
		turn++
		requestIDs <- head.RequestID
		respond(w, turn, head.RequestID)
	})
	w.SetEngineClientID("engine")
	return w, requestIDs
}

// sendToolsReply delivers a tools-result carrying a single tool named for the
// turn it answers, so a list consumed by the wrong turn is visible by name.
// This is the door the run loop puts an inbound tools-result through, and it is
// called from the callback registry's goroutine — the same shape production has,
// where the loop dispatches the reply while the turn waits on its own goroutine.
// Replies are handed over in the order they are sent.
func sendToolsReply(w *ConversationWorker, requestID, toolName string) {
	payload, _ := json.Marshal(ToolsResultMessage{
		Type:      "tools-result",
		RequestID: requestID,
		Tools:     []ToolDefinition{{Name: toolName, Category: "read"}},
	})
	w.handleToolsResult(payload)
}

// offeredToolName runs one context/tools round-trip with no context items (so
// only the tools half is awaited) and returns the single tool it was offered.
func offeredToolName(t *testing.T, w *ConversationWorker) string {
	t.Helper()
	_, tools, err := w.currentRun().requestContextAndToolsForItemIDs(nil)
	if err != nil {
		t.Fatalf("requestContextAndToolsForItemIDs: %v", err)
	}
	if len(tools) != 1 {
		t.Fatalf("got %d tools, want exactly 1", len(tools))
	}
	return tools[0].Name
}

func TestContextAndToolsUseTurnThreadNotProcessingState(t *testing.T) {
	threadIDs := make(chan string, 1)
	w, _ := newToolsRequestHarness(t, func(w *ConversationWorker, _ int, requestID string) {
		sendToolsReply(w, requestID, "turn-tool")
	})
	w.SetCallback("thread-observer", func(b []byte) {
		var request struct {
			Type         string `json:"type"`
			ThreadItemID string `json:"threadItemId"`
		}
		if json.Unmarshal(b, &request) == nil && request.Type == "request-tools" {
			threadIDs <- request.ThreadItemID
		}
	})
	w.turn.thread.itemID = "turn-thread"
	w.doc.SetMetadata("processingState", map[string]any{"threadItemId": "other-thread"})

	if _, _, err := w.currentRun().requestContextAndTools(); err != nil {
		t.Fatalf("requestContextAndTools: %v", err)
	}
	if got := <-threadIDs; got != "turn-thread" {
		t.Fatalf("request-tools threadItemId = %q, want turn thread", got)
	}
}

// TestLateToolsReplyIsNotServedToTheNextTurn pins the correlation that keeps one
// turn's tool list out of the next turn's request.
//
// request-tools is broadcast (w.send → callbacks.broadcast), so every connected
// client answers it: one reply is consumed by the turn that asked and the rest
// arrive late. The slot holds one, so a late reply left sitting in it is
// taken instantly by the next turn's wait — and with the slot then full, that
// turn's OWN reply is dropped.
//
// The cost is not academic. Each turn's list is filtered through the strategy of
// the thread it belongs to, so consecutive turns on different threads are
// offered different lists: a root turn following a sub-agent's inherits the
// sub-agent's filtered list, losing the write tools and the sub-agent tools with
// it. A missing delegating tool is absent from turn.delegatingTools, so every
// call to one skips delegation and fails.
func TestLateToolsReplyIsNotServedToTheNextTurn(t *testing.T) {
	w, requestIDs := newToolsRequestHarness(t, func(w *ConversationWorker, turn int, requestID string) {
		sendToolsReply(w, requestID, fmt.Sprintf("turn-%d", turn))
	})

	if got := offeredToolName(t, w); got != "turn-1" {
		t.Fatalf("turn 1 was offered %q, want turn-1", got)
	}

	// A second client's reply to turn 1's request, landing after that turn was
	// already answered — the ordinary case, since every client answers.
	sendToolsReply(w, <-requestIDs, "turn-1")

	if got := offeredToolName(t, w); got != "turn-2" {
		t.Fatalf("turn 2 was offered %q: a late reply to turn 1's request won the cap-1 slot, and turn 2's own reply was dropped", got)
	}
}

// TestOnlyOneToolsReplyPerRequestIsAccepted pins the invariant behind the two
// tests above, in the one case their timing cannot reach deterministically: a
// second client's answer to the request still in flight, arriving after this
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

// TestToolsReplyForAnotherRequestIsIgnored covers the same hazard one beat
// earlier — the duplicate arrives while the next turn is already waiting. No
// amount of clearing state between turns catches that one; only matching a reply
// against the request it answers does.
func TestToolsReplyForAnotherRequestIsIgnored(t *testing.T) {
	w, _ := newToolsRequestHarness(t, func(w *ConversationWorker, turn int, requestID string) {
		if turn == 2 {
			// A peer answering turn 1, a moment too late.
			sendToolsReply(w, "request-from-an-earlier-turn", "turn-1")
		}
		sendToolsReply(w, requestID, fmt.Sprintf("turn-%d", turn))
	})

	if got := offeredToolName(t, w); got != "turn-1" {
		t.Fatalf("turn 1 was offered %q, want turn-1", got)
	}
	if got := offeredToolName(t, w); got != "turn-2" {
		t.Fatalf("turn 2 was offered %q: a reply to an earlier request was accepted as this turn's tool list", got)
	}
}
