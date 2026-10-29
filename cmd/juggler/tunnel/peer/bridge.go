//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package peer

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net"
	"net/http"
	"runtime/debug"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/gorilla/websocket"
	"github.com/pion/webrtc/v4"

	"juggler/internal/jlog"
)

// The data channel's text frames, every one a JSON text message with a "type":
//
//   - chunkType: one piece of a frame larger than chunkSize; the pieces of one
//     frame share an id and are joined in index order.
//   - httpRequestType / httpResponseType: one HTTP exchange, matched by id,
//     bodies in base64.
//   - wsOpenType: opens the link's one WebSocket at path. Every other frame is
//     a text message on it, both ways.
//
// Its binary messages are pieces of the WebSocket's binary messages, both ways
// (pieces, in chunk.go).
const (
	chunkType        = "__juggler_dc_chunk"
	httpRequestType  = "__juggler_http_req"
	httpResponseType = "__juggler_http_res"
	wsOpenType       = "__juggler_ws_open"
)

// chunkSize is the largest frame sent whole; SCTP messages much above it are
// not reliably delivered by every browser.
const chunkSize = 16 * 1024

// maxRequestBodyBytes is the largest request body a link forwards: a
// session's own cap on every request body (defaultMaxBodyBytes in
// cmd/juggler/server/body_limit.go), so nothing a session would accept is
// refused here, and nothing it would refuse is held here first.
const maxRequestBodyBytes = 32 << 20

// maxResponseBodyBytes is the largest answer a link carries back. A frame
// holds a response whole, so it is read into memory; the bound is the largest
// body the app serves on purpose, a file's content (MaxFileContentBytes in
// cmd/juggler/server/handlers/files.go).
const maxResponseBodyBytes = 100 << 20

// maxConcurrentRequests bounds a link's requests at the server at once, and
// so the responses it holds whole (up to maxResponseBodyBytes each). A request
// past it waits, and the channel's read loop with it, so the guest's own
// sender is held back by the channel's flow control rather than anything
// being refused or queued without bound. A browser holds a page to six
// connections per host over plain HTTP, which the app already lives within on
// every other transport, so a legitimate page never waits on a held request of
// its own here.
const maxConcurrentRequests = 8

// queueDepth bounds the frames waiting for the channel, and for the WebSocket.
const queueDepth = 256

// bridge carries one data channel's traffic to its target.
type bridge struct {
	ctx    context.Context
	cancel context.CancelFunc
	pc     *webrtc.PeerConnection
	dc     *webrtc.DataChannel
	to     target
	client *http.Client
	// out holds frames for the channel; the writer goroutine is its one reader,
	// so sends never interleave inside a frame.
	out chan message
	// toWS holds messages for the WebSocket, queued until it opens.
	toWS chan message
	// requests holds a slot per request at the server (maxConcurrentRequests).
	requests  chan struct{}
	wsOpened  atomic.Bool
	seq       atomic.Uint64
	closeOnce sync.Once
}

// message is one message on the channel or the WebSocket, and its type.
type message struct {
	data   []byte
	binary bool
}

