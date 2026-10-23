//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

// streamFor plays an attempt that streams one chunk of chunkType every tick
// for the given span, marking each as model output the way callLLMWithSink's
// sink does when isModelOutputChunk says so, then delivers its response.
func streamFor(w *ConversationWorker, chunkType provider.ContentBlockType, span, tick time.Duration, resp *LLMResponse) {
	r := w.currentRun()
	go func() {
		deadline := time.Now().Add(span)
		for time.Now().Before(deadline) {
			if isModelOutputChunk(chunkType) {
				r.t.lastOutputAt.Store(time.Now().UnixNano())
			}
			w.turn.chunks <- StreamChunk{TurnID: "current", Type: chunkType, Content: "."}
			time.Sleep(tick)
		}
		w.turn.responseChan <- llmCallResult{TurnID: "current", Response: resp}
	}()
}

// TestLLMBackstopSparesAStreamThatKeepsProducing pins that the backstop is
// not a cap on a call's length: GLM at max effort reasons for over half an
// hour in one call, streaming the whole time, and that call must be allowed
// to finish. Here the stream runs several backstops long.
func TestLLMBackstopSparesAStreamThatKeepsProducing(t *testing.T) {
	w := NewConversationWorker("conv-backstop-producing", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	want := &LLMResponse{StopReason: "end_turn"}
	streamFor(w, provider.ContentBlockTypeThinking, 2*time.Second, 10*time.Millisecond, want)

	got, err := w.currentRun().waitForLLMResponse("current", 500*time.Millisecond)
	if err != nil {
		t.Fatalf("a call still streaming thinking was cut off: %v", err)
	}
	if got != want {
		t.Fatalf("waitForLLMResponse = %#v, want the streamed call's response", got)
	}
}

// TestLLMBackstopStillCatchesAStreamThatProducesNothing pins what the
// backstop is for: a call that keeps the provider's idle watchdog fed with
// chunks that aren't the model's (status notices) but never produces output
// is given up on.
func TestLLMBackstopStillCatchesAStreamThatProducesNothing(t *testing.T) {
	w := NewConversationWorker("conv-backstop-barren", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	streamFor(w, provider.ContentBlockTypeStatus, 4*time.Second, 10*time.Millisecond, &LLMResponse{})

	start := time.Now()
	_, err := w.currentRun().waitForLLMResponse("current", 500*time.Millisecond)
	if err == nil {
		t.Fatal("a call that produced nothing outlived the backstop")
	}
	// The stream runs 4s; a backstop that waited for it to end proves nothing.
	if elapsed := time.Since(start); elapsed > 3*time.Second {
		t.Fatalf("backstop fired after %v, want about its 500ms", elapsed)
	}
}
