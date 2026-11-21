//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
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

// A first load sends nothing until doc.yjs is read and applied, and on a slow
// disk that outlasts the viewer's silence bound on ready — which then gives up
// on a load the worker finishes moments later. So a load in progress is
// announced as `working` until it ends. The stand-in disk here does not finish
// reading until a `working` frame has reached the page.
func TestFirstLoadIsHeardWhileItReads(t *testing.T) {
	w := NewConversationWorker("conv-slow-load", "user:test")
	w.workingEvery = time.Millisecond

	tmpDir := t.TempDir()
	convDir := filepath.Join(tmpDir, ".juggler", "slow--conv-slow-load")
	if err := os.MkdirAll(convDir, 0o755); err != nil {
		t.Fatalf("mkdir conv dir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(convDir, "doc.yjs"), w.doc.ToState(), 0o644); err != nil {
		t.Fatalf("seed doc.yjs: %v", err)
	}

	heard := make(chan struct{})
	var heardOnce sync.Once
	w.SetCallback("page", func(msg []byte) {
		var m struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(msg, &m) == nil && m.Type == string(msgWorking) {
			heardOnce.Do(func() { close(heard) })
		}
	})

	gaveUp := false
	w.SetPathProvider(func(string) (string, bool) {
		select {
		case <-heard:
		case <-time.After(30 * time.Second):
			gaveUp = true
		}
		return convDir, true
	})

	initPayload, _ := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: "conv-slow-load", LoadFromDisk: true},
		Config:       WorkerConfig{ProjectPath: tmpDir},
	})
	w.currentRun().handleInit(initPayload)
	defer w.doc.Destroy()

	if gaveUp {
		t.Fatalf("the page heard no %s frame while the first load was reading", msgWorking)
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