// newBridge carries dc's traffic for the link whose life is ctx; cancel ends
// that link.
func newBridge(ctx context.Context, cancel context.CancelFunc, pc *webrtc.PeerConnection, dc *webrtc.DataChannel, to target, onOpen func() bool) {
	b := &bridge{
		ctx:      ctx,
		cancel:   cancel,
		pc:       pc,
		dc:       dc,
		to:       to,
		out:      make(chan message, queueDepth),
		toWS:     make(chan message, queueDepth),
		requests: make(chan struct{}, maxConcurrentRequests),
	}
	b.client = &http.Client{
		Transport: &http.Transport{
			DialContext:        func(ctx context.Context, _, _ string) (net.Conn, error) { return to.dial(ctx) },
			DisableCompression: true,
			IdleConnTimeout:    30 * time.Second,
		},
		// A redirect is the page's to follow, as it would be on any transport.
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
	chunks := newReassembler() // the channel's read loop is its only user
	dc.OnOpen(func() {
		onOpen()
		go b.writeLoop()
	})
	dc.OnMessage(func(m webrtc.DataChannelMessage) {
		// pion calls this on its own goroutine, where a panic would end the
		// process and every session on it.
		defer b.survive("a frame")
		if b.ctx.Err() != nil {
			return
		}
		if m.IsString {
			b.dispatch(chunks, append([]byte(nil), m.Data...))
			return
		}
		whole, err := chunks.takeBinary(m.Data)
		if err != nil {
			b.end(err)
		} else if whole != nil {
			b.queueForWS(message{data: whole, binary: true})
		}
	})
	dc.OnClose(b.close)
	go func() {
		<-ctx.Done()
		b.close()
	}()
}

// close ends the link: the peer connection, the WebSocket (through ctx) and
// any idle connection to the server.
func (b *bridge) close() {
	b.closeOnce.Do(func() {
		b.cancel()
		_ = b.pc.Close()
		b.client.CloseIdleConnections()
	})
}

// end ends the link for a guest that broke the protocol. It only cancels: the
// close that follows runs off the channel's read loop, which may be the
// caller.
func (b *bridge) end(why error) {
	if b.ctx.Err() == nil {
		jlog.Info("WebRTC: ending a link: %v", why)
	}
	b.cancel()
}

// survive, deferred at the top of every goroutine the link runs code on, turns
// a panic into the end of that link alone.
func (b *bridge) survive(where string) {
	if r := recover(); r != nil {
		jlog.Error("WebRTC: panic in %s, ending the link: %v\n%s", where, r, debug.Stack())
		b.cancel()
	}
}

// writeLoop is the channel's one writer.
func (b *bridge) writeLoop() {
	defer b.survive("the channel's writer")
	for {
		select {
		case f := <-b.out:
			var err error
			if f.binary {
				err = b.dc.Send(f.data)
			} else {
				err = b.dc.SendText(string(f.data))
			}
			if err != nil {
				jlog.Info("WebRTC: send failed: %v", err)
				b.close()
				return
			}
		case <-b.ctx.Done():
			return
		}
	}
}

// enqueue queues one frame for the channel, unless the link has ended.
func (b *bridge) enqueue(f message) bool {
	select {
	case b.out <- f:
		return true
	case <-b.ctx.Done():
		return false
	}
}

// send queues a text payload, in chunks when it is larger than chunkSize.
func (b *bridge) send(payload []byte) {
	if len(payload) <= chunkSize {
		b.enqueue(message{data: payload})
		return
	}
	bounds := chunkBounds(payload)
	id := fmt.Sprintf("s%d", b.seq.Add(1))
	for i, span := range bounds {
		f, err := json.Marshal(chunk{Type: chunkType, ID: id, Index: i, Total: len(bounds), Data: string(payload[span[0]:span[1]])})
		if err != nil || !b.enqueue(message{data: f}) {
			return
		}
	}
}

// sendBinary queues a binary WebSocket message as its pieces.
func (b *bridge) sendBinary(payload []byte) {
	for _, p := range pieces(uint32(b.seq.Add(1)), payload) {
		if !b.enqueue(message{data: p, binary: true}) {
			return
		}
	}
}

// queueForWS queues a message for the WebSocket, or ends the link when the
// queue is full. A message dropped would desynchronise the page from its
// session, and waiting for room would hold the channel's one read loop, and
// every request on the link with it, behind a WebSocket that is not being
// read; an ended link is one the page connects afresh and resyncs.
func (b *bridge) queueForWS(m message) {
	select {
	case b.toWS <- m:
	default:
		b.end(fmt.Errorf("the WebSocket fell %d messages behind", queueDepth))
	}
}

// dispatch routes one frame from the channel. A chunk that breaks the
// protocol ends the link: no sender within it makes one, and a guest that
// does is not owed the memory to find out what it meant.
func (b *bridge) dispatch(chunks *reassembler, data []byte) {
	whole, isChunk, err := chunks.take(data)
	if err != nil {
		b.end(err)
		return
	}
	if isChunk {
		if whole == nil {
			return
		}
		data = whole
	}
	var head struct {
		Type string `json:"type"`
		Path string `json:"path"`
	}
	_ = json.Unmarshal(data, &head)
	switch head.Type {
	case httpRequestType:
		// Off the read loop, so a slow request holds up neither the others
		// nor the WebSocket; each answer carries its own id. A request past
		// maxConcurrentRequests holds the read loop until one finishes.
		select {
		case b.requests <- struct{}{}:
		case <-b.ctx.Done():
			return
		}
		go func() {
			defer func() { <-b.requests }()
			b.serveHTTP(data)
		}()
	case wsOpenType:
		if !b.wsOpened.CompareAndSwap(false, true) {
			jlog.Info("WebRTC: ignoring a second WebSocket on one link")
			return
		}
		go b.runWebSocket(head.Path)
	default:
		b.queueForWS(message{data: data})
	}
}

// runWebSocket opens the link's WebSocket at path and pipes it to the channel
// both ways until either end goes, which ends the link: the page recovers by
// connecting afresh.
func (b *bridge) runWebSocket(path string) {
	defer b.close()
	defer b.survive("the WebSocket")
	if !strings.HasPrefix(path, "/") {
		jlog.Info("WebRTC: refusing WebSocket path %q", path)
		return
	}
	dialer := websocket.Dialer{
		NetDialContext:   func(ctx context.Context, _, _ string) (net.Conn, error) { return b.to.dial(ctx) },
		HandshakeTimeout: 30 * time.Second,
	}
	header := http.Header{"Origin": {"http://" + b.to.host}}
	conn, resp, err := dialer.DialContext(b.ctx, "ws://"+b.to.host+path, header)
	if resp != nil && resp.Body != nil {
		_ = resp.Body.Close()
	}
	if err != nil {
		jlog.Info("WebRTC: WebSocket %s: %v", path, err)
		return
	}
	go func() {
		defer b.close()
		defer b.survive("the WebSocket's reader")
		for {
			kind, m, err := conn.ReadMessage()
			if err != nil {
				return
			}
			if kind == websocket.BinaryMessage {
				b.sendBinary(m)
			} else {
				b.send(m)
			}
		}
	}()
	defer func() { _ = conn.Close() }()
	for {
		select {
		case m := <-b.toWS:
			kind := websocket.TextMessage
			if m.binary {
				kind = websocket.BinaryMessage
			}
			if err := conn.WriteMessage(kind, m.data); err != nil {
				return
			}
		case <-b.ctx.Done():
			return
		}
	}
}

type httpRequest struct {
	ID      string            `json:"id"`
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers"`
	Body    string            `json:"body"`
}

type httpResponse struct {
	Type         string              `json:"type"`
	ID           string              `json:"id"`
	Status       int                 `json:"status"`
	Headers      map[string][]string `json:"headers"`
	Body         string              `json:"body"`
	BodyEncoding string              `json:"bodyEncoding"`
}

// unforwarded are the request headers a link never passes on: the ones that
// describe its own hop (the request is made afresh), Host and Origin, which
// name the link itself, and Accept-Encoding, since the bootstrap hands the
// body to the page as it arrives and never decodes one.
var unforwarded = map[string]bool{
	"Host": true, "Origin": true, "Connection": true, "Upgrade": true, "Keep-Alive": true,
	"Te": true, "Trailer": true, "Transfer-Encoding": true, "Content-Length": true,
	"Proxy-Connection": true, "Accept-Encoding": true,
}

// serveHTTP makes one request frame's request and answers it on the channel.
func (b *bridge) serveHTTP(frame []byte) {
	defer b.survive("a request")
	var req httpRequest
	if err := json.Unmarshal(frame, &req); err != nil {
		jlog.Error("WebRTC: bad request frame: %v", err)
		return
	}
	status, header, body := b.do(req)
	payload, err := json.Marshal(httpResponse{
		Type:         httpResponseType,
		ID:           req.ID,
		Status:       status,
		Headers:      header,
		Body:         base64.StdEncoding.EncodeToString(body),
		BodyEncoding: "base64",
	})
	if err != nil {
		jlog.Error("WebRTC: marshal response for %s: %v", req.Path, err)
		return
	}
	b.send(payload)
}

// do makes req over the link and returns what the server answered, or a 400,
// 413 or 502 of its own when there is nothing to send, too much to send, or
// no answer the link can carry. Each is an ordinary response frame, which the
// bootstrap hands the page as the request's answer.
func (b *bridge) do(req httpRequest) (int, map[string][]string, []byte) {
	plain := func(status int, text string) (int, map[string][]string, []byte) {
		return status, map[string][]string{"Content-Type": {"text/plain; charset=utf-8"}}, []byte(text)
	}
	if !strings.HasPrefix(req.Path, "/") {
		return plain(http.StatusBadRequest, "bad request path")
	}
	var body io.Reader
	if req.Body != "" {
		// Measured before decoding, so a body plainly over costs nothing
		// more; base64 pads to whole 3-byte groups, so up to two bytes over
		// encode no longer and are caught once decoded.
		tooLarge := func() (int, map[string][]string, []byte) {
			return plain(http.StatusRequestEntityTooLarge, "request body too large")
		}
		if len(req.Body) > base64.StdEncoding.EncodedLen(maxRequestBodyBytes) {
			return tooLarge()
		}
		raw, err := base64.StdEncoding.DecodeString(req.Body)
		if err != nil {
			return plain(http.StatusBadRequest, "bad request body")
		}
		if len(raw) > maxRequestBodyBytes {
			return tooLarge()
		}
		body = bytes.NewReader(raw)
	}
	method := req.Method
	if method == "" {
		method = http.MethodGet
	}
	out, err := http.NewRequestWithContext(b.ctx, method, "http://"+b.to.host+req.Path, body)
	if err != nil {
		return plain(http.StatusBadRequest, "bad request")
	}
	for k, v := range req.Headers {
		if k = http.CanonicalHeaderKey(k); !unforwarded[k] {
			out.Header.Set(k, v)
		}
	}
	res, err := b.client.Do(out)
	if err != nil {
		return plain(http.StatusBadGateway, "the server did not answer")
	}
	defer func() { _ = res.Body.Close() }()
	got, err := io.ReadAll(io.LimitReader(res.Body, maxResponseBodyBytes+1))
	if err != nil {
		return plain(http.StatusBadGateway, "the server's answer was cut short")
	}
	if len(got) > maxResponseBodyBytes {
		return plain(http.StatusBadGateway, "the server's answer is too large for this link")
	}
	return res.StatusCode, res.Header, got
}
