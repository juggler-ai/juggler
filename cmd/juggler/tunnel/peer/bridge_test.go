//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package peer

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"

	"juggler/cmd/juggler/tunnel"
)

// guest is a remote browser's half of a link, as the rendezvous bootstrap
// page plays it: it offers the "juggler" data channel and reads its frames,
// joining chunks.
type guest struct {
	t      *testing.T
	pc     *webrtc.PeerConnection
	dc     *webrtc.DataChannel
	frames chan []byte
	// pieces holds the channel's binary messages, as they arrive.
	pieces chan []byte
	closed chan struct{}
	chunks *reassembler
}

// dialGuest connects a guest to p, whose link serves to until life ends.
func dialGuest(t *testing.T, p *Peer, life context.Context, to target) *guest {
	t.Helper()
	pc, err := webrtc.NewPeerConnection(webrtc.Configuration{})
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = pc.Close() })
	dc, err := pc.CreateDataChannel("juggler", nil)
	if err != nil {
		t.Fatal(err)
	}
	// The server's answers interleave, one per request in flight and the
	// WebSocket's, each up to the largest response.
	chunks := newReassembler()
	chunks.maxAssemblies = maxConcurrentRequests + 1
	chunks.maxFrameBytes = 2 * maxResponseBodyBytes
	chunks.maxHeldBytes = chunks.maxAssemblies * chunks.maxFrameBytes
	g := &guest{t: t, pc: pc, dc: dc, frames: make(chan []byte, 256), pieces: make(chan []byte, 1024), closed: make(chan struct{}), chunks: chunks}
	opened := make(chan struct{})
	dc.OnOpen(func() { close(opened) })
	dc.OnClose(func() { close(g.closed) })
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		if m.IsString {
			g.frames <- append([]byte(nil), m.Data...)
		} else {
			g.pieces <- append([]byte(nil), m.Data...)
		}
	})
	offer, err := pc.CreateOffer(nil)
	if err != nil {
		t.Fatal(err)
	}
	gathered := webrtc.GatheringCompletePromise(pc)
	if err := pc.SetLocalDescription(offer); err != nil {
		t.Fatal(err)
	}
	<-gathered
	local := pc.LocalDescription()
	answer, err := p.Accept(t.Context(), life, tunnel.SessionDescription{Type: "offer", SDP: local.SDP}, nil, to.dial, to.host)
	if err != nil {
		t.Fatalf("Accept: %v", err)
	}
	if answer.Type != "answer" {
		t.Fatalf("answer type %q", answer.Type)
	}
	if err := pc.SetRemoteDescription(webrtc.SessionDescription{Type: webrtc.SDPTypeAnswer, SDP: answer.SDP}); err != nil {
		t.Fatal(err)
	}
	select {
	case <-opened:
	case <-time.After(20 * time.Second):
		t.Fatal("the data channel never opened")
	}
	return g
}

func (g *guest) send(v any) {
	g.t.Helper()
	raw, err := json.Marshal(v)
	if err != nil {
		g.t.Fatal(err)
	}
	if err := g.dc.SendText(string(raw)); err != nil {
		g.t.Fatal(err)
	}
}

// next returns the next whole frame for which want is true.
func (g *guest) next(want func([]byte) bool) []byte {
	g.t.Helper()
	deadline := time.After(20 * time.Second)
	for {
		select {
		case raw := <-g.frames:
			whole, isChunk, err := g.chunks.take(raw)
			if err != nil {
				g.t.Fatalf("the server sent a bad chunk: %v", err)
			}
			if isChunk {
				if whole == nil {
					continue
				}
				raw = whole
			}
			if want(raw) {
				return raw
			}
		case <-deadline:
			g.t.Fatal("timed out waiting for a frame")
		}
	}
}

