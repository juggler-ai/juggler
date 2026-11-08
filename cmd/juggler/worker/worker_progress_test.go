//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"testing"
	"time"
)

// A worker answering one client is still working through the queue every other
// client's request waits in, and each client's silence watch can only count
// what reaches it. So handling another client's message, with nothing
// broadcast lately, is announced to every client as `working`.
func TestHandlingAnotherClientsMessageIsHeardByEveryClient(t *testing.T) {
	w := NewConversationWorker("conv-working", "user:test")
	w.workingEvery = 0
	w.currentRun().Start(context.Background())
	defer w.currentRun().Stop()

	page, engine := newMsgChan(), newMsgChan()
	w.SetCallback("page", page.callback)
	w.SetCallback("engine", engine.callback)
	quiesce(t, w, page, engine)

	// The ack goes to the engine alone.
	w.SendFromClient("engine", "ping", json.RawMessage(`{"ackId":"engine-only"}`))

	if got := framesUntilBarrier(t, w, page); !got.saw(string(msgWorking)) {
		t.Fatalf("the page heard %v while the worker handled the engine's request, want a %s frame", got, msgWorking)
	}
}

// Something broadcast within workingEvery has already told every client the
// worker is alive, so no `working` follows it.
func TestWorkingIsNotSentWhenTheWorkerWasHeardLately(t *testing.T) {
	w := NewConversationWorker("conv-working-quiet", "user:test")
	w.workingEvery = time.Hour
	w.currentRun().Start(context.Background())
	defer w.currentRun().Stop()

	page, engine := newMsgChan(), newMsgChan()
	w.SetCallback("page", page.callback)
	w.SetCallback("engine", engine.callback)
	// The barriers' acks are broadcasts: the worker has just been heard.
	quiesce(t, w, page, engine)

	w.SendFromClient("engine", "ping", json.RawMessage(`{"ackId":"engine-only"}`))

	if got := framesUntilBarrier(t, w, page); got.saw(string(msgWorking)) {
		t.Fatalf("the page heard %v, want no %s frame an hour inside the last broadcast", got, msgWorking)
	}
}
