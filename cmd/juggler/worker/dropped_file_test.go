//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"strings"
	"testing"
)

// TestDropContextItemsHidesDroppedFile: a dropped file's bytes exist only in its
// item, so drop_context_items must hide it, keeping the content for
// restore_dropped_file, while any other context item is still deleted.
func TestDropContextItemsHidesDroppedFile(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()

	w.tracker.InsertMessage(0, ConversationItem{
		Type:   "rule",
		ItemID: "RULE_1",
		Data:   []byte(`{"text":"x"}`),
	})
	w.tracker.InsertMessage(1, ConversationItem{
		Type:   ItemTypeDroppedFile,
		ItemID: "DROP_1",
		Data:   []byte(`{"filename":"11.js","content":"let a = 1;\n"}`),
	})

	msg, err := w.execDropContextItems(map[string]any{keyItemIDs: []any{"RULE_1", "DROP_1"}})
	if err != nil {
		t.Fatalf("execDropContextItems: %v", err)
	}
	if msg != "Dropped 2 context items" {
		t.Errorf("message = %q, want both items counted", msg)
	}

	items := w.doc.GetItems()
	if len(items) != 1 || items[0].ItemID != "DROP_1" {
		t.Fatalf("want only DROP_1 left, got %+v", items)
	}
	var data struct {
		Filename string `json:"filename"`
		Content  string `json:"content"`
		Hidden   bool   `json:"hidden"`
	}
	if err := json.Unmarshal(items[0].Data, &data); err != nil {
		t.Fatalf("unmarshal data: %v", err)
	}
	if !data.Hidden {
		t.Error("dropped file not marked hidden")
	}
	if data.Content != "let a = 1;\n" || data.Filename != "11.js" {
		t.Errorf("dropped file lost its snapshot: %+v", data)
	}
}

// TestCompactionSummaryNamesFoldedDroppedFiles: once /compact folds a dropped
// file away, the summary is all the model sees, so it must name the file and
// the tool that returns it — including one inside a nested thread.
func TestCompactionSummaryNamesFoldedDroppedFiles(t *testing.T) {
	nested, _ := json.Marshal([]ConversationItem{
		{Type: ItemTypeDroppedFile, ItemID: "DROP_2", Data: []byte(`{"filename":"b.txt","content":"b"}`)},
	})
	folded, _ := json.Marshal([]ConversationItem{
		{Type: ItemTypeUser, ItemID: "u1", Content: "look at this"},
		{Type: ItemTypeDroppedFile, ItemID: "DROP_1", Data: []byte(`{"filename":"11.js","content":"a"}`)},
		{Type: ItemTypeThread, ItemID: "t1", Items: nested},
	})
	result, _ := json.Marshal("the summary")
	fold := ConversationItem{Type: ItemTypeThread, BoundedCompaction: true, Result: result, Items: folded}

	content, _ := buildThreadResultMap(fold)["content"].(string)
	for _, want := range []string{"the summary", "restore_dropped_file", "- DROP_1: 11.js", "- DROP_2: b.txt"} {
		if !strings.Contains(content, want) {
			t.Errorf("summary missing %q:\n%s", want, content)
		}
	}

	plain, _ := json.Marshal([]ConversationItem{{Type: ItemTypeUser, ItemID: "u1", Content: "hi"}})
	fold.Items = plain
	content, _ = buildThreadResultMap(fold)["content"].(string)
	if content != compactionSummaryWireHeader+"the summary" {
		t.Errorf("a fold with no dropped files must render unchanged, got:\n%s", content)
	}
}
