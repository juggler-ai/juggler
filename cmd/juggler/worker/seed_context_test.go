//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
)

// sysPromptItem builds a system-prompt context item (root's canonical shape)
// carrying a custom data.text, so tests can assert the editable snapshot
// propagates through a clone.
func sysPromptItem(id, text string) ConversationItem {
	data, _ := json.Marshal(map[string]any{"text": text, "selectedPresetId": "default"})
	return ConversationItem{
		Type:                ItemTypeSystemPrompt,
		ItemID:              id,
		Data:                data,
		PreventUserDeletion: true,
	}
}

// dataText reads item.Data's "text" field.
func dataText(t *testing.T, item ConversationItem) string {
	t.Helper()
	if len(item.Data) == 0 {
		return ""
	}
	var d map[string]any
	if err := json.Unmarshal(item.Data, &d); err != nil {
		t.Fatalf("data unmarshal: %v", err)
	}
	s, _ := d["text"].(string)
	return s
}

// seedableRoot appends a canonical starting-context run to root — system
// prompt, an agents file, memory — followed by a user message and then two
// items that must NOT be seeded: a context item pinned mid-conversation and a
// tool-minted context item. Returns the root array.
func seedableRoot(doc *ConversationDocument, sysText string) {
	doc.AppendMessage(
		sysPromptItem("SYSTEM_1", sysText),
		ConversationItem{Type: "file-content", ItemID: "agents-1", Content: "CLAUDE.md"},
		ConversationItem{Type: "memory", ItemID: "mem-1", Content: "remembered fact"},
		ConversationItem{Type: ItemTypeUser, ItemID: "u-1", Content: "hello"},
		ConversationItem{Type: "file-content", ItemID: "pin-1", Content: "pinned mid-convo"},
		ConversationItem{Type: "file-content", ItemID: "tool-1", Content: "tool output", ToolUseID: "tu-x"},
	)
}

func TestSeedThreadFromParentClonesStartingContext(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")
	defer doc.Destroy()
	root := doc.ensureItems()
	seedableRoot(doc, "custom identity")

	childArr := doc.InsertThreadIntoArray(root, doc.GetItemsLengthFromArray(root), "child")
	doc.SeedThreadFromParent(root, childArr, nil)

	items := doc.GetItemsFromArray(childArr)
	if len(items) != 3 {
		t.Fatalf("expected 3 seeded items (system prompt, agents, memory), got %d: %+v", len(items), items)
	}

	// Order preserved: system prompt, then agents, then memory.
	if items[0].Type != ItemTypeSystemPrompt {
		t.Errorf("item[0] type = %q, want system-prompt", items[0].Type)
	}
	if items[1].Type != "file-content" || items[1].Content != "CLAUDE.md" {
		t.Errorf("item[1] = %+v, want the agents file", items[1])
	}
	if items[2].Type != "memory" {
		t.Errorf("item[2] type = %q, want memory", items[2].Type)
	}

	// Fresh ids — never the literal SYSTEM_1 or the parent's ids (duplicate ids
	// are fatal: the frontend/worker dedupe by id).
	for _, it := range items {
		switch it.ItemID {
		case "", "SYSTEM_1", "agents-1", "mem-1":
			t.Errorf("seeded item kept a non-fresh id: %q", it.ItemID)
		}
	}

	// The cloned system prompt keeps preventUserDeletion and its editable data.
	if !items[0].PreventUserDeletion {
		t.Errorf("cloned system prompt lost preventUserDeletion")
	}
	if got := dataText(t, items[0]); got != "custom identity" {
		t.Errorf("cloned system prompt data.text = %q, want %q", got, "custom identity")
	}

	// Mid-conversation and tool-minted context items are NOT seeded.
	for _, it := range items {
		if it.Content == "pinned mid-convo" || it.ToolUseID != "" {
			t.Errorf("unexpectedly seeded a non-starting-context item: %+v", it)
		}
	}
}

func TestSeedThreadFromParentNoSeedItems(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")
	defer doc.Destroy()
	root := doc.ensureItems()
	// Only a conversational item at root — nothing to seed.
	doc.AppendMessage(ConversationItem{Type: ItemTypeUser, ItemID: "u-1", Content: "hi"})

	childArr := doc.InsertThreadIntoArray(root, doc.GetItemsLengthFromArray(root), "child")
	doc.SeedThreadFromParent(root, childArr, nil)

	if got := doc.GetItemsLengthFromArray(childArr); got != 0 {
		t.Fatalf("expected no seeded items, got %d", got)
	}
}

