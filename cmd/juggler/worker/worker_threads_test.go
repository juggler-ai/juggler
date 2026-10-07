//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"strings"
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

// Sub-threads: settlement and summarisation, the depth and breadth caps, parent
// wiring for created threads, and error propagation back to the parent.

// TestThreadRunSettlesOnTrailingText verifies the return contract: a run's
// answer is the assistant message it comes to rest on. The child here replies
// and calls nothing; that reply settles the run, becomes the thread's summary,
// and returns to the parent, which carries on. Exercises the full production
// path: LLM calls create_thread → executeCreateThread → nested strategy loop →
// loop ends → settle → parent resumes.
func TestThreadRunSettlesOnTrailingText(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	w.currentRun().storeState(StateProcessing)

	// Mock responses:
	// 1. Parent LLM calls create_thread tool
	// 2. Thread LLM responds with text + end_turn — the run's answer
	// 3. Parent continuation, which only runs because the child returned
	w.setMockResponses([]MockResponse{
		// Parent turn 1: calls create_thread
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-1", Name: "create_thread", Input: json.RawMessage(`{"goal":"Test thread","prompt":"Do the task"}`)},
			},
			StopReason: "tool_use",
		},
		// Thread turn: plain text, no tool call.
		{
			Blocks: []LLMResponseBlock{
				{Type: "text", Content: "I completed the task successfully."},
			},
			StopReason: "end_turn",
		},
		// Parent turn 2: runs once the child's run settles.
		{
			Blocks: []LLMResponseBlock{
				{Type: "text", Content: "Thanks, noted."},
			},
			StopReason: "end_turn",
		},
	})

	// Feed context and tools results for the three LLM iterations:
	// parent turn 1, the thread turn, and the parent's continuation.
	go func() {
		ctxResponse, _ := json.Marshal(map[string]any{
			"type":         "render-context-items-result",
			"systemPrompt": "You are a helpful assistant.",
			"contexts":     []any{},
		})
		toolsResponse, _ := json.Marshal(map[string]any{
			"type":  "tools-result",
			"tools": []ToolDefinition{{Name: "create_thread"}},
		})

		for i := 0; i < 3; i++ {
			w.engine.contextReply.inject(w.done, ctxResponse)
			w.engine.toolsReply.inject(w.done, toolsResponse)
		}
	}()

	// Run the strategy loop as production does — starts from a user message
	w.driveStrategyLoop(t, "Hello", false)

	items := w.doc.GetItems()
	var threadItem ConversationItem
	for _, item := range items {
		if item.Type == ItemTypeThread {
			threadItem = item
			break
		}
	}
	if threadItem.ItemID == "" {
		t.Fatal("no thread item found — create_thread did not insert a thread")
	}
	if !threadRunSettled(threadItem) {
		t.Errorf("a run that ended on assistant text must be settled")
	}
	threadResult, _ := w.doc.GetThreadYMap(threadItem.ItemID).Get("result").(string)
	if threadResult != "I completed the task successfully." {
		t.Errorf("thread result = %q, want the reply the run rested on", threadResult)
	}

	// The parent got its answer back and carried on.
	var continued bool
	for _, item := range items {
		if item.Type == ItemTypeAssistant && strings.Contains(item.Content, "Thanks, noted.") {
			continued = true
		}
	}
	if !continued {
		t.Errorf("parent must resume once the child's run settles; items=%+v", items)
	}

	w.doc.Destroy()
}

