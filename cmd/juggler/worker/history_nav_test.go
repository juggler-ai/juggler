//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"testing"
	"time"
)

// TestHistoryNavigationSuppressesReducerForDangerousLastItems covers the
// user-visible undo bug at the worker boundary rather than guessing a single
// item type. Immediately after undo/redo, browser/engine Yjs sync echoes can
// reintroduce stale activity="awaiting_llm". If the reducer runs against that
// stale marker, several otherwise-valid thread shapes dispatch CallLLM and
// fight the user's undo. The history-navigation recoil barrier must suppress
// reducer advancement for all of those shapes.
func TestHistoryNavigationSuppressesReducerForDangerousLastItems(t *testing.T) {
	cases := []struct {
		name  string
		items []ConversationItem
	}{
		{
			name:  "last-user",
			items: []ConversationItem{userMsg("please continue")},
		},
		{
			name: "last-completed-tool",
			items: []ConversationItem{
				userMsg("run ls"),
				assistantMsg("running"),
				toolAction("call_1", StateCompleted),
			},
		},
		{
			name: "last-meta-tool-result",
			items: []ConversationItem{
				userMsg("meta"),
				{Type: ItemTypeMetaToolResult, Content: "ok"},
			},
		},
		{
			name: "last-completed-thread",
			items: []ConversationItem{
				userMsg("thread it"),
				threadMsg("thread-1", "done"),
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			w := NewConversationWorker("conv-"+tc.name, "author")
			defer w.doc.Destroy()

			for i, item := range tc.items {
				w.doc.InsertMessage(i, item)
			}
			w.doc.SetMetadata("processingState", map[string]any{
				"activity":     ActivityAwaitingLLM,
				"threadItemId": "",
				"status":       "processing_tools",
			})
			w.undo.navRecoilUntilMs = time.Now().UnixMilli() + 10_000

			w.currentRun().handleItemsChange()

			if got := w.getActivity(); got != ActivityNone {
				t.Fatalf("history-nav echo should clear stale activity, got %q", got)
			}
			if w.sched.reconcilePending() {
				t.Fatalf("history-nav echo should not tickle reducer for %s", tc.name)
			}
		})
	}
}
