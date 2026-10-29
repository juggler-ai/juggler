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
