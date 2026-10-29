//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Mock LLM caller — scripted responses for tests. Compiled only when -tags
// production is NOT set; mock_llm_production.go stands in for it in release
// builds, where no worker can carry a script and callLLM never asks for one.

//go:build !production

package worker

import (
	"encoding/json"
	"fmt"
	"sync/atomic"

	"juggler/cmd/juggler/providers/provider"
	"juggler/internal/jlog"
)

// mockScript is the worker's slot for a script. Installed whole by
// setMockResponses and read by every turn's provider call, so it is atomic.
type mockScript struct {
	caller atomic.Pointer[mockLLMCaller]
}

// mock returns the worker's installed script, or nil when it has none and its
// calls go to the provider.
func (w *ConversationWorker) mock() *mockLLMCaller { return w.script.caller.Load() }

// callScriptedLLM answers a provider call from the worker's script when a test
// has installed one, recording the request it was asked. scripted is false when
// none is, and the call goes to the provider.
func (r *run) callScriptedLLM(request json.RawMessage, turnID string, sink func(StreamChunk)) (scripted bool, response *LLMResponse, err error) {
	if r.mock() == nil {
		return false, nil, nil
	}
	r.mock().recordRequest(request)
	response, err = r.callLLMMockWithSink(turnID, sink)
	return true, response, err
}

// mockLLMCaller holds the scripted-response state for one worker under test.
type mockLLMCaller struct {
	// responses is the script, held as a channel because several of a
	// conversation's turns run at once: a parent and its read-only children each
	// pop from here on their own goroutine, and the queue orders them without a
	// lock. The pointer is swapped wholesale when a test installs a new script.
	responses atomic.Pointer[chan MockResponse]
	// releaseCh unblocks a paused response (MockResponse.PauseBeforeReturn).
	// Buffered so a release sent before the pause is reached is captured.
	releaseCh chan struct{}
	// gate, when installed, holds the delivery goroutine on its way into the
	// pause announcement. One-shot: the goroutine takes it, so a script with
	// several paused responses gates only the first.
	gate atomic.Pointer[announceGate]

	// requests is every request the script was asked to answer, in order, for a
	// test asserting on what a turn sent rather than on what came back. Replaced
	// whole on each append, as several turns may record at once.
	requests atomic.Pointer[[]json.RawMessage]
}

// recordRequest keeps a copy of a request the script is answering.
func (m *mockLLMCaller) recordRequest(request json.RawMessage) {
	kept := append(json.RawMessage(nil), request...)
	for {
		old := m.requests.Load()
		next := []json.RawMessage{kept}
		if old != nil {
			next = append(append([]json.RawMessage(nil), *old...), kept)
		}
		if m.requests.CompareAndSwap(old, &next) {
			return
		}
	}
}

// announceGate stops the delivery goroutine immediately before it announces a
// pause, so a test can place that announcement genuinely beside something it
// does to the turn. The goroutine reports that it has arrived and then waits;
// the test starts the other half and lets this one go, and the two proceed with
// no ordering between them. That is the only arrangement that can honestly ask
// whether the announcement touches state belonging to the turn's goroutine —
// wait for the announcement instead and the wait itself orders the pair, which
// is a different question with a different answer.
type announceGate struct {
	arrived chan struct{}
	release chan struct{}
}

func newMockLLMCaller() *mockLLMCaller {
	m := &mockLLMCaller{releaseCh: make(chan struct{}, 1)}
	m.setResponses(nil)
	return m
}

// setResponses installs a fresh script, forgetting the requests the last one
// answered. Called between turns, never beside one.
func (m *mockLLMCaller) setResponses(r []MockResponse) {
	queue := make(chan MockResponse, len(r)+1)
	for _, response := range r {
		queue <- response
	}
	m.responses.Store(&queue)
	m.requests.Store(nil)
}

// pop takes the next scripted response, reporting how many are left behind it.
func (m *mockLLMCaller) pop() (MockResponse, int, bool) {
	queue := *m.responses.Load()
	select {
	case response := <-queue:
		return response, len(queue), true
	default:
		return MockResponse{}, 0, false
	}
}

// remaining reports how many scripted responses are still queued.
func (m *mockLLMCaller) remaining() int {
	return len(*m.responses.Load())
}

// release signals a paused response to complete. Non-blocking: if the buffer
// is full, an earlier release already covers a pause point that hasn't been
// hit yet. Idempotent.
func (m *mockLLMCaller) release() {
	select {
	case m.releaseCh <- struct{}{}:
	default:
	}
}

// setMockResponses installs a mock caller (creating one on first call) with
// the given scripted responses. Used by tests that build a worker directly.
func (w *ConversationWorker) setMockResponses(r []MockResponse) {
	w.script.caller.CompareAndSwap(nil, newMockLLMCaller())
	w.mock().setResponses(r)
}

