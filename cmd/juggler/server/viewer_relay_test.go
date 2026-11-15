//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// relayFrame is a delivered relay as a viewer sees it.
type relayFrame struct {
	Type    string          `json:"type"`
	From    string          `json:"from"`
	Payload json.RawMessage `json:"payload"`
}

// testViewerClient builds a joinable WSClient carrying a viewer id, with a
// buffered send channel standing in for a connection.
func testViewerClient(id, viewerID string) *WSClient {
	return &WSClient{
		ID:       id,
		Role:     ClientRoleViewer,
		viewerID: viewerID,
		send:     make(chan wsMessage, 256),
		closed:   make(chan struct{}),
	}
}

// receivedAnything reports whether a client was sent anything within a short
// window. Used ONLY for the negative cases, where the point is that nothing
// arrives: a flat wait is all such an assertion can be, so it is kept cheap.
// A positive case waits on awaitDelivery instead.
func receivedAnything(c *WSClient) bool {
	select {
	case <-c.send:
		return true
	case <-time.After(150 * time.Millisecond):
		return false
	}
}

// relayBudget bounds every wait here that expects something to arrive. A
// test-local patience limit, not a product constant: nothing in the relay path
// is slow, so the budget is spent only when a run is already failing, and a
// generous one costs a passing run nothing. It is generous rather than huge
// because the package shares one `-timeout 5m`: a budget long enough for
// several blown waits to add up to that would trade a named test failure for
// the whole package being killed, which reports nothing about which wait broke.
const relayBudget = 20 * time.Second

// awaitDelivery blocks until the client is sent something, and fails the test if
// nothing is. Delivery is asynchronous in two hops — sendToViewer posts an op to
// the viewer group's loop, which hands the message to each client's mailbox — so
// how long it takes is a question about the scheduler, and a CI machine running
// a whole suite's sockets alongside can take orders of magnitude longer over it
// than a quiet laptop. The budget is generous because it is only ever paid when
// the test is already failing.
func awaitDelivery(t *testing.T, c *WSClient, who string) wsMessage {
	t.Helper()
	select {
	case msg := <-c.send:
		return msg
	case <-time.After(relayBudget):
		t.Fatalf("%s received nothing", who)
		return wsMessage{}
	}
}

// TestViewerRelay_ReachesOnlyTheNamedViewer is the whole contract: this
// addresses one viewer, and the other viewers of the same project are not
// merely uninterested in the message, they never see it.
func TestViewerRelay_ReachesOnlyTheNamedViewer(t *testing.T) {
	s := newTestServerState(t)

	a := testViewerClient("c1", "v_a")
	b := testViewerClient("c2", "v_b")
	c := testViewerClient("c3", "v_c")
	s.joinViewerGroup(a)
	s.joinViewerGroup(b)
	s.joinViewerGroup(c)

	s.viewerSendToViewer("v_b", map[string]string{"type": "viewer-relay"})

	if msg := awaitDelivery(t, b, "the addressed viewer"); msg.json == nil {
		t.Fatal("the addressed viewer got an empty message")
	}
	if receivedAnything(a) {
		t.Error("a viewer that was not addressed received the relay")
	}
	if receivedAnything(c) {
		t.Error("a second unaddressed viewer received the relay")
	}
}

// TestViewerRelay_EmptyIDReachesNobody: an unset recipient must not degenerate
// into a broadcast. This is the failure that would quietly turn a private
// message between two viewers into one every viewer of the project can read.
func TestViewerRelay_EmptyIDReachesNobody(t *testing.T) {
	s := newTestServerState(t)

	a := testViewerClient("c1", "v_a")
	b := testViewerClient("c2", "")
	s.joinViewerGroup(a)
	s.joinViewerGroup(b)

	s.viewerSendToViewer("", map[string]string{"type": "viewer-relay"})

	if receivedAnything(a) {
		t.Error("an empty recipient id reached a viewer that has one")
	}
	if receivedAnything(b) {
		t.Error("an empty recipient id reached the viewer with no id, which nothing can address")
	}
}

// TestViewerRelay_UnknownIDIsDropped: there is no queue behind this. A viewer
// that has gone never receives what was sent while it was away.
func TestViewerRelay_UnknownIDIsDropped(t *testing.T) {
	s := newTestServerState(t)

	a := testViewerClient("c1", "v_a")
	s.joinViewerGroup(a)

	s.viewerSendToViewer("v_nobody", map[string]string{"type": "viewer-relay"})

	if receivedAnything(a) {
		t.Error("a relay addressed to an unknown viewer was delivered to someone else")
	}
}