// TestCreateThreadInjectsToolUseInParentMessages verifies that when the parent
// LLM calls create_thread, the parent's subsequent buildMessages output
// contains the assistant tool_use block AND a user tool_result with the
// thread's summary. Without this, the parent LLM has no memory that it
// spawned a thread and will re-do the work on continuation.
func TestCreateThreadInjectsToolUseInParentMessages(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	w.currentRun().storeState(StateProcessing)

	w.setMockResponses([]MockResponse{
		// Parent turn 1: calls create_thread
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-create-1", Name: "create_thread", Input: json.RawMessage(`{"goal":"Test thread","prompt":"Do the task"}`)},
			},
			StopReason: "tool_use",
		},
		// Child thread: its trailing assistant text is what the run returns.
		{
			Blocks: []LLMResponseBlock{
				{Type: "text", Content: "Task completed successfully."},
			},
			StopReason: "end_turn",
		},
		// Parent continuation
		{
			Blocks: []LLMResponseBlock{
				{Type: "text", Content: "Got it."},
			},
			StopReason: "end_turn",
		},
	})

	go func() {
		ctxResponse, _ := json.Marshal(map[string]any{
			"type":         "render-context-items-result",
			"systemPrompt": "You are a helpful assistant.",
			"contexts":     []any{},
		})
		toolsResponse, _ := json.Marshal(map[string]any{
			"type":  "tools-result",
			"tools": []ToolDefinition{{Name: "create_thread"}},
		})
		for i := 0; i < 3; i++ {
			w.engine.contextReply.inject(w.done, ctxResponse)
			w.engine.toolsReply.inject(w.done, toolsResponse)
		}
	}()

	w.driveStrategyLoop(t, "Hello", false)

	// After the loop, w.turn.thread is reset, so buildMessages walks the root
	// items — exactly the view the parent LLM would see on continuation.
	messages := w.currentRun().buildMessages(nil)

	var foundToolUse, foundToolResult bool
	var toolResultContent string
	var toolInput map[string]any
	for _, m := range messages {
		if m["type"] == "tool-use" && m["toolUseId"] == "tu-create-1" && m["toolName"] == "create_thread" {
			foundToolUse = true
			toolInput, _ = m["toolInput"].(map[string]any)
		}
		if m["type"] == "tool-result" && m["toolUseId"] == "tu-create-1" {
			foundToolResult = true
			toolResultContent, _ = m["content"].(string)
		}
	}

	if !foundToolUse {
		t.Errorf("expected tool-use block for create_thread (tu-create-1) in parent messages; messages=%+v", messages)
	}
	if !foundToolResult {
		t.Errorf("expected tool-result block for tu-create-1 in parent messages; messages=%+v", messages)
	}
	if foundToolResult && !strings.Contains(toolResultContent, "Task completed successfully.") {
		t.Errorf("tool-result content should contain the thread's summary; got %q", toolResultContent)
	}
	// The tool_use block must carry the LLM's original input object; without
	// this, providers see {"input": null} and the model treats the call as
	// invalid (i.e. "I never spawned this thread").
	if toolInput == nil {
		t.Fatalf("tool-use block has nil toolInput — provider will see null input; messages=%+v", messages)
	}
	if got, _ := toolInput["goal"].(string); got != "Test thread" {
		t.Errorf("toolInput.goal = %q, want %q", got, "Test thread")
	}
	if got, _ := toolInput["prompt"].(string); got != "Do the task" {
		t.Errorf("toolInput.prompt = %q, want %q", got, "Do the task")
	}

	w.doc.Destroy()
}

// TestReducer_EmptyUserThreadDoesNotAutoRunUnderAwaitingLLM reproduces the
// "the new thread immediately starts running" bug at the reducer level.
//
// When the parent conversation is parked at activity=awaiting_llm (the marker a
// pending tool / in-flight turn leaves on the ROOT thread) and the user presses
// the composer "New Thread" button, an empty thread is inserted at root as a
// pure Yjs mutation with no user message. The reducer's walk-down then descends
// into that empty child and — because "empty nested thread under awaiting_llm"
// is the continuation dispatch trigger — borrows the PARENT's awaiting_llm
// marker to fire an LLM turn on the brand-new thread.
//
// That marker does not belong to the new thread: a user-created thread must
// wait for the user to actually send a message. The legitimate empty-thread
// auto-run (continueInNewThread / the orchestrator) always targets the thread
// directly via processingState.threadItemID, so it is reached as the walk-down
// ROOT, never by descending into it.
func TestReducer_EmptyUserThreadDoesNotAutoRunUnderAwaitingLLM(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// A single text response: if the empty thread wrongly runs, it consumes this
	// and appends an assistant item — the evidence of the bug.
	w.setMockResponses([]MockResponse{
		{Blocks: []LLMResponseBlock{{Type: "text", Content: "SHOULD NOT RUN"}}, StopReason: "end_turn"},
	})

	// Feed context/tools so that IF the buggy dispatch fires the turn COMPLETES
	// (leaving evidence) instead of blocking the test on the context channel.
	go func() {
		ctxResponse, _ := json.Marshal(map[string]any{
			"type":         "render-context-items-result",
			"systemPrompt": "You are a helpful assistant.",
			"contexts":     []any{},
		})
		toolsResponse, _ := json.Marshal(map[string]any{"type": "tools-result", "tools": []any{}})
		for i := 0; i < 2; i++ {
			w.engine.contextReply.inject(w.done, ctxResponse)
			w.engine.toolsReply.inject(w.done, toolsResponse)
		}
	}()

	// Parent parked at awaiting_llm on the ROOT thread (threadItemID="").
	w.requestLLM("")

	// User presses "New Thread": empty thread inserted at root.
	threadItemID := generateItemID()
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		item := ConversationItem{Type: ItemTypeThread, ItemID: threadItemID, Goal: "Thread"}
		ymap := conversationItemToYMap(item)
		ymap.Set("items", ycrdt.NewYArray())
		ymap.Set("strategyCreated", true)
		w.doc.ensureItems().Push(ycrdt.ArrayAny{ymap})
	}, w.doc.authorID)

	// Drive the reducer exactly as the event loop would after the insert.
	w.needsReconcile.Store(true)
	w.quiesce(t)

	arr := w.doc.GetThreadItemsArray(threadItemID)
	if arr == nil {
		t.Fatal("thread items array missing")
	}
	items := w.doc.GetItemsFromArray(arr)
	if len(items) != 0 {
		t.Fatalf("empty user-created thread auto-ran under awaiting_llm: thread has %d item(s): %+v; it must wait for the user to send a message", len(items), items)
	}
}

