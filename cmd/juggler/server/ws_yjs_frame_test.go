//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"reflect"
	"slices"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/worker"

	"github.com/gorilla/websocket"
)

func intPtr(n int) *int { return &n }

// TestYjsFrameRoundTrip pins the layout both ends implement independently — Go
// here, web/js/utils/yjs-sync-frame.js in the browser.
func TestYjsFrameRoundTrip(t *testing.T) {
	cases := map[string]yjsFrame{
		"plain sync":        {kind: yjsFrameKindSync, convID: "conv_abc", update: []byte{0, 1, 2, 0xff}},
		"engine derived":    {kind: yjsFrameKindSync, convID: "conv_é", engineDerived: true, update: []byte{9}},
		"since edit":        {kind: yjsFrameKindSync, convID: "c", sinceEditMs: intPtr(1234), update: []byte{1, 2}},
		"zero since edit":   {kind: yjsFrameKindSync, convID: "c", sinceEditMs: intPtr(0), update: []byte{1}},
		"empty update":      {kind: yjsFrameKindSync, convID: "c"},
		"resync with state": {kind: yjsFrameKindResyncResponse, convID: "conv_x", stateVector: []byte{1, 2, 3}, update: []byte{4, 5}},
		"resync empty vec":  {kind: yjsFrameKindResyncResponse, convID: "conv_x", stateVector: []byte{}, update: []byte{4}},
	}
	for name, want := range cases {
		frame := encodeYjsFrame(want)
		if !isYjsFrame(frame) {
			t.Errorf("%s: an encoded frame is not recognised as one", name)
			continue
		}
		got, err := parseYjsFrame(frame)
		if err != nil {
			t.Errorf("%s: parse of an encoded frame failed: %v", name, err)
			continue
		}
		if got.kind != want.kind || got.convID != want.convID || got.engineDerived != want.engineDerived {
			t.Errorf("%s: header round trip = %+v, want %+v", name, got, want)
		}
		if (got.sinceEditMs == nil) != (want.sinceEditMs == nil) || (got.sinceEditMs != nil && *got.sinceEditMs != *want.sinceEditMs) {
			t.Errorf("%s: sinceEditMs = %v, want %v", name, got.sinceEditMs, want.sinceEditMs)
		}
		if (got.stateVector == nil) != (want.stateVector == nil) || !bytes.Equal(got.stateVector, want.stateVector) {
			t.Errorf("%s: stateVector = %v, want %v", name, got.stateVector, want.stateVector)
		}
		if !bytes.Equal(got.update, want.update) {
			t.Errorf("%s: update = %v, want %v", name, got.update, want.update)
		}
	}

	// The fixed prefix is spelled out longhand, as the JS reader hard-codes it.
	frame := encodeYjsFrame(yjsFrame{kind: yjsFrameKindSync, convID: "ab", engineDerived: true, update: []byte{7}})
	want := []byte{'J', 'Y', 'S', '1', 1, 1, 0, 2, 'a', 'b', 7}
	if !bytes.Equal(frame, want) {
		t.Errorf("frame bytes = %v, want %v", frame, want)
	}
}

