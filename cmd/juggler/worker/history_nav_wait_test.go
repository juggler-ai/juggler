//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"sync/atomic"
	"testing"
	"time"
)

// historyNavHarness is a worker with one undoable step — an assistant reply at
// root — and a viewer that collects acks. The worker's loop is not started: the
// test is the actor and calls the history handlers itself.
func historyNavHarness(t *testing.T) (*ConversationWorker, <-chan AckMessage) {
	t.Helper()
	w := NewConversationWorker("conv-history-nav-wait", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })
	w.tracker.EnsureInitialized()
	w.currentRun().appendTargetMessage(ConversationItem{Type: ItemTypeAssistant, ItemID: "a-1", Content: "an answer"})
	w.tracker.StopCapturing()

	acks := make(chan AckMessage, 4)
	w.SetCallback("viewer", func(raw []byte) {
		var m AckMessage
		if json.Unmarshal(raw, &m) == nil && m.Type == msgAck {
			acks <- m
		}
	})
	return w, acks
}

// hasRootItem reports whether the root thread holds an item with this id.
func hasRootItem(w *ConversationWorker, itemID string) bool {
	for _, it := range w.doc.GetItems() {
		if it.ItemID == itemID {
			return true
		}
	}
	return false
}

// startUnwindingTurn publishes a live root turn whose goroutine, once
// cancelled, takes unwind to return — a turn on a slow core still writing its
// way out. When it returns it records whether the undo had already landed
// underneath it (a-1 gone while it was still running).
func startUnwindingTurn(t *testing.T, w *ConversationWorker, unwind time.Duration, release <-chan struct{}) (appliedUnderneath *atomic.Bool) {
	t.Helper()
	appliedUnderneath = &atomic.Bool{}
	r := w.currentRun()
	tr := r.beginTurn("")
	r.runTurn(tr, func(tr *run) {
		for tr.loadState() != StateCancelling {
			select {
			case <-tr.t.wake:
			case <-release:
				return
			}
		}
		select {
		case <-time.After(unwind):
		case <-release:
		}
		appliedUnderneath.Store(!hasRootItem(w, "a-1"))
	})
	return appliedUnderneath
}

func awaitAck(t *testing.T, acks <-chan AckMessage, within time.Duration) AckMessage {
	t.Helper()
	select {
	case a := <-acks:
		return a
	case <-time.After(within):
		t.Fatalf("the undo was never acknowledged within %s", within)
		return AckMessage{}
	}
}

// TestUndoWaitsForASlowTurnToUnwind pins what bounds undo's wait for the turn
// it stops: that turn reaching idle, not a fixed span of wall time. On a slow
// core a cancelled turn is still writing its way out when any span picked on a
// fast one runs out, and refusing the undo then makes the button do nothing.
// The turn here takes 1.5s to unwind after the cancel; the undo must wait for
// it, then apply — never before it has returned.
func TestUndoWaitsForASlowTurnToUnwind(t *testing.T) {
	w, acks := historyNavHarness(t)
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	appliedUnderneath := startUnwindingTurn(t, w, 1500*time.Millisecond, release)

	payload, _ := json.Marshal(map[string]string{"ackId": "undo-slow"})
	w.currentRun().handleUndo(payload)

	ack := awaitAck(t, acks, 5*time.Second)
	if ack.Result != true {
		t.Fatalf("the undo was refused (ack result %v) while the stopped turn was still unwinding; "+
			"it must wait for the turn to reach idle and then apply", ack.Result)
	}
	if appliedUnderneath.Load() {
		t.Fatal("the undo was applied while the stopped turn was still running")
	}
	if hasRootItem(w, "a-1") {
		t.Fatal("the undo was acknowledged as applied but the reply it should remove is still there")
	}
}

// TestUndoRefusesATurnThatNeverUnwinds is the other half: a stopped turn that
// never returns is the one case liveness cannot bound, so the ceiling does —
// and at the ceiling the undo is refused, leaving the document as it was,
// rather than applied under a turn that may still write over it.
func TestUndoRefusesATurnThatNeverUnwinds(t *testing.T) {
	w, acks := historyNavHarness(t)
	w.historyNavStopCheck, w.historyNavStopCeiling = 20*time.Millisecond, 200*time.Millisecond
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	startUnwindingTurn(t, w, time.Hour, release)

	payload, _ := json.Marshal(map[string]string{"ackId": "undo-wedged"})
	w.currentRun().handleUndo(payload)

	if ack := awaitAck(t, acks, 5*time.Second); ack.Result == true {
		t.Fatal("the undo was applied under a turn that never returned; at the ceiling it must be refused")
	}
	if !hasRootItem(w, "a-1") {
		t.Fatal("the refused undo still removed the reply")
	}
}