// get makes one HTTP exchange over the channel.
func (g *guest) get(id, path string, headers map[string]string) httpResponse {
	g.t.Helper()
	g.send(map[string]any{"type": httpRequestType, "id": id, "method": "GET", "path": path, "headers": headers})
	var res httpResponse
	g.next(func(raw []byte) bool {
		return json.Unmarshal(raw, &res) == nil && res.Type == httpResponseType && res.ID == id
	})
	return res
}

func body(t *testing.T, res httpResponse) string {
	t.Helper()
	b, err := base64.StdEncoding.DecodeString(res.Body)
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

// testServer is what a link reaches: it reports the headers it was sent, serves
// a body larger than a chunk, and echoes WebSocket messages.
func testServer(t *testing.T) target {
	t.Helper()
	big := strings.Repeat("é", chunkSize)
	up := websocket.Upgrader{}
	mux := http.NewServeMux()
	mux.HandleFunc("/headers", func(w http.ResponseWriter, r *http.Request) {
		_ = json.NewEncoder(w).Encode(map[string]string{
			"host": r.Host, "origin": r.Header.Get("Origin"), "x-test": r.Header.Get("X-Test"),
			"acceptEncoding": r.Header.Get("Accept-Encoding"),
		})
	})
	mux.HandleFunc("/big", func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(big)) })
	mux.HandleFunc("/ws", func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Origin") != "http://"+r.Host {
			http.Error(w, "cross-origin", http.StatusForbidden)
			return
		}
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = c.Close() }()
		for {
			_, m, err := c.ReadMessage()
			if err != nil {
				return
			}
			if err := c.WriteMessage(websocket.TextMessage, append([]byte("echo:"), m...)); err != nil {
				return
			}
		}
	})
	// Every message comes back as it was sent: the same bytes, the same type.
	mux.HandleFunc("/ws-mirror", func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = c.Close() }()
		for {
			kind, m, err := c.ReadMessage()
			if err != nil {
				return
			}
			if err := c.WriteMessage(kind, m); err != nil {
				return
			}
		}
	})
	// Each text message names a size; the answer is a binary message that
	// size, of bytes that are not UTF-8 (binaryPattern).
	mux.HandleFunc("/ws-binary", func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = c.Close() }()
		for {
			_, m, err := c.ReadMessage()
			if err != nil {
				return
			}
			n, err := strconv.Atoi(string(m))
			if err != nil {
				return
			}
			if err := c.WriteMessage(websocket.BinaryMessage, binaryPattern(n)); err != nil {
				return
			}
		}
	})
	srv := httptest.NewServer(mux)
	t.Cleanup(srv.Close)
	addr := srv.Listener.Addr().String()
	return target{
		host: "machine.test",
		dial: func(ctx context.Context) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "tcp", addr)
		},
	}
}

// TestLinkCarriesHTTP: a request frame becomes a request to the link's server
// naming the link's Host, with the browser's own Host, Origin and
// Accept-Encoding left behind, and its answer comes back whole, however large.
func TestLinkCarriesHTTP(t *testing.T) {
	p := New(filepath.Join(t.TempDir(), identityFileName))
	g := dialGuest(t, p, t.Context(), testServer(t))

	res := g.get("r1", "/headers", map[string]string{"X-Test": "yes", "Origin": "https://juggler.studio", "Host": "juggler.studio", "Accept-Encoding": "gzip"})
	if res.Status != http.StatusOK {
		t.Fatalf("status %d: %s", res.Status, body(t, res))
	}
	var seen map[string]string
	if err := json.Unmarshal([]byte(body(t, res)), &seen); err != nil {
		t.Fatal(err)
	}
	if seen["host"] != "machine.test" || seen["origin"] != "" || seen["x-test"] != "yes" || seen["acceptEncoding"] != "" {
		t.Fatalf("the server saw %v; want host machine.test, no origin or accept-encoding, x-test yes", seen)
	}

	if got := body(t, g.get("r2", "/big", nil)); got != strings.Repeat("é", chunkSize) {
		t.Fatalf("a chunked answer came back %d bytes, want %d", len(got), 2*chunkSize)
	}
	if res := g.get("r3", "relative", nil); res.Status != http.StatusBadRequest {
		t.Fatalf("a path without a leading slash got %d, want 400", res.Status)
	}
}

