//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"testing"
	"time"

	ycrdt "github.com/skyterra/y-crdt"
)

// TestPromotionOnATurnLeavesTheItemsChangePassToTheActor pins where the
// items-change pass a promotion asks for runs. A turn promotes its thread's
// queued messages at every boundary, on its own goroutine, and the pass reaches
// state only the actor may touch: here, the delivery pump a waiting
// deliverTaskOutput request starts, which is a plain map write. Run there, it
// races the actor's own pass over the same map. The turn must hand the pass to
// the actor through the items-change signal instead.
func TestPromotionOnATurnLeavesTheItemsChangePassToTheActor(t *testing.T) {
	w := NewConversationWorker("conv-promote-on-turn", "user:test")
	defer w.doc.Destroy()
	w.currentRun().storeState(StateIdle)
	w.actor.bind() // the test goroutine is the actor; the turn below is not

	pushRequestedEntry(t, w, "deliverTaskOutput", "d-1", func(req *ycrdt.YMap) {
		req.Set("taskId", "bg-task-1")
		req.Set("convId", "conv-promote-on-turn")
	})
	w.enqueuePendingMessage("", UserMessageInput{Text: "typed while busy"})
	select {
	case <-w.docChangeChan: // the setup's own writes
	default:
	}

	promoted := make(chan int)
	go func() { promoted <- w.runFor(newTurnState()).promotePendingItems("", restDrain(time.Now())) }()
	if n := <-promoted; n != 1 {
		t.Fatalf("promoted %d message(s), want 1", n)
	}

	if p, running := w.pumps.pumpsByEntry["d-1"]; running {
		close(p.stop)
		t.Fatal("the turn's promotion ran the items-change pass on the turn's goroutine: it started a delivery pump in the actor's table")
	}
	select {
	case <-w.docChangeChan:
	default:
		t.Fatal("the promotion left the actor no items-change signal to act on")
	}

	w.currentRun().handleItemsChange()
	p, running := w.pumps.pumpsByEntry["d-1"]
	if !running {
		t.Fatal("the actor's items-change pass did not start the delivery pump")
	}
	close(p.stop) // unwind without ops.KillTask (no registry here)
}
