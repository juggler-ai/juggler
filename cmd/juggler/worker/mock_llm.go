//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Mock LLM caller — scripted responses for tests, never present in
// production paths. callLLM picks the mock branch iff w.mock != nil.

package worker

import (
	"fmt"

	provider "juggler/cmd/juggler/providers/registry"
	"juggler/internal/jlog"
)

// mockLLMCaller holds the scripted-response state for one worker under test.
// A non-nil pointer on the worker is the mock-mode signal; nil means production.
type mockLLMCaller struct {
	responses []MockResponse
	// releaseCh unblocks a paused response (MockResponse.PauseBeforeReturn).
	// Buffered so a release sent before the pause is reached is captured.
	releaseCh chan struct{}
}

func newMockLLMCaller() *mockLLMCaller {
	return &mockLLMCaller{releaseCh: make(chan struct{}, 1)}
}

func (m *mockLLMCaller) setResponses(r []MockResponse) {
	m.responses = r
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
	if w.mock == nil {
		w.mock = newMockLLMCaller()
	}
	w.mock.setResponses(r)
}

// popMockResponse returns and removes the next mock response from the queue,
// delivering it through the same async channel path the real provider uses
// (`queueStreamChunk` for each block, then `llmResponseChan` for the final
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
func (w *ConversationWorker) popMockResponse(sink func(StreamChunk)) (*LLMResponse, error) {
	if len(w.mock.responses) == 0 {
		w.tape.Record("mock-pop", map[string]any{"exhausted": true})
		return nil, fmt.Errorf("mock responses exhausted")
	}

	mock := w.mock.responses[0]
	w.mock.responses = w.mock.responses[1:]
	w.tape.Record("mock-pop", map[string]any{
		"remaining":  len(w.mock.responses),
		"stopReason": mock.StopReason,
		"blocks":     len(mock.Blocks),
	})

	response := &LLMResponse{
		Blocks:       mock.Blocks,
		StopReason:   mock.StopReason,
		InputTokens:  mock.InputTokens,
		OutputTokens: mock.OutputTokens,
		CachedTokens: mock.CachedTokens,
		Error:        mock.Error,
	}

	// Drain any stale response left by a previously-cancelled call.
	select {
	case <-w.llmResponseChan:
	default:
	}

	paused := mock.PauseBeforeReturn

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
			w.sendStatus("mock-paused", "")
			select {
			case <-w.mock.releaseCh:
			case <-w.done:
				return
			}
		}

		w.deliverLLMResponse(response, nil)
	}()

	return w.waitForLLMResponse(LLMTimeout)
}

// callLLMMock is the mock branch of callLLM. Returns the next scripted
// response, or an error if responses are exhausted.
func (w *ConversationWorker) callLLMMockWithSink(sink func(StreamChunk)) (*LLMResponse, error) {
	if len(w.mock.responses) > 0 {
		jlog.Info("[callLLM] conv=%s thread=%q mockLeft=%d", w.conversationID, w.thread.itemID, len(w.mock.responses))
		response, err := w.popMockResponse(sink)
		if err != nil {
			return nil, err
		}
		// A scripted turn with Error set simulates a provider failure. The
		// non-mock callLLM translates response.Error after waitForLLMResponse;
		// the mock branch returns early, so mirror that translation here.
		if response.Error != "" {
			return nil, fmt.Errorf("LLM error: %s", response.Error)
		}
		return response, nil
	}
	jlog.Error("[callLLM] conv=%s thread=%q EXHAUSTED", w.conversationID, w.thread.itemID)
	return nil, fmt.Errorf("mock responses exhausted - test may have more LLM calls than expected")
}