// TestThreadDepthCap pins the runaway-recursion backstop: create_thread may
// nest up to maxThreadDepth levels, and a spawn from a thread already at that
// depth is refused. The refusal must not silently vanish (that would leave the
// parent's tool_use unanswered) nor create the over-deep thread — instead the
// worker appends a meta-tool-result error bound to the create_thread tool_use,
// telling the model to do the sub-task inline. Below the cap, spawning works
// normally.
func TestThreadDepthCap(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)

	// Build a thread chain root -> L1 -> ... -> L{maxThreadDepth}, each level
	// holding the next as its only nested item. Record each level's id+array.
	type level struct {
		id  string
		arr *ycrdt.YArray
	}
	levels := make([]level, 0, maxThreadDepth)
	arr := w.doc.ensureItems()
	for i := 1; i <= maxThreadDepth; i++ {
		nested := w.doc.InsertThreadIntoArray(arr, w.doc.GetItemsLengthFromArray(arr), fmt.Sprintf("L%d", i))
		items := w.doc.GetItemsFromArray(arr)
		levels = append(levels, level{id: items[len(items)-1].ItemID, arr: nested})
		arr = nested
	}

	// threadDepth must count root ("") as 0 and each level as its 1-based depth.
	if got := w.doc.threadDepth(""); got != 0 {
		t.Fatalf("threadDepth(root) = %d, want 0", got)
	}
	for i, lv := range levels {
		if got := w.doc.threadDepth(lv.id); got != i+1 {
			t.Fatalf("threadDepth(L%d) = %d, want %d", i+1, got, i+1)
		}
	}

	deepest := levels[len(levels)-1] // depth == maxThreadDepth

	// A spawn from the deepest thread is refused.
	w.turn.thread.itemID = deepest.id
	w.turn.thread.itemsArray = deepest.arr
	beforeLen := w.doc.GetItemsLengthFromArray(deepest.arr)
	input := json.RawMessage(`{"goal":"too deep","prompt":"spawn another"}`)
	if err := w.currentRun().executeCreateThread("tu-deep", "create_thread", input); err != nil {
		t.Fatalf("executeCreateThread returned error: %v", err)
	}

	deepItems := w.doc.GetItemsFromArray(deepest.arr)
	for _, it := range deepItems {
		if it.Type == ItemTypeThread {
			t.Fatalf("depth cap breached: a child thread was created below depth %d", maxThreadDepth)
		}
	}
	if got := w.doc.GetItemsLengthFromArray(deepest.arr); got != beforeLen+1 {
		t.Fatalf("expected exactly one item appended (the refusal), before=%d after=%d", beforeLen, got)
	}
	var refusal *ConversationItem
	for i := range deepItems {
		if deepItems[i].Type == ItemTypeMetaToolResult && deepItems[i].ToolUseID == "tu-deep" {
			refusal = &deepItems[i]
		}
	}
	if refusal == nil {
		t.Fatalf("expected a meta-tool-result refusal bound to tu-deep; items=%+v", deepItems)
	}
	if !refusal.IsError {
		t.Errorf("refusal meta-tool-result should be isError=true")
	}

	// The refusal must reach the LLM as a paired create_thread tool_use +
	// tool_result, never a dangling tool_use the provider would reject.
	msgs := w.currentRun().buildMessages(nil)
	var sawToolUse, sawResult bool
	for _, m := range msgs {
		if m["type"] == "tool-use" && m["toolUseId"] == "tu-deep" {
			sawToolUse = true
		}
		if m["type"] == "tool-result" && m["toolUseId"] == "tu-deep" {
			sawResult = true
		}
	}
	if !sawToolUse || !sawResult {
		t.Errorf("refusal must emit a paired tool_use+tool_result for tu-deep; sawToolUse=%v sawResult=%v", sawToolUse, sawResult)
	}

	// A spawn one level above the cap (depth maxThreadDepth-1) is allowed.
	parent := levels[len(levels)-2]
	w.turn.thread.itemID = parent.id
	w.turn.thread.itemsArray = parent.arr
	if err := w.currentRun().executeCreateThread("tu-ok", "create_thread", json.RawMessage(`{"goal":"ok","prompt":"work"}`)); err != nil {
		t.Fatalf("executeCreateThread (below cap) returned error: %v", err)
	}
	var spawned bool
	for _, it := range w.doc.GetItemsFromArray(parent.arr) {
		if it.Type == ItemTypeThread && it.ItemID != deepest.id {
			spawned = true
		}
	}
	if !spawned {
		t.Errorf("expected a child thread to be created below the depth cap")
	}
}

