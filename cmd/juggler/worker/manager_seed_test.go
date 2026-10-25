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

// TestASeedIsAnsweredThroughItsAckAlone pins who hears a seed's "ready": no
// one. A seed's init comes from the server, not a client, and the server waits
// for it on the ack channel. A "ready" for it on the wire has no client to
// answer, so it would go to every client — the engine included, which is
// creating that very conversation and has an init of its own outstanding. The
// foreign ready resolves that init before the reply addressed to the engine
// has gone out, and the engine's create carries on with an empty document: no
// items, and no model, so its first prompt is refused as "no provider
// configured".
func TestASeedIsAnsweredThroughItsAckAlone(t *testing.T) {
	const convID = "conv-seed-ready"
	w := NewConversationWorker(convID, "server:seed")
	convDir := t.TempDir()
	w.SetPathProvider(func(string) (string, bool) { return convDir, true })
	w.currentRun().Start(context.Background())
	t.Cleanup(w.currentRun().Stop)

	engine := newMsgChan()
	w.SetCallback("engine", engine.callback)

	seed, err := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: convID, Name: "Seeded"},
		Config:       WorkerConfig{ProjectPath: convDir},
	})
	if err != nil {
		t.Fatalf("marshalling the seed's init: %v", err)
	}
	if err := w.awaitAck(context.Background(), w.sendWithAck("init", seed)); err != nil {
		t.Fatalf("the seed's init failed: %v", err)
	}
	if framesUntilBarrier(t, w, engine).saw("ready") {
		t.Fatal("the seed's init was answered on the wire; a client was sent a ready for an init it never sent")
	}

	// The engine's own init is still answered, and to it.
	empty := NewConversationDocument(convID, "user:engine")
	w.SendFromClient("engine", "init", initPayload(t, convID, empty.GetStateVector()))
	if !framesUntilBarrier(t, w, engine).saw("ready") {
		t.Fatal("the engine's own init went unanswered")
	}
}

// TestSeedingAConversationLeavesTheManagerFree pins where a seed waits. Seeding
// initializes the new conversation's worker and saves its document before the
// server announces it, and both are waits on that one worker — its mailbox and
// its disk. The Manager's goroutine serves every conversation, so it must not be
// the one waiting: a slow save there stalls every other conversation's traffic
// behind it.
func TestSeedingAConversationLeavesTheManagerFree(t *testing.T) {
	m := NewManager()
	projectDir := t.TempDir()
	m.SetPathProvider(func(string) (string, bool) { return projectDir, true })

	saving := make(chan struct{}, 1)
	release := make(chan struct{})
	m.SetSaveBinary(func(string, []byte) error {
		select {
		case saving <- struct{}{}:
		default:
		}
		<-release
		return nil
	})
	t.Cleanup(func() {
		select {
		case <-release:
		default:
			close(release)
		}
		m.Shutdown()
	})

	seeded := make(chan error, 1)
	go func() {
		seeded <- m.SeedNewConversation("conv-seeded", "Seeded", projectDir, "2026-10-19T00:00:00Z", nil)
	}()
	select {
	case <-saving:
	case <-time.After(10 * time.Second):
		t.Fatal("the seed never saved its document")
	}

	answered := make(chan int, 1)
	go func() { answered <- m.Count() }()
	select {
	case n := <-answered:
		if n != 1 {
			t.Errorf("Count = %d, want the seeded worker", n)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("the Manager stopped answering while one conversation's seed waited on its save")
	}

	close(release)
	select {
	case err := <-seeded:
		if err != nil {
			t.Fatalf("SeedNewConversation: %v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the seed never returned once its save was released")
	}
}
