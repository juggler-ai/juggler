//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"
)

// newTruncationWorker builds a worker wired for a bare strategy run: an
// initialised doc plus a goroutine feeding the context/tools replies the loop
// blocks on. The caller queues the mock responses.
func newTruncationWorker(t *testing.T, convID string) *ConversationWorker {
	t.Helper()
	w := NewConversationWorker(convID, "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	initPayload, err := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: convID},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	if err != nil {
		t.Fatalf("marshal init: %v", err)
	}
	w.currentRun().handleInit(initPayload)

	stop := make(chan struct{})
	t.Cleanup(func() { close(stop) })
	go func() {
		ctxResp, _ := json.Marshal(map[string]any{
			"type": "render-context-items-response", "systemPrompt": "sys", "contexts": []any{},
		})
		toolsResp, _ := json.Marshal(map[string]any{"type": "tools-result", "tools": []any{}})
		for {
			select {
			case <-stop:
				return
			default:
			}
			if !w.engine.contextReply.inject(w.done, ctxResp) {
				return
			}
			if !w.engine.toolsReply.inject(w.done, toolsResp) {
				return
			}
		}
	}()
	return w
}

func thinkingBlock(s string) LLMResponseBlock {
	return LLMResponseBlock{Type: provider.ContentBlockTypeThinking, Thinking: s}
}

func textBlock(s string) LLMResponseBlock {
	return LLMResponseBlock{Type: provider.ContentBlockTypeText, Content: s}
}

// itemsByType groups a finished run's conversation items for assertions.
func itemsByType(w *ConversationWorker) map[string][]ConversationItem {
	byType := map[string][]ConversationItem{}
	for _, it := range w.doc.GetItems() {
		byType[it.Type] = append(byType[it.Type], it)
	}
	return byType
}

// assistantContains reports whether any assistant item carries the substring.
func assistantContains(items map[string][]ConversationItem, substr string) bool {
	for _, it := range items[ItemTypeAssistant] {
		if strings.Contains(it.Content, substr) {
			return true
		}
	}
	return false
}

// A reasoning model whose whole output budget goes on thinking returns thinking
// and nothing else, with stop reason max_tokens. That is a truncation, not a
// blank turn: re-issuing the identical request spends the identical budget and
// is cut off in the identical place, and each round's thinking is replayed into
// the next, so every attempt starts nearer the limit. It must cost ONE call and
// be reported as what it was.
func TestTruncatedThinkingOnlyTurnIsReportedNotRetried(t *testing.T) {
	w := newTruncationWorker(t, "conv-truncated")
	w.windowResolver = func(ModelConfig) ContextWindowInfo { return ContextWindowInfo{WindowTokens: 8192, ReserveTokens: 1638} }

	// Four queued, only one may be consumed: the surplus proves the loop
	// stopped rather than merely running the queue dry.
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{thinkingBlock("pondering the clipping routine")}, StopReason: "max_tokens", OutputTokens: 1638},
		{Blocks: []LLMResponseBlock{thinkingBlock("still pondering")}, StopReason: "max_tokens", OutputTokens: 1638},
		{Blocks: []LLMResponseBlock{thinkingBlock("and again")}, StopReason: "max_tokens", OutputTokens: 1638},
		{Blocks: []LLMResponseBlock{textBlock("SENTINEL")}, StopReason: "end_turn"},
	})

	w.driveStrategyLoop(t, "optimise clipToPolygon", false)

	if n := w.mock.remaining(); n != 3 {
		t.Fatalf("leftover mock responses = %d, want 3 (one call, not %d)", n, MaxBarrenTurns)
	}

	items := itemsByType(w)

	notices := items[ItemTypeNotice]
	if len(notices) != 1 {
		t.Fatalf("got %d notice items, want exactly 1", len(notices))
	}
	notice := notices[0]
	if notice.Summary == "" {
		t.Error("notice has no summary — nothing for the transcript row to title itself with")
	}
	// The point of the notice: name the budget that ended the turn, rather than
	// merely reporting that something went wrong.
	if !strings.Contains(notice.Content, "1638") {
		t.Errorf("notice drops the output budget that truncated the turn: %q", notice.Content)
	}
	// The reported symptom was thinking followed by nothing, which reads as a
	// crash unless the note says otherwise.
	if !strings.Contains(notice.Content, "thinking") {
		t.Errorf("notice doesn't explain that thinking consumed the budget: %q", notice.Content)
	}

	if n := len(items[ItemTypeThinking]); n != 1 {
		t.Errorf("got %d thinking items, want 1 (one call, one thinking block)", n)
	}
	// The old ending: a placeholder blaming the model for a silence that was
	// Juggler's own output cap.
	if assistantContains(items, "no further response") {
		t.Error("truncated turn still papered over with the barren placeholder")
	}
}

// A truncated turn that DID emit text is still reported, but the text stands:
// the reply is short, not absent, and nothing may discard it.
func TestTruncatedTurnWithTextKeepsTheTextAndReportsIt(t *testing.T) {
	w := newTruncationWorker(t, "conv-truncated-text")
	w.windowResolver = func(ModelConfig) ContextWindowInfo { return ContextWindowInfo{WindowTokens: 8192, ReserveTokens: 1638} }

	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{textBlock("Here is the first half of the answer")}, StopReason: "max_tokens", OutputTokens: 1638},
		{Blocks: []LLMResponseBlock{textBlock("SENTINEL")}, StopReason: "end_turn"},
	})

	w.driveStrategyLoop(t, "explain the algorithm", false)

	if n := w.mock.remaining(); n != 1 {
		t.Fatalf("leftover mock responses = %d, want 1 (exactly one call)", n)
	}
	items := itemsByType(w)
	if n := len(items[ItemTypeNotice]); n != 1 {
		t.Fatalf("got %d notice items, want exactly 1", n)
	}
	if !assistantContains(items, "first half of the answer") {
		t.Errorf("the truncated reply's text was lost; assistant items = %+v", items[ItemTypeAssistant])
	}
}

// The genuine transient-blank path must survive the truncation fix: a provider
// that intermittently emits an empty end_turn is still retried MaxBarrenTurns
// times and still ends in the placeholder. Without this, "don't retry
// truncations" could quietly become "don't retry anything".
func TestBarrenTurnWithoutTruncationStillRetries(t *testing.T) {
	w := newTruncationWorker(t, "conv-barren")

	barren := MockResponse{Blocks: []LLMResponseBlock{thinkingBlock("hmm")}, StopReason: "end_turn"}
	w.setMockResponses([]MockResponse{
		barren, barren, barren,
		{Blocks: []LLMResponseBlock{textBlock("SENTINEL")}, StopReason: "end_turn"},
	})

	w.driveStrategyLoop(t, "optimise clipToPolygon", false)

	if n := w.mock.remaining(); n != 1 {
		t.Fatalf("leftover mock responses = %d, want 1 (exactly %d calls)", n, MaxBarrenTurns)
	}

	items := itemsByType(w)
	if n := len(items[ItemTypeNotice]); n != 0 {
		t.Errorf("a barren turn earned %d truncation notice(s) it did not deserve", n)
	}
	if !assistantContains(items, "no further response") {
		t.Errorf("barren stall placeholder missing; assistant items = %+v", items[ItemTypeAssistant])
	}
}