// TestViewerRelay_DuplicateIDsBothReceive pins the deliberate answer to a
// duplicated tab carrying a copied id: both connections get it. Delivering to
// one of them would mean choosing, and there is nothing to choose on.
func TestViewerRelay_DuplicateIDsBothReceive(t *testing.T) {
	s := newTestServerState(t)

	first := testViewerClient("c1", "v_same")
	second := testViewerClient("c2", "v_same")
	s.joinViewerGroup(first)
	s.joinViewerGroup(second)

	s.viewerSendToViewer("v_same", map[string]string{"type": "viewer-relay"})

	awaitDelivery(t, first, "the first connection under the shared id")
	awaitDelivery(t, second, "the second connection under the shared id")
}

// TestViewerRelay_LeavingStopsDelivery: a viewer that has left the group is not
// addressable, even under an id that was valid a moment ago.
func TestViewerRelay_LeavingStopsDelivery(t *testing.T) {
	s := newTestServerState(t)

	a := testViewerClient("c1", "v_a")
	b := testViewerClient("c2", "v_b")
	s.joinViewerGroup(a)
	s.joinViewerGroup(b)
	s.leaveViewerGroup("c2")

	s.viewerSendToViewer("v_b", map[string]string{"type": "viewer-relay"})

	if receivedAnything(b) {
		t.Error("a departed viewer was still delivered to")
	}
	if receivedAnything(a) {
		t.Error("a relay to a departed viewer fell through to another one")
	}
}

// --- Over a real socket, through the inbound dispatch ---

// nextRelay reads frames until a viewer-relay arrives, or fails.
func nextRelay(t *testing.T, conn *websocket.Conn) relayFrame {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(relayBudget))
	for {
		_, msgBytes, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("no relay reached the viewer: %v", err)
		}
		var frame relayFrame
		if err := json.Unmarshal(msgBytes, &frame); err != nil {
			continue
		}
		if frame.Type == "viewer-relay" {
			return frame
		}
	}
}

// expectNoRelay reads for a short window and fails if a relay arrives. Other
// frames (the connect seeds, heartbeats) are skipped: the assertion is about
// this message type reaching this viewer, not about the link being silent.
func expectNoRelay(t *testing.T, conn *websocket.Conn) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(400 * time.Millisecond))
	for {
		_, msgBytes, err := conn.ReadMessage()
		if err != nil {
			return // the read deadline expiring is the pass
		}
		var frame relayFrame
		if err := json.Unmarshal(msgBytes, &frame); err != nil {
			continue
		}
		if frame.Type == "viewer-relay" {
			t.Fatalf("a relay reached a viewer it was not addressed to, from %q", frame.From)
		}
	}
}

// dialRole opens a real socket in the given role with the given viewer id, and
// returns only once that connection has joined the viewer group — which is what
// makes it addressable.
//
// The dial returns as soon as the upgrade handshake does, several steps before
// the server-side loop joins the group, so a relay sent the moment a dial
// returns can be routed while its recipient is still not in the set. There is no
// queue behind a relay, so it would simply be dropped and the test would wait
// out its read deadline for a message that was never going to come.
//
// The probe is any message at all: the loop handles inbound messages only after
// it has joined, and the join and the relay are enqueued on the viewer group's
// one channel, so a frame the server emits in consequence proves the join is
// already in front of anything sent next. session-changed is used because it has
// nothing to do with relaying, so a broken relay fails an assertion rather than
// this setup. The server sends it on to every client but its sender, so it is
// watched for on a second connection (see awaitHandled).
func dialRole(t *testing.T, ts *httptest.Server, role, viewerID string) *websocket.Conn {
	t.Helper()
	conn := dialSocket(t, ts, "role="+role+"&viewerId="+viewerID)
	if !awaitHandled(t, ts, conn) {
		t.Fatalf("the %s connection never joined the viewer group", role)
	}
	return conn
}