// TestThreadBreadthCap pins the runaway fan-out backstop: create_thread is
// refused once maxLiveThreads llmCreated children are already in flight, even
// though the nesting depth is well under maxThreadDepth. This is the case the
// depth cap alone misses — a model re-delegating the same task into ever more
// shallow siblings. Like the depth refusal, it must emit a paired
// meta-tool-result (never a dangling tool_use) and must not create the thread.
// The cap self-heals: once a child records a result, liveThreadCount drops and
// spawning is allowed again.
func TestThreadBreadthCap(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)

	// Fill the document with maxLiveThreads in-flight llmCreated siblings at
	// root (no result). These count toward liveThreadCount.
	root := w.doc.ensureItems()
	ids := make([]string, 0, maxLiveThreads)
	for i := 0; i < maxLiveThreads; i++ {
		w.doc.InsertThreadIntoArray(root, w.doc.GetItemsLengthFromArray(root), fmt.Sprintf("T%d", i))
		items := w.doc.GetItemsFromArray(root)
		id := items[len(items)-1].ItemID
		w.doc.SetThreadField(id, "llmCreated", true)
		ids = append(ids, id)
	}
	if got := w.doc.liveThreadCount(); got != maxLiveThreads {
		t.Fatalf("liveThreadCount = %d, want %d", got, maxLiveThreads)
	}

	// A create_thread from root (depth 0, far under the depth cap) is refused
	// purely because too many threads are already live.
	beforeLen := w.doc.GetItemsLengthFromArray(root)
	if err := w.currentRun().executeCreateThread("tu-breadth", "create_thread",
		json.RawMessage(`{"goal":"more","prompt":"spawn another"}`)); err != nil {
		t.Fatalf("executeCreateThread returned error: %v", err)
	}
	if got := w.doc.GetItemsLengthFromArray(root); got != beforeLen+1 {
		t.Fatalf("expected exactly one item appended (the refusal), before=%d after=%d", beforeLen, got)
	}
	rootItems := w.doc.GetItemsFromArray(root)
	var refusal *ConversationItem
	for i := range rootItems {
		if rootItems[i].Type == ItemTypeThread && rootItems[i].ItemID != "" {
			if !containsID(ids, rootItems[i].ItemID) {
				t.Fatalf("breadth cap breached: a new thread was created while %d were live", maxLiveThreads)
			}
		}
		if rootItems[i].Type == ItemTypeMetaToolResult && rootItems[i].ToolUseID == "tu-breadth" {
			refusal = &rootItems[i]
		}
	}
	if refusal == nil {
		t.Fatalf("expected a meta-tool-result refusal bound to tu-breadth")
	}
	if !refusal.IsError {
		t.Errorf("refusal meta-tool-result should be isError=true")
	}

	// The refusal reaches the LLM as a paired create_thread tool_use+tool_result.
	msgs := w.currentRun().buildMessages(nil)
	var sawToolUse, sawResult bool
	for _, m := range msgs {
		if m["type"] == "tool-use" && m["toolUseId"] == "tu-breadth" {
			sawToolUse = true
		}
		if m["type"] == "tool-result" && m["toolUseId"] == "tu-breadth" {
			sawResult = true
		}
	}
	if !sawToolUse || !sawResult {
		t.Errorf("refusal must emit a paired tool_use+tool_result for tu-breadth; sawToolUse=%v sawResult=%v", sawToolUse, sawResult)
	}

	// Self-heal: once one live thread records a result, the count drops below
	// the cap and a spawn is allowed again.
	w.doc.SetThreadField(ids[0], "result", "done")
	if got := w.doc.liveThreadCount(); got != maxLiveThreads-1 {
		t.Fatalf("liveThreadCount after one result = %d, want %d", got, maxLiveThreads-1)
	}
	if err := w.currentRun().executeCreateThread("tu-ok", "create_thread",
		json.RawMessage(`{"goal":"ok","prompt":"work"}`)); err != nil {
		t.Fatalf("executeCreateThread (below breadth cap) returned error: %v", err)
	}
	var spawned bool
	for _, it := range w.doc.GetItemsFromArray(root) {
		if it.Type == ItemTypeThread && !containsID(ids, it.ItemID) {
			spawned = true
		}
	}
	if !spawned {
		t.Errorf("expected a child thread to be created below the breadth cap")
	}
}

// containsID reports whether id is in ids.
func containsID(ids []string, id string) bool {
	for _, x := range ids {
		if x == id {
			return true
		}
	}
	return false
}

