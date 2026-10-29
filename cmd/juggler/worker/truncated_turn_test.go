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

// onlyNotice returns the run's single notice, failing unless there is exactly one.
func onlyNotice(t *testing.T, w *ConversationWorker) ConversationItem {
	t.Helper()
	notices := itemsByType(w)[ItemTypeNotice]
	if len(notices) != 1 {
		t.Fatalf("got %d notice items, want exactly 1", len(notices))
	}
	return notices[0]
}

// retryOffer decodes the one-off retry a truncation notice offers; zero when it
// offers none.
func retryOffer(t *testing.T, notice ConversationItem) truncationNoticeData {
	t.Helper()
	var data truncationNoticeData
	if len(notice.Data) > 0 {
		if err := json.Unmarshal(notice.Data, &data); err != nil {
			t.Fatalf("notice data %s: %v", notice.Data, err)
		}
	}
	return data
}