func TestGetContextItemIDsForThreadOwnItemsOnly(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")
	defer doc.Destroy()
	root := doc.ensureItems()
	seedableRoot(doc, "identity")

	childArr := doc.InsertThreadIntoArray(root, doc.GetItemsLengthFromArray(root), "child")
	doc.SeedThreadFromParent(root, childArr, nil)
	// A context item produced by a tool running inside the child.
	doc.InsertMessageIntoArray(childArr, doc.GetItemsLengthFromArray(childArr),
		ConversationItem{Type: "file-content", ItemID: "child-ctx-1", Content: "child read this"})

	// Resolve the child's thread id.
	childID := doc.GetItemsFromArray(root)[6].ItemID // index 6 == the thread item (after 6 root items)
	if childID == "" {
		t.Fatalf("could not resolve child thread id")
	}

	ids := doc.GetContextItemIDsForThread(childID)

	// Must contain the child's own seeded ids + its tool item, and NOT root's
	// canonical SYSTEM_1 / agents / memory / user ids.
	got := map[string]bool{}
	for _, id := range ids {
		got[id] = true
	}
	for _, rootID := range []string{"SYSTEM_1", "agents-1", "mem-1", "u-1", "pin-1", "tool-1"} {
		if got[rootID] {
			t.Errorf("sub-thread context leaked root item id %q", rootID)
		}
	}
	if !got["child-ctx-1"] {
		t.Errorf("sub-thread context missing its own item child-ctx-1; got %v", ids)
	}
	// Three seeds + one child item.
	if len(ids) != 4 {
		t.Errorf("expected 4 context ids (3 seeds + 1 own), got %d: %v", len(ids), ids)
	}

	// Root still renders every root item.
	rootIDs := doc.GetContextItemIDsForThread("")
	rootGot := map[string]bool{}
	for _, id := range rootIDs {
		rootGot[id] = true
	}
	for _, rootID := range []string{"SYSTEM_1", "agents-1", "mem-1", "u-1", "pin-1", "tool-1"} {
		if !rootGot[rootID] {
			t.Errorf("root context missing %q", rootID)
		}
	}
}

func TestCreateThreadSeedsChildEagerly(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	seedableRoot(w.doc, "identity")

	threadID, err := w.currentRun().spawnThread(threadSpec{Goal: "child", Prompt: "do the thing"}, toolSpawn{})
	if err != nil {
		t.Fatalf("spawnThread: %v", err)
	}

	childArr := w.doc.GetThreadItemsArray(threadID)
	items := w.doc.GetItemsFromArray(childArr)
	if len(items) != 4 {
		t.Fatalf("expected 3 seeds + 1 prompt, got %d: %+v", len(items), items)
	}
	if items[0].Type != ItemTypeSystemPrompt {
		t.Errorf("first child item = %q, want the seeded system prompt", items[0].Type)
	}
	// Prompt is appended AFTER the seeds.
	last := items[len(items)-1]
	if last.Type != ItemTypeUser || last.Content != "do the thing" {
		t.Errorf("last child item = %+v, want the user prompt after seeds", last)
	}
}

func TestCreateThreadContinuationDoesNotSeed(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	seedableRoot(w.doc, "identity")

	threadID, err := w.currentRun().spawnThread(threadSpec{Goal: "cont", IsContinuation: true}, toolSpawn{})
	if err != nil {
		t.Fatalf("spawnThread: %v", err)
	}
	childArr := w.doc.GetThreadItemsArray(threadID)
	if got := w.doc.GetItemsLengthFromArray(childArr); got != 0 {
		t.Fatalf("continuation must not seed; got %d items", got)
	}
}

func TestSeedThreadIfUnseededLazyAndIdempotent(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")
	defer doc.Destroy()
	root := doc.ensureItems()
	seedableRoot(doc, "identity")

	// Client-created / legacy sub-thread: a thread inserted directly with only
	// its own user message, never routed through insertThread's eager seeding.
	childArr := doc.InsertThreadIntoArray(root, doc.GetItemsLengthFromArray(root), "child")
	doc.InsertMessageIntoArray(childArr, 0, ConversationItem{Type: ItemTypeUser, ItemID: "cu-1", Content: "task"})
	childID := doc.GetItemsFromArray(root)[6].ItemID

	// Before: no system-prompt item.
	doc.SeedThreadIfUnseeded(childID)
	items := doc.GetItemsFromArray(childArr)
	sysCount := 0
	for _, it := range items {
		if it.Type == ItemTypeSystemPrompt {
			sysCount++
		}
	}
	if sysCount != 1 {
		t.Fatalf("lazy seed must add exactly one system prompt, got %d (items=%+v)", sysCount, items)
	}
	// Seeds land at the head, user message stays last.
	if items[0].Type != ItemTypeSystemPrompt {
		t.Errorf("lazy seeds should be at the head; item[0]=%q", items[0].Type)
	}
	if items[len(items)-1].ItemID != "cu-1" {
		t.Errorf("the thread's own message should follow the seeds")
	}
	lenAfterFirst := len(items)

	// Idempotent: a second turn's guard is a no-op.
	doc.SeedThreadIfUnseeded(childID)
	if got := doc.GetItemsLengthFromArray(childArr); got != lenAfterFirst {
		t.Fatalf("re-seeding duplicated items: %d -> %d", lenAfterFirst, got)
	}
}

