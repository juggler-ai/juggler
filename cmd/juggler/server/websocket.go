//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"sync"
	"sync/atomic"
	"time"

	"juggler/internal/jlog"

	"github.com/buger/jsonparser"
	"github.com/gorilla/websocket"
)

const (
	// wsWriteTimeout bounds how long a single message write may block.
	//
	// A peer can accept a connection and then stop draining it — a suspended
	// laptop, dead wifi, a half-open TCP connection nothing has noticed. The
	// write then sits in the kernel socket buffer indefinitely, and the stall
	// propagates: the writer goroutine blocks, its 256-deep send buffer fills,
	// trySend blocks behind it, and any actor that calls Send inline blocks
	// behind that. One dead client stalls every live one, so the write needs a
	// bound even though there is nothing to usefully do when it expires.
	//
	// 60s sits well clear of the slowest legitimate write. The worst of those
	// is a remote viewer pulling a full-state resync, which runs to megabytes
	// on a large conversation — but remote peers negotiate permessage-deflate,
	// so the wire size is a fraction of the logical one, and the deadline
	// covers handing the message to the kernel, not its round trip. That
	// clears a multi-megabyte transfer on a link an order of magnitude worse
	// than a usable one. Shorter is tempting (it is also the bound on how long
	// a wedged client can stall an actor) but below ~30s a slow-but-alive
	// client on a big conversation is at risk, and killing it mid-resync
	// buys nothing: it reconnects and repeats the same transfer.
	wsWriteTimeout = 60 * time.Second

	// wsCloseWriteTimeout bounds the goodbye frame. Two bytes on a connection
	// that is going away regardless, so it gets a short budget — the only
	// thing waiting behind it is teardown.
	wsCloseWriteTimeout = 5 * time.Second

	// wsWriteBufferSize sizes the per-connection buffer gorilla frames
	// outgoing messages in.
	//
	// gorilla splits a compressed message across frames as soon as it outgrows
	// this buffer, and fragmented compressed frames are the shape WebKit has
	// historically mishandled — which matters here because every Juggler
	// viewer is WebKit (WKWebView on macOS, WebKitGTK on Linux) and remote
	// peers are exactly the ones that negotiate permessage-deflate. The
	// library's own guidance is to make the buffer larger than any expected
	// message. Juggler cannot honour that literally, since a full-state resync
	// runs to megabytes, but 32 KiB keeps ordinary traffic — sync deltas,
	// status, tool output chunks — inside a single frame, and costs one
	// syscall per 32 KiB rather than per kilobyte. Do not shrink it below
	// what wsDeflatedChunkSize relies on: a chunk of that size, compressed,
	// fits in one frame.
	wsWriteBufferSize = 32 * 1024

	// wsReadBufferSize sizes the per-connection buffer gorilla reads incoming
	// frames through.
	//
	// It does not bound message size — gorilla streams a frame's payload
	// through this buffer, refilling it with one read syscall at a time — so it
	// is purely the granularity of inbound I/O. Juggler's inbound traffic is
	// dominated by yjs-sync updates, which run to megabytes when a viewer
	// pushes a large edit or completes a resync, and at a kilobyte apiece that
	// is thousands of syscalls per update where 32 KiB is tens. Matched to the
	// write buffer for that reason rather than any symmetry requirement.
	//
	// gorilla allocates both buffers per connection, so the resting cost is
	// (read + write) × connections. Juggler holds a handful — one engine and a
	// few viewers — which is what makes generous buffers the right trade here;
	// a server fielding thousands of mostly idle connections would want the
	// opposite. Deliberately no SetReadLimit to accompany it: no safe bound
	// exists when one yjs-sync update can be tens of megabytes, and every
	// upgrade is authenticated before it reaches this buffer.
	wsReadBufferSize = 32 * 1024
)

// newWSUpgrader builds the upgrader shared by viewer and engine connections.
//
// Deliberately no WriteBufferPool: a pool trades a get/put per message for
// buffers that idle connections do not hold, which pays off for many mostly
// quiet connections. Juggler is the opposite shape — a handful of connections
// (one engine, a few viewers) writing constantly for the length of a turn — so
// pooling would add churn to the hot path to reclaim a few hundred kilobytes.
func newWSUpgrader() websocket.Upgrader {
	return websocket.Upgrader{
		ReadBufferSize:  wsReadBufferSize,
		WriteBufferSize: wsWriteBufferSize,
		CheckOrigin:     sameOriginCheck,
		// permessage-deflate (RFC 7692) is negotiated per-connection in
		// handleWebSocket — enabled only for remote (tunnel / LAN) peers, where
		// the link is the bottleneck, and left off for loopback (engine + local
		// viewer), where deflate is pure CPU cost. See handleWebSocket.
	}
}

