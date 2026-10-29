//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄▄▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"sync"
	"testing"
)

// A close arriving at a window that has not been through the gate must be
// cancelled, or the flush would be announced to a webview Wails has already
// destroyed and the reply would never come.
func TestCloseReadyHoldsTheFirstCloseAndPassesTheReIssuedOne(t *testing.T) {
	a := newTestAppState(t)
	e := registerTestWindow(a, "w1")

	if a.closeReady(e) {
		t.Fatal("the first close must be held so the gate can run against a live page")
	}

	a.reg(func(st *regState) { st.windows["w1"].settled = true })
	if !a.closeReady(e) {
		t.Fatal("the close the gate re-issues must fall straight through to teardown")
	}
}

// A quit settles every window together before it tears any of them down, so
// gating each one again would re-ask a question already answered.
func TestCloseReadyLetsAQuitThrough(t *testing.T) {
	a := newTestAppState(t)
	e := registerTestWindow(a, "w1")

	a.reg(func(st *regState) { st.quitting = true })
	if !a.closeReady(e) {
		t.Fatal("a window closing as part of a quit must not be gated again")
	}
}

// Nothing left to settle for a window already out of the registry.
func TestCloseReadyLetsAnUnregisteredWindowThrough(t *testing.T) {
	a := newTestAppState(t)
	e := registerTestWindow(a, "w1")
	a.reg(func(st *regState) { delete(st.windows, "w1") })

	if !a.closeReady(e) {
		t.Fatal("a window no longer registered has nothing left to settle")
	}
}

// The window stays clickable while the gate runs, so repeat closes arrive during
// it. A second gate would raise a second prompt and a second handshake.
func TestClaimSettleAdmitsOnlyTheFirstCaller(t *testing.T) {
	a := newTestAppState(t)
	e := registerTestWindow(a, "w1")

	if !a.claimSettle(e) {
		t.Fatal("the first close must win the right to run the gate")
	}
	if a.claimSettle(e) {
		t.Fatal("a close arriving while the gate runs must not start a second one")
	}
}

func TestClaimSettleAdmitsOneOfManyConcurrentClosers(t *testing.T) {
	a := newTestAppState(t)
	e := registerTestWindow(a, "w1")

	const closers = 8
	claims := make(chan bool, closers)
	var wg sync.WaitGroup
	for range closers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			claims <- a.claimSettle(e)
		}()
	}
	wg.Wait()
	close(claims)

	won := 0
	for claimed := range claims {
		if claimed {
			won++
		}
	}
	if won != 1 {
		t.Fatalf("exactly one closer must run the gate, got %d", won)
	}
}
