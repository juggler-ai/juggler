//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄▄▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"sync"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/machineserver"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Closing the last main window quits the app (handleWindowClosed), so it stops
// whatever a quit would, and asks first exactly as a quit does. Closing any
// other window ends nothing — the app stays, and so does its server — and a
// board closes with the window that opened it, which has already asked. Kept
// working, the window stays, and a later close asks again.
func TestClosingTheLastWindowAsksAsAQuitDoes(t *testing.T) {
	for _, tc := range []struct {
		name     string
		running  machineserver.Session
		others   []string // other windows open: "main" or "board"
		closing  string   // the closing window: "main" or "board"
		wantAsk  bool
		keepWork bool
	}{
		{name: "last window, a turn running", running: machineserver.Session{Busy: true}, closing: "main", wantAsk: true, keepWork: true},
		{name: "last window, a background task running", running: machineserver.Session{BackgroundTasks: 1}, closing: "main", wantAsk: true},
		{name: "last window, nothing running", closing: "main"},
		{name: "another main window open", running: machineserver.Session{Busy: true}, others: []string{"main"}, closing: "main"},
		{name: "last main window beside its boards", running: machineserver.Session{BackgroundTasks: 1}, others: []string{"board"}, closing: "main", wantAsk: true},
		{name: "a board", running: machineserver.Session{Busy: true}, others: []string{"main"}, closing: "board"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := newTestAppState(t)
			srv := newStubMachineServer(t, a, core.Version)
			running := tc.running
			running.ID, running.Project, running.State = "a", "/a", machineserver.SessionRunning
			srv.list.Store(&[]machineserver.Session{running})
			if _, err := a.serverClient(true); err != nil {
				t.Fatal(err)
			}
			window := func(id, kind string) *winEntry {
				e := registerTestWindow(a, id)
				if kind == "board" {
					a.reg(func(*regState) { e.board = "b-" + id })
				}
				return e
			}
			for i, kind := range tc.others {
				window("other"+string(rune('0'+i)), kind)
			}
			e := window("closing", tc.closing)

			asks := 0
			orig := confirmStopsDiscard
			confirmStopsDiscard = func(*appState, application.Window, stoppingAction, machineserver.BusyWork) bool {
				asks++
				return !tc.keepWork
			}
			t.Cleanup(func() { confirmStopsDiscard = orig })

			if !a.claimSettle(e) {
				t.Fatal("the gate could not be claimed")
			}
			goAhead := a.confirmCloseEndingTheApp(e)
			if want := map[bool]int{true: 1, false: 0}[tc.wantAsk]; asks != want {
				t.Fatalf("asked %d times, want %d", asks, want)
			}
			if goAhead == tc.keepWork {
				t.Fatalf("close goes ahead = %v, but the user chose keep working = %v", goAhead, tc.keepWork)
			}
			if tc.keepWork && !a.claimSettle(e) {
				t.Fatal("after keeping the window, a later close could not run the gate again")
			}
		})
	}
}

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
