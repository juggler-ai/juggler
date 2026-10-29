//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"bytes"
	"encoding/binary"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/gorilla/websocket"
)

// TestWSChunkHeaderRoundTrip pins the wire format both ends implement
// independently — Go writes it, web/js/services/websocket.js reads it — so a
// change to either side that is not mirrored fails here.
func TestWSChunkHeaderRoundTrip(t *testing.T) {
	want := wsChunkHeader{kind: wsChunkKindBinary, id: 0x0102030405060708, index: 3, total: 9}
	frame := make([]byte, wsChunkHeaderSize+4)
	encodeWSChunkHeader(frame, want)
	copy(frame[wsChunkHeaderSize:], "data")

	got, data, ok := parseWSChunkHeader(frame)
	if !ok {
		t.Fatal("a header this end wrote was rejected by the parser this end reads with")
	}
	if got != want {
		t.Errorf("header round trip = %+v, want %+v", got, want)
	}
	if string(data) != "data" {
		t.Errorf("data = %q, want %q", data, "data")
	}
	if wsChunkHeaderSize != 21 {
		t.Errorf("wsChunkHeaderSize = %d, want 21 — the JS reader hard-codes this offset",
			wsChunkHeaderSize)
	}
}

// TestWSChunkHeaderRejectsNonChunks covers the case that matters for
// correctness rather than framing: an ordinary binary message must never be
// mistaken for a chunk and swallowed.
func TestWSChunkHeaderRejectsNonChunks(t *testing.T) {
	valid := func(h wsChunkHeader) []byte {
		b := make([]byte, wsChunkHeaderSize)
		encodeWSChunkHeader(b, h)
		return b
	}
	badMagic := valid(wsChunkHeader{index: 0, total: 1})
	badMagic[2] = 'X'

	cases := map[string][]byte{
		"empty":                   {},
		"shorter than the header": make([]byte, wsChunkHeaderSize-1),
		"wrong magic":             badMagic,
		"zero total":              valid(wsChunkHeader{index: 0, total: 0}),
		"index past total":        valid(wsChunkHeader{index: 4, total: 4}),
	}
	for name, frame := range cases {
		if _, _, ok := parseWSChunkHeader(frame); ok {
			t.Errorf("%s: accepted as a chunk frame", name)
		}
	}
}

func TestWSChunkCount(t *testing.T) {
	cases := []struct {
		payload int
		want    int
	}{
		{0, 1},
		{1, 1},
		{wsChunkThreshold, 1},
		{wsChunkThreshold + 1, 2},
		{wsChunkThreshold * 2, 2},
		{wsChunkThreshold*2 + 1, 3},
	}
	for _, c := range cases {
		if got := wsChunkCount(c.payload); got != c.want {
			t.Errorf("wsChunkCount(%d) = %d, want %d", c.payload, got, c.want)
		}
	}
}

// wsPair upgrades a real connection and returns the server's WSClient beside
// the peer that receives what it writes. Nothing here is faked: the production
// upgrader, production buffer sizes, and a real socket in between, because what
// is being tested is what actually reaches a client.
func wsPair(t *testing.T) (*WSClient, *websocket.Conn) {
	t.Helper()

	upgraded := make(chan *websocket.Conn, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u := newWSUpgrader()
		u.CheckOrigin = func(*http.Request) bool { return true }
		conn, err := u.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		upgraded <- conn
	}))
	t.Cleanup(srv.Close)

	peer, resp, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(srv.URL, "http"), nil)
	if resp != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("couldn't dial the test server: %v", err)
	}
	t.Cleanup(func() { _ = peer.Close() })

	var conn *websocket.Conn
	select {
	case conn = <-upgraded:
	case <-time.After(5 * time.Second):
		t.Fatal("the upgrade never completed")
	}

	client := NewWSClient(conn, ClientRoleEngine, "", ClientInfo{}, nil)
	t.Cleanup(client.Close)
	return client, peer
}

// TestAnOversizedMessageArrivesWhole is the regression test for the reported
// failure: a full-state resync larger than any client will accept as one
// message used to be written whole, and the client answered it by closing the
// connection — permanently, since reconnecting produced the same message again.
//
// The payload deliberately straddles a chunk boundary with a multi-byte rune.
// That is the hazard the binary framing exists to avoid: split as text into
// JSON string fields, the two halves of that rune would each be invalid UTF-8.
func TestAnOversizedMessageArrivesWhole(t *testing.T) {
	if testing.Short() {
		t.Skip("allocates a payload larger than the chunk threshold")
	}
	client, peer := wsPair(t)

	// A rune whose three bytes span the first boundary: it starts one byte
	// before it and ends one byte after.
	payload := bytes.Repeat([]byte("a"), wsChunkThreshold-1)
	payload = append(payload, []byte("€")...)
	payload = append(payload, bytes.Repeat([]byte("b"), wsChunkThreshold)...)
	if !utf8.Valid(payload) {
		t.Fatal("the test payload is not valid UTF-8 to begin with")
	}
	wantChunks := wsChunkCount(len(payload))
	if wantChunks < 3 {
		t.Fatalf("the payload should span at least three chunks, got %d", wantChunks)
	}

	client.SendRaw(payload)

	var (
		reassembled []byte
		id          uint64
		seen        int
	)
	_ = peer.SetReadDeadline(time.Now().Add(30 * time.Second))
	for seen < wantChunks {
		msgType, frame, err := peer.ReadMessage()
		if err != nil {
			t.Fatalf("reading chunk %d: %v", seen, err)
		}
		if msgType != websocket.BinaryMessage {
			t.Fatalf("chunk %d arrived as message type %d, want binary (%d)",
				seen, msgType, websocket.BinaryMessage)
		}
		h, data, ok := parseWSChunkHeader(frame)
		if !ok {
			t.Fatalf("chunk %d is not a well-formed chunk frame", seen)
		}
		if h.kind != wsChunkKindText {
			t.Errorf("chunk %d kind = %d, want text (%d)", seen, h.kind, wsChunkKindText)
		}
		if int(h.total) != wantChunks {
			t.Errorf("chunk %d claims total %d, want %d", seen, h.total, wantChunks)
		}
		if int(h.index) != seen {
			t.Fatalf("chunk arrived at index %d, want %d — the run must be in order",
				h.index, seen)
		}
		if seen == 0 {
			id = h.id
		} else if h.id != id {
			t.Fatalf("chunk %d carries id %d, want %d — one message's frames must share an id",
				seen, h.id, id)
		}
		reassembled = append(reassembled, data...)
		seen++
	}

	if !bytes.Equal(reassembled, payload) {
		t.Fatalf("reassembled %d bytes, want %d, and they differ", len(reassembled), len(payload))
	}
	if !utf8.Valid(reassembled) {
		t.Error("the reassembled payload is not valid UTF-8")
	}
}

