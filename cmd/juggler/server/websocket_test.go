//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"bufio"
	"errors"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"github.com/gorilla/websocket"
)

// gorillaTimeoutErr mimics the error gorilla/websocket returns when a write
// deadline expires: its own net.Error implementation, carrying Timeout() but
// NOT wrapping the original os.ErrDeadlineExceeded. Classifying it is the
// whole reason writeDeadlineExceeded matches on the interface — a test built
// on os.ErrDeadlineExceeded would pass against a sentinel check that fails in
// production.
type gorillaTimeoutErr struct{}

func (gorillaTimeoutErr) Error() string   { return "write tcp 127.0.0.1:1->127.0.0.1:2: i/o timeout" }
func (gorillaTimeoutErr) Timeout() bool   { return true }
func (gorillaTimeoutErr) Temporary() bool { return true }

// TestWriteDeadlineExceededClassification pins that an expired write deadline
// is recognised through the net.Error interface. The sentinel check that looks
// obvious here does not work: gorilla substitutes its own net.Error for the
// underlying error and that type has no Unwrap, so a test built on
// os.ErrDeadlineExceeded would pass against a check that fails in production.
func TestWriteDeadlineExceededClassification(t *testing.T) {
	timeout := error(gorillaTimeoutErr{})

	if errors.Is(timeout, os.ErrDeadlineExceeded) {
		t.Fatal("test fixture no longer mimics gorilla: it must NOT unwrap to os.ErrDeadlineExceeded")
	}
	if !writeDeadlineExceeded(timeout) {
		t.Error("an expired write deadline must be detected via the net.Error interface")
	}

	// The converse: a peer that vanished is not a deadline expiry, and must not
	// borrow the "stopped reading" diagnosis, which points at a different fault.
	for _, err := range []error{
		&net.OpError{Op: "writev", Net: "tcp", Err: os.NewSyscallError("writev", syscall.ENOBUFS)},
		&net.OpError{Op: "writev", Net: "tcp", Err: os.NewSyscallError("writev", syscall.EPIPE)},
		errors.New("websocket: close sent"),
	} {
		if writeDeadlineExceeded(err) {
			t.Errorf("%v must not be classified as a write deadline expiry", err)
		}
	}
}

// TestWSUpgraderWriteBufferAvoidsFragmenting guards the write buffer against
// being shrunk back. gorilla fragments a compressed message once it outgrows
// this buffer, and fragmented compressed frames are the shape WebKit — every
// Juggler viewer — has trouble with. The exact size is a judgement call; being
// far above the 1 KiB that fragmented nearly every message is not.
func TestWSUpgraderWriteBufferAvoidsFragmenting(t *testing.T) {
	u := newWSUpgrader()
	if u.WriteBufferSize < 16*1024 {
		t.Errorf("WriteBufferSize = %d, want >= 16 KiB so ordinary messages ride one frame", u.WriteBufferSize)
	}
	if u.WriteBufferPool != nil {
		t.Error("WriteBufferPool costs a get/put per message; Juggler has few connections writing constantly")
	}
	if u.CheckOrigin == nil {
		t.Error("CheckOrigin must stay set — it is the same-origin gate on upgrades")
	}
}

// TestWSUpgraderReadBufferMatchesInboundSize guards the read buffer against
// drifting back to gorilla's kilobyte default. Inbound yjs-sync updates run to
// megabytes, and gorilla streams a frame's payload through this buffer one
// read syscall at a time, so the default costs thousands of syscalls per
// update. Also pins the absence of a read limit: no safe bound exists for a
// sync update, and every upgrade is authenticated before it gets this far.
func TestWSUpgraderReadBufferMatchesInboundSize(t *testing.T) {
	u := newWSUpgrader()
	if u.ReadBufferSize < 16*1024 {
		t.Errorf("ReadBufferSize = %d, want >= 16 KiB so a multi-megabyte sync is not read a kilobyte at a time",
			u.ReadBufferSize)
	}
	if u.ReadBufferSize != u.WriteBufferSize {
		t.Errorf("read (%d) and write (%d) buffers are sized together; changing one alone wants a reason",
			u.ReadBufferSize, u.WriteBufferSize)
	}
}

// poisonSocket is a net.Conn that writes happily until it is poisoned, after
// which every write fails with ENOBUFS — kernel backpressure, the one write
// error transient enough to look worth retrying, and so the case that shows
// retrying to be futile. It counts the writes gorilla actually attempts on the
// socket, which is how a test tells "gorilla tried again" from "gorilla
// answered from its own latched error".
type poisonSocket struct {
	writes    atomic.Int32
	poisoned  atomic.Bool
	closed    chan struct{}
	closeOnce sync.Once
}

func (p *poisonSocket) Read(b []byte) (int, error) {
	<-p.closed // a peer that never speaks, until the connection goes
	return 0, io.EOF
}

func (p *poisonSocket) Write(b []byte) (int, error) {
	p.writes.Add(1)
	if p.poisoned.Load() {
		return 0, &net.OpError{Op: "write", Net: "tcp",
			Err: os.NewSyscallError("write", syscall.ENOBUFS)}
	}
	return len(b), nil
}

func (p *poisonSocket) Close() error {
	p.closeOnce.Do(func() { close(p.closed) })
	return nil
}

func (p *poisonSocket) LocalAddr() net.Addr { return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 1} }
func (p *poisonSocket) RemoteAddr() net.Addr {
	return &net.TCPAddr{IP: net.IPv4(127, 0, 0, 1), Port: 2}
}
func (p *poisonSocket) SetDeadline(time.Time) error     { return nil }
func (p *poisonSocket) SetReadDeadline(time.Time) error { return nil }
func (p *poisonSocket) SetWriteDeadline(t time.Time) error {
	return nil
}