// TestYjsFrameRejectsMalformed: anything that is not a well-formed frame is
// refused, never read past its end, and a chunk frame is never mistaken for one.
func TestYjsFrameRejectsMalformed(t *testing.T) {
	valid := encodeYjsFrame(yjsFrame{kind: yjsFrameKindResyncResponse, convID: "conv", stateVector: []byte{1, 2}, update: []byte{3}})
	if _, err := parseYjsFrame(valid); err != nil {
		t.Fatalf("a valid frame was refused: %v", err)
	}
	mutate := func(f func(b []byte) []byte) []byte { return f(slices.Clone(valid)) }

	cases := map[string][]byte{
		"empty":             {},
		"magic only":        []byte("JYS1"),
		"chunk magic":       mutate(func(b []byte) []byte { copy(b, "JGC1"); return b }),
		"json":              []byte(`{"type":"worker-message"}`),
		"unknown kind":      mutate(func(b []byte) []byte { b[4] = 9; return b }),
		"unknown flag":      mutate(func(b []byte) []byte { b[5] |= 0x80; return b }),
		"empty conv":        encodeYjsFrameRaw(yjsFrameKindSync, 0, "", nil),
		"conv past the end": mutate(func(b []byte) []byte { binary.BigEndian.PutUint16(b[6:8], 500); return b }),
		"vector past end":   mutate(func(b []byte) []byte { binary.BigEndian.PutUint32(b[12:16], 1<<20); return b }),
		"truncated vector":  valid[:len(valid)-3],
		"truncated since":   encodeYjsFrameRaw(yjsFrameKindSync, yjsFlagSinceEdit, "c", []byte{0, 1}),
		"sync with vector":  encodeYjsFrameRaw(yjsFrameKindSync, yjsFlagStateVector, "c", []byte{0, 0, 0, 0}),
	}
	for name, frame := range cases {
		if _, err := parseYjsFrame(frame); err == nil {
			t.Errorf("%s: accepted as a sync frame", name)
		}
	}
	if isYjsFrame(mutate(func(b []byte) []byte { copy(b, "JGC1"); return b })) {
		t.Error("a chunk frame was recognised as a sync frame")
	}
}

// encodeYjsFrameRaw writes a header with arbitrary flags, for frames the
// encoder would never produce.
func encodeYjsFrameRaw(kind, flags byte, convID string, rest []byte) []byte {
	b := append([]byte("JYS1"), kind, flags, 0, 0)
	binary.BigEndian.PutUint16(b[6:8], uint16(len(convID)))
	b = append(b, convID...)
	return append(b, rest...)
}

// TestYjsFrameCoversWorkerFields keeps the binary path from silently dropping
// a field: the frame carries every field of the two messages it replaces, and
// a field added to either fails here until the frame learns it.
func TestYjsFrameCoversWorkerFields(t *testing.T) {
	fields := func(v any) []string {
		var out []string
		rt := reflect.TypeOf(v)
		for i := 0; i < rt.NumField(); i++ {
			out = append(out, rt.Field(i).Name)
		}
		return out
	}
	if got, want := fields(worker.YjsSyncMessage{}), []string{"Type", "Bytes", "EngineDerived", "SinceEditMs"}; !slices.Equal(got, want) {
		t.Errorf("YjsSyncMessage fields = %v; the JYS1 frame carries %v", got, want)
	}
	if got, want := fields(worker.ResyncResponseMessage{}), []string{"Type", "Bytes", "StateVector"}; !slices.Equal(got, want) {
		t.Errorf("ResyncResponseMessage fields = %v; the JYS1 frame carries %v", got, want)
	}
}