// wsMessage represents a message to be written to the websocket.
// Either json (for WriteJSON) or raw (for WriteMessage) should be set, not both.
type wsMessage struct {
	json   any    // For JSON-encoded messages
	raw    []byte // For raw messages: text unless binary is set
	binary bool   // raw is a binary message (a Yjs sync frame, ws_yjs_frame.go)
}

// ClientRole identifies the type of WebSocket client
type ClientRole string

const (
	// ClientRoleViewer is a user browser that renders UI and sends user actions
	ClientRoleViewer ClientRole = "viewer"
	// ClientRoleEngine is the hidden headless browser that executes tools and renders context
	ClientRoleEngine ClientRole = "engine"
)

// WSClient wraps a WebSocket connection with a channel for serialized writes.
// A dedicated writer goroutine processes messages from the channel, ensuring
// only one goroutine writes to the connection at a time (required by gorilla/websocket).
type WSClient struct {
	ID        string     // Unique identifier for this client connection
	Role      ClientRole // Role: engine or viewer
	viewerID  string     // Caller-supplied viewer identity, or empty (see sanitiseViewerID)
	info      ClientInfo // Display metadata captured at connect (see clientInfoFromRequest)
	conn      *websocket.Conn
	send      chan wsMessage // Channel for outgoing messages
	closed    chan struct{}  // Closed to signal shutdown; see Close
	closeOnce sync.Once      // Ensures closed is closed only once
	stats     *wsStats       // Optional outbound byte accounting; nil = disabled
	// lastSendAt is when a message last reached the connection, as unix
	// nanoseconds. Written by the writer goroutine and read by the client's
	// message loop, which is why it is atomic. See IdleOutbound.
	lastSendAt atomic.Int64
	// chunkSeq names the runs of chunk frames an oversized message is split
	// into, so the client can tell one run from the next. Plain rather than
	// atomic because only writePump ever touches it — unlike lastSendAt, which
	// crosses goroutines. See writeChunked.
	chunkSeq uint64
	// binarySync is whether this client asked for Yjs sync as binary frames
	// (sync=binary on the upgrade; see ws_yjs_frame.go). Set once, before the
	// client's message loop starts, and only read after.
	binarySync bool
	// deflates is whether this connection compresses what it writes (a remote
	// peer that offered permessage-deflate; offersDeflate), which
	// keeps every binary message it writes inside one frame
	// (wsDeflatedChunkSize). Set once, before the first message is queued.
	deflates bool
}

// generateClientID creates a unique client ID using crypto/rand
func generateClientID() string {
	b := make([]byte, 8)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("client_%d", time.Now().UnixNano())
	}
	return fmt.Sprintf("client_%s", hex.EncodeToString(b))
}

// NewWSClient creates a new WSClient and starts its writer goroutine. viewerID
// is the caller's own stable identity, already sanitised, and may be empty; info
// is display metadata for the connected-clients UI; stats may be nil (accounting
// disabled).
func NewWSClient(conn *websocket.Conn, role ClientRole, viewerID string, info ClientInfo, stats *wsStats) *WSClient {
	client := &WSClient{
		ID:       generateClientID(),
		Role:     role,
		viewerID: viewerID,
		info:     info,
		conn:     conn,
		send:     make(chan wsMessage, 256), // Buffered to prevent blocking senders
		closed:   make(chan struct{}),
		stats:    stats,
	}
	// The upgrade response is itself something this connection has just carried,
	// so the link starts idle from now rather than from the zero time.
	client.lastSendAt.Store(time.Now().UnixNano())
	go client.writePump()
	return client
}

// writeDeadlineExceeded reports whether err is the write deadline expiring:
// the peer is holding a connection open without draining it. The socket is
// fine, the peer is not, so it names the one write failure worth reporting in
// its own words — the client is reachable and simply not listening. Closing
// lets it reconnect, which is the only thing that recovers it.
//
// Matched through the net.Error interface rather than os.ErrDeadlineExceeded:
// gorilla substitutes its own net.Error implementation for the underlying
// error, and that type carries Timeout() but no Unwrap, so the sentinel does
// not match it.
func writeDeadlineExceeded(err error) bool {
	var netErr net.Error
	return errors.As(err, &netErr) && netErr.Timeout()
}