// hijackTo serves an upgrade whose hijacked connection is the given socket,
// which is the only way to hand gorilla a net.Conn a test controls.
type hijackTo struct {
	socket net.Conn
	header http.Header
}

func (h *hijackTo) Header() http.Header         { return h.header }
func (h *hijackTo) Write(b []byte) (int, error) { return len(b), nil }
func (h *hijackTo) WriteHeader(int)             {}
func (h *hijackTo) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	return h.socket, bufio.NewReadWriter(bufio.NewReader(h.socket), bufio.NewWriter(h.socket)), nil
}

// poisonedWSConn completes a real websocket upgrade — the production upgrader,
// production buffer sizes — over a socket the caller can poison afterwards.
// The handshake write happens before poisoning, so writes counted from the
// returned socket are the connection's own.
func poisonedWSConn(t *testing.T) (*websocket.Conn, *poisonSocket) {
	t.Helper()
	socket := &poisonSocket{closed: make(chan struct{})}

	req := httptest.NewRequest(http.MethodGet, "/ws?role=viewer", nil)
	req.Header.Set("Connection", "Upgrade")
	req.Header.Set("Upgrade", "websocket")
	req.Header.Set("Sec-WebSocket-Version", "13")
	req.Header.Set("Sec-WebSocket-Key", "dGhlIHNhbXBsZSBub25jZQ==")

	u := newWSUpgrader()
	u.CheckOrigin = func(*http.Request) bool { return true } // origin is a separate concern

	conn, err := u.Upgrade(&hijackTo{socket: socket, header: http.Header{}}, req, nil)
	if err != nil {
		t.Fatalf("couldn't upgrade over the test socket: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn, socket
}

// TestGorillaLatchesTheFirstWriteError pins the library behaviour writeOne's
// no-retry rule rests on: gorilla stores the first write error on the
// connection and answers every later write from that store WITHOUT touching
// the socket. A retry therefore cannot reach the kernel to discover that
// backpressure has cleared — it can only burn wall time before the same
// failure. If a gorilla upgrade ever made writes recoverable, this fails and
// the decision in writeOne is worth revisiting.
func TestGorillaLatchesTheFirstWriteError(t *testing.T) {
	conn, socket := poisonedWSConn(t)
	socket.poisoned.Store(true)
	before := socket.writes.Load()

	first := conn.WriteMessage(websocket.TextMessage, []byte("one"))
	if first == nil {
		t.Fatal("a write to a poisoned socket must fail")
	}
	if !errors.Is(first, syscall.ENOBUFS) {
		t.Fatalf("want the socket's ENOBUFS surfaced, got %v", first)
	}
	if got := socket.writes.Load() - before; got != 1 {
		t.Fatalf("the first write should reach the socket exactly once, got %d attempts", got)
	}

	second := conn.WriteMessage(websocket.TextMessage, []byte("two"))
	if second != first {
		t.Fatalf("a later write must return the latched error itself, got %v (want %v)", second, first)
	}
	if got := socket.writes.Load() - before; got != 1 {
		t.Fatalf("a retried write reached the socket: %d attempts, want 1 — retrying would then be worth doing", got)
	}

	// The goodbye frame is not exempt. WriteControl is documented as usable
	// concurrently with a message write, so it might plausibly bypass the
	// latch; it does not — it consults the same store before writing. A
	// connection that has failed a write cannot send a close frame either, so
	// teardown depends on closing the socket, not on the peer being told.
	goodbye := conn.WriteControl(websocket.CloseMessage,
		websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""),
		time.Now().Add(time.Second))
	if goodbye != first {
		t.Errorf("WriteControl must be answered from the latch too, got %v (want %v)", goodbye, first)
	}
	if got := socket.writes.Load() - before; got != 1 {
		t.Errorf("the close frame reached a poisoned socket: %d attempts, want 1", got)
	}
}

// TestWriteErrorClosesTheClientAtOnce pins the pump's half of that: a failed
// write ends the connection immediately rather than sitting in a backoff
// first. ENOBUFS is the error a retry ladder would have held on for about a
// second — time bought for nothing, since the connection is already spent, and
// paid by the client, whose reconnect cannot begin until the socket goes.
func TestWriteErrorClosesTheClientAtOnce(t *testing.T) {
	conn, socket := poisonedWSConn(t)
	client := NewWSClient(conn, ClientRoleViewer, "", ClientInfo{}, nil)
	t.Cleanup(client.Close)

	idleAtStart := client.lastSendAt.Load()
	socket.poisoned.Store(true)
	before := socket.writes.Load()

	start := time.Now()
	client.SendRaw([]byte(`{"type":"heartbeat"}`))

	select {
	case <-client.closed:
	case <-time.After(5 * time.Second):
		t.Fatal("a client whose write failed was still open: nothing drains its queue and nothing tells it to reconnect")
	}
	if elapsed := time.Since(start); elapsed > 300*time.Millisecond {
		t.Errorf("closing took %v; a spent connection must be dropped at once, not held through a backoff", elapsed)
	}
	if got := socket.writes.Load() - before; got != 1 {
		t.Errorf("the payload was written %d times, want 1: the connection cannot carry anything after the first failure", got)
	}
	if client.lastSendAt.Load() != idleAtStart {
		t.Error("a write that failed must not stamp lastSendAt: the liveness supervisor would read a message that never left as proof of life")
	}
}
