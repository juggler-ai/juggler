//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package worker

// The tests beside worker_threads_test.go that need a test-capable build: the
// scripted provider or another //go:build !production seam.

import (
	"encoding/json"
	"strings"
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

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
	w.sched.markReconcile(reconcileTestDriven)
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

	// Mock: parent calls create_thread, the thread's LLM call fails with an
	// error no retry can clear, and the parent's continuation turn runs on the
	// error it gets back.
	w.setMockResponses([]MockResponse{
		// Parent turn 1: calls create_thread
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-1", Name: "create_thread", Input: json.RawMessage(`{"goal":"Error test","prompt":"Do the task"}`)},
			},
			StopReason: "tool_use",
		},
		// Thread turn: the provider rejects the request.
		{
			Error: "invalid request: the prompt was rejected",
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
		if it.Type == ItemTypeError && strings.Contains(it.Content, "the prompt was rejected") {
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
	if !strings.Contains(runResult, "the prompt was rejected") {
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

// TestRetriedChildErrorWakesTheParent is the human half of
// TestThreadErrorReturnsToParent. The parent has read its child's error and
// answered it; the user then retries the child, and it succeeds. That run reaches
// the parent as a receipt — the call's error is committed history — and the
// parent must take it up on its own: it was told the work failed, and the work
// it was waiting on is now done. A parent left resting here sits on the error
// for good while the answer it needed stands below it unread.
func TestRetriedChildErrorWakesTheParent(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	w.doc.SetMetadata("defaultModelConfig", map[string]any{"provider": "test", "model": "test"})
	w.doc.AppendMessage(ConversationItem{Type: ItemTypeUser, ItemID: "msg-1", Content: "Hello"})

	ctxResponse, _ := json.Marshal(map[string]any{
		"type":         "render-context-items-result",
		"systemPrompt": "Test",
		"contexts":     []any{},
	})
	toolsResponse, _ := json.Marshal(map[string]any{
		"type":  "tools-result",
		"tools": []ToolDefinition{{Name: "create_thread"}},
	})
	feed := func(turns int) {
		go func() {
			for i := 0; i < turns; i++ {
				w.engine.contextReply.inject(w.done, ctxResponse)
				w.engine.toolsReply.inject(w.done, toolsResponse)
			}
		}()
	}

	w.setMockResponses([]MockResponse{
		{
			Blocks: []LLMResponseBlock{
				{Type: "tool_use", ID: "tu-1", Name: "create_thread", Input: json.RawMessage(`{"goal":"Find auth","prompt":"Find the auth flow"}`)},
			},
			StopReason: "tool_use",
		},
		{Error: "invalid request: bad model"},
		{
			Blocks:     []LLMResponseBlock{{Type: "text", Content: "The subthread failed."}},
			StopReason: "end_turn",
		},
	})
	feed(3)
	w.driveStrategyLoop(t, "Start", false)

	var threadID string
	for _, item := range w.doc.GetItems() {
		if item.Type == ItemTypeThread {
			threadID = item.ItemID
		}
	}
	if threadID == "" {
		t.Fatal("no thread item found — create_thread did not insert a thread")
	}

	// The user retries the child, and this time it answers.
	w.setMockResponses([]MockResponse{
		{
			Blocks:     []LLMResponseBlock{{Type: "text", Content: "Auth lives in auth.go."}},
			StopReason: "end_turn",
		},
		{
			Blocks:     []LLMResponseBlock{{Type: "text", Content: "Picked up the retried result."}},
			StopReason: "end_turn",
		},
	})
	feed(2)
	w.currentRun().storeState(StateIdle)
	sendMsg(t, w, SendMessageMessage{ThreadItemID: threadID, IsContinuation: true})
	w.quiesce(t)

	items := w.doc.GetItems()
	var receipt ConversationItem
	for _, item := range items {
		if isReceiptItem(item) && item.AliasOf == threadID {
			receipt = item
		}
	}
	if !receipt.RecoversError {
		t.Fatalf("the retried run must reach the parent as a receipt that recovers its error, got %+v", receipt)
	}
	if last := items[len(items)-1]; last.Type != ItemTypeAssistant || !strings.Contains(last.Content, "Picked up the retried result.") {
		t.Errorf("the parent must take up the retried run on its own; it ends on %+v", last)
	}
	if left := w.mock().remaining(); left != 0 {
		t.Errorf("%d scripted response(s) never used — the parent did not run its turn", left)
	}
}
