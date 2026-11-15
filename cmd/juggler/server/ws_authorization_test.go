//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/worker"

	"github.com/gorilla/websocket"
)

// Who may open the realtime socket, and once it is open, which frames each role
// may send on it.

// TestInboundFrameRoles_CoverTheVocabulary: every frame a client sends has an
// entry, and the table names nothing that is not one. A frame missing from it
// would be refused from everyone, which is a feature silently switched off.
func TestInboundFrameRoles_CoverTheVocabulary(t *testing.T) {
	for _, f := range allInboundFrames {
		if len(inboundFrameRoles[f]) == 0 {
			t.Errorf("inbound frame %q names no role that may send it", f)
		}
	}
	if len(inboundFrameRoles) != len(allInboundFrames) {
		t.Errorf("inboundFrameRoles has %d entries, want one per inbound frame (%d)", len(inboundFrameRoles), len(allInboundFrames))
	}
}

// TestInboundFrameRoles_RefuseEachForeignRole lists every refusal, written out
// rather than derived from the table, so a widened entry fails here.
func TestInboundFrameRoles_RefuseEachForeignRole(t *testing.T) {
	refused := []struct {
		frame frameType
		role  ClientRole
	}{
		{frameEngineHeartbeat, ClientRoleViewer},
		{frameViewerHeartbeat, ClientRoleEngine},
		{frameViewerFault, ClientRoleEngine},
		{frameEngineBridge, ClientRoleViewer},
		{frameViewerRelay, ClientRoleEngine},
		{frameOneShotResult, ClientRoleViewer},
	}
	for _, c := range refused {
		if known, allowed := inboundFrameAllowed(c.frame, c.role); !known || allowed {
			t.Errorf("%s from a %s: known=%v allowed=%v, want a known frame refused", c.frame, c.role, known, allowed)
		}
	}
	for _, f := range []frameType{frameShellStart, frameShellCancel, frameSessionChanged, frameWorkerMessage} {
		for _, role := range []ClientRole{ClientRoleViewer, ClientRoleEngine} {
			if _, allowed := inboundFrameAllowed(f, role); !allowed {
				t.Errorf("%s from a %s was refused; both roles send it", f, role)
			}
		}
	}
	if known, allowed := inboundFrameAllowed("no-such-frame", ClientRoleEngine); known || allowed {
		t.Errorf("an unknown frame: known=%v allowed=%v, want neither", known, allowed)
	}
}

// A viewer cannot answer for the engine. The forged one-shot-result is dropped
// before dispatch — the armed run is still waiting once the server has handled
// it — and the engine's own answer, sent after, is the one delivered.
func TestOneShotResult_OnlyFromTheEngine(t *testing.T) {
	s, ts := newEngineSocketServer(t)
	engine := dialEngine(t, ts)
	if !waitUntil(muteDetectionBudget, s.IsEngineConnected) {
		t.Fatal("engine never registered")
	}
	viewer, _ := dialViewerStatus(t, ts, testSocketToken)
	if viewer == nil {
		t.Fatal("the viewer was refused")
	}

	ch, err := s.oneShot.arm("run_auth")
	if err != nil {
		t.Fatalf("arm: %v", err)
	}
	answer := map[string]any{"type": "one-shot-result", "requestId": "run_auth", "status": "done"}

	if err := viewer.WriteJSON(answer); err != nil {
		t.Fatalf("viewer send: %v", err)
	}
	// The loop handles one connection's frames in order, so a probe the server
	// has handled proves the forgery before it has been handled too.
	if !awaitHandled(t, ts, viewer) {
		t.Fatal("the viewer's probe was never handled")
	}
	select {
	case res := <-ch:
		t.Fatalf("a viewer's one-shot-result was delivered as the engine's: %+v", res)
	default:
	}

	if err := engine.WriteJSON(answer); err != nil {
		t.Fatalf("engine send: %v", err)
	}
	select {
	case <-ch:
	case <-time.After(2 * time.Second):
		t.Fatal("the engine's one-shot-result was never delivered")
	}
}

// dialViewerStatus dials a viewer socket on a server that enforces the token,
// and returns the connection, or the HTTP status that refused the upgrade.
func dialViewerStatus(t *testing.T, ts *httptest.Server, token string) (*websocket.Conn, int) {
	t.Helper()
	target := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws?role=viewer"
	if token != "" {
		target += "&token=" + token
	}
	conn, resp, err := websocket.DefaultDialer.Dial(target, nil)
	if resp != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		if resp == nil {
			t.Fatalf("viewer WS dial failed: %v", err)
		}
		return nil, resp.StatusCode
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn, http.StatusSwitchingProtocols
}

// newTokenGatedSocketServer is a socket server outside test mode, so the viewer
// token gate is on.
func newTokenGatedSocketServer(t *testing.T) *httptest.Server {
	t.Helper()
	s := newTestServerState(t)
	s.workerManager = worker.NewManager()
	s.upgrader = websocket.Upgrader{}
	s.apiToken = testSocketToken
	ts := httptest.NewServer(http.HandlerFunc(s.handleWebSocket))
	t.Cleanup(ts.Close)
	return ts
}

// No page this server serves dials without the token, so a caller that sends
// none is refused before it is given a socket.
func TestViewerUpgrade_NoTokenRefusedBeforeUpgrade(t *testing.T) {
	ts := newTokenGatedSocketServer(t)
	if _, status := dialViewerStatus(t, ts, ""); status != http.StatusForbidden {
		t.Fatalf("a token-less viewer upgrade got status %d, want 403 in place of the upgrade", status)
	}
}

// A token that is not ours is a page an earlier server instance served. The
// browser cannot read the status of a refused upgrade, so it is upgraded and
// closed before the session frame — the shape websocket.js reloads on.
func TestViewerUpgrade_StaleTokenOpensThenCloses(t *testing.T) {
	ts := newTokenGatedSocketServer(t)
	conn, status := dialViewerStatus(t, ts, "the-instance-that-died")
	if conn == nil {
		t.Fatalf("a stale-token viewer upgrade got status %d; the page needs the socket to open to learn it is stale", status)
	}
	_ = conn.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, msg, err := conn.ReadMessage(); err == nil {
		t.Fatalf("a stale-token viewer was served; first frame %s", msg)
	}

	ours, _ := dialViewerStatus(t, ts, testSocketToken)
	if ours == nil {
		t.Fatal("a viewer with our token was refused")
	}
	_ = ours.SetReadDeadline(time.Now().Add(2 * time.Second))
	if _, _, err := ours.ReadMessage(); err != nil {
		t.Fatalf("a viewer with our token was not served: %v", err)
	}
}