// TestLinkCarriesOneWebSocket: an open frame opens the link's WebSocket, with
// the link's own origin; messages flow both ways, large ones chunked, and
// those sent before it opened are delivered in order.
func TestLinkCarriesOneWebSocket(t *testing.T) {
	p := New(filepath.Join(t.TempDir(), identityFileName))
	g := dialGuest(t, p, t.Context(), testServer(t))

	g.send(map[string]any{"type": wsOpenType, "path": "/ws"})
	g.send(map[string]any{"type": "hello"})
	big := strings.Repeat("ü", chunkSize)
	g.send(map[string]any{"type": "big", "text": big})

	echo := func(raw []byte) bool { return strings.HasPrefix(string(raw), "echo:") }
	if got := string(g.next(echo)); got != `echo:{"type":"hello"}` {
		t.Fatalf("first message back %q", got)
	}
	var back struct{ Text string }
	if err := json.Unmarshal(g.next(echo)[len("echo:"):], &back); err != nil || back.Text != big {
		t.Fatalf("the large message came back damaged (%v, %d bytes)", err, len(back.Text))
	}
}

// binaryPattern is n bytes that are not valid UTF-8 anywhere a split could
// fall, so a binary message read as text cannot come through intact.
func binaryPattern(n int) []byte {
	b := make([]byte, n)
	for i := range b {
		b[i] = byte(0x80 + i%0x7f)
	}
	return b
}

// The binary pieces' wire format, written out here rather than taken from the
// package, so the tests hold the bridge to it:
//
//	"JDB1" | id uint32 BE | index uint32 BE | total uint32 BE | data
const testPieceHeader = 16

// nextBinary returns the next binary message the server sent, joined from its
// pieces.
func (g *guest) nextBinary() []byte {
	g.t.Helper()
	deadline := time.After(20 * time.Second)
	parts := map[uint32]map[uint32][]byte{}
	for {
		select {
		case p := <-g.pieces:
			if len(p) < testPieceHeader || string(p[:4]) != "JDB1" {
				g.t.Fatalf("a binary message on the channel is not a piece: % x", p[:min(len(p), testPieceHeader)])
			}
			if len(p) > chunkSize {
				g.t.Fatalf("a piece of %d bytes, over the channel's %d", len(p), chunkSize)
			}
			id, index, total := binary.BigEndian.Uint32(p[4:]), binary.BigEndian.Uint32(p[8:]), binary.BigEndian.Uint32(p[12:])
			if parts[id] == nil {
				parts[id] = map[uint32][]byte{}
			}
			parts[id][index] = p[testPieceHeader:]
			if uint32(len(parts[id])) == total {
				var whole []byte
				for i := uint32(0); i < total; i++ {
					whole = append(whole, parts[id][i]...)
				}
				return whole
			}
		case raw := <-g.frames:
			if len(raw) > 200 {
				raw = raw[:200]
			}
			g.t.Fatalf("waiting for a binary message, the server sent text: %q", raw)
		case <-deadline:
			g.t.Fatal("timed out waiting for a binary message")
		}
	}
}

// sendBinary sends payload as one binary WebSocket message, in pieces under
// id, as the bootstrap's sendFrame does.
func (g *guest) sendBinary(id uint32, payload []byte) {
	g.t.Helper()
	per := chunkSize - testPieceHeader
	total := max(1, (len(payload)+per-1)/per)
	for i := 0; i < total; i++ {
		data := payload[i*per : min((i+1)*per, len(payload))]
		p := make([]byte, testPieceHeader, testPieceHeader+len(data))
		copy(p, "JDB1")
		binary.BigEndian.PutUint32(p[4:], id)
		binary.BigEndian.PutUint32(p[8:], uint32(i))
		binary.BigEndian.PutUint32(p[12:], uint32(total))
		if err := g.dc.Send(append(p, data...)); err != nil {
			g.t.Fatal(err)
		}
	}
}