// writePump is the dedicated writer goroutine - only this goroutine writes to the connection
func (c *WSClient) writePump() {
	defer c.conn.Close()
	// Marking the client closed on the way out covers the exit writeOne forces:
	// nothing drains send once this goroutine is gone, so without it a sender
	// would fill the buffer and then block until the read side noticed the dead
	// socket. Idempotent, so the ordinary Close-driven exit passes through it.
	defer c.Close()
	for {
		select {
		case msg := <-c.send:
			if !c.writeOne(msg) {
				return
			}
		case <-c.closed:
			// Shutting down. Flush whatever is already queued first — a close is
			// often preceded by a message that exists precisely to be read on the
			// way out (the hub's server-shutdown notice) — then say goodbye.
			for {
				select {
				case msg := <-c.send:
					if !c.writeOne(msg) {
						return
					}
					continue
				default:
				}
				break
			}
			_ = c.conn.SetWriteDeadline(time.Now().Add(wsCloseWriteTimeout))
			_ = c.conn.WriteMessage(websocket.CloseMessage,
				websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
			return
		}
	}
}

// writeOne writes a single queued message, reporting whether the pump may
// continue. Only writePump calls it, so the one-writer-per-connection rule
// gorilla requires still holds.
//
// Any write failure ends the connection, and there is no retry for any class
// of error — not even transient kernel backpressure like ENOBUFS. gorilla
// latches the first error a connection sees (Conn.writeFatal) and answers
// every later write straight from that latch without touching the socket, so
// once one write has failed no payload can leave this connection again: a
// retry cannot reach the kernel to discover the pressure has cleared. It would
// only postpone the close. The close is the recovery — the viewer's stall
// watchdog sees the socket go and reconnects, with a jittered near-instant
// first attempt, which costs far less than holding a connection that can no
// longer carry anything.
func (c *WSClient) writeOne(msg wsMessage) bool {
	payload := msg.raw
	if payload == nil {
		var mErr error
		if payload, mErr = json.Marshal(msg.json); mErr != nil {
			jlog.Error("WebSocket marshal error for client %p: %v", c, mErr)
			return true
		}
	}
	c.stats.record(statsOut, payload, c.Role)
	messageType, chunkKind := websocket.TextMessage, wsChunkKindText
	if msg.binary {
		messageType, chunkKind = websocket.BinaryMessage, wsChunkKindBinary
	}

	// Accounting above covers the logical message, so a chunked send is one
	// entry there however many frames it takes on the wire.
	var err error
	if !c.writesWhole(len(payload), msg.binary) {
		// Worth a line every time it is for size. That is the exceptional path —
		// nothing in an ordinary session comes close to the threshold — so its
		// arrival says a conversation has grown to a size no client accepts
		// whole, and it names which one while the evidence is still to hand. A
		// binary message chunked to keep a compressed one whole
		// (wsDeflatedChunkSize) is ordinary traffic, and says nothing.
		if len(payload) > wsChunkThreshold {
			jlog.Info("Splitting a %d byte %s message into %d frames for %s client %p; "+
				"no client accepts one this large whole",
				len(payload), describeWSMessage(payload), wsChunkCount(len(payload), c.chunkSize()), c.Role, c)
		}
		err = c.writeChunked(payload, chunkKind)
	} else {
		// Armed fresh per write. SetWriteDeadline only records the time; gorilla
		// applies it to the socket inside its write lock, in the same critical
		// section as the write itself, so this cannot be clobbered by the pong and
		// close frames gorilla sends from the read goroutine via WriteControl.
		_ = c.conn.SetWriteDeadline(time.Now().Add(wsWriteTimeout))
		err = c.conn.WriteMessage(messageType, payload)
	}
	if err != nil {
		// What failed matters as much as that it failed: a peer that hangs up
		// part-way through one particular message is saying something about that
		// message, and without its size and type the log leaves no trace of which
		// one it was.
		if writeDeadlineExceeded(err) {
			jlog.Error("WebSocket write of a %d byte %s message to client %p exceeded %s and was abandoned; "+
				"the peer stopped reading (%d queued). Closing so it can reconnect: %v",
				len(payload), describeWSMessage(payload), c, wsWriteTimeout, len(c.send), err)
		} else {
			jlog.Error("Couldn't write a %d byte %s message to WebSocket client %p (%d queued); "+
				"closing so it can reconnect: %v",
				len(payload), describeWSMessage(payload), c, len(c.send), err)
		}
		return false
	}
	c.lastSendAt.Store(time.Now().UnixNano())
	return true
}

// describeWSMessage names an outgoing payload for a log line: its type, and for
// the worker envelope that carries nearly all of Juggler's traffic, the worker
// message type and conversation inside it.
//
// Read with jsonparser rather than encoding/json because this runs on paths
// where the payload may be tens of megabytes, and Unmarshal would validate the
// whole document to read three short fields near its front. Every producer
// emits Type first, so in practice this stops after a few bytes.
//
// It never fails: a payload too broken to describe still has a size worth
// logging, and swallowing the line to report a parse error would lose it.
func describeWSMessage(payload []byte) string {
	if isYjsFrame(payload) {
		return describeYjsFrame(payload)
	}
	msgType, err := jsonparser.GetString(payload, "type")
	if err != nil {
		return "unlabelled"
	}
	if msgType != "worker-message" {
		return msgType
	}
	workerMsgType, err := jsonparser.GetString(payload, "workerMsgType")
	if err != nil {
		return msgType
	}
	convID, err := jsonparser.GetString(payload, "conversationId")
	if err != nil {
		return workerMsgType
	}
	return fmt.Sprintf("%s (%s)", workerMsgType, convID)
}

// trySend queues a message, blocking while the buffer is full but never past
// the client's close. Returns false once the client is closed.
//
// Shutdown is signalled by closing a separate `closed` channel rather than the
// send channel itself: a sender and a closer can run on any two goroutines (a
// broadcast racing the engine supervisor, say), and closing a channel from under
// a concurrent send is a data race that costs a panic per send, and a recover
// around the send would hide the race without preventing it.
func (c *WSClient) trySend(msg wsMessage) bool {
	// Prefer the closed signal when both are ready, so a closed client stops
	// accepting work promptly rather than by chance.
	select {
	case <-c.closed:
		return false
	default:
	}
	select {
	case c.send <- msg:
		return true
	case <-c.closed:
		return false
	}
}

// Send queues a JSON message to be written to the websocket.
// Blocks if buffer is full. Returns false only if the client is closed.
func (c *WSClient) Send(msg any) bool {
	return c.trySend(wsMessage{json: msg})
}

// SendRaw queues a raw text message to be written to the websocket.
// Used for streaming chunks that don't need JSON encoding.
// Blocks if buffer is full. Returns false only if the client is closed.
func (c *WSClient) SendRaw(data []byte) bool {
	return c.trySend(wsMessage{raw: data})
}

// SendBinary queues a binary message — a Yjs sync frame — on the same queue as
// every other message, so it keeps its place among them.
// Blocks if buffer is full. Returns false only if the client is closed.
func (c *WSClient) SendBinary(data []byte) bool {
	return c.trySend(wsMessage{raw: data, binary: true})
}

// AcceptsBinarySync reports whether this client asked for Yjs sync as binary
// frames (see ws_yjs_frame.go).
func (c *WSClient) AcceptsBinarySync() bool { return c.binarySync }

// Close stops the writer goroutine and closes the connection. Safe to call
// multiple times, and from any goroutine — including one that is not the
// client's owner, which is how a wedged engine is evicted.
func (c *WSClient) Close() {
	c.closeOnce.Do(func() {
		close(c.closed)
	})
}

// QueuedWrites reports how many messages are waiting to be written to this
// client. A peer that has stopped reading shows up here as a backlog climbing
// toward the send channel's capacity, which is the difference between "quiet"
// and "not draining" — worth naming in any diagnostic about a client that has
// gone silent.
func (c *WSClient) QueuedWrites() int { return len(c.send) }

// IdleOutbound reports how long this client has had nothing to send, which is
// what decides whether the link needs a beat (see link_liveness.go).
//
// Zero while anything is queued: a backlog is the opposite of idle, and it is
// also the shape of a peer that has stopped draining — where a beat would queue
// behind the backlog and block its sender rather than prove anything.
func (c *WSClient) IdleOutbound() time.Duration {
	if len(c.send) > 0 {
		return 0
	}
	return time.Since(time.Unix(0, c.lastSendAt.Load()))
}

func (c *WSClient) ClientID() string       { return c.ID }
func (c *WSClient) ClientRole() ClientRole { return c.Role }
func (c *WSClient) ClientInfo() ClientInfo { return c.info }
func (c *WSClient) ViewerID() string       { return c.viewerID }

// Sender is the interface for broadcasting messages to a WebSocket client.
// WSClient satisfies this interface.
type Sender interface {
	Send(msg any) bool
	SendRaw(data []byte) bool
}