// TestAnOrdinaryMessageIsNotChunked keeps the exceptional path exceptional:
// everything the server sends in a normal session is kilobytes, and none of it
// should acquire a header or change message type.
func TestAnOrdinaryMessageIsNotChunked(t *testing.T) {
	client, peer := wsPair(t)

	want := `{"type":"session","clientId":"client_abc"}`
	client.SendRaw([]byte(want))

	_ = peer.SetReadDeadline(time.Now().Add(5 * time.Second))
	msgType, frame, err := peer.ReadMessage()
	if err != nil {
		t.Fatalf("reading the message: %v", err)
	}
	if msgType != websocket.TextMessage {
		t.Errorf("message type = %d, want text (%d)", msgType, websocket.TextMessage)
	}
	if string(frame) != want {
		t.Errorf("payload = %q, want %q", frame, want)
	}
}

// TestChunkRunsAreNamedApart pins the one property the client's reassembler
// needs beyond ordering: two oversized messages on the same connection must not
// share an id, or a dropped frame would splice them together.
func TestChunkRunsAreNamedApart(t *testing.T) {
	if testing.Short() {
		t.Skip("allocates payloads larger than the chunk threshold")
	}
	client, peer := wsPair(t)

	payload := bytes.Repeat([]byte("x"), wsChunkThreshold+1)
	client.SendRaw(payload)
	client.SendRaw(payload)

	ids := make([]uint64, 0, 2)
	_ = peer.SetReadDeadline(time.Now().Add(30 * time.Second))
	for i := 0; i < 4; i++ {
		_, frame, err := peer.ReadMessage()
		if err != nil {
			t.Fatalf("reading frame %d: %v", i, err)
		}
		h, _, ok := parseWSChunkHeader(frame)
		if !ok {
			t.Fatalf("frame %d is not a well-formed chunk frame", i)
		}
		if h.index == 0 {
			ids = append(ids, h.id)
		}
	}
	if len(ids) != 2 {
		t.Fatalf("saw %d runs, want 2", len(ids))
	}
	if ids[0] == ids[1] {
		t.Errorf("both messages were sent under id %d; a lost frame would splice them", ids[0])
	}
}

// TestDescribeWSMessage covers the label that turns a write failure from "a
// write failed" into "this conversation's resync failed". The worker envelope
// carries nearly all of Juggler's traffic, so naming what is inside it is the
// difference between a diagnosable log and an anonymous one.
func TestDescribeWSMessage(t *testing.T) {
	cases := []struct {
		name    string
		payload string
		want    string
	}{
		{
			name:    "worker envelope names its message and conversation",
			payload: `{"type":"worker-message","conversationId":"conv_abc","workerMsgType":"yjs-sync","payload":{}}`,
			want:    "yjs-sync (conv_abc)",
		},
		{
			name:    "a plain message is named by its type",
			payload: `{"type":"providers-update","providers":[]}`,
			want:    "providers-update",
		},
		{
			name:    "an envelope missing its worker type still names itself",
			payload: `{"type":"worker-message","conversationId":"conv_abc"}`,
			want:    "worker-message",
		},
		{
			name:    "a payload with no type is not worth guessing at",
			payload: `{"conversationId":"conv_abc"}`,
			want:    "unlabelled",
		},
		{
			// The failure path must never be the thing that panics: a payload
			// this broken still has a size worth logging.
			name:    "truncated JSON is described rather than fatal",
			payload: `{"type":"worker-message","conversationId":"conv_`,
			want:    "worker-message",
		},
	}
	for _, c := range cases {
		if got := describeWSMessage([]byte(c.payload)); got != c.want {
			t.Errorf("%s: describeWSMessage = %q, want %q", c.name, got, c.want)
		}
	}
}

// parseWSChunkHeader splits a frame into its header and data. Reports false for
// anything that is not a well-formed chunk frame, so an ordinary binary message
// is never mistaken for one.
func parseWSChunkHeader(frame []byte) (wsChunkHeader, []byte, bool) {
	if len(frame) < wsChunkHeaderSize {
		return wsChunkHeader{}, nil, false
	}
	if string(frame[0:4]) != string(wsChunkMagic[:]) {
		return wsChunkHeader{}, nil, false
	}
	h := wsChunkHeader{
		kind:  frame[4],
		id:    binary.BigEndian.Uint64(frame[5:13]),
		index: binary.BigEndian.Uint32(frame[13:17]),
		total: binary.BigEndian.Uint32(frame[17:21]),
	}
	if h.total == 0 || h.index >= h.total {
		return wsChunkHeader{}, nil, false
	}
	return h, frame[wsChunkHeaderSize:], true
}
