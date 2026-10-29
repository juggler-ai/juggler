//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside compaction_fold_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"juggler/cmd/juggler/providers/provider"

	ycrdt "github.com/skyterra/y-crdt"
)

func feedCompactionContextAndTools(w *ConversationWorker, tools ...ToolDefinition) {
	go func() {
		contextResponse, _ := json.Marshal(map[string]any{
			"type": "render-context-items-response", "systemPrompt": "system prompt", "contexts": []any{},
		})
		toolsResponse, _ := json.Marshal(ToolsResultMessage{Type: "tools-result", Tools: tools})
		for {
			if !w.engine.contextReply.inject(w.done, contextResponse) {
				return
			}
			if !w.engine.toolsReply.inject(w.done, toolsResponse) {
				return
			}
		}
	}()
}

// TestHandleCompactFoldsSummarizesAndAcks drives the /compact + /handoff worker
// op end-to-end: an idle worker folds on request, summarizes via the pickup, and
// acks {folded:true}.
func TestHandleCompactFoldsSummarizesAndAcks(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	feedCompactionContextAndTools(w)
	w.SetLLMCaller(func(_ context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "command compact summary"}}}, nil
	})
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr := w.doc.ensureItems()
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: "rule", ItemID: generateItemID(), Content: "rule"})})
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeUser, ItemID: generateItemID(), Content: "hello"})})
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "hi"})})
	}, w.doc.authorID)

	waitAck := captureAck(t, w, "client-1", "a1")
	w.currentRun().handleCompact(json.RawMessage(`{"type":"compact","ackId":"a1"}`))
	w.quiesce(t)

	ack := waitAck()
	result, _ := ack["result"].(map[string]any)
	if folded, _ := result["folded"].(bool); !folded {
		t.Fatalf("ack result = %v, want {folded:true}", result)
	}
	items := w.doc.GetItems()
	if len(items) != 2 || items[1].Type != ItemTypeThread {
		t.Fatalf("root = %d items, want [rule, foldThread]", len(items))
	}
	thread := w.doc.GetThreadYMap(items[1].ItemID)
	if got, _ := thread.Get("result").(string); got != "command compact summary" {
		t.Fatalf("fold thread result = %q, want the summarizer output", got)
	}
}

// TestManualCompactNotesAssumedWindow: /compact on a model whose window is a
// guess says so. The reply budget the summary is written into is derived from
// that window, so a guess too small is also why a summary comes back cut short.
// The notice stands in root after the fold — not inside the fold thread, whose
// items are the summarizer's source.
func TestManualCompactNotesAssumedWindow(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "local", "model": "qwen"})
	w.SetWindowResolver(func(ModelConfig) ContextWindowInfo {
		return ContextWindowInfo{WindowTokens: 8192, ReserveTokens: 1638, Assumed: true}
	})
	feedCompactionContextAndTools(w)
	w.SetLLMCaller(func(_ context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "command compact summary"}}}, nil
	})
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr := w.doc.ensureItems()
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeUser, ItemID: generateItemID(), Content: "hello"})})
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "hi"})})
	}, w.doc.authorID)

	waitAck := captureAck(t, w, "client-1", "an1")
	w.currentRun().handleCompact(json.RawMessage(`{"type":"compact","ackId":"an1"}`))
	w.quiesce(t)
	if result, _ := waitAck()["result"].(map[string]any); result["folded"] != true {
		t.Fatalf("ack result = %v, want {folded:true}", result)
	}

	items := w.doc.GetItems()
	notices := assumedWindowNotices(t, items)
	if len(notices) != 1 {
		t.Fatalf("root holds %d assumed-window notices, want 1: %s", len(notices), itemIDs(items))
	}
	if !strings.Contains(notices[0].Summary, "8192") {
		t.Errorf("notice summary = %q, want the window it compacted at", notices[0].Summary)
	}
	for _, item := range items {
		if item.Type == ItemTypeThread {
			if got, _ := w.doc.GetThreadYMap(item.ItemID).Get("result").(string); got != "command compact summary" {
				t.Fatalf("fold thread result = %q, want the summarizer output — the notice must not disturb the fold", got)
			}
		}
	}
}