// TestYjsFrameFromWorkerPayload: the worker's JSON payloads become frames that
// carry the same bytes, and anything else is left to the JSON envelope.
func TestYjsFrameFromWorkerPayload(t *testing.T) {
	update := bytes.Repeat([]byte{0, 0xff, 0x7f, 0x80}, 1000)

	sync, _ := json.Marshal(worker.YjsSyncMessage{Type: "yjs-sync", Bytes: update, EngineDerived: true})
	f, err := parseYjsFrame(yjsFrameFromWorkerPayload("conv_s", sync))
	if err != nil {
		t.Fatalf("yjs-sync payload did not become a frame: %v", err)
	}
	if f.kind != yjsFrameKindSync || f.convID != "conv_s" || !f.engineDerived || !bytes.Equal(f.update, update) {
		t.Errorf("yjs-sync frame = kind %d conv %q derived %v, %d bytes; want the payload's", f.kind, f.convID, f.engineDerived, len(f.update))
	}

	resync, _ := json.Marshal(worker.ResyncResponseMessage{Type: "resync-response", Bytes: update[:10], StateVector: []byte{1, 2}})
	f, err = parseYjsFrame(yjsFrameFromWorkerPayload("conv_r", resync))
	if err != nil {
		t.Fatalf("resync-response payload did not become a frame: %v", err)
	}
	if f.kind != yjsFrameKindResyncResponse || !bytes.Equal(f.update, update[:10]) || !bytes.Equal(f.stateVector, []byte{1, 2}) {
		t.Errorf("resync-response frame = %+v", f)
	}

	nilVector, _ := json.Marshal(worker.ResyncResponseMessage{Type: "resync-response", Bytes: []byte{1}})
	f, err = parseYjsFrame(yjsFrameFromWorkerPayload("conv_r", nilVector))
	if err != nil || f.stateVector != nil {
		t.Errorf("an absent state vector must stay absent: %+v, %v", f, err)
	}

	for _, other := range []string{`{"type":"ready"}`, `{"type":"yjs-sync","bytes":"!!not base64"}`, `not json`} {
		if got := yjsFrameFromWorkerPayload("c", []byte(other)); got != nil {
			t.Errorf("%s became a sync frame", other)
		}
	}
}

// TestInboundYjsFrameBecomesWorkerMessage: a client's binary sync reaches the
// worker as the very message its JSON envelope would have been.
func TestInboundYjsFrameBecomesWorkerMessage(t *testing.T) {
	update := []byte{1, 2, 3, 0, 255}
	wm, err := workerMessageFromYjsFrame(encodeYjsFrame(yjsFrame{
		kind: yjsFrameKindSync, convID: "conv_in", engineDerived: true, sinceEditMs: intPtr(42), update: update,
	}))
	if err != nil {
		t.Fatalf("a client sync frame was refused: %v", err)
	}
	if wm.ConversationID != "conv_in" || wm.WorkerMsgType != "yjs-sync" {
		t.Errorf("routed to %q as %q", wm.ConversationID, wm.WorkerMsgType)
	}
	var msg worker.YjsSyncMessage
	if err := json.Unmarshal(wm.Payload, &msg); err != nil {
		t.Fatalf("payload is not a yjs-sync message: %v", err)
	}
	if msg.Type != "yjs-sync" || !bytes.Equal(msg.Bytes, update) || !msg.EngineDerived || msg.SinceEditMs == nil || *msg.SinceEditMs != 42 {
		t.Errorf("payload = %+v", msg)
	}

	if _, err := workerMessageFromYjsFrame(encodeYjsFrame(yjsFrame{kind: yjsFrameKindResyncResponse, convID: "c", update: []byte{1}})); err == nil {
		t.Error("a client may not send a resync-response")
	}
}

// TestWorkerSyncTravelsAsBinary: a yjs-sync for a client that asked for binary
// is written as one binary frame carrying the update bytes, in order with the
// JSON around it; a client that did not ask still gets the JSON envelope.
func TestWorkerSyncTravelsAsBinary(t *testing.T) {
	update := bytes.Repeat([]byte{0xde, 0xad, 0, 1}, 64)
	payload, _ := json.Marshal(worker.YjsSyncMessage{Type: "yjs-sync", Bytes: update})

	client, peer := wsPair(t)
	client.binarySync = true
	client.SendRaw([]byte(`{"type":"before"}`))
	sendWorkerMessage(client, "conv_b", payload)
	client.SendRaw([]byte(`{"type":"after"}`))

	_ = peer.SetReadDeadline(time.Now().Add(5 * time.Second))
	read := func() (int, []byte) {
		kind, data, err := peer.ReadMessage()
		if err != nil {
			t.Fatalf("read: %v", err)
		}
		return kind, data
	}
	if _, data := read(); string(data) != `{"type":"before"}` {
		t.Fatalf("first message = %s", data)
	}
	kind, data := read()
	if kind != websocket.BinaryMessage {
		t.Fatalf("the sync arrived as message type %d, want binary", kind)
	}
	f, err := parseYjsFrame(data)
	if err != nil || f.convID != "conv_b" || !bytes.Equal(f.update, update) {
		t.Fatalf("the binary frame does not carry the update: %+v, %v", f, err)
	}
	if _, data := read(); string(data) != `{"type":"after"}` {
		t.Fatalf("third message = %s", data)
	}

	plain, plainPeer := wsPair(t)
	sendWorkerMessage(plain, "conv_b", payload)
	_ = plainPeer.SetReadDeadline(time.Now().Add(5 * time.Second))
	kind, data, err = plainPeer.ReadMessage()
	if err != nil || kind != websocket.TextMessage || !strings.Contains(string(data), `"workerMsgType":"yjs-sync"`) {
		t.Fatalf("a client that did not ask for binary got kind %d %.80s (%v)", kind, data, err)
	}
}