// TestSeedThreadIfUnseededParentWithoutSystemPrompt pins the idempotency of the
// per-turn backstop against a parent that owns NO system-prompt item — the shape
// of a conversation whose root never received the canonical SYSTEM_1. The seed
// set is then agents file + memory and nothing else, so seeding can never make a
// system-prompt item appear in the child: any idempotency key read off the
// child's items answers "unseeded" forever and every turn prepends another copy
// of the parent's starting context.
func TestSeedThreadIfUnseededParentWithoutSystemPrompt(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")
	defer doc.Destroy()
	root := doc.ensureItems()
	doc.AppendMessage(
		ConversationItem{Type: "file-content", ItemID: "agents-1", Content: "CLAUDE.md"},
		ConversationItem{Type: "memory", ItemID: "mem-1", Content: "remembered fact"},
		ConversationItem{Type: ItemTypeUser, ItemID: "u-1", Content: "hello"},
	)

	childArr := doc.InsertThreadIntoArray(root, doc.GetItemsLengthFromArray(root), "child")
	doc.InsertMessageIntoArray(childArr, 0, ConversationItem{Type: ItemTypeUser, ItemID: "cu-1", Content: "task"})
	childID := doc.GetItemsFromArray(root)[3].ItemID

	// One seed, then two more turns' worth of backstop calls.
	for turn := 1; turn <= 3; turn++ {
		doc.SeedThreadIfUnseeded(childID)
		items := doc.GetItemsFromArray(childArr)
		if len(items) != 3 {
			t.Fatalf("turn %d: expected 2 seeds + the thread's own message, got %d: %+v", turn, len(items), items)
		}
		if items[0].Content != "CLAUDE.md" || items[1].Type != "memory" || items[2].ItemID != "cu-1" {
			t.Fatalf("turn %d: unexpected item order: %+v", turn, items)
		}
	}
}

// TestSeedThreadIfUnseededSkipsRunningThread pins the upgrade path: a thread
// already part-way through its work is never seeded, whatever its items look
// like. Threads left mid-conversation in existing documents reach the backstop
// with turns behind them and no mark, and cloning the parent's standing context
// into them at that point would drop a system prompt and an agents file into the
// middle of a conversation that has been running without them.
func TestSeedThreadIfUnseededSkipsRunningThread(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")
	defer doc.Destroy()
	root := doc.ensureItems()
	doc.AppendMessage(
		ConversationItem{Type: "file-content", ItemID: "agents-1", Content: "CLAUDE.md"},
		ConversationItem{Type: "memory", ItemID: "mem-1", Content: "remembered fact"},
		ConversationItem{Type: ItemTypeUser, ItemID: "u-1", Content: "hello"},
	)

	childArr := doc.InsertThreadIntoArray(root, doc.GetItemsLengthFromArray(root), "child")
	doc.InsertMessageIntoArray(childArr, 0,
		ConversationItem{Type: ItemTypeUser, ItemID: "cu-1", Content: "task"},
		ConversationItem{Type: ItemTypeAssistant, ItemID: "ca-1", Content: "on it"},
		ConversationItem{Type: ItemTypeToolAction, ItemID: "ct-1", ToolName: "read"})
	childID := doc.GetItemsFromArray(root)[3].ItemID

	before := doc.GetItemsLengthFromArray(childArr)
	doc.SeedThreadIfUnseeded(childID)
	if got := doc.GetItemsLengthFromArray(childArr); got != before {
		t.Fatalf("a thread with turns behind it must not be seeded: %d -> %d", before, got)
	}
	// And it is marked, so the check is paid for once rather than every turn.
	if seeded, _ := doc.GetThreadYMap(childID).Get(threadContextSeededField).(bool); !seeded {
		t.Errorf("a skipped thread should still be marked seeded")
	}
}

