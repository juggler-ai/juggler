//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

// The worker's own writes group into undo steps by their explicit boundaries —
// a user-facing item opening a group, turn-idle, a slash command — and never by
// how far apart they land. A turn's tool calls arrive after its text has
// streamed, which on a slow worker, or after a long reply on any worker, is
// further from the reply's append than the capture window.
//
// The sleeps below are the condition under test, as in undo_client_clock_test:
// each puts the next write outside the window, and a slower machine only puts
// it further outside.

import (
	"encoding/json"
	"testing"
)

func TestWorkerTurnWritesAreOneUndoStepAtAnySpacing(t *testing.T) {
	w := NewConversationWorker("test-conv", "user:test")
	defer w.doc.Destroy()
	w.tracker.EnsureInitialized()
	w.tracker.AppendMessage(ConversationItem{Type: ItemTypeUser, ItemID: "ask", Content: "do it"})
	height := w.tracker.UndoStackLen()

	w.currentRun().appendTargetMessage(ConversationItem{Type: ItemTypeAssistant, ItemID: "reply", Content: "Working on it."})
	arriveLate()
	w.currentRun().appendTargetMessage(ConversationItem{Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "tu-1", ToolName: "read_file", State: StateCompleted})
	arriveLate()
	w.currentRun().appendTargetMessage(ConversationItem{Type: ItemTypeToolAction, ItemID: "ta-2", ToolUseID: "tu-2", ToolName: "read_file", State: StateCompleted})

	if got := w.tracker.UndoStackLen() - height; got != 1 {
		t.Fatalf("a reply and its two tool calls, each landing past the capture window, made %d undo steps, want 1", got)
	}
	w.tracker.Undo()
	if got := itemIDs(w.doc.GetItems()); got != "ask(user)" {
		t.Fatalf("one undo left %s, want the whole reply gone and the ask kept", got)
	}
}

// A tool's result is written by the engine, in its own doc, and reaches the
// worker as that client's yjs-sync whenever the tool finishes — seconds after
// the tool call it completes. It belongs to the turn that made the call, as do
// the worker's writes on either side of it, so one undo takes back all three.
func TestEngineToolResultsJoinTheTurnAtAnySpacing(t *testing.T) {
	w, engine := clientEditWorker(t)
	w.SetEngineClientID(clientA)
	height := w.tracker.UndoStackLen()

	w.tracker.AppendMessage(ConversationItem{Type: ItemTypeAssistant, ItemID: "reply", Content: "Reading it."})
	w.tracker.AppendMessage(ConversationItem{Type: ItemTypeToolAction, ItemID: "ta-1", ToolUseID: "tu-1", ToolName: "read_file", State: StateApproved})
	if err := engine.ApplySyncUpdate(w.Document().GetStateUpdate(engine.GetStateVector())); err != nil {
		t.Fatalf("bringing the engine up to date failed: %v", err)
	}
	arriveLate()

	before := engine.GetStateVector()
	if err := engine.UpdateItemByToolUseID("tu-1", "state", StateCompleted); err != nil {
		t.Fatalf("engine completing the tool failed: %v", err)
	}
	if err := engine.UpdateItemByToolUseID("tu-1", "result", map[string]any{"content": "contents", "isError": false}); err != nil {
		t.Fatalf("engine writing the result failed: %v", err)
	}
	// The engine's own clock says its previous edit was long ago, as it is when
	// its last write was the previous tool's result.
	payload, err := json.Marshal(YjsSyncMessage{Type: msgYjsSync, Bytes: engine.GetStateUpdate(before), SinceEditMs: ms(5000)})
	if err != nil {
		t.Fatalf("marshalling yjs-sync: %v", err)
	}
	w.SendFromClient(clientA, "yjs-sync", payload)
	barrier(t, w)
	arriveLate()
	w.tracker.AppendMessage(ConversationItem{Type: ItemTypeToolAction, ItemID: "ta-2", ToolUseID: "tu-2", ToolName: "read_file", State: StateApproved})

	if got := w.tracker.UndoStackLen() - height; got != 1 {
		t.Fatalf("a reply, its tool call, the engine's result and the next call, each past the window, made %d undo steps, want 1", got)
	}
}

