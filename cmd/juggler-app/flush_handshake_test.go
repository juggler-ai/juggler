//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄▄▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"testing"
	"time"

	"juggler/cmd/juggler/machineserver"
)

// newTestAppState builds just enough appState to exercise the registry and the
// server connection: the ops channels and the goroutines that own them. It deliberately skips
// newAppState, which resolves GPU policy and loads the persisted workspace —
// filesystem work the handshake has nothing to do with.
func newTestAppState(t *testing.T) *appState {
	t.Helper()
	a := &appState{regOps: make(chan func(*regState), 32)}
	st := &regState{windows: map[string]*winEntry{}}
	go func() {
		for op := range a.regOps {
			op(st)
		}
	}()
	t.Cleanup(func() { close(a.regOps) })
	// With no server to find, until a test starts one (newStubMachineServer).
	a.connectOpts = machineserver.ConnectOptions{ConfigDir: t.TempDir()}
	a.startConn()
	return a
}

// registerTestWindow adds a bare entry the handshake can be armed against.
func registerTestWindow(a *appState, id string) *winEntry {
	e := withSecret(&winEntry{id: id})
	a.reg(func(st *regState) { st.windows[id] = e })
	return e
}

// closed reports whether ch has been closed, without blocking.
func closed(ch chan struct{}) bool {
	select {
	case <-ch:
		return true
	default:
		return false
	}
}

func TestFlushHandshakeReleasesOnMatchingToken(t *testing.T) {
	a := newTestAppState(t)
	e := registerTestWindow(a, "w1")

	token, done := a.armFlushWait(e)
	if token == "" {
		t.Fatal("armFlushWait returned an empty token")
	}
	if closed(done) {
		t.Fatal("handshake was already complete before the page replied")
	}

	a.releaseFlushWait(e, token)
	if !closed(done) {
		t.Fatal("a reply quoting the announced token must release the waiter")
	}
}

func TestFlushHandshakeIgnoresWrongToken(t *testing.T) {
	a := newTestAppState(t)
	e := registerTestWindow(a, "w1")

	_, done := a.armFlushWait(e)

	a.releaseFlushWait(e, "not-the-token")
	if closed(done) {
		t.Fatal("a reply with the wrong token must not release the waiter")
	}
	a.releaseFlushWait(e, "")
	if closed(done) {
		t.Fatal("an empty token must not release the waiter")
	}
}

// The gate closing one window and a quit sweeping every window can both want the
// same page flushed at once. They want the identical guarantee, and the page can
// only answer what it was last told, so the second joins the reply already on its
// way instead of raising the sequence number under it — which would get that
// reply refused as stale and leave the first waiter to burn its whole deadline.
func TestFlushHandshakeJoinsAnAnnouncementAwaitingAReply(t *testing.T) {
	a := newTestAppState(t)
	e := registerTestWindow(a, "w1")

	first, waiting := a.armFlushWait(e)
	joined, alsoWaiting := a.armFlushWait(e)
	if joined != first {
		t.Fatalf("joining must quote the announced token, got %q for an announcement of %q", joined, first)
	}

	a.releaseFlushWait(e, first)
	if !closed(waiting) || !closed(alsoWaiting) {
		t.Fatal("the page's one reply must release everyone waiting on that announcement")
	}
}

// Sharing lasts only as long as the reply is outstanding. Once a handshake has
// been answered the next announcement is a new question — a repeat of the old
// reply must not answer it, or a flush that never ran reports drafts safe.
func TestFlushHandshakeIgnoresStaleTokenAfterANewAnnouncement(t *testing.T) {
	a := newTestAppState(t)
	e := registerTestWindow(a, "w1")

	stale, first := a.armFlushWait(e)
	a.releaseFlushWait(e, stale)
	if !closed(first) {
		t.Fatal("the announced token must release its own waiter")
	}

	fresh, second := a.armFlushWait(e)
	if fresh == stale {
		t.Fatal("an announcement made after a reply must mint a new token")
	}

	a.releaseFlushWait(e, stale)
	if closed(second) {
		t.Fatal("a repeat of the previous reply must not release the current waiter")
	}

	a.releaseFlushWait(e, fresh)
	if !closed(second) {
		t.Fatal("the current token must still release the current waiter")
	}
}

func TestAwaitFlushReturnsWhenPageReplies(t *testing.T) {
	a := newTestAppState(t)
	e := registerTestWindow(a, "w1")

	token, done := a.armFlushWait(e)
	go func() {
		time.Sleep(10 * time.Millisecond)
		a.releaseFlushWait(e, token)
	}()

	returned := make(chan struct{})
	go func() {
		a.awaitFlush(e.id, done, time.Now().Add(closeFlushTimeout))
		close(returned)
	}()

	select {
	case <-returned:
	case <-time.After(closeFlushTimeout):
		t.Fatal("awaitFlush did not return once the page replied")
	}
}

// A deadline that has already passed — the second and later windows in a set
// where the first used up the whole budget — must not wait again.
func TestAwaitFlushReturnsImmediatelyOnAnExpiredDeadline(t *testing.T) {
	a := newTestAppState(t)
	e := registerTestWindow(a, "w1")

	_, done := a.armFlushWait(e)

	returned := make(chan struct{})
	go func() {
		a.awaitFlush(e.id, done, time.Now().Add(-time.Second))
		close(returned)
	}()

	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("awaitFlush must not wait once the shared deadline has passed")
	}
}

// Nothing to notify (a window with no webview) must not cost a timeout.
func TestAwaitFlushReturnsImmediatelyWithoutAHandshake(t *testing.T) {
	a := newTestAppState(t)

	returned := make(chan struct{})
	go func() {
		a.awaitFlush("w1", nil, time.Now().Add(closeFlushTimeout))
		close(returned)
	}()

	select {
	case <-returned:
	case <-time.After(time.Second):
		t.Fatal("awaitFlush must return immediately when there is no handshake pending")
	}
}