// TestCreateThreadEagerSeedSurvivesBackstop pins the other half: a thread seeded
// eagerly at creation is left alone by the per-turn backstop, so the two seeding
// paths cannot both fire on one thread.
func TestCreateThreadEagerSeedSurvivesBackstop(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	seedableRoot(w.doc, "identity")

	threadID, err := w.currentRun().spawnThread(threadSpec{Goal: "child", Prompt: "do the thing"}, toolSpawn{})
	if err != nil {
		t.Fatalf("spawnThread: %v", err)
	}
	childArr := w.doc.GetThreadItemsArray(threadID)
	before := w.doc.GetItemsLengthFromArray(childArr)

	w.doc.SeedThreadIfUnseeded(threadID)
	if got := w.doc.GetItemsLengthFromArray(childArr); got != before {
		t.Fatalf("backstop re-seeded an eagerly seeded thread: %d -> %d", before, got)
	}
}

// TestSeedThreadIfUnseededSkipsNoContextSeed pins the general fold/move-into-
// thread exemption: a thread populated by relocating a parent's items (marked
// noContextSeed) is never auto-seeded, even though it owns no system-prompt item
// — because seeding would re-inject the standing context the fold deliberately
// kept at the parent. The exemption keys on noContextSeed, NOT noAutoSelect (a
// tab-selection concern), so this thread is left auto-selectable and still opts
// out.
func TestSeedThreadIfUnseededSkipsNoContextSeed(t *testing.T) {
	doc := NewConversationDocument("test-conv", "user:test")
	defer doc.Destroy()
	root := doc.ensureItems()
	seedableRoot(doc, "identity")

	// A folded summary thread: pre-populated with moved content + a prompt, no
	// system-prompt item, and flagged noContextSeed. Deliberately NOT
	// noAutoSelect, to prove the exemption is decoupled from tab selection.
	childArr := doc.InsertThreadIntoArray(root, doc.GetItemsLengthFromArray(root), "Compacted history")
	doc.InsertMessageIntoArray(childArr, 0,
		ConversationItem{Type: ItemTypeUser, ItemID: "moved-1", Content: "moved message"},
		ConversationItem{Type: ItemTypeUser, ItemID: "prompt-1", Content: "summarize this"})
	childID := doc.GetItemsFromArray(root)[6].ItemID
	doc.SetThreadField(childID, "noContextSeed", true)

	before := doc.GetItemsLengthFromArray(childArr)
	doc.SeedThreadIfUnseeded(childID)
	if got := doc.GetItemsLengthFromArray(childArr); got != before {
		t.Fatalf("noContextSeed thread must not be seeded: %d -> %d", before, got)
	}
	for _, it := range doc.GetItemsFromArray(childArr) {
		if it.Type == ItemTypeSystemPrompt {
			t.Errorf("noContextSeed thread wrongly received a seeded system prompt")
		}
	}
}

func TestSeedChainPropagatesCustomization(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateProcessing)
	seedableRoot(w.doc, "root-identity")

	// Child seeded from root carries root's identity.
	childID, err := w.currentRun().spawnThread(threadSpec{Goal: "child", Prompt: "c"}, toolSpawn{})
	if err != nil {
		t.Fatalf("createThread child: %v", err)
	}
	childArr := w.doc.GetThreadItemsArray(childID)
	childItems := w.doc.GetItemsFromArray(childArr)
	if got := dataText(t, childItems[0]); got != "root-identity" {
		t.Fatalf("child system prompt text = %q, want root-identity", got)
	}

	// Customize the child's own clone.
	custom, _ := json.Marshal(map[string]any{"text": "child-identity", "selectedPresetId": "default"})
	var customMap map[string]any
	_ = json.Unmarshal(custom, &customMap)
	if err := w.doc.UpdateItemByIDInArray(childArr, childItems[0].ItemID, "data", customMap); err != nil {
		t.Fatalf("update child clone: %v", err)
	}

	// Grandchild seeded from the child inherits the child's customization.
	gcID, err := w.currentRun().spawnThread(threadSpec{Goal: "gc", Prompt: "g", ParentThreadItemID: childID}, toolSpawn{})
	if err != nil {
		t.Fatalf("createThread grandchild: %v", err)
	}
	gcArr := w.doc.GetThreadItemsArray(gcID)
	gcItems := w.doc.GetItemsFromArray(gcArr)
	if len(gcItems) == 0 || gcItems[0].Type != ItemTypeSystemPrompt {
		t.Fatalf("grandchild not seeded with a system prompt: %+v", gcItems)
	}
	if got := dataText(t, gcItems[0]); got != "child-identity" {
		t.Errorf("grandchild system prompt text = %q, want child-identity (customization propagated from parent)", got)
	}
}
