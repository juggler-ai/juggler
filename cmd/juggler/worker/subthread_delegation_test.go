//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"testing"

	ycrdt "github.com/skyterra/y-crdt"
)

// TestDelegationBlockedDrivesBothConsumers pins the property that makes
// delegationBlocked worth having: its answer must reach BOTH things that follow
// from it. Whenever it says delegation is unavailable, the tool list must have
// dropped every RequiresDelegation tool (they could only fail) and kept every
// merely-optional delegator (they still work inline); whenever it says
// delegation is available, both must survive.
//
// Asserting the two together is the point. Either consumer alone can be changed
// without breaking its own test while silently disagreeing with the other, and
// that disagreement is exactly the bug this pairing exists to prevent: a tool
// offered to a model that cannot use it.
func TestDelegationBlockedDrivesBothConsumers(t *testing.T) {
	tools := []ToolDefinition{
		{Name: "read", InputSchema: json.RawMessage(`{"type":"object"}`)},
		{Name: "Explore", InputSchema: json.RawMessage(`{"type":"object"}`),
			DelegatesToSubthread: true, RequiresDelegation: true},
		{Name: "WebFetch", InputSchema: json.RawMessage(`{"type":"object"}`),
			DelegatesToSubthread: true},
	}
	offers := func(ts []ToolDefinition, name string) bool {
		for _, td := range ts {
			if td.Name == name {
				return true
			}
		}
		return false
	}

	cases := []struct {
		name        string
		build       func(*ConversationWorker) string
		wantBlocked bool
	}{
		{"ordinary thread", func(w *ConversationWorker) string {
			return insertThreadWithOpts(w, threadOpts{goal: "Normal", llmCreated: true})
		}, false},
		{"delegated thread", func(w *ConversationWorker) string {
			return insertThreadWithOpts(w, threadOpts{goal: "Sub-agent", delegated: true})
		}, true},
		{"descendant of a delegated thread", func(w *ConversationWorker) string {
			parent := insertThreadWithOpts(w, threadOpts{goal: "Sub-agent", delegated: true})
			arr := w.doc.GetThreadItemsArray(parent)
			w.doc.InsertThreadIntoArray(arr, w.doc.GetItemsLengthFromArray(arr), "Child")
			kids := w.doc.GetItemsFromArray(arr)
			return kids[len(kids)-1].ItemID
		}, true},
		{"at the nesting cap", func(w *ConversationWorker) string {
			arr := w.doc.ensureItems()
			deepest := ""
			for i := 1; i <= maxThreadDepth; i++ {
				nested := w.doc.InsertThreadIntoArray(arr, w.doc.GetItemsLengthFromArray(arr), "L")
				items := w.doc.GetItemsFromArray(arr)
				deepest = items[len(items)-1].ItemID
				arr = nested
			}
			return deepest
		}, true},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := NewConversationWorker("test-conv", "user:test")
			defer w.doc.Destroy()
			threadID := tc.build(w)
			w.turn.thread.itemID = threadID

			reason := w.delegationBlocked(threadID)
			if (reason != "") != tc.wantBlocked {
				t.Fatalf("delegationBlocked = %q, wantBlocked=%v", reason, tc.wantBlocked)
			}
			if tc.wantBlocked && reason == "" {
				t.Fatal("a blocked thread must give a reason; it is logged and read by a human")
			}

			got := w.currentRun().filterToolsForThread(tools)
			if offers(got, "Explore") == tc.wantBlocked {
				t.Errorf("Explore offered=%v while delegation blocked=%v: a delegation-only tool must be offered exactly when it could be used",
					offers(got, "Explore"), tc.wantBlocked)
			}
			if !offers(got, "WebFetch") {
				t.Error("WebFetch has an inline path, so it must survive the filter in every case and lose only its delegation")
			}
			if !offers(got, "read") {
				t.Error("an unrelated tool must never be touched by the delegation rule")
			}
		})
	}
}

// countThreads returns the total number of thread items anywhere in the doc
// (root + nested), used to prove delegation did or did not nest.
func countThreads(w *ConversationWorker) int {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()
	n := 0
	walkThreads(w.doc.getItems(), func(_ *ycrdt.YMap, _ *ycrdt.YArray, _ string) bool {
		n++
		return false
	})
	return n
}

// fillLiveThreads inserts n in-flight llmCreated threads at root — the shape
// liveThreadCount counts, and the only input the breadth cap has.
func fillLiveThreads(t *testing.T, w *ConversationWorker, n int) {
	t.Helper()
	for i := 0; i < n; i++ {
		insertThreadWithOpts(w, threadOpts{goal: fmt.Sprintf("T%d", i), llmCreated: true})
	}
	if got := w.doc.liveThreadCount(); got != n {
		t.Fatalf("liveThreadCount = %d, want %d", got, n)
	}
}

// metaToolResultFor returns the refusal bound to toolUseID at root, or nil.
func metaToolResultFor(w *ConversationWorker, toolUseID string) *ConversationItem {
	items := w.doc.GetItems()
	for i := range items {
		if items[i].Type == ItemTypeMetaToolResult && items[i].ToolUseID == toolUseID {
			return &items[i]
		}
	}
	return nil
}