func TestBrowserCreateThreadUsesRequestedParentThread(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	w.currentRun().storeState(StateIdle)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "anthropic", "model": "claude-test"})

	// Some root history (threads are isolated, so this is not inherited).
	w.doc.AppendMessage(ConversationItem{Type: ItemTypeUser, ItemID: "root-user", Content: "Root context"})

	// Create a parent thread under root with one nested user message.
	parentItems := w.doc.InsertThreadIntoArray(w.doc.getItems(), w.doc.GetItemsLength(), "Parent thread")
	rootItems := w.doc.GetItems()
	parentThreadID := rootItems[len(rootItems)-1].ItemID
	w.doc.InsertMessageIntoArray(parentItems, 0, ConversationItem{
		Type:    ItemTypeUser,
		ItemID:  "parent-user",
		Content: "Parent context",
	})

	w.setMockResponses([]MockResponse{
		// Continuation child: the run settles on its trailing assistant text.
		{
			Blocks: []LLMResponseBlock{
				{Type: "text", Content: "Child completed."},
			},
			StopReason: "end_turn",
		},
	})

	go func() {
		ctxResponse, _ := json.Marshal(map[string]any{
			"type":         "render-context-items-result",
			"systemPrompt": "Test",
			"contexts":     []any{},
		})
		toolsResponse, _ := json.Marshal(map[string]any{
			"type":  "tools-result",
			"tools": []ToolDefinition{{Name: "create_thread"}},
		})
		w.engine.contextReply.inject(w.done, ctxResponse)
		w.engine.toolsReply.inject(w.done, toolsResponse)
	}()

	payload, _ := json.Marshal(CreateThreadMessage{
		Type:           "create-thread",
		RequestID:      "req-1",
		Goal:           "Child thread",
		Prompt:         "",
		ThreadItemID:   parentThreadID,
		IsContinuation: true,
	})

	w.currentRun().handleCreateThread(payload)
	w.quiesce(t)

	// Root should still contain exactly one thread: the parent.
	items := w.doc.GetItems()
	if len(items) != 2 {
		t.Fatalf("expected 2 root items (root user + parent thread), got %d", len(items))
	}
	if items[1].Type != ItemTypeThread || items[1].ItemID != parentThreadID {
		t.Fatalf("expected root child to remain parent thread %q, got %+v", parentThreadID, items[1])
	}

	childItems := w.doc.GetItemsFromArray(parentItems)
	if len(childItems) != 2 {
		t.Fatalf("expected parent thread to contain 2 items (existing user + child thread), got %d", len(childItems))
	}
	childThread := childItems[1]
	if childThread.Type != ItemTypeThread {
		t.Fatalf("expected nested child thread, got type %q", childThread.Type)
	}

	childThreadMap := w.doc.GetThreadYMap(childThread.ItemID)
	if childThreadMap == nil {
		t.Fatal("expected nested child thread Y.Map")
	}
	if result, _ := childThreadMap.Get("result").(string); result != "Child completed." {
		t.Fatalf("expected child thread result to be written, got %q", result)
	}

	// The continuation child was created under the requested parent thread,
	// not inserted as a new root-level thread.
	childArr := w.doc.GetThreadItemsArray(childThread.ItemID)
	if childArr == nil {
		t.Fatal("expected nested child thread items array")
	}
	childNestedItems := w.doc.GetItemsFromArray(childArr)
	if len(childNestedItems) == 0 {
		t.Fatal("expected continuation child thread to contain assistant output")
	}
	if childNestedItems[0].Type != ItemTypeAssistant || childNestedItems[0].Content != "Child completed." {
		t.Fatalf("expected child thread to start with assistant continuation output, got %+v", childNestedItems[0])
	}
	for _, item := range childNestedItems {
		if item.Type == ItemTypeUser {
			t.Fatalf("did not expect continuation child thread to contain a synthetic user message: %+v", item)
		}
	}

	w.doc.Destroy()
}

