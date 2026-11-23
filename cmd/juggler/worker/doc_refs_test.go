//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"reflect"
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

// nestedItemsJSON is items as a thread's nested-items JSON.
func nestedItemsJSON(t *testing.T, items ...ConversationItem) json.RawMessage {
	t.Helper()
	raw, err := json.Marshal(items)
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

// TestCollectRefsReadsEveryShape pins every live set the sweeps keep, read off
// one document holding each shape a reference arrives in: fields Go writes as
// plain values, fields a client writes as Y types (toYValue,
// web/js/model/item-accessor.js), a chain of threads nested three deep as
// repeated compaction folds leave them, a thread whose items are a plain array
// rather than a Y.Array, a draft and a queued message.
func TestCollectRefsReadsEveryShape(t *testing.T) {
	w := NewConversationWorker("conv-refs", "user:test")
	defer w.doc.Destroy()

	w.doc.AppendMessage(ConversationItem{Type: ItemTypeUser, ItemID: "u1", TransactionID: "t-root-user",
		Attachments: []AssetRef{{ID: "a-root"}}})

	// A tool-action as a client writes one: displayData, attachments and
	// heldAssets are Y types.
	w.doc.AppendMessage(ConversationItem{Type: ItemTypeToolAction, ItemID: "c1", ToolUseID: "tu-client",
		State: StatePending, TransactionID: "t-client"})
	ycrdtMu.Lock()
	m := w.doc.getItems().Get(1).(*ycrdt.YMap)
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		dd := ycrdt.NewYMap(nil)
		m.Set(keyDisplayData, dd)
		diff := ycrdt.NewYMap(nil)
		dd.Set("diffData", diff)
		diff.Set("oldRef", "a-diff-old")
		diff.Set("newRef", "a-diff-new")
		atts := ycrdt.NewYArray()
		m.Set(keyAttachments, atts)
		att := ycrdt.NewYMap(nil)
		atts.Push(ycrdt.ArrayAny{att})
		att.Set("id", "a-client-att")
		held := ycrdt.NewYArray()
		m.Set(keyHeldAssets, held)
		held.Push(ycrdt.ArrayAny{"a-client-held"})
	}, w.doc.authorID)
	ycrdtMu.Unlock()

	// Three threads deep.
	l3 := nestedItemsJSON(t,
		ConversationItem{Type: ItemTypeThinking, ItemID: "k3", TransactionID: "t-l3"},
		ConversationItem{Type: ItemTypeToolAction, ItemID: "x3", ToolUseID: "tu-l3-done", State: StateCompleted,
			HeldAssets: []string{"a-l3-held-settled"}, Attachments: []AssetRef{{ID: "a-l3"}}},
	)
	l2 := nestedItemsJSON(t,
		ConversationItem{Type: ItemTypeToolAction, ItemID: "x2", ToolUseID: "tu-l2", State: StateRunning,
			TransactionID: "t-l2", Attachments: []AssetRef{{ID: "a-l2"}}},
		ConversationItem{Type: ItemTypeThread, ItemID: "th3", Items: l3},
	)
	w.doc.AppendMessage(ConversationItem{Type: ItemTypeThread, ItemID: "th1", BoundedCompaction: true, Items: nestedItemsJSON(t,
		ConversationItem{Type: ItemTypeAssistant, ItemID: "s1", TransactionID: "t-l1-old"},
		ConversationItem{Type: ItemTypeThread, ItemID: "th2", BoundedCompaction: true, Items: l2},
		ConversationItem{Type: ItemTypeAssistant, ItemID: "s2", TransactionID: "t-l1-new"},
	)})

	// A thread whose items are a plain array.
	w.doc.doc.Transact(func(_ *ycrdt.Transaction) {
		pm := conversationItemToYMap(ConversationItem{Type: ItemTypeThread, ItemID: "thp"})
		w.doc.ensureItems().Push(ycrdt.ArrayAny{pm})
		pm.Set(keyItems, ycrdt.ArrayAny{ycrdt.Object{
			"type": ItemTypeToolAction, "itemId": "xp", "toolUseId": "tu-plain", "state": StatePending,
			"transactionId": "t-plain", "attachments": ycrdt.ArrayAny{ycrdt.Object{"id": "a-plain"}},
		}})
	}, w.doc.authorID)

	w.enqueuePendingMessage("", UserMessageInput{Text: "queued", Attachments: []AssetRef{{ID: "a-pending"}}})
	w.doc.SetMetadata("draft", map[string]any{"text": "unsent", "attachments": []any{map[string]any{"id": "a-draft"}}})

	refs := w.doc.collectRefs()
	set := func(ids ...string) map[string]bool {
		m := map[string]bool{}
		for _, id := range ids {
			m[id] = true
		}
		return m
	}
	for _, c := range []struct {
		name      string
		got, want map[string]bool
	}{
		{"txns", refs.txns, set("t-root-user", "t-client", "t-l1-old", "t-l2", "t-l3", "t-l1-new", "t-plain")},
		{"latestTxns", refs.latestTxns, set("t-client", "t-l1-new", "t-l2", "t-l3", "t-plain")},
		{"assets", refs.assets, set("a-root", "a-diff-old", "a-diff-new", "a-client-att", "a-client-held",
			"a-l2", "a-l3", "a-plain", "a-pending", "a-draft")},
		{"unsettled", refs.unsettled, set("tu-client", "tu-l2", "tu-plain")},
	} {
		if !reflect.DeepEqual(c.got, c.want) {
			t.Errorf("%s = %v\n want %v", c.name, c.got, c.want)
		}
	}
	if refs.unreadable {
		t.Error("every thread here is readable, but collectRefs reported one that is not")
	}
}
