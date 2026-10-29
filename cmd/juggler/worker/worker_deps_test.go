//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

import (
	"context"
	"encoding/json"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

// TestManagerSettersReachALiveWorkerWhileItsTurnsRead pins the Manager's
// setters against a worker that is running. Each one replaces what the worker
// was handed — the LLM caller included, which every setter but the sync
// throttle carries to live workers — while the worker's turns read those same
// dependencies on goroutines of their own. Under -race this is the test that
// fails if any of them is a field written in place.
func TestManagerSettersReachALiveWorkerWhileItsTurnsRead(t *testing.T) {
	m := NewManager()
	t.Cleanup(m.Shutdown)
	w := m.GetOrCreate("conv-setters", "user:test")
	initPayload, err := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: "conv-setters"},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	if err != nil {
		t.Fatalf("marshalling init: %v", err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := w.SendAndWait(ctx, "init", initPayload); err != nil {
		t.Fatalf("init: %v", err)
	}
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	answerEngineRequests(w, nil, func() *SubthreadSpec { return nil })
	w.SetCallback("client", func([]byte) {})

	llm := func(_ context.Context, _ json.RawMessage, sink func(StreamChunk)) (*LLMResponse, error) {
		sink(StreamChunk{Type: provider.ContentBlockTypeText, Content: "an answer"})
		return &LLMResponse{
			Blocks:     []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "an answer"}},
			StopReason: "end_turn",
		}, nil
	}
	m.SetLLMCaller(llm)
	if m.Count() != 1 || w.deps().llmCallFunc == nil {
		t.Fatal("the Manager's LLM caller never reached the worker it already had")
	}

	replacing := make(chan struct{})
	go func() {
		defer close(replacing)
		for range 200 {
			m.SetLLMCaller(llm)
			m.SetSpendLimit(func() int64 { return 0 })
			m.SetRunBudget(func() int64 { return 0 })
			m.SetWindowResolver(func(ModelConfig) ContextWindowInfo { return ContextWindowInfo{} })
			m.SetAutoCompactGate(func() bool { return true })
			m.SetPathProvider(func(string) (string, bool) { return "", false })
		}
	}()

	const turns = 3
	for i := range turns {
		sendUserMessage(t, w, "hello")
		deadline := time.Now().Add(10 * time.Second)
		for countAssistant(w) < i+1 {
			if time.Now().After(deadline) {
				t.Fatalf("turn %d never answered", i+1)
			}
			time.Sleep(2 * time.Millisecond)
		}
	}
	<-replacing
}

// countAssistant counts the assistant messages in w's document.
func countAssistant(w *ConversationWorker) int {
	n := 0
	for _, it := range w.doc.GetItems() {
		if it.Type == ItemTypeAssistant {
			n++
		}
	}
	return n
}