// TestThreadErrorReturnsToParent pins what an errored run owes its caller. The
// parent asked a question and is owed an answer; "the run stopped on this
// error" is an answer it can act on, so the run settles as an error carrying
// that text and the parent resumes. Nothing is fabricated on the thread's
// behalf: the error is an item in its history, it carries no summary, and it
// stays exactly as resumable as any other stopped thread.
func TestThreadErrorReturnsToParent(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})

	// Add a user message so the conversation isn't empty
	w.doc.AppendMessage(ConversationItem{
		Type:    ItemTypeUser,
		ItemID:  "msg-1",
		Content: "Hello",
	})

	// Mock: parent calls create_thread, the thread's LLM call fails (simulated
	// dropped connection), and the parent's continuation turn runs on the error
	// it gets back.
	w.setMockResponses([]MockResponse{
		// Parent turn 1: calls create_thread
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-1", Name: "create_thread", Input: json.RawMessage(`{"goal":"Error test","prompt":"Do the task"}`)},
			},
			StopReason: "tool_use",
		},
		// Thread turn: the provider errors (e.g. a dropped connection).
		{
			Error: "connection reset by peer",
		},
		// Parent turn 2: runs on the error the child returned.
		{
			Blocks: []LLMResponseBlock{
				{Type: "text", Content: "Continuing after thread."},
			},
			StopReason: "end_turn",
		},
	})

	go func() {
		ctxResponse, _ := json.Marshal(map[string]any{
			"type":         "render-context-items-result",
			"systemPrompt": "Test",
			"contexts":     []any{},
		})
		toolsResponse, _ := json.Marshal(map[string]any{
			"type":  "tools-result",
			"tools": []ToolDefinition{{Name: "create_thread"}},
		})
		// Parent turn 1 + thread turn (error). The buffered channels (cap 1)
		// absorb a third send harmlessly if the parent never resumes.
		for i := 0; i < 3; i++ {
			w.engine.contextReply.inject(w.done, ctxResponse)
			w.engine.toolsReply.inject(w.done, toolsResponse)
		}
	}()

	w.driveStrategyLoop(t, "Start", false)

	// After thread error:
	// 1. Thread context should be reset
	if w.turn.thread.itemID != "" {
		t.Errorf("thread.itemID should be empty after thread error, got %q", w.turn.thread.itemID)
	}
	if w.turn.thread.itemsArray != nil {
		t.Error("thread.itemsArray should be nil after thread error")
	}

	// 2. No summary was fabricated. A failure is not a result: the worker never
	//    passes one off as the thread's summary.
	items := w.doc.GetItems()
	var threadItemID string
	for _, item := range items {
		if item.Type == ItemTypeThread {
			threadItemID = item.ItemID
			break
		}
	}
	if threadItemID == "" {
		t.Fatal("no thread item found — create_thread did not insert a thread")
	}
	threadYMap := w.doc.GetThreadYMap(threadItemID)
	if threadYMap == nil {
		t.Fatal("expected thread Y.Map")
	}
	if result, _ := threadYMap.Get("result").(string); result != "" {
		t.Errorf("an errored run must not summarise the thread, but result was stamped: %q", result)
	}

	// 3. The error must be visible in the thread's history as an error item.
	//    This is exactly the state the user can review and resume from.
	threadArr := w.doc.GetThreadItemsArray(threadItemID)
	if threadArr == nil {
		t.Fatal("expected thread items array")
	}
	threadItems := w.doc.GetItemsFromArray(threadArr)
	foundErr := false
	for _, it := range threadItems {
		if it.Type == ItemTypeError && strings.Contains(it.Content, "connection reset by peer") {
			foundErr = true
			break
		}
	}
	if !foundErr {
		t.Errorf("expected the error to be visible as an error item in the thread, got items %+v", threadItems)
	}

	// 4. Worker should be idle
	if w.currentRun().loadState() != StateIdle {
		t.Errorf("worker state should be idle after error recovery, got %v", w.currentRun().loadState())
	}

	// 5. The conversation must be fully at rest — no LLM claim left dangling.
	if act := w.getActivity(); act != ActivityNone {
		t.Errorf("activity should be cleared (idle) after a child thread error, got %q", act)
	}

	// 6. The run settled as an error carrying the provider's own words, and the
	//    parent resumed on them. A run that never settles is a parent parked
	//    forever on a child that has already stopped.
	var status, runResult string
	ycrdtMu.Lock()
	status, runResult = latestRunOutcomeLocked(findThreadYMap(w.doc.getItems(), threadItemID))
	ycrdtMu.Unlock()
	if status != runStatusError {
		t.Errorf("run status = %q, want %q", status, runStatusError)
	}
	if !strings.Contains(runResult, "connection reset by peer") {
		t.Errorf("run result = %q, want the provider error text", runResult)
	}
	var resumed bool
	for _, item := range w.doc.GetItems() {
		if item.Type == ItemTypeAssistant && strings.Contains(item.Content, "Continuing after thread.") {
			resumed = true
		}
	}
	if !resumed {
		t.Errorf("parent must resume on the error its child returned; items=%+v", w.doc.GetItems())
	}

	w.doc.Destroy()
}

// =============================================================================
// NEEDS-STRATEGY-RUN THREAD AUTO-DETECTION TESTS
//
// These tests verify that checkForNewThreads correctly processes threads
// marked with needsStrategyRun=true and ignores all other threads.
// =============================================================================

// threadOpts configures a test thread.
type threadOpts struct {
	goal             string
	needsStrategyRun bool
	noAutoSelect     bool // If set, thread folds in place (e.g. /compact)
	userMessage      string
	result           string // If set, thread is pre-completed
	forceTool        string // If set, thread forces the model to call this tool
	llmCreated       bool   // If set, marks the thread as LLM tool-created
	canSpawnThreads  bool   // If set, thread's LLM may itself use create_thread
	delegated        bool   // If set, marks the thread as delegatesToSubthread-spawned
	// boundedCompaction, if set, marks the thread as a browser /compact fold: it
	// carries the boundedCompaction flag and a compactionPromptItemId pointing at
	// an appended summarization-prompt item, so the worker summarizes it with the
	// bounded reducer instead of an ordinary strategy turn.
	boundedCompaction bool
}

// insertThreadWithOpts creates a thread in the doc in a single transaction
// to avoid observer races. Returns the thread itemId.
func insertThreadWithOpts(w *ConversationWorker, opts threadOpts) string {
	threadItemID := generateItemID()
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		item := ConversationItem{
			Type:   ItemTypeThread,
			ItemID: threadItemID,
			Goal:   opts.goal,
		}
		compactionPromptID := ""
		if opts.boundedCompaction {
			compactionPromptID = generateItemID()
			item.BoundedCompaction = true
			item.CompactionPromptItemID = compactionPromptID
		}
		ymap := conversationItemToYMap(item)
		yarr := ycrdt.NewYArray()
		ymap.Set("items", yarr)
		if opts.needsStrategyRun {
			ymap.Set("needsStrategyRun", true)
		}
		if opts.noAutoSelect {
			ymap.Set("noAutoSelect", true)
		}
		if opts.result != "" {
			ymap.Set("result", opts.result)
		}
		if opts.forceTool != "" {
			ymap.Set("forceTool", opts.forceTool)
		}
		if opts.llmCreated {
			ymap.Set("llmCreated", true)
		}
		if opts.canSpawnThreads {
			ymap.Set("canSpawnThreads", true)
		}
		if opts.delegated {
			ymap.Set("delegated", true)
		}
		if opts.userMessage != "" {
			userItem := ConversationItem{
				Type:    ItemTypeUser,
				ItemID:  generateItemID(),
				Content: opts.userMessage,
			}
			yarr.Push(ycrdt.ArrayAny{conversationItemToYMap(userItem)})
		}
		if compactionPromptID != "" {
			yarr.Push(ycrdt.ArrayAny{conversationItemToYMap(ConversationItem{
				Type: ItemTypeUser, ItemID: compactionPromptID, Content: "Summarize this conversation",
			})})
		}
		w.doc.ensureItems().Push(ycrdt.ArrayAny{ymap})
	}, w.doc.authorID)
	// Fire handleItemsChange synchronously (the docChangeChan path only runs
	// when run() is active; tests drive the observer inline here).
	w.currentRun().handleItemsChange()
	return threadItemID
}