// TestLinkCarriesBinaryWebSocketMessagesToTheGuest: a binary message from the
// server reaches the guest as binary, byte for byte, in pieces that fit the
// channel — up to the size of a session's own chunk frame (8 MiB of a
// message too large to send whole, plus its header, in server/ws_chunk.go).
func TestLinkCarriesBinaryWebSocketMessagesToTheGuest(t *testing.T) {
	p := New(filepath.Join(t.TempDir(), identityFileName))
	g := dialGuest(t, p, t.Context(), testServer(t))
	g.send(map[string]any{"type": wsOpenType, "path": "/ws-binary"})
	for _, n := range []int{0, 100, chunkSize - testPieceHeader, 3*chunkSize + 5, 8<<20 + 21} {
		if err := g.dc.SendText(strconv.Itoa(n)); err != nil {
			t.Fatal(err)
		}
		if got := g.nextBinary(); !bytes.Equal(got, binaryPattern(n)) {
			t.Fatalf("a %d-byte binary message arrived as %d bytes, not the ones sent", n, len(got))
		}
	}
}

// TestLinkCarriesBinaryWebSocketMessagesFromTheGuest: a binary message from
// the guest, whole or in pieces, reaches the server as one binary message, and
// text stays text.
func TestLinkCarriesBinaryWebSocketMessagesFromTheGuest(t *testing.T) {
	p := New(filepath.Join(t.TempDir(), identityFileName))
	g := dialGuest(t, p, t.Context(), testServer(t))
	g.send(map[string]any{"type": wsOpenType, "path": "/ws-mirror"})
	for i, n := range []int{0, 10, 5*chunkSize + 1} {
		g.sendBinary(uint32(i+1), binaryPattern(n))
		if got := g.nextBinary(); !bytes.Equal(got, binaryPattern(n)) {
			t.Fatalf("a %d-byte binary message came back as %d bytes, not the ones sent", n, len(got))
		}
	}
	g.send(map[string]any{"type": "hello"})
	if got := string(g.next(func([]byte) bool { return true })); got != `{"type":"hello"}` {
		t.Fatalf("a text message came back %q", got)
	}
}

// TestLinkEndsOnABadPiece: a binary message on the channel that is no piece,
// or a piece no sender makes, ends the link.
func TestLinkEndsOnABadPiece(t *testing.T) {
	p := New(filepath.Join(t.TempDir(), identityFileName))
	to := testServer(t)
	piece := func(id, index, total uint32) []byte {
		b := make([]byte, testPieceHeader+1)
		copy(b, "JDB1")
		binary.BigEndian.PutUint32(b[4:], id)
		binary.BigEndian.PutUint32(b[8:], index)
		binary.BigEndian.PutUint32(b[12:], total)
		return b
	}
	for name, frames := range map[string][][]byte{
		"not a piece":      {[]byte("hello")},
		"a short header":   {[]byte("JDB1\x00\x00")},
		"a huge total":     {piece(1, 0, 1<<31)},
		"index past total": {piece(1, 3, 3)},
		"a piece repeated": {piece(1, 0, 3), piece(1, 0, 3)},
		"a changing total": {piece(1, 0, 3), piece(1, 1, 4)},
	} {
		t.Run(name, func(t *testing.T) {
			g := dialGuest(t, p, t.Context(), to)
			for _, f := range frames {
				if err := g.dc.Send(f); err != nil {
					t.Fatal(err)
				}
			}
			g.waitClosed("a bad piece left the link open")
		})
	}
}

