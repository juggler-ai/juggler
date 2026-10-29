//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside llm_turn_correlation_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

func TestMockLLMUsesFreshAttemptGeneration(t *testing.T) {
	w := NewConversationWorker("conv-mock-generation", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "one"}}},
		{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "two"}}},
	})

	var generations []string
	sink := func(chunk StreamChunk) { generations = append(generations, chunk.TurnID) }
	if _, err := w.currentRun().callLLMWithSink(nil, sink); err != nil {
		t.Fatalf("first mock call: %v", err)
	}
	if _, err := w.currentRun().callLLMWithSink(nil, sink); err != nil {
		t.Fatalf("second mock call: %v", err)
	}

	if len(generations) != 2 || generations[0] == "" || generations[1] == "" || generations[0] == generations[1] {
		t.Fatalf("mock attempt generations = %#v, want two distinct non-empty ids", generations)
	}
}
