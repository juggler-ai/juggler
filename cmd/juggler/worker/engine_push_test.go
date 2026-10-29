//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"strings"
	"testing"
	"time"
)

// TestCallbackRegistry_EngineTargeting is the deterministic unit check for the
// engine-targeted send: sendToEngine reaches only the client marked via
// setEngine, and becomes a no-op once that client is removed.
func TestCallbackRegistry_EngineTargeting(t *testing.T) {
	r := newCallbackRegistry()
	defer r.stop()

	engineCh := make(chan []byte, 4)
	viewerCh := make(chan []byte, 4)
	r.set("engine", func(b []byte) { engineCh <- b })
	r.set("viewer", func(b []byte) { viewerCh <- b })
	r.setEngine("engine")

	r.sendToEngine([]byte("state"))
	select {
	case b := <-engineCh:
		if string(b) != "state" {
			t.Fatalf("engine received %q, want %q", b, "state")
		}
	case <-time.After(2 * time.Second):
		t.Fatal("engine did not receive sendToEngine")
	}
	select {
	case b := <-viewerCh:
		t.Fatalf("viewer must NOT receive an engine-targeted send, got %q", b)
	case <-time.After(150 * time.Millisecond):
	}

	// After the engine detaches, sendToEngine is a no-op (no panic, no delivery).
	r.remove("engine")
	r.sendToEngine([]byte("state2"))
	select {
	case b := <-engineCh:
		t.Fatalf("a detached engine received %q", b)
	case <-time.After(150 * time.Millisecond):
	}
}

// enginePushHarness drives pushStateToEngine directly and collects the Yjs
// updates the engine client receives. The engine's mailbox also carries the
// ordinary broadcasts, which cannot be told apart from a push on the wire — so
// the assertions below are written over ALL of them, which is the stronger
// statement anyway: nothing the engine receives after the seed is full state.
type enginePushHarness struct {
	t        *testing.T
	w        *ConversationWorker
	received chan []byte
}

func newEnginePushHarness(t *testing.T) *enginePushHarness {
	t.Helper()
	w := NewConversationWorker("test-conv", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	initPayload, _ := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: "test-conv"},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	w.currentRun().handleInit(initPayload)

	h := &enginePushHarness{t: t, w: w, received: make(chan []byte, 64)}
	w.SetCallback("engine", func(b []byte) {
		var m struct {
			Type string `json:"type"`
			// encoding/json decodes a JSON string into []byte as base64, which is
			// exactly what marshalYjsSync writes.
			Bytes []byte `json:"bytes"`
		}
		if json.Unmarshal(b, &m) == nil && m.Type == "yjs-sync" {
			h.received <- m.Bytes
		}
	})
	w.SetEngineClientID("engine")
	return h
}

// nextUpdate returns the next Yjs update the engine received, failing the test
// if none arrives. Delivery is through the callback registry's mailbox, so it is
// ordered but not synchronous with the push that produced it.
func (h *enginePushHarness) nextUpdate(what string) []byte {
	h.t.Helper()
	select {
	case b := <-h.received:
		return b
	case <-time.After(5 * time.Second):
		h.t.Fatalf("engine received no yjs-sync for %s", what)
		return nil
	}
}

// drain collects everything delivered within a settle window, so an assertion
// can cover the broadcasts interleaved with a push as well as the push itself.
func (h *enginePushHarness) drain() [][]byte {
	h.t.Helper()
	var out [][]byte
	deadline := time.After(250 * time.Millisecond)
	for {
		select {
		case b := <-h.received:
			out = append(out, b)
		case <-deadline:
			return out
		}
	}
}