// TestHandleCompactUnderLandedPauseLiftsAndSummarizes pins /compact as human
// intent: a landed pause (mark standing, nothing running) must not swallow the
// summarization. The fold commits either way — the busy gate passes, since a
// landed pause holds no claim — so a mark left standing gives a conversation
// whose history is folded into a thread that never gets its summary, and which
// the reducer will not re-drive. Folding is an unambiguous "do this now", so it
// lifts the mark exactly as a send does.
func TestHandleCompactUnderLandedPauseLiftsAndSummarizes(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	feedCompactionContextAndTools(w)
	w.SetLLMCaller(func(_ context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "paused compact summary"}}}, nil
	})
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr := w.doc.ensureItems()
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeUser, ItemID: generateItemID(), Content: "hello"})})
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "hi"})})
	}, w.doc.authorID)

	// The user's state: Pause pressed, and the pause has landed.
	w.markPoliteStop("")

	waitAck := captureAck(t, w, "client-1", "a3")
	w.currentRun().handleCompact(json.RawMessage(`{"type":"compact","ackId":"a3"}`))
	w.quiesce(t)

	ack := waitAck()
	result, _ := ack["result"].(map[string]any)
	if folded, _ := result["folded"].(bool); !folded {
		t.Fatalf("ack result = %v, want {folded:true}", result)
	}
	if w.hasPoliteStops() {
		t.Errorf("/compact left the pause standing: marks = %v", w.politeStopMarks())
	}
	items := w.doc.GetItems()
	if len(items) != 1 || items[0].Type != ItemTypeThread {
		t.Fatalf("root = %d items, want [foldThread]", len(items))
	}
	thread := w.doc.GetThreadYMap(items[0].ItemID)
	if got, _ := thread.Get("result").(string); got != "paused compact summary" {
		t.Fatalf("fold thread result = %q, want the summarizer output — a fold with no summary is unrecoverable", got)
	}
}

// TestHandleCompactConvergesToSingleSummary drives two full /compact cycles
// with fresh history between them and verifies convergence end-to-end: the
// second compaction swallows the first summary, leaving one thread whose
// summary was produced from a source containing the first summary's text.
func TestHandleCompactConvergesToSingleSummary(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	feedCompactionContextAndTools(w)
	summaries := []string{"first summary", "second summary"}
	var sources []string
	w.SetLLMCaller(func(_ context.Context, encoded json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		sources = append(sources, string(encoded))
		s := summaries[0]
		summaries = summaries[1:]
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: s}}}, nil
	})
	pushUserTurn := func(content string) {
		w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
			arr := w.doc.ensureItems()
			arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeUser, ItemID: generateItemID(), Content: content})})
			arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "done: " + content})})
		}, w.doc.authorID)
	}

	pushUserTurn("first task")
	waitAck := captureAck(t, w, "client-1", "c1")
	w.currentRun().handleCompact(json.RawMessage(`{"type":"compact","ackId":"c1"}`))
	w.quiesce(t)
	waitAck()

	pushUserTurn("second task")
	waitAck = captureAck(t, w, "client-1", "c2")
	w.currentRun().handleCompact(json.RawMessage(`{"type":"compact","ackId":"c2"}`))
	w.quiesce(t)
	waitAck()

	items := w.doc.GetItems()
	if len(items) != 1 || items[0].Type != ItemTypeThread {
		t.Fatalf("root = %d items (%+v), want exactly one summary thread", len(items), items)
	}
	thread := w.doc.GetThreadYMap(items[0].ItemID)
	ycrdtMu.Lock()
	got, _ := thread.Get("result").(string)
	ycrdtMu.Unlock()
	if got != "second summary" {
		t.Fatalf("final thread result = %q, want the second summary", got)
	}
	// The second summarization's source must carry the first summary's text
	// forward (the swallowed thread's condensed result).
	if len(sources) != 2 || !strings.Contains(sources[1], "first summary") {
		t.Fatalf("second summarization source did not contain the first summary (calls=%d)", len(sources))
	}
}