// TestLinkEndsWithItsLife: when the tunnel it belongs to stops, the link
// closes — a remote caller is not kept in after the owner turns it off.
func TestLinkEndsWithItsLife(t *testing.T) {
	p := New(filepath.Join(t.TempDir(), identityFileName))
	life, end := context.WithCancel(t.Context())
	g := dialGuest(t, p, life, testServer(t))
	end()
	select {
	case <-g.closed:
	case <-time.After(20 * time.Second):
		t.Fatal("the data channel outlived its tunnel")
	}
}

// linkHolds counts the goroutines Accept started that are still running: each
// one holds a peer connection for as long as its link is meant to live.
func linkHolds() int {
	buf := make([]byte, 1<<20)
	for {
		n := runtime.Stack(buf, true)
		if n < len(buf) {
			return strings.Count(string(buf[:n]), "created by juggler/cmd/juggler/tunnel/peer.(*Peer).Accept")
		}
		buf = make([]byte, 2*len(buf))
	}
}

// awaitNoLinkHolds fails the test unless every hold Accept started is let go.
func awaitNoLinkHolds(t *testing.T, why string) {
	t.Helper()
	deadline := time.Now().Add(20 * time.Second)
	for linkHolds() > 0 {
		if time.Now().After(deadline) {
			t.Fatalf("%s: %d link(s) still held", why, linkHolds())
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// TestALinkLetsGoWhenItEnds: what a link holds is let go when that link ends —
// an offer that fails before it is answered, a guest that goes — not only when
// the tunnel it belongs to stops, which may be never.
func TestALinkLetsGoWhenItEnds(t *testing.T) {
	p := New(filepath.Join(t.TempDir(), identityFileName))
	awaitNoLinkHolds(t, "before the test")

	if _, err := p.Accept(t.Context(), t.Context(), tunnel.SessionDescription{Type: "offer", SDP: "v=0 not an offer"}, nil, nil, ""); err == nil {
		t.Fatal("a malformed offer was answered")
	}
	awaitNoLinkHolds(t, "an offer refused before it was answered")

	g := dialGuest(t, p, t.Context(), testServer(t))
	if res := g.get("r1", "/headers", nil); res.Status != http.StatusOK {
		t.Fatalf("the link answered %d", res.Status)
	}
	_ = g.pc.Close()
	awaitNoLinkHolds(t, "a guest that went")
}

// TestLinkEndsWhenItsWebSocketFallsBehind: a guest's messages are never lost
// on the way to the server. When the server takes them more slowly than the
// guest sends, so that the link's queue for them fills, the link ends — the
// page connects afresh and resyncs — rather than drop one and carry on.
func TestLinkEndsWhenItsWebSocketFallsBehind(t *testing.T) {
	p := New(filepath.Join(t.TempDir(), identityFileName))
	stall := make(chan struct{})
	up := websocket.Upgrader{}
	to := pipeTarget(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := up.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer func() { _ = c.Close() }()
		<-stall // reads nothing, so the link's first write is never taken
	}))
	t.Cleanup(func() { close(stall) }) // before the server closes, which waits on its handlers
	g := dialGuest(t, p, t.Context(), to)
	g.send(map[string]any{"type": wsOpenType, "path": "/ws"})
	for i := 0; i < queueDepth+16; i++ {
		select {
		case <-g.closed:
			return
		default:
		}
		if err := g.dc.SendText(fmt.Sprintf(`{"type":"sync","n":%d}`, i)); err != nil {
			break // the link went while we were sending
		}
	}
	g.waitClosed("a WebSocket that fell behind left the link open, its messages dropped")
}

// pipeTarget is a link target serving h over in-memory connections, which
// hold no bytes in flight: a write waits until the server reads it.
func pipeTarget(t *testing.T, h http.Handler) target {
	t.Helper()
	ln := &pipeListener{conns: make(chan net.Conn), done: make(chan struct{})}
	srv := &http.Server{Handler: h, ReadHeaderTimeout: 10 * time.Second}
	go func() { _ = srv.Serve(ln) }()
	t.Cleanup(func() { _ = srv.Close() })
	return target{
		host: "machine.test",
		dial: func(ctx context.Context) (net.Conn, error) {
			client, server := net.Pipe()
			select {
			case ln.conns <- server:
				return client, nil
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-ln.done:
				return nil, net.ErrClosed
			}
		},
	}
}

// pipeListener accepts the connections pipeTarget's dial makes.
type pipeListener struct {
	conns chan net.Conn
	done  chan struct{}
	once  sync.Once
}

func (l *pipeListener) Accept() (net.Conn, error) {
	select {
	case c := <-l.conns:
		return c, nil
	case <-l.done:
		return nil, net.ErrClosed
	}
}

func (l *pipeListener) Close() error   { l.once.Do(func() { close(l.done) }); return nil }
func (l *pipeListener) Addr() net.Addr { return &net.UnixAddr{Name: "pipe", Net: "pipe"} }

// TestLinkEndsWhenItsWebSocketIsRefused: a WebSocket the server refuses ends
// the link, which is how the page learns to start afresh.
func TestLinkEndsWhenItsWebSocketIsRefused(t *testing.T) {
	p := New(filepath.Join(t.TempDir(), identityFileName))
	g := dialGuest(t, p, t.Context(), testServer(t))
	g.send(map[string]any{"type": wsOpenType, "path": "/no-such-socket"})
	select {
	case <-g.closed:
	case <-time.After(20 * time.Second):
		t.Fatal("a refused WebSocket left the link open")
	}
}

// waitClosed fails the test unless the guest's channel closes.
func (g *guest) waitClosed(why string) {
	g.t.Helper()
	select {
	case <-g.closed:
	case <-time.After(20 * time.Second):
		g.t.Fatal(why)
	}
}

// sendChunked sends payload as a guest's bootstrap does: whole when it fits a
// chunk, else as chunk frames under one id.
func (g *guest) sendChunked(id string, payload []byte) {
	g.t.Helper()
	if len(payload) <= chunkSize {
		if err := g.dc.SendText(string(payload)); err != nil {
			g.t.Fatal(err)
		}
		return
	}
	bounds := chunkBounds(payload)
	for i, span := range bounds {
		g.send(chunk{Type: chunkType, ID: id, Index: i, Total: len(bounds), Data: string(payload[span[0]:span[1]])})
	}
}

// TestLinkEndsOnAChunkClaimingAHugeTotal: a chunk whose total no frame could
// need ends the guest's link — and only that link: the process lives on and
// takes the next one.
func TestLinkEndsOnAChunkClaimingAHugeTotal(t *testing.T) {
	p := New(filepath.Join(t.TempDir(), identityFileName))
	to := testServer(t)
	g := dialGuest(t, p, t.Context(), to)
	g.send(map[string]any{"type": chunkType, "id": "x", "index": 0, "total": int64(1e15), "data": "a"})
	g.waitClosed("a chunk claiming a total of 1e15 left the link open")

	again := dialGuest(t, p, t.Context(), to)
	if res := again.get("r1", "/headers", nil); res.Status != http.StatusOK {
		t.Fatalf("a fresh link after the bad one got %d", res.Status)
	}
}

// TestLinkEndsWhenUnfinishedFramesPileUp: a guest that starts frame after
// frame and finishes none loses its link, rather than holding the server's
// memory one unfinished frame at a time.
func TestLinkEndsWhenUnfinishedFramesPileUp(t *testing.T) {
	p := New(filepath.Join(t.TempDir(), identityFileName))
	g := dialGuest(t, p, t.Context(), testServer(t))
	for i := 0; i < 200; i++ {
		select {
		case <-g.closed:
			return
		default:
		}
		if err := g.dc.SendText(fmt.Sprintf(`{"type":%q,"id":"f%d","index":0,"total":2,"data":"a"}`, chunkType, i)); err != nil {
			break // the link went while we were sending
		}
	}
	g.waitClosed("200 unfinished frames under fresh ids left the link open")
}

// TestLinkEndsOnAMalformedChunk: a chunk no sender would make — an index past
// its total, a total that changes within a frame, a piece sent twice — ends
// the link.
func TestLinkEndsOnAMalformedChunk(t *testing.T) {
	p := New(filepath.Join(t.TempDir(), identityFileName))
	to := testServer(t)
	for name, frames := range map[string][]chunk{
		"index past total": {{Type: chunkType, ID: "a", Index: 2, Total: 2, Data: "x"}},
		"total changes":    {{Type: chunkType, ID: "a", Index: 0, Total: 3, Data: "x"}, {Type: chunkType, ID: "a", Index: 1, Total: 4, Data: "x"}},
		"piece repeated":   {{Type: chunkType, ID: "a", Index: 0, Total: 3, Data: "x"}, {Type: chunkType, ID: "a", Index: 0, Total: 3, Data: "x"}},
	} {
		t.Run(name, func(t *testing.T) {
			g := dialGuest(t, p, t.Context(), to)
			for _, f := range frames {
				g.send(f)
			}
			g.waitClosed("a malformed chunk left the link open")
		})
	}
}

// TestLinkSurvivesAPanicInItsWebSocket: a panic in the link's own goroutines
// ends that link, never the process.
func TestLinkSurvivesAPanicInItsWebSocket(t *testing.T) {
	p := New(filepath.Join(t.TempDir(), identityFileName))
	to := target{host: "machine.test", dial: func(context.Context) (net.Conn, error) { panic("dial exploded") }}
	g := dialGuest(t, p, t.Context(), to)
	g.send(map[string]any{"type": wsOpenType, "path": "/ws"})
	g.waitClosed("a panicking WebSocket dial left the link open")
}

// TestLinkCarriesAnUploadAtTheBodyLimit: a request body as large as a session
// accepts reaches the server whole, its frame chunked; any more is answered
// 413 without being forwarded.
func TestLinkCarriesAnUploadAtTheBodyLimit(t *testing.T) {
	p := New(filepath.Join(t.TempDir(), identityFileName))
	var forwarded atomic.Int64
	to := handlerTarget(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n, _ := io.Copy(io.Discard, r.Body)
		forwarded.Add(1)
		_, _ = fmt.Fprint(w, n)
	}))
	g := dialGuest(t, p, t.Context(), to)
	post := func(id string, size int) httpResponse {
		raw, err := json.Marshal(httpRequest{ID: id, Method: "POST", Path: "/upload", Body: base64.StdEncoding.EncodeToString(make([]byte, size))})
		if err != nil {
			t.Fatal(err)
		}
		g.sendChunked("up-"+id, append([]byte(`{"type":"`+httpRequestType+`",`), raw[1:]...))
		var res httpResponse
		g.next(func(raw []byte) bool {
			return json.Unmarshal(raw, &res) == nil && res.Type == httpResponseType && res.ID == id
		})
		return res
	}
	if res := post("u1", maxRequestBodyBytes); res.Status != http.StatusOK || body(t, res) != fmt.Sprint(maxRequestBodyBytes) {
		t.Fatalf("an upload at the limit got %d %q", res.Status, body(t, res))
	}
	// One byte over encodes no longer than the limit; a whole 3-byte group
	// over encodes longer, and is refused undecoded.
	for _, over := range []int{1, 3} {
		if res := post(fmt.Sprintf("u-over%d", over), maxRequestBodyBytes+over); res.Status != http.StatusRequestEntityTooLarge {
			t.Fatalf("an upload %d byte(s) over the limit got %d, want 413", over, res.Status)
		}
	}
	if forwarded.Load() != 1 {
		t.Fatalf("the server saw %d uploads, want only the one within the limit", forwarded.Load())
	}
}