// dialSocket opens a real socket with the given query (the token is added), and
// closes it when the test ends.
func dialSocket(t *testing.T, ts *httptest.Server, query string) *websocket.Conn {
	t.Helper()
	dialURL := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws?" + query + "&token=" + testSocketToken
	conn, resp, err := websocket.DefaultDialer.Dial(dialURL, nil)
	if resp != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("WS dial (%s) failed: %v", query, err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

// awaitHandled sends session-changed on conn and reports whether the server
// handled it, which it does only after every frame conn sent before it — a
// connection's frames are handled in order, by a loop that runs only once the
// connection has registered and joined the viewer group.
//
// The server does not send session-changed back to its sender, so the proof is
// read on an observer: a viewer opened for the purpose and closed afterwards.
// The observer is waited on until it has been sent providers-update, which the
// server sends only once the connection is registered with the hub, so every
// broadcast after that reaches it.
func awaitHandled(t *testing.T, ts *httptest.Server, conn *websocket.Conn) bool {
	t.Helper()
	observer := dialSocket(t, ts, "role=viewer")
	defer func() { _ = observer.Close() }()
	if !readFrameType(observer, "providers-update") {
		t.Fatal("the observer connection was never registered")
	}
	if err := conn.WriteJSON(map[string]string{"type": "session-changed"}); err != nil {
		t.Fatalf("readiness probe could not be sent: %v", err)
	}
	return readFrameType(observer, "session-changed")
}

// readFrameType reads conn until a frame of type want arrives, and reports
// whether one did within relayBudget.
func readFrameType(conn *websocket.Conn, want string) bool {
	_ = conn.SetReadDeadline(time.Now().Add(relayBudget))
	for {
		_, msgBytes, err := conn.ReadMessage()
		if err != nil {
			return false
		}
		var frame relayFrame
		if json.Unmarshal(msgBytes, &frame) == nil && frame.Type == want {
			return true
		}
	}
}

// TestViewerRelay_PayloadTravelsVerbatim drives the whole path over two real
// sockets. The server routes the message and reads nothing inside it, so what
// arrives is byte-for-byte what was sent.
func TestViewerRelay_PayloadTravelsVerbatim(t *testing.T) {
	_, ts := newViewerSocketServer(t)

	sender := dialRole(t, ts, "viewer", "v_sender")
	recipient := dialRole(t, ts, "viewer", "v_recipient")

	const payload = `{"kind":"active-context","conversation":{"id":"conv_1","title":"Auth \"refactor\""},"nested":[1,2,{"deep":null}]}`
	if err := sender.WriteMessage(websocket.TextMessage,
		[]byte(`{"type":"viewer-relay","to":"v_recipient","payload":`+payload+`}`)); err != nil {
		t.Fatalf("send: %v", err)
	}

	frame := nextRelay(t, recipient)
	if string(frame.Payload) != payload {
		t.Errorf("payload arrived as %s, want %s", frame.Payload, payload)
	}
	if frame.From != "v_sender" {
		t.Errorf("relay arrived from %q, want %q", frame.From, "v_sender")
	}
}

// TestViewerRelay_FromCannotBeForged: the sender is taken from the connection,
// never from the message, so a viewer cannot pass itself off as another one.
func TestViewerRelay_FromCannotBeForged(t *testing.T) {
	_, ts := newViewerSocketServer(t)

	sender := dialRole(t, ts, "viewer", "v_sender")
	recipient := dialRole(t, ts, "viewer", "v_recipient")

	if err := sender.WriteMessage(websocket.TextMessage,
		[]byte(`{"type":"viewer-relay","to":"v_recipient","from":"v_someone_else","payload":{}}`)); err != nil {
		t.Fatalf("send: %v", err)
	}

	frame := nextRelay(t, recipient)
	if frame.From != "v_sender" {
		t.Errorf("a forged sender was believed: relay arrived from %q, want %q", frame.From, "v_sender")
	}
}

// TestViewerRelay_EngineCannotRelay: the engine has nothing to say to a single
// viewer that engine-bridge does not already carry, and it is not a viewer, so
// the case is refused rather than routed.
func TestViewerRelay_EngineCannotRelay(t *testing.T) {
	_, ts := newViewerSocketServer(t)

	recipient := dialRole(t, ts, "viewer", "v_recipient")
	engine := dialRole(t, ts, "engine", "v_engine")

	if err := engine.WriteMessage(websocket.TextMessage,
		[]byte(`{"type":"viewer-relay","to":"v_recipient","payload":{}}`)); err != nil {
		t.Fatalf("send: %v", err)
	}

	expectNoRelay(t, recipient)
}

// TestViewerRelay_UnknownRecipientOverTheSocket: the sender is told nothing and
// nothing else is disturbed. Best-effort means exactly this.
func TestViewerRelay_UnknownRecipientOverTheSocket(t *testing.T) {
	_, ts := newViewerSocketServer(t)

	sender := dialRole(t, ts, "viewer", "v_sender")
	bystander := dialRole(t, ts, "viewer", "v_bystander")

	if err := sender.WriteMessage(websocket.TextMessage,
		[]byte(`{"type":"viewer-relay","to":"v_nobody","payload":{}}`)); err != nil {
		t.Fatalf("send: %v", err)
	}

	expectNoRelay(t, bystander)
	expectNoRelay(t, sender)
}
