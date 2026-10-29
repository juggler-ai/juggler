//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"fmt"
	"testing"
	"time"
)

// blockingSender simulates a client whose send buffer is permanently full —
// Send/SendRaw block forever. The viewerGroup actor MUST NOT stall while
// fanning out to such a client.
type blockingSender struct {
	id       string
	released chan struct{}
}

func (b *blockingSender) Send(_ any) bool {
	<-b.released
	return false
}
func (b *blockingSender) SendRaw(_ []byte) bool {
	<-b.released
	return false
}

// fastSender records every Send for verification.
type fastSender struct {
	id   string
	recv chan any
}

func (f *fastSender) Send(msg any) bool {
	f.recv <- msg
	return true
}
func (f *fastSender) SendRaw(_ []byte) bool { return true }

// TestViewerGroup_BroadcastOrderPreservedPerClient guards the streaming
// contract every viewerSendToAll caller relies on: two broadcasts issued in
// sequence must arrive at each client in that sequence. The shell-output
// path depends on it directly — a `done` chunk that overtakes its `data`
// chunk makes the client resolve a real command's output as empty.
func TestViewerGroup_BroadcastOrderPreservedPerClient(t *testing.T) {
	g := newViewerGroup()
	defer g.stop()

	// Unbuffered recv: each delivery blocks until the test consumes it, so
	// any cross-broadcast race is forced to express itself as misordering.
	fast := &fastSender{id: "fast", recv: make(chan any)}
	g.ch <- viewerOp{kind: vgJoin, sender: fast, clientID: fast.id}

	const n = 200
	for i := 0; i < n; i++ {
		g.sendToAll(i)
	}

	for want := 0; want < n; want++ {
		select {
		case got := <-fast.recv:
			if got != want {
				t.Fatalf("broadcast order violated: got %v, want %d", got, want)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for broadcast %d", want)
		}
	}
}

// TestViewerGroup_RawAndJSONBroadcastsShareOrdering verifies sendToAll and
// sendRawToAll deliveries cannot reorder relative to each other — they ride
// the same per-client queue.
func TestViewerGroup_RawAndJSONBroadcastsShareOrdering(t *testing.T) {
	g := newViewerGroup()
	defer g.stop()

	recv := make(chan string)
	s := &orderProbeSender{recv: recv}
	g.ch <- viewerOp{kind: vgJoin, sender: s, clientID: "probe"}

	const n = 100
	for i := 0; i < n; i++ {
		if i%2 == 0 {
			g.sendToAll(fmt.Sprintf("m%d", i))
		} else {
			g.sendRawToAll([]byte(fmt.Sprintf("m%d", i)))
		}
	}

	for i := 0; i < n; i++ {
		want := fmt.Sprintf("m%d", i)
		if i%2 == 1 {
			want = "raw:" + want
		} else {
			want = "json:" + want
		}
		select {
		case got := <-recv:
			if got != want {
				t.Fatalf("interleaved order violated at %d: got %q, want %q", i, got, want)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("timed out waiting for message %d", i)
		}
	}
}

// orderProbeSender records both Send and SendRaw deliveries on one channel,
// tagged by kind so the test can assert cross-kind ordering.
type orderProbeSender struct {
	recv chan string
}

func (o *orderProbeSender) Send(msg any) bool {
	o.recv <- "json:" + msg.(string)
	return true
}

func (o *orderProbeSender) SendRaw(data []byte) bool {
	o.recv <- "raw:" + string(data)
	return true
}

func TestViewerGroup_BlockingSenderDoesNotStallActor(t *testing.T) {
	g := newViewerGroup()
	defer g.stop()

	slow := &blockingSender{id: "slow", released: make(chan struct{})}
	fast := &fastSender{id: "fast", recv: make(chan any, 16)}

	// Join both members directly via the channel so the test does not depend
	// on a *WSClient.
	g.ch <- viewerOp{kind: vgJoin, sender: slow, clientID: slow.id}
	g.ch <- viewerOp{kind: vgJoin, sender: fast, clientID: fast.id}

	// Fire a broadcast that the slow sender will block on indefinitely.
	g.sendToAll(map[string]any{"hello": "world"})

	// Now issue a state-mutating op that the actor must service even while
	// the broadcast is in flight. If the fan-out blocks the actor, this
	// returns nothing within the timeout and the test fails.
	done := make(chan bool, 1)
	go func() {
		_, cancel := context.WithCancel(context.Background())
		defer cancel()
		ok := g.startShell("shell-1", cancel, false)
		done <- ok
	}()

	select {
	case ok := <-done:
		if !ok {
			t.Fatal("startShell returned false unexpectedly")
		}
	case <-time.After(500 * time.Millisecond):
		t.Fatal("viewerGroup actor blocked on slow sender — startShell never returned")
	}

	close(slow.released) // let the blocked send unwind
	// fast sender receives via its own mailbox regardless of the slow one.
	select {
	case <-fast.recv:
	case <-time.After(500 * time.Millisecond):
		t.Fatal("fast sender never received broadcast")
	}
}
