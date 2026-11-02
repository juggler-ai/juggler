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
	if _, err := a.serverClient(true); err != nil {
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

// TestAQuitIsHeldOpenWhileTheUserDecides: a quit the app has not authorised —
// at a logout, the system's — is neither refused at once, which would cancel
// the logout, nor granted, which would discard a running turn unasked. It is
// held open while the busy confirmation is up, and refused only once the user
// chooses to keep working.
func TestAQuitIsHeldOpenWhileTheUserDecides(t *testing.T) {
	a := newTestAppState(t)
	srv := newStubMachineServer(t, a, core.Version)
	srv.list.Store(&[]machineserver.Session{{ID: "a", Project: "/a", State: machineserver.SessionRunning, Busy: true}})
	if _, err := a.serverClient(true); err != nil {
		t.Fatal(err)
	}

	up := make(chan struct{})
	answer := make(chan struct{})
	orig := confirmQuitDiscard
	confirmQuitDiscard = func(*appState, int) bool {
		close(up)
		<-answer
		return false
	}
	t.Cleanup(func() { confirmQuitDiscard = orig })

	decided := make(chan bool, 2)
	a.shouldQuitLater(func(quit bool) { decided <- quit })
	<-up
	select {
	case quit := <-decided:
		t.Fatalf("the quit was decided %v while the user was still being asked", quit)
	default:
	}
	close(answer)
	if quit := <-decided; quit {
		t.Fatal("the user chose to keep working, and the quit was granted")
	}
	if len(decided) != 0 {
		t.Fatal("the quit was decided twice")
	}
}
