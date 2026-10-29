//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

import (
	"testing"
)

// A safety classifier declines a request with HTTP 200, stop reason "refusal",
// and often no content at all. By shape that is identical to a barren turn, so
// the retry ladder would send the same request three times — each one billed,
// each one refused for the same reason — and then file a deliberate decision
// under "no further response". It must cost ONE call.
func TestRefusedTurnIsNotRetried(t *testing.T) {
	w := newTruncationWorker(t, "conv-refused")

	// Four queued, only one may be consumed: the surplus proves the loop
	// stopped rather than merely running the queue dry.
	refusal := MockResponse{StopReason: "refusal"}
	w.setMockResponses([]MockResponse{
		refusal, refusal, refusal,
		{Blocks: []LLMResponseBlock{textBlock("SENTINEL")}, StopReason: "end_turn"},
	})

	w.driveStrategyLoop(t, "a request that gets declined", false)

	if n := w.mock().remaining(); n != 3 {
		t.Fatalf("leftover mock responses = %d, want 3 (one call, not %d)", n, MaxBarrenTurns)
	}

	items := itemsByType(w)
	// The old ending: a refusal reported as a silence, which reads as an outage
	// and invites the user to retry something that will never succeed.
	if assistantContains(items, "no further response") {
		t.Error("a refusal was papered over with the barren placeholder")
	}
	// The SENTINEL must never be reached — consuming it would mean the loop
	// carried on past the refusal.
	if assistantContains(items, "SENTINEL") {
		t.Error("the loop continued past the refusal")
	}
}

// A refusal that DID carry text is still terminal, and the text stands: the
// model explained itself in the reply, and nothing may discard that.
func TestRefusedTurnWithTextKeepsTheText(t *testing.T) {
	w := newTruncationWorker(t, "conv-refused-text")

	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{textBlock("I can't help with that.")}, StopReason: "refusal"},
		{Blocks: []LLMResponseBlock{textBlock("SENTINEL")}, StopReason: "end_turn"},
	})

	w.driveStrategyLoop(t, "a request that gets declined", false)

	if n := w.mock().remaining(); n != 1 {
		t.Fatalf("leftover mock responses = %d, want 1 (exactly one call)", n)
	}
	items := itemsByType(w)
	if !assistantContains(items, "I can't help with that.") {
		t.Errorf("the refusal's own text was lost; assistant items = %+v", items[ItemTypeAssistant])
	}
}
