//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"sync"
	"sync/atomic"
	"testing"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/machineserver"
)

// TestQuitAsksOnceWhileItsConfirmationIsUp: a quit asked for again while the
// busy confirmation is on screen (another Cmd+Q, the page's Exit) shows no
// second dialog. Once the user has answered, a quit asks again.
func TestQuitAsksOnceWhileItsConfirmationIsUp(t *testing.T) {
	a := newTestAppState(t)
	srv := newStubMachineServer(t, a, core.Version)
	srv.list.Store(&[]machineserver.Session{{ID: "a", Project: "/a", State: machineserver.SessionRunning, Busy: true}})
	if _, err := a.serverClient(); err != nil {
		t.Fatal(err)
	}

	var asks atomic.Int32
	up := make(chan struct{})
	answer := make(chan struct{})
	letGo := sync.OnceFunc(func() { close(answer) })
	t.Cleanup(letGo)
	orig := confirmQuitDiscard
	// The first dialog stays up until the test answers it; any other answers
	// "Keep working" at once.
	confirmQuitDiscard = func(*appState, int) bool {
		if asks.Add(1) == 1 {
			close(up)
			<-answer
		}
		return false
	}
	t.Cleanup(func() { confirmQuitDiscard = orig })

	first := make(chan struct{})
	go func() {
		defer close(first)
		a.confirmThenQuit()
	}()
	<-up
	a.confirmThenQuit()
	a.confirmThenQuit()
	if n := asks.Load(); n != 1 {
		t.Fatalf("%d quit dialogs with the first still up, want 1", n)
	}

	letGo()
	<-first
	a.confirmThenQuit()
	if n := asks.Load(); n != 2 {
		t.Fatalf("%d quit dialogs after the first was answered and a quit asked again, want 2", n)
	}
}
