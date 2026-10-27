//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"
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
// request-tools is broadcast (w.send → callbacks.broadcast), but only the engine
// answers it (handleRequestTools in web/js/services/worker-manager-protocols.js
// returns early in every other realm). A reply can still reach a turn that is
// not waiting for it: the answer to a turn that already ended — it missed
// ContextTimeout, or was cancelled — or a second answer to the same request
// from an engine that reconnected while it was in flight. The slot holds one,
// so a late reply left sitting in it is taken instantly by the next turn's
// wait — and with the slot then full, that turn's OWN reply is dropped.
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

	// A second reply to turn 1's request, landing after that turn was already
	// answered.
	sendToolsReply(w, <-requestIDs, "turn-1")

	if got := offeredToolName(t, w); got != "turn-2" {
		t.Fatalf("turn 2 was offered %q: a late reply to turn 1's request won the cap-1 slot, and turn 2's own reply was dropped", got)
	}
}

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

// TestToolsReplyForAnotherRequestIsIgnored covers the same hazard one beat
// earlier — the duplicate arrives while the next turn is already waiting. No
// amount of clearing state between turns catches that one; only matching a reply
// against the request it answers does.
func TestToolsReplyForAnotherRequestIsIgnored(t *testing.T) {
	w, _ := newToolsRequestHarness(t, func(w *ConversationWorker, turn int, requestID string) {
		if turn == 2 {
			// An answer to turn 1, a moment too late.
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

// shrinkContextWait sets the context wait's check interval and ceiling on one
// worker.
func shrinkContextWait(w *ConversationWorker, window, ceiling time.Duration) {
	w.contextCheck, w.contextCeiling = window, ceiling
}

// TestContextWaitOutlastsItsWindowWhileTheEngineIsAttached pins what bounds a
// turn's wait for its context and tools: the engine it asked going away, not a
// fixed span of wall time. An engine on a slow core is still building the
// answer when any span picked on a fast one runs out, and failing the turn
// then reports "context/tools request timed out" for an engine that was about
// to answer. The reply here lands six windows late, from an engine attached
// throughout.
func TestContextWaitOutlastsItsWindowWhileTheEngineIsAttached(t *testing.T) {
	const window = 50 * time.Millisecond
	w, _ := newToolsRequestHarness(t, func(w *ConversationWorker, _ int, requestID string) {
		// Off the callback goroutine: the wait asks that goroutine which
		// engine is attached, so blocking it here would deadlock the test.
		time.AfterFunc(6*window, func() { sendToolsReply(w, requestID, "slow-engine-tool") })
	})
	shrinkContextWait(w, window, time.Minute)
	if got := offeredToolName(t, w); got != "slow-engine-tool" {
		t.Fatalf("offered %q, want the slow engine's answer", got)
	}
}

// TestContextWaitFailsWhenTheEngineAskedGoesAway is the other half: an engine
// that detaches can never answer a request sent before, so the turn fails at
// the next check and says why, rather than waiting out the ceiling.
func TestContextWaitFailsWhenTheEngineAskedGoesAway(t *testing.T) {
	w, _ := newToolsRequestHarness(t, func(w *ConversationWorker, _ int, _ string) {
		go w.SetEngineClientID("")
	})
	shrinkContextWait(w, 20*time.Millisecond, time.Minute)
	started := time.Now()
	_, _, err := w.currentRun().requestContextAndToolsForItemIDs(nil)
	if err == nil || !strings.Contains(err.Error(), "no longer attached") {
		t.Fatalf("want a failure naming the engine that went away, got %v", err)
	}
	if elapsed := time.Since(started); elapsed > 30*time.Second {
		t.Fatalf("the departed engine was waited on for %s; it can never answer", elapsed)
	}
}

// TestContextWaitHasACeilingForAnEngineThatNeverAnswers bounds the case
// liveness cannot: an engine that stays attached and never answers this
// request. The failure says the engine was still there, which points at the
// lost request rather than at the link.
func TestContextWaitHasACeilingForAnEngineThatNeverAnswers(t *testing.T) {
	w, _ := newToolsRequestHarness(t, func(*ConversationWorker, int, string) {})
	shrinkContextWait(w, 20*time.Millisecond, 200*time.Millisecond)
	_, _, err := w.currentRun().requestContextAndToolsForItemIDs(nil)
	if err == nil || !strings.Contains(err.Error(), "still attached") || !strings.Contains(err.Error(), "tools") {
		t.Fatalf("want a ceiling failure naming the attached engine and the missing half, got %v", err)
	}
}