// TestSettledRunRecordsWhatItCostAndReturned pins the two figures the tile
// makes the delegation economics legible with. A sub-thread does not inherit
// the parent transcript and hands back only its final answer, so a child that
// reads a great deal costs the parent almost nothing — but nothing said so, and
// users talked themselves out of delegating because of it. Both figures are
// stamped at settle so no tile needs a fetch to show them.
func TestSettledRunRecordsWhatItCostAndReturned(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	threadID := insertThreadWithOpts(w, threadOpts{goal: "Read the files", userMessage: "read them"})
	w.turn.thread.itemID = threadID
	w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)

	w.currentRun().appendTargetMessage(ConversationItem{
		Type: ItemTypeAssistant, ItemID: generateItemID(), Content: strings.Repeat("file contents ", 4000),
	})
	w.currentRun().appendTargetMessage(ConversationItem{
		Type: ItemTypeAssistant, ItemID: generateItemID(), Content: "Auth lives in auth.go.",
	})
	w.settleThreadRun(threadID, false)

	ymap := w.doc.GetThreadYMap(threadID)
	ycrdtMu.Lock()
	contextTokens, okContext := ymap.Get("contextTokens").(ycrdt.Number)
	resultTokens, okResult := ymap.Get("resultTokens").(ycrdt.Number)
	ycrdtMu.Unlock()
	if !okContext || !okResult {
		t.Fatal("a settled run must record what the thread's own context cost and what it handed back")
	}
	if contextTokens < 10_000 {
		t.Fatalf("contextTokens = %v, want the whole transcript the child built", contextTokens)
	}
	if resultTokens <= 0 || resultTokens > contextTokens/100 {
		t.Fatalf("resultTokens = %v against context %v, want only the answer handed to the parent", resultTokens, contextTokens)
	}
}

// TestSettledRunSummarisesThread pins who owns the thread's summary: the run
// that comes to rest, and nothing else. The summary is the last thing the
// thread said, so it needs no author and no protection — a later run simply
// says something later.
func TestSettledRunSummarisesThread(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	threadID := insertThreadWithOpts(w, threadOpts{goal: "Work", userMessage: "do it"})
	w.turn.thread.itemID = threadID
	w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)
	reply := func(text string) {
		w.currentRun().appendTargetMessage(ConversationItem{
			Type: ItemTypeAssistant, ItemID: generateItemID(), Content: text,
		})
	}

	reply("Did the work, here is the summary.")
	w.settleThreadRun(threadID, false)
	ymap := w.doc.GetThreadYMap(threadID)
	if result, _ := ymap.Get("result").(string); result != "Did the work, here is the summary." {
		t.Fatalf("thread result = %q, want the trailing reply", result)
	}

	// Run again: the newer reply is the summary.
	w.currentRun().appendTargetMessage(ConversationItem{
		Type: ItemTypeUser, ItemID: generateItemID(), Content: "one more thing",
	})
	reply("Did the extra thing.")
	w.settleThreadRun(threadID, false)
	if result, _ := ymap.Get("result").(string); result != "Did the extra thing." {
		t.Fatalf("thread result = %q, want the latest run's reply", result)
	}

	// A run that did not come to rest returns its outcome to the caller and
	// leaves the summary standing rather than passing failure off as a result.
	w.currentRun().appendTargetMessage(ConversationItem{
		Type: ItemTypeUser, ItemID: generateItemID(), Content: "and again",
	})
	w.currentRun().appendTargetMessage(ConversationItem{
		Type: ItemTypeError, ItemID: generateItemID(), Content: "invalid request: bad model",
	})
	w.settleThreadRun(threadID, false)
	if result, _ := ymap.Get("result").(string); result != "Did the extra thing." {
		t.Fatalf("thread result = %q, want the last real answer left alone", result)
	}
}