// TestEnginePushSeedsOnceThenSendsDeltas pins the cost of the engine push. The
// first push to a given engine is the whole document, because the engine holds
// nothing to build on; every later one is a delta against what it was already
// sent. Without that, a conversation carrying large tool results re-encoded and
// shipped the entire document once per tool dispatch and once per redrive — the
// splitting-into-frames case in the server's WS writer, to communicate a few
// dozen bytes of change.
func TestEnginePushSeedsOnceThenSendsDeltas(t *testing.T) {
	h := newEnginePushHarness(t)

	// Bulk the document up so full state is unmistakable next to a delta.
	const bulkSize = 256 * 1024
	h.w.doc.SetMetadata("bulk", strings.Repeat("x", bulkSize))

	h.w.pushStateToEngine()
	seed := h.nextUpdate("the first push")
	if len(seed) < bulkSize {
		t.Fatalf("first push to a fresh engine must be full state, got %d bytes (doc bulk alone is %d)",
			len(seed), bulkSize)
	}
	h.drain() // discard the broadcast of the bulk write

	// A small change, then a second push. The delta must carry the change without
	// carrying the document.
	h.w.doc.SetMetadata("probe", "after-seed")
	h.w.pushStateToEngine()

	// Each update is applied separately: Yjs updates are not concatenable, so
	// collecting them as one buffer would test nothing about either.
	updates := h.drain()
	for _, update := range updates {
		if len(update) >= bulkSize {
			t.Fatalf("engine was sent full state again (%d bytes) after it had been seeded", len(update))
		}
	}
	if len(updates) == 0 {
		t.Fatal("engine received nothing for the second push")
	}

	// Small is not enough — the delta must actually carry the change. Rebuild the
	// engine's view from what it was sent and read the change back out of it.
	peer := NewConversationDocument("test-conv", "probe-peer")
	defer peer.Destroy()
	if err := peer.LoadFromState(seed); err != nil {
		t.Fatalf("seeding the peer from the first push failed: %v", err)
	}
	for _, update := range updates {
		if err := peer.ApplyUpdate(update); err != nil {
			t.Fatalf("applying the delta to the seeded peer failed: %v", err)
		}
	}
	if got, _ := peer.GetMetadata("probe").(string); got != "after-seed" {
		t.Fatalf("delta did not carry the change: peer read probe=%q, want %q", got, "after-seed")
	}
	if got, _ := peer.GetMetadata("bulk").(string); len(got) != bulkSize {
		t.Fatalf("peer lost the seeded bulk: got %d bytes, want %d", len(got), bulkSize)
	}
}

// TestEnginePushReseedsWhenTheEngineLostTheDocument covers the two ways the
// worker's belief about what the engine holds becomes worthless. A delta is only
// meaningful to a peer that has the base it builds on, so both must fall back to
// full state — otherwise the saving above reintroduces the "tools stuck" wedge
// it was carved out of.
func TestEnginePushReseedsWhenTheEngineLostTheDocument(t *testing.T) {
	const bulkSize = 256 * 1024

	// A different engine attaching: the new one has observed none of these ops.
	t.Run("a new engine attaches", func(t *testing.T) {
		h := newEnginePushHarness(t)
		h.w.doc.SetMetadata("bulk", strings.Repeat("x", bulkSize))
		h.w.pushStateToEngine()
		h.nextUpdate("the first push")
		h.drain()

		h.w.SetEngineClientID("engine")
		h.w.pushStateToEngine()
		if got := len(h.nextUpdate("the push after a re-attach")); got < bulkSize {
			t.Fatalf("a freshly attached engine must be re-seeded with full state, got %d bytes", got)
		}
	})

	// The engine reporting it does not hold the conversation. It can release one
	// without dropping its socket, so this trace is the only word the worker gets.
	t.Run("the engine reports conv-not-loaded", func(t *testing.T) {
		h := newEnginePushHarness(t)
		h.w.doc.SetMetadata("bulk", strings.Repeat("x", bulkSize))
		h.w.pushStateToEngine()
		h.nextUpdate("the first push")
		h.drain()

		h.w.handleEngineTrace(json.RawMessage(
			`{"event":"execute-noact","toolUseId":"tu-1","reason":"conv-not-loaded"}`))
		h.w.pushStateToEngine()
		if got := len(h.nextUpdate("the push after conv-not-loaded")); got < bulkSize {
			t.Fatalf("an engine that reported conv-not-loaded must be re-seeded with full state, got %d bytes", got)
		}
	})

	// The counterpart: a decline about the TOOL, not the conversation, says the
	// engine still holds the document, so the delta path must survive it.
	t.Run("a tool-level decline does not re-seed", func(t *testing.T) {
		h := newEnginePushHarness(t)
		h.w.doc.SetMetadata("bulk", strings.Repeat("x", bulkSize))
		h.w.pushStateToEngine()
		h.nextUpdate("the first push")
		h.drain()

		h.w.handleEngineTrace(json.RawMessage(
			`{"event":"execute-noact","toolUseId":"tu-1","reason":"no-thread"}`))
		h.w.pushStateToEngine()
		for _, update := range h.drain() {
			if len(update) >= bulkSize {
				t.Fatalf("a no-thread decline re-sent full state (%d bytes); it says nothing about the document", len(update))
			}
		}
	})
}
