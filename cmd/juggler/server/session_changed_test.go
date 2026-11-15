//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// fenceTo broadcasts a frame of a type nothing else sends, and reads conn up to
// it, returning the types of the frames that arrived ahead of it. The hub is one
// actor and each client's mailbox is first in, first out, so everything the hub
// was handed before the fence reaches conn before it — which turns "nothing
// arrived" into an ordering fact rather than a wait that happened to expire.
func fenceTo(t *testing.T, s *Server, conn *websocket.Conn, fence string) []string {
	t.Helper()
	s.broadcastToAll(bareFrame{Type: frameType(fence)})
	return readUntilType(t, conn, fence)
}

// readUntilType reads conn until a frame of type want arrives, and returns the
// types of the frames before it.
func readUntilType(t *testing.T, conn *websocket.Conn, want string) []string {
	t.Helper()
	var before []string
	_ = conn.SetReadDeadline(time.Now().Add(relayBudget))
	for {
		_, msgBytes, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("no %s frame arrived: %v (saw %v)", want, err, before)
		}
		var frame struct {
			Type string `json:"type"`
		}
		if json.Unmarshal(msgBytes, &frame) != nil {
			continue
		}
		if frame.Type == want {
			return before
		}
		before = append(before, frame.Type)
	}
}

// TestSessionChanged_ReachesOthersButNotTheSender: session-changed asks a client
// to re-read the session another one has just written. The writer already holds
// what it wrote, so an echo would only send it to re-read its own save — a full
// manifest GET per tab switch, per window.
func TestSessionChanged_ReachesOthersButNotTheSender(t *testing.T) {
	s, ts := newViewerSocketServer(t)

	writer := dialRole(t, ts, "viewer", "v_writer")
	other := dialRole(t, ts, "viewer", "v_other")

	// Start both from a clean read position: whatever dialling put on the wire
	// is behind this fence.
	fenceTo(t, s, writer, "test-fence-start")
	fenceTo(t, s, other, "test-fence-start")

	if err := writer.WriteJSON(map[string]string{"type": "session-changed"}); err != nil {
		t.Fatalf("send: %v", err)
	}

	// The other window hears it. Reading it there proves the hub has handled the
	// broadcast, so the fence below is queued behind it for the writer too.
	readUntilType(t, other, "session-changed")

	for _, typ := range fenceTo(t, s, writer, "test-fence-end") {
		if typ == "session-changed" {
			t.Fatal("the writer was sent its own session-changed back")
		}
	}
}