// TestViewerSocket_BinarySyncEndToEnd drives a real worker over a real socket:
// a viewer that asks for binary is told so, receives the worker's state as a
// binary frame, and a binary update it sends is applied to the worker's doc.
func TestViewerSocket_BinarySyncEndToEnd(t *testing.T) {
	s, ts := newViewerSocketServer(t)
	t.Cleanup(s.workerManager.Shutdown)
	url := "ws" + strings.TrimPrefix(ts.URL, "http") + "/ws?role=viewer&sync=binary"
	conn, resp, err := websocket.DefaultDialer.Dial(url, nil)
	if resp != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		t.Fatalf("dial: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	_ = conn.SetReadDeadline(time.Now().Add(20 * time.Second))

	const convID = "conv-binary"
	sawSession := false
	for !sawSession {
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("no session frame: %v", err)
		}
		var m map[string]any
		if json.Unmarshal(data, &m) == nil && m["type"] == "session" {
			sawSession = true
			if m["binarySync"] != true {
				t.Fatalf("the session frame did not grant binary sync: %s", data)
			}
		}
	}

	initPayload, _ := json.Marshal(worker.InitMessage{
		Type:         "init",
		Conversation: worker.SerializedConversation{ID: convID, Name: "Binary"},
		Config:       worker.WorkerConfig{ProjectPath: t.TempDir()},
	})
	if err := conn.WriteJSON(worker.WorkerMessage{Type: "worker-message", ConversationID: convID, WorkerMsgType: "init", Payload: initPayload}); err != nil {
		t.Fatal(err)
	}

	client := worker.NewConversationDocument(convID, "client-test")
	t.Cleanup(client.Destroy)
	gotState := false
	for !gotState {
		kind, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("no binary state arrived: %v", err)
		}
		if kind == websocket.TextMessage && strings.Contains(string(data), `"workerMsgType":"yjs-sync"`) {
			t.Fatalf("a viewer that asked for binary was sent a JSON yjs-sync")
		}
		if kind != websocket.BinaryMessage {
			continue
		}
		f, err := parseYjsFrame(data)
		if err != nil || f.convID != convID || f.kind != yjsFrameKindSync {
			t.Fatalf("unexpected binary message: %+v, %v", f, err)
		}
		if err := client.ApplySyncUpdate(f.update); err != nil {
			t.Fatalf("the frame's update does not apply: %v", err)
		}
		gotState = true
	}

	client.SetMetadata("binaryProbe", "arrived")
	if err := conn.WriteMessage(websocket.BinaryMessage, encodeYjsFrame(yjsFrame{
		kind: yjsFrameKindSync, convID: convID, update: client.GetStateUpdate(nil),
	})); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(20 * time.Second)
	for time.Now().Before(deadline) {
		if w := s.workerManager.Get(convID); w != nil && w.Document().GetMetadata("binaryProbe") == "arrived" {
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("the worker never applied the viewer's binary sync")
}
