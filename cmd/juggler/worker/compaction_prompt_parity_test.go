//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"os"
	"strings"
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

// TestModernFoldRecognizedWithoutPromptMarker pins the Phase-2 invariant that a
// modern browser fold no longer depends on the prompt-prefix scan: a thread
// carrying only boundedCompaction + compactionPromptItemId (no legacy
// noAutoSelect/forceTool markers, and a prompt whose content does NOT match
// defaultSummarizationPromptMarker) is still recognized as a bounded-compaction
// thread and resolves its prompt via the explicit id.
func TestModernFoldRecognizedWithoutPromptMarker(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	threadID := generateItemID()
	promptID := generateItemID()
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		thread := conversationItemToYMap(ConversationItem{
			Type: ItemTypeThread, ItemID: threadID, Goal: "Compacted conversation history",
			BoundedCompaction: true, CompactionPromptItemID: promptID,
		})
		items := ycrdt.NewYArray()
		items.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeUser, ItemID: generateItemID(), Content: "prior history"})})
		// Prompt content that deliberately does not begin with the marker.
		items.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeUser, ItemID: promptID, Content: "Summarize this, please."})})
		thread.Set("items", items)
		w.doc.ensureItems().Push(ycrdt.ArrayAny{thread})
	}, w.doc.authorID)
	w.thread.itemID = threadID
	w.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)

	if !w.isBoundedCompactionThread(threadID) {
		t.Fatal("expected a boundedCompaction-marked thread to be recognized without legacy markers")
	}
	id, reason := w.resolveCompactionPromptItemID(threadID, w.getTargetItems())
	if reason != "" {
		t.Fatalf("resolveCompactionPromptItemID reason=%q, want success via explicit compactionPromptItemId", reason)
	}
	if id != promptID {
		t.Fatalf("resolved prompt id = %q, want %q (explicit id, not a marker scan)", id, promptID)
	}
}

// TestSummarizationPromptMarkerIsPrefix pins the Go-internal contract that the
// worker uses to recognize a legacy folded thread's orchestration prompt: the
// marker must be a verbatim prefix of the canonical prompt.
func TestSummarizationPromptMarkerIsPrefix(t *testing.T) {
	if !strings.HasPrefix(DefaultSummarizationPrompt, defaultSummarizationPromptMarker) {
		t.Fatalf("defaultSummarizationPromptMarker is not a prefix of DefaultSummarizationPrompt.\n"+
			"marker: %q\nprompt starts: %q",
			defaultSummarizationPromptMarker, firstN(DefaultSummarizationPrompt, len(defaultSummarizationPromptMarker)+16))
	}
}

// TestSummarizationPromptMatchesJSFallback pins the cross-language contract. Go
// owns DefaultSummarizationPrompt and ships it to the browser in the "ready"
// bootstrap; the browser keeps a fallback copy in compaction-utils.js for
// callers running before the bootstrap arrives. If someone edits one prompt
// without the other, folded-thread recognition and the fallback silently
// diverge. This asserts byte-for-byte equality against the JS source so the
// desync is caught at build time.
func TestSummarizationPromptMatchesJSFallback(t *testing.T) {
	const jsPath = "../../../web/js/utils/compaction-utils.js"
	raw, err := os.ReadFile(jsPath)
	if err != nil {
		t.Fatalf("read %s: %v", jsPath, err)
	}

	prompt, err := extractDefaultSummarizationPromptJS(string(raw))
	if err != nil {
		t.Fatalf("extract JS prompt from %s: %v", jsPath, err)
	}
	if prompt != DefaultSummarizationPrompt {
		t.Fatalf("JS fallback prompt differs from Go DefaultSummarizationPrompt.\n"+
			"Update both together — they are a single contract.\nGo len=%d, JS len=%d",
			len(DefaultSummarizationPrompt), len(prompt))
	}
}

// extractDefaultSummarizationPromptJS pulls the template-literal body of the JS
// defaultSummarizationPrompt() fallback. The prompt contains no backticks or
// ${} interpolations, so the fallback literal spans from the first backtick
// after the function declaration to the next backtick.
func extractDefaultSummarizationPromptJS(src string) (string, error) {
	const decl = "export function defaultSummarizationPrompt()"
	di := strings.Index(src, decl)
	if di < 0 {
		return "", errNotFound("function declaration " + decl)
	}
	rest := src[di+len(decl):]
	open := strings.IndexByte(rest, '`')
	if open < 0 {
		return "", errNotFound("opening backtick of the prompt template literal")
	}
	body := rest[open+1:]
	end := strings.IndexByte(body, '`')
	if end < 0 {
		return "", errNotFound("closing backtick of the prompt template literal")
	}
	return body[:end], nil
}

type errNotFound string

func (e errNotFound) Error() string { return "not found: " + string(e) }

func firstN(s string, n int) string {
	if n > len(s) {
		n = len(s)
	}
	return s[:n]
}