// TestHandleCompactLeavesAnEchoedSummaryUnsummarized pins the reducer's
// shrink rule where the user meets it: a summarizer whose answer is no shorter
// than the transcript it was given has summarized nothing, so the fold is left
// marked unsummarized — with its transcript intact and Re-summarise offered —
// rather than committing the answer as the conversation's only record.
func TestHandleCompactLeavesAnEchoedSummaryUnsummarized(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	feedCompactionContextAndTools(w)
	// The fault in the wild: the transcript handed back instead of a summary.
	w.SetLLMCaller(func(_ context.Context, encoded json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		var req hiddenLLMRequest
		if err := json.Unmarshal(encoded, &req); err != nil {
			return nil, err
		}
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: req.Messages[0].Content}}}, nil
	})
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr := w.doc.ensureItems()
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeUser, ItemID: generateItemID(), Content: echoableTurn("hello")})})
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "hi"})})
	}, w.doc.authorID)

	waitAck := captureAck(t, w, "client-1", "e1")
	w.currentRun().handleCompact(json.RawMessage(`{"type":"compact","ackId":"e1"}`))
	w.quiesce(t)
	waitAck()

	items := w.doc.GetItems()
	threadID := items[len(items)-1].ItemID
	if result := threadResult(w, threadID); result != "" {
		t.Fatalf("fold result = %q, want no result — an echo is not a summary", result)
	}
	if !threadFlag(w, threadID, "compactionUnsummarized") {
		t.Fatal("a fold whose summarizer echoed the transcript is not marked unsummarized: it offers no route back to a summary")
	}
}

// The reported shape: a fold commits, its summarizer is cancelled, and the
// parent is left holding the fold tile and nothing else. Cancellation writes no
// error item and the one-shot trigger was consumed before the run, so without an
// explicit marker the state is indistinguishable from a summarizer that never
// started — and the viewer's Re-summarise affordance has nothing to render
// against, leaving no route back to a summary at all.
func TestFoldSummarizerCancellationMarksThreadUnsummarized(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	feedCompactionContextAndTools(w)
	w.SetLLMCaller(func(_ context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		cancelLiveRuns(w)
		return nil, context.Canceled
	})
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr := w.doc.ensureItems()
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: "rule", ItemID: generateItemID(), Content: "rule"})})
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeUser, ItemID: generateItemID(), Content: "hello"})})
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "hi"})})
	}, w.doc.authorID)

	waitAck := captureAck(t, w, "client-1", "a1")
	w.currentRun().handleCompact(json.RawMessage(`{"type":"compact","ackId":"a1"}`))
	w.quiesce(t)
	waitAck()

	items := w.doc.GetItems()
	if len(items) != 2 || items[1].Type != ItemTypeThread {
		t.Fatalf("root = %d items, want [rule, foldThread]", len(items))
	}
	threadID := items[1].ItemID
	if result := threadResult(w, threadID); result != "" {
		t.Fatalf("cancelled summarizer published %q, want no result", result)
	}
	if !threadFlag(w, threadID, "compactionUnsummarized") {
		t.Fatal("a fold whose summarizer was cancelled is not marked unsummarized: the blank conversation has no recovery affordance and leaves no trace")
	}
}

// Re-summarise is the recovery route, so it has to clear the marker and the
// marker has to survive only until a summary actually exists.
func TestResummariseClearsUnsummarizedMarker(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	feedCompactionContextAndTools(w)
	w.SetLLMCaller(func(_ context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		cancelLiveRuns(w)
		return nil, context.Canceled
	})
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		arr := w.doc.ensureItems()
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeUser, ItemID: generateItemID(), Content: "hello"})})
		arr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "hi"})})
	}, w.doc.authorID)

	waitAck := captureAck(t, w, "client-1", "a1")
	w.currentRun().handleCompact(json.RawMessage(`{"type":"compact","ackId":"a1"}`))
	w.quiesce(t)
	waitAck()

	items := w.doc.GetItems()
	threadID := items[len(items)-1].ItemID
	if !threadFlag(w, threadID, "compactionUnsummarized") {
		t.Fatal("fold was not marked unsummarized after a cancelled summarizer")
	}

	// Re-summarise against a summarizer that answers this time.
	w.currentRun().storeState(StateIdle)
	w.SetLLMCaller(func(_ context.Context, _ json.RawMessage, _ func(StreamChunk)) (*LLMResponse, error) {
		return &LLMResponse{Blocks: []LLMResponseBlock{{Type: provider.ContentBlockTypeText, Content: "recovered summary"}}}, nil
	})
	waitAck2 := captureAck(t, w, "client-1", "a2")
	w.currentRun().handleResummarizeCompactionThread(json.RawMessage(
		`{"type":"resummarize-compaction-thread","threadItemId":"` + threadID + `","ackId":"a2"}`))
	w.quiesce(t)
	waitAck2()

	if result := threadResult(w, threadID); result != "recovered summary" {
		t.Fatalf("fold result = %q, want the re-summarised output", result)
	}
	if threadFlag(w, threadID, "compactionUnsummarized") {
		t.Fatal("marker outlived the summary that made it untrue")
	}
}