// TestLinkAnswersAnOversizeResponseWith502: an answer larger than a link
// carries comes back as the bootstrap's ordinary response frame, a 502 saying
// so, and the link lives on.
func TestLinkAnswersAnOversizeResponseWith502(t *testing.T) {
	p := New(filepath.Join(t.TempDir(), identityFileName))
	to := handlerTarget(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = w.Write(make([]byte, maxResponseBodyBytes+1))
	}))
	g := dialGuest(t, p, t.Context(), to)
	if res := g.get("r1", "/huge", nil); res.Status != http.StatusBadGateway {
		t.Fatalf("an oversize answer came back %d, want 502", res.Status)
	}
	select {
	case <-g.closed:
		t.Fatal("an oversize answer ended the link")
	default:
	}
}

// TestLinkBoundsItsRequestsInFlight: no more than maxConcurrentRequests of a
// link's requests are at the server at once, and the rest are served, not
// refused, as those finish.
func TestLinkBoundsItsRequestsInFlight(t *testing.T) {
	p := New(filepath.Join(t.TempDir(), identityFileName))
	var inFlight, peak atomic.Int64
	release := make(chan struct{})
	var released sync.Once
	free := func() { released.Do(func() { close(release) }) }
	arrived := make(chan struct{}, 64)
	to := handlerTarget(t, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := inFlight.Add(1)
		for {
			old := peak.Load()
			if n <= old || peak.CompareAndSwap(old, n) {
				break
			}
		}
		arrived <- struct{}{}
		<-release
		inFlight.Add(-1)
	}))
	t.Cleanup(free) // before the server closes, which waits on its handlers
	g := dialGuest(t, p, t.Context(), to)
	const sent = 3 * maxConcurrentRequests
	for i := 0; i < sent; i++ {
		g.send(map[string]any{"type": httpRequestType, "id": fmt.Sprintf("r%d", i), "method": "GET", "path": "/hold"})
	}
	for i := 0; i < maxConcurrentRequests; i++ {
		select {
		case <-arrived:
		case <-time.After(20 * time.Second):
			t.Fatalf("only %d requests reached the server", i)
		}
	}
	// The server has as many as it may; a ninth arriving now would be one too
	// many. A link that admits it does so on the frame it already holds, so a
	// stretch of quiet is a fair test of it.
	select {
	case <-arrived:
		t.Fatalf("%d requests were at the server at once", inFlight.Load())
	case <-time.After(500 * time.Millisecond):
	}
	free()
	seen := map[string]bool{}
	for len(seen) < sent {
		var res httpResponse
		g.next(func(raw []byte) bool {
			return json.Unmarshal(raw, &res) == nil && res.Type == httpResponseType
		})
		if res.Status != http.StatusOK {
			t.Fatalf("request %s got %d", res.ID, res.Status)
		}
		seen[res.ID] = true
	}
	if peak.Load() > maxConcurrentRequests {
		t.Fatalf("%d requests were at the server at once, want at most %d", peak.Load(), maxConcurrentRequests)
	}
}

// handlerTarget is a link target serving h.
func handlerTarget(t *testing.T, h http.Handler) target {
	t.Helper()
	srv := httptest.NewServer(h)
	t.Cleanup(srv.Close)
	addr := srv.Listener.Addr().String()
	return target{
		host: "machine.test",
		dial: func(ctx context.Context) (net.Conn, error) {
			var d net.Dialer
			return d.DialContext(ctx, "tcp", addr)
		},
	}
}

// TestAcceptRefusesANonOffer: only an offer is answered.
func TestAcceptRefusesANonOffer(t *testing.T) {
	p := New(filepath.Join(t.TempDir(), identityFileName))
	if _, err := p.Accept(t.Context(), t.Context(), tunnel.SessionDescription{Type: "answer", SDP: "v=0"}, nil, nil, ""); err == nil {
		t.Fatal("an answer was accepted as an offer")
	}
}
