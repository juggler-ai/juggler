//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import "testing"

// TestBuildMessages_EmitsStoredThinking is the regression guard for the DeepSeek
// thinking-mode 400 ("The `reasoning_content` in the thinking mode must be
// passed back to the API"). The provider-layer replay (openaibase's
// ReasoningReplay quirk) only fires when it receives a "thinking" message,
// but buildMessages historically had no case for ItemTypeThinking, so stored
// reasoning was silently dropped before the provider ever saw it — leaving the
// quirk with nothing to echo. A continued (post-tool-call) DeepSeek turn then
// 400'd. buildMessages must emit a thinking message, positioned before the
// tool-use it preceded, so the assistant turn carries its reasoning back.
func TestBuildMessages_EmitsStoredThinking(t *testing.T) {
	w := NewConversationWorker("conv-thinking-replay", "user:test")
	defer w.doc.Destroy()

	// A representative reasoning turn as it lands in the doc: the model thinks,
	// then calls a tool. This is exactly the shape the continuation request
	// rebuilds from stored items.
	w.doc.InsertMessage(0, ConversationItem{
		Type: ItemTypeUser, ItemID: "u-1", Content: "What's the weather?",
	})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeThinking, ItemID: "th-1",
		Content: "The user wants weather; I should call the tool.",
	})
	w.doc.InsertMessage(2, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "call_1",
		ToolName: "get_weather", State: StateCompleted,
		Result: []byte(`{"content":"sunny","isError":false}`),
	})

	msgs := w.currentRun().buildMessages(nil)

	// Locate the thinking message and assert it appears BEFORE the tool-use —
	// otherwise the provider's per-turn grouping would attach the reasoning to
	// the wrong assistant turn.
	thinkingIdx, toolUseIdx := -1, -1
	for i, m := range msgs {
		switch m["type"] {
		case "thinking":
			if c, _ := m["content"].(string); c == "The user wants weather; I should call the tool." {
				thinkingIdx = i
			}
		case "tool-use":
			if m["toolUseId"] == "call_1" {
				toolUseIdx = i
			}
		}
	}

	if thinkingIdx < 0 {
		t.Fatalf("buildMessages dropped the stored thinking item — DeepSeek continuation will 400; messages=%+v", msgs)
	}
	if toolUseIdx < 0 {
		t.Fatalf("precondition: tool-use message missing; messages=%+v", msgs)
	}
	if thinkingIdx > toolUseIdx {
		t.Errorf("thinking message must precede its tool-use (thinking@%d, tool-use@%d); messages=%+v",
			thinkingIdx, toolUseIdx, msgs)
	}
}

// TestBuildMessages_BatchesParallelToolCalls guards the second DeepSeek failure
// mode: a turn with parallel tool calls stores them as consecutive tool-actions
// sharing one TransactionID.
// If buildMessages emits them interleaved (use/result/use/result), the provider
// transform flushes a separate assistant message per tool-result and DeepSeek's
// thinking mode carries reasoning_content only on the first — the continued turn
// then 400s. All tool_use messages for the same turn must precede all
// tool_result messages so the transform groups them into ONE assistant message.
func TestBuildMessages_BatchesParallelToolCalls(t *testing.T) {
	w := NewConversationWorker("conv-parallel-tools", "user:test")
	defer w.doc.Destroy()

	w.doc.InsertMessage(0, ConversationItem{Type: ItemTypeUser, ItemID: "u-1", Content: "q"})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeThinking, ItemID: "th-1", Content: "reasoning", TransactionID: "txn-1",
	})
	// Two parallel tool calls from the SAME turn (shared TransactionID).
	w.doc.InsertMessage(2, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-a", ToolUseID: "a", ToolName: "glob",
		State: StateCompleted, TransactionID: "txn-1",
		Result: []byte(`{"content":"ra","isError":false}`),
	})
	w.doc.InsertMessage(3, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-b", ToolUseID: "b", ToolName: "read",
		State: StateCompleted, TransactionID: "txn-1",
		Result: []byte(`{"content":"rb","isError":false}`),
	})

	msgs := w.currentRun().buildMessages(nil)

	// Positions: both tool_use must come before both tool_result.
	lastUse, firstResult := -1, len(msgs)
	for idx, m := range msgs {
		switch m["type"] {
		case "tool-use":
			if idx > lastUse {
				lastUse = idx
			}
		case "tool-result":
			if idx < firstResult {
				firstResult = idx
			}
		}
	}
	if lastUse < 0 || firstResult == len(msgs) {
		t.Fatalf("expected both tool_use and tool_result messages; got %+v", msgs)
	}
	if lastUse > firstResult {
		t.Errorf("parallel-turn tool_use messages must all precede tool_result messages "+
			"(lastUse@%d, firstResult@%d) — interleaving 400s DeepSeek; messages=%+v",
			lastUse, firstResult, msgs)
	}
}

// TestBuildMessages_DoesNotMergeSequentialTurns asserts the batching is keyed on
// TransactionID, not raw adjacency: two tool-actions from DIFFERENT turns that
// happen to be stored consecutively (no separator) must stay as separate
// assistant turns — emitted as use/result, use/result — so we don't misrepresent
// sequential calls as one parallel turn for non-thinking providers.
func TestBuildMessages_DoesNotMergeSequentialTurns(t *testing.T) {
	w := NewConversationWorker("conv-sequential-tools", "user:test")
	defer w.doc.Destroy()

	w.doc.InsertMessage(0, ConversationItem{Type: ItemTypeUser, ItemID: "u-1", Content: "q"})
	w.doc.InsertMessage(1, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-a", ToolUseID: "a", ToolName: "glob",
		State: StateCompleted, TransactionID: "txn-1",
		Result: []byte(`{"content":"ra","isError":false}`),
	})
	w.doc.InsertMessage(2, ConversationItem{
		Type: ItemTypeToolAction, ItemID: "ta-b", ToolUseID: "b", ToolName: "read",
		State: StateCompleted, TransactionID: "txn-2",
		Result: []byte(`{"content":"rb","isError":false}`),
	})

	msgs := w.currentRun().buildMessages(nil)

	// Expected order: use(a), result(a), use(b), result(b) — the first turn's
	// result precedes the second turn's tool_use.
	var order []string
	for _, m := range msgs {
		if t := m["type"]; t == "tool-use" || t == "tool-result" {
			order = append(order, m["type"].(string)+":"+m["toolUseId"].(string))
		}
	}
	want := []string{"tool-use:a", "tool-result:a", "tool-use:b", "tool-result:b"}
	if len(order) != len(want) {
		t.Fatalf("order = %v, want %v", order, want)
	}
	for i := range want {
		if order[i] != want[i] {
			t.Fatalf("order = %v, want %v (sequential turns must not be merged into a parallel batch)", order, want)
		}
	}
}

// TestBuildMessages_SkipsEmptyThinking asserts a content-less thinking item is
// not emitted as an empty message (which some providers reject).
func TestBuildMessages_SkipsEmptyThinking(t *testing.T) {
	w := NewConversationWorker("conv-thinking-empty", "user:test")
	defer w.doc.Destroy()

	w.doc.InsertMessage(0, ConversationItem{Type: ItemTypeUser, ItemID: "u-1", Content: "hi"})
	w.doc.InsertMessage(1, ConversationItem{Type: ItemTypeThinking, ItemID: "th-1", Content: ""})

	for _, m := range w.currentRun().buildMessages(nil) {
		if m["type"] == "thinking" {
			t.Fatalf("empty thinking item should not be emitted; messages=%+v", w.currentRun().buildMessages(nil))
		}
	}
}