// popMockResponse returns and removes the next mock response from the queue,
// delivering it through the same async channel path the real provider uses
// (`queueStreamChunk` for each block, then `turn.responseChan` for the final
// response, all from a worker goroutine; the caller awaits via
// `waitForLLMResponse`). This means a single mock turn produces multiple
// run-loop iterations — exactly like the real Anthropic stream — so reducer
// or observer bugs that require separate event-loop ticks to surface are not
// masked by synchronous delivery.
//
// When PauseBeforeReturn is set, the goroutine streams the chunks, emits a
// "mock-paused" status, and waits for releaseCh before delivering the final
// response. This lets tests inject actions (e.g. cancel) at a deterministic
// moment between stream and return.
func (r *run) popMockResponse(turnID string, sink func(StreamChunk)) (*LLMResponse, error) {
	mock, remaining, ok := r.mock().pop()
	if !ok {
		r.tape.Record("mock-pop", map[string]any{"exhausted": true})
		return nil, fmt.Errorf("mock responses exhausted")
	}

	r.tape.Record("mock-pop", map[string]any{
		"remaining":  remaining,
		"stopReason": mock.StopReason,
		"blocks":     len(mock.Blocks),
	})
	if mock.Panic != "" {
		panic(mock.Panic)
	}

	response := &LLMResponse{
		Blocks:                 mock.Blocks,
		StopReason:             mock.StopReason,
		InputTokens:            mock.InputTokens,
		InputTokensApproximate: mock.InputTokensApproximate,
		OutputTokens:           mock.OutputTokens,
		CachedTokens:           provider.Reported(mock.CachedTokens),
		Error:                  mock.Error,
	}

	paused := mock.PauseBeforeReturn
	// The thread this run writes to, read here on the goroutine that owns it. The
	// goroutine below outlives the turn whenever a cancel lands on a paused
	// response — it stays parked while the turn unwinds and clears the field — so
	// it carries its own copy, the same way liveRunEntry does for everyone else
	// reading a run's thread from off its goroutine.
	threadItemID := r.t.thread.itemID

	go func() {
		for _, block := range mock.Blocks {
			if sink == nil {
				continue
			}
			switch block.Type {
			case provider.ContentBlockTypeText:
				if block.Content != "" {
					sink(StreamChunk{Type: provider.ContentBlockTypeText, Content: block.Content})
				}
			case provider.ContentBlockTypeThinking:
				if block.Thinking != "" {
					sink(StreamChunk{Type: provider.ContentBlockTypeThinking, Content: block.Thinking})
				}
			case provider.ContentBlockTypeToolUse:
				sink(StreamChunk{Type: provider.ContentBlockTypeToolUse})
			}
		}

		if paused {
			if gate := r.mock().gate.Swap(nil); gate != nil {
				close(gate.arrived)
				<-gate.release
			}
			r.announceMockPause(threadItemID)
			select {
			case <-r.mock().releaseCh:
			case <-r.done:
				return
			}
		}

		r.deliverLLMResponse(turnID, response, nil)
	}()

	return r.waitForLLMResponse(turnID, LLMTimeout)
}

// announceMockPause publishes the pause point on the run's own entry, and only
// while that run still holds its claim. Tests watch for it two ways: the browser
// harness's wait-for-mock-paused reads processingState.status, which the
// projection republishes from the entry, and the message goes out on the wire as
// an ordinary status.
//
// Deliberately not sendStatus. This runs on the mock's goroutine while the turn
// is parked in waitForLLMResponse, so it describes a turn it does not own, and a
// status frame is rebuilt from scratch — claim included. A cancel that lands
// first rests that turn and retires it; a frame written here afterwards would
// then put the claim back on a thread with nothing running, leaving the
// conversation busy forever. The gated patch is a no-op once the claim is gone.
//
// threadItemID is passed in rather than read from the run for the same reason:
// off the turn's goroutine, the run's thread field may be being cleared by that
// very cancel.
func (r *run) announceMockPause(threadItemID string) {
	r.patchRunIf(threadItemID,
		entryHoldsClaim,
		func(entry runEntry, _ map[string]any) { entry.setStatus(statusMockPaused) },
	)
	r.send(mockPausedStatus{Type: msgStatus, Status: "mock-paused", Message: ""})
}

// callLLMMock is the mock branch of callLLM. Returns the next scripted
// response, or an error if responses are exhausted.
func (r *run) callLLMMockWithSink(turnID string, sink func(StreamChunk)) (*LLMResponse, error) {
	if r.mock().remaining() > 0 {
		jlog.Info("[callLLM] conv=%s thread=%q mockLeft=%d", r.conversationID, r.t.thread.itemID, r.mock().remaining())
		response, err := r.popMockResponse(turnID, sink)
		if err != nil {
			return nil, err
		}
		// A scripted turn with Error set simulates a provider failure. The
		// non-mock callLLM classifies response.Error after waitForLLMResponse;
		// the mock branch returns early, so it runs the same classifier here.
		// Wrapping the text by hand instead would hand every scripted failure to
		// the turn loop as a bare error, so a scripted rate limit would be the one
		// thing a test of rate limiting could not produce.
		if response.Error != "" {
			return nil, classifyLLMError(response.Error, nil)
		}
		return response, nil
	}
	jlog.Error("[callLLM] conv=%s thread=%q EXHAUSTED", r.conversationID, r.t.thread.itemID)
	return nil, fmt.Errorf("mock responses exhausted - test may have more LLM calls than expected")
}

// mockPausedStatus is the status the mock LLM sends when a scripted test holds
// the turn; unlike StatusMessage it names no thread.
type mockPausedStatus struct {
	Type    wireMsgType `json:"type"` // "status"
	Status  string      `json:"status"`
	Message string      `json:"message"`
}