// TestFilterToolsForThread verifies the canSpawnThreads capability rule at the
// worker boundary: create_thread is offered to root and to user-created
// (/thread, canSpawnThreads=true) threads, and withheld from every other thread
// — LLM-created children, and compaction-shaped threads carrying neither
// llmCreated nor strategyCreated (the auto-compact regression). Other tools and
// their order are always preserved. The final case asserts the wiring through
// buildLLMRequest (call site + ordering vs. the forced-tool resolve).
//
// The filter's other rule — withholding delegation-only tools — is owned by
// TestDelegationBlockedDrivesBothConsumers, which has to assert it against the
// delegation path in the same breath.
func TestFilterToolsForThread(t *testing.T) {
	tools := []ToolDefinition{
		{Name: "bash", Description: "Run bash", InputSchema: json.RawMessage(`{"type":"object"}`)},
		{Name: "create_thread", Description: "Spawn a thread", InputSchema: json.RawMessage(`{"type":"object"}`)},
		{Name: "read", Description: "Read a file", InputSchema: json.RawMessage(`{"type":"object"}`)},
	}
	hasCreateThread := func(ts []ToolDefinition) bool {
		for _, t := range ts {
			if t.Name == "create_thread" {
				return true
			}
		}
		return false
	}
	otherToolsIntact := func(t *testing.T, ts []ToolDefinition) {
		t.Helper()
		var names []string
		for _, td := range ts {
			if td.Name != "create_thread" {
				names = append(names, td.Name)
			}
		}
		if len(names) != 2 || names[0] != "bash" || names[1] != "read" {
			t.Errorf("other tools not intact/ordered: got %v, want [bash read]", names)
		}
	}

	t.Run("root scope keeps create_thread", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		w.turn.thread.itemID = "" // root
		got := w.currentRun().filterToolsForThread(tools)
		if !hasCreateThread(got) {
			t.Error("root scope must keep create_thread")
		}
		otherToolsIntact(t, got)
	})

	t.Run("restricted llm-created thread withholds create_thread", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		threadID := insertThreadWithOpts(w, threadOpts{goal: "Delegated", llmCreated: true})
		w.turn.thread.itemID = threadID
		got := w.currentRun().filterToolsForThread(tools)
		if hasCreateThread(got) {
			t.Error("llm-created thread must not see create_thread")
		}
		otherToolsIntact(t, got)
	})

	t.Run("user thread with canSpawnThreads keeps create_thread", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		threadID := insertThreadWithOpts(w, threadOpts{goal: "User", canSpawnThreads: true})
		w.turn.thread.itemID = threadID
		got := w.currentRun().filterToolsForThread(tools)
		if !hasCreateThread(got) {
			t.Error("canSpawnThreads thread must keep create_thread")
		}
		otherToolsIntact(t, got)
	})

	// Regression for the auto-compact incident: a client-side fold thread carries
	// neither llmCreated nor strategyCreated nor canSpawnThreads, so it must be
	// restricted purely by absence of the flag. Asserted through buildLLMRequest.
	t.Run("compaction-shaped thread withholds create_thread via buildLLMRequest", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
		threadID := insertThreadWithOpts(w, threadOpts{goal: "Compaction fold"})
		w.turn.thread.itemID = threadID

		raw := w.currentRun().buildLLMRequest(&ContextResult{SystemPrompt: "sys"}, tools, "txn-compact", false)
		var req struct {
			Tools []ToolDefinition `json:"tools"`
		}
		if err := json.Unmarshal(raw, &req); err != nil {
			t.Fatalf("unmarshal request: %v", err)
		}
		if hasCreateThread(req.Tools) {
			t.Error("compaction-shaped thread must not see create_thread in the built request")
		}
		otherToolsIntact(t, req.Tools)
	})
}

// TestPromoteThreadSpawnCapable verifies the "human-steered ⇒ spawn-capable"
// promotion: a genuine user message into an LLM-created leaf thread stamps
// canSpawnThreads (so its own agent may then create_thread), while root and
// delegated threads are never promoted, and an already-capable thread is a no-op.
func TestPromoteThreadSpawnCapable(t *testing.T) {
	canSpawn := func(w *ConversationWorker, id string) bool {
		m := w.doc.GetThreadYMap(id)
		if m == nil {
			return false
		}
		ycrdtMu.Lock()
		defer ycrdtMu.Unlock()
		v, _ := m.Get("canSpawnThreads").(bool)
		return v
	}

	t.Run("llm-created leaf is promoted when user steers it", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		id := insertThreadWithOpts(w, threadOpts{goal: "Leaf", llmCreated: true})
		if canSpawn(w, id) {
			t.Fatal("precondition: llm-created leaf must not start spawn-capable")
		}
		w.promoteThreadSpawnCapable(id)
		if !canSpawn(w, id) {
			t.Error("user-steered llm-created thread must become spawn-capable")
		}
	})

	t.Run("root is never promoted", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		w.promoteThreadSpawnCapable("") // must not panic; root has the full list already
	})

	t.Run("delegated subthread is never promoted", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		id := insertThreadWithOpts(w, threadOpts{goal: "Delegated", delegated: true})
		w.promoteThreadSpawnCapable(id)
		if canSpawn(w, id) {
			t.Error("delegated subthread must not be promoted (decision #3)")
		}
	})

	t.Run("already-capable thread stays capable (idempotent)", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		id := insertThreadWithOpts(w, threadOpts{goal: "User", canSpawnThreads: true})
		w.promoteThreadSpawnCapable(id)
		if !canSpawn(w, id) {
			t.Error("already spawn-capable thread must remain spawn-capable")
		}
	})
}