// Spacing is ignored only for the worker's own group, and only until a
// boundary: everything that separated the worker's writes still does.
func TestWorkerTurnWritesKeepEveryOtherBoundary(t *testing.T) {
	toolCall := func(id string) ConversationItem {
		return ConversationItem{Type: ItemTypeToolAction, ItemID: id, ToolUseID: "tu-" + id, ToolName: "read_file", State: StateCompleted}
	}

	t.Run("turn idle", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		w.tracker.EnsureInitialized()
		height := w.tracker.UndoStackLen()

		w.tracker.AppendMessage(ConversationItem{Type: ItemTypeAssistant, ItemID: "reply", Content: "Done."})
		w.tracker.StopCapturing()
		w.tracker.AppendMessage(toolCall("late"))

		if got := w.tracker.UndoStackLen() - height; got != 2 {
			t.Fatalf("a write after an explicit boundary gave %d undo steps, want 2", got)
		}
	})

	t.Run("after an undo", func(t *testing.T) {
		w := NewConversationWorker("test-conv", "user:test")
		defer w.doc.Destroy()
		w.tracker.EnsureInitialized()

		w.tracker.AppendMessage(ConversationItem{Type: ItemTypeAssistant, ItemID: "first", Content: "one"})
		w.tracker.AppendMessage(ConversationItem{Type: ItemTypeAssistant, ItemID: "second", Content: "two"})
		w.tracker.Undo()
		height := w.tracker.UndoStackLen()
		w.tracker.AppendMessage(toolCall("after"))

		if got := w.tracker.UndoStackLen() - height; got != 1 {
			t.Fatalf("a write after an undo gave %d new undo steps, want 1 of its own", got)
		}
	})

	t.Run("a client's edit on top", func(t *testing.T) {
		w, client := clientEditWorker(t)
		height := w.tracker.UndoStackLen()

		w.tracker.AppendMessage(ConversationItem{Type: ItemTypeAssistant, ItemID: "reply", Content: "reply"})
		if err := client.ApplySyncUpdate(w.Document().GetStateUpdate(client.GetStateVector())); err != nil {
			t.Fatalf("bringing the client up to date failed: %v", err)
		}
		arriveLate()
		deleteLastFromClient(t, w, client, nil)
		arriveLate()
		w.tracker.AppendMessage(toolCall("late"))

		if got := w.tracker.UndoStackLen() - height; got != 3 {
			t.Fatalf("worker append, client delete, worker append, each past the window, gave %d undo steps, want 3", got)
		}
	})

	t.Run("an engine edit after turn idle", func(t *testing.T) {
		w, engine := clientEditWorker(t)
		w.SetEngineClientID(clientA)
		w.tracker.AppendMessage(ConversationItem{Type: ItemTypeAssistant, ItemID: "reply", Content: "Done."})
		if err := engine.ApplySyncUpdate(w.Document().GetStateUpdate(engine.GetStateVector())); err != nil {
			t.Fatalf("bringing the engine up to date failed: %v", err)
		}
		w.tracker.StopCapturing()
		height := w.tracker.UndoStackLen()

		deleteLastFromClient(t, w, engine, ms(0))

		if got := w.tracker.UndoStackLen() - height; got != 1 {
			t.Fatalf("an engine edit after an explicit boundary gave %d new undo steps, want 1 of its own", got)
		}
	})

	t.Run("client edits spaced past the window", func(t *testing.T) {
		w, client := clientEditWorker(t)
		w.tracker.AppendMessage(ConversationItem{Type: ItemTypeAssistant, ItemID: "reply", Content: "reply"})
		if err := client.ApplySyncUpdate(w.Document().GetStateUpdate(client.GetStateVector())); err != nil {
			t.Fatalf("bringing the client up to date failed: %v", err)
		}
		w.SendFromClient(clientA, "stop-undo-capturing", json.RawMessage(`{}`))
		barrier(t, w)
		height := w.tracker.UndoStackLen()

		deleteLastFromClient(t, w, client, nil)
		arriveLate()
		deleteLastFromClient(t, w, client, nil)

		if got := w.tracker.UndoStackLen() - height; got != 2 {
			t.Fatalf("two client deletes arriving past the window gave %d undo steps, want 2", got)
		}
	})
}
