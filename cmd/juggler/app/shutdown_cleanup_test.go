//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"slices"
	"testing"
	"time"
)

// TestParentGoneReleasesResourcesBeforeExit is the regression test for the
// other orphan route: quitting the desktop app.
//
// A server spawned by juggler-app runs with --exit-with-parent and self-
// terminates when its owner dies. That exit ran no teardown at all, so every
// provider subprocess the server had spawned was left running — the same leak
// as the signal path, reached by quitting the app rather than the terminal.
func TestParentGoneReleasesResourcesBeforeExit(t *testing.T) {
	var order []string
	onParentGone(
		func() { order = append(order, "release") },
		time.Second,
		func(int) { order = append(order, "exit") },
	)

	if len(order) != 2 || order[0] != "release" || order[1] != "exit" {
		t.Fatalf("parent-gone steps = %v, want the release to complete before the exit", order)
	}
}

// TestParentGoneExitsEvenIfReleaseWedges keeps the watchdog's guarantee intact:
// it exists to make sure a server never outlives its owner, so a teardown that
// hangs must not be able to keep us alive.
func TestParentGoneExitsEvenIfReleaseWedges(t *testing.T) {
	wedged := make(chan struct{})
	t.Cleanup(func() { close(wedged) })
	exited := make(chan struct{})

	go onParentGone(
		func() { <-wedged },
		20*time.Millisecond,
		func(int) { close(exited) },
	)

	select {
	case <-exited:
	case <-time.After(5 * time.Second):
		t.Fatal("a wedged teardown blocked the parent-gone exit — the server would outlive its owner")
	}
}

// TestQuitGraceTimeoutExceedsServerShutdownBudget guards the coupling between
// the two timers on the shutdown path. quitGraceTimeout starts when the quit is
// requested and force-exits the process; the server shutdown that now runs
// inside that window is allowed serverShutdownTimeout to finish. If the
// force-exit can fire first it SIGKILLs us mid-teardown, orphaning exactly the
// subprocesses the teardown exists to reap.
func TestQuitGraceTimeoutExceedsServerShutdownBudget(t *testing.T) {
	if quitGraceTimeout <= serverShutdownTimeout {
		t.Fatalf("quitGraceTimeout (%v) must exceed serverShutdownTimeout (%v), or the force-exit can cut a legitimate shutdown short", quitGraceTimeout, serverShutdownTimeout)
	}
}

// TestRunCleanupsRunsEachCleanupOnce locks in that the teardown stack is
// single-shot. Cleanups release real resources — the server shutdown that kills
// provider subprocesses, the instance lock — and shutdown now drives the stack
// from the quit path as well as from Run's defer, so running it twice must not
// run any cleanup twice.
func TestRunCleanupsRunsEachCleanupOnce(t *testing.T) {
	a := &App{}
	counts := make([]int, 3)
	for i := range counts {
		a.pushCleanup(func() { counts[i]++ })
	}

	a.runCleanups()
	a.runCleanups()

	for i, n := range counts {
		if n != 1 {
			t.Errorf("cleanup %d ran %d times, want exactly 1", i, n)
		}
	}
}

// TestBeginShutdownRunsCleanupsBeforeNativeQuit is the regression test for
// orphaned provider subprocesses.
//
// Cleanups used to run only from Run's deferred walk, which is reached only if
// the native application's Run returns. On macOS app.Quit() terminates the
// process outright, so that defer never fired: the server was never shut down,
// conversations were never closed, and every live claude CLI was orphaned —
// left running with a dead control channel, still burning tokens. Teardown must
// therefore complete BEFORE control is handed to the native quit.
func TestBeginShutdownRunsCleanupsBeforeNativeQuit(t *testing.T) {
	a := &App{}
	var order []string
	a.pushCleanup(func() { order = append(order, "cleanup-first-registered") })
	a.pushCleanup(func() { order = append(order, "cleanup-last-registered") })

	a.beginShutdown(func() { order = append(order, "native-quit") })

	if len(order) != 3 {
		t.Fatalf("shutdown steps = %v, want two cleanups then the native quit", order)
	}
	if order[2] != "native-quit" {
		t.Fatalf("shutdown order = %v, want the native quit LAST — anything after it may never run", order)
	}
	// LIFO, matching the existing teardown contract.
	if order[0] != "cleanup-last-registered" || order[1] != "cleanup-first-registered" {
		t.Fatalf("cleanup order = %v, want LIFO (last registered released first)", order)
	}
}

// TestAwaitTeardownHoldsTheNativeQuitUntilCleanupsFinish is the regression test
// for a quit that discarded whatever a conversation was in the middle of.
//
// beginShutdown gets the order right, but it was not the only route to the
// native quit: closing the done channel woke a goroutine that called app.Quit()
// straight away, in parallel with the cleanups beginShutdown was still running.
// [NSApp terminate:] ends the process without unwinding, so it was a footrace
// for whether the worker shutdown inside those cleanups got as far as writing
// its conversations. Nothing else persists a conversation while an LLM call is
// in flight — the run loop is inside the turn and can't service a save — so
// losing that race lost the whole turn, the user's own message included.
func TestAwaitTeardownHoldsTheNativeQuitUntilCleanupsFinish(t *testing.T) {
	a := &App{}

	order := make(chan string, 2)

	cleanupRunning := make(chan struct{})
	releaseCleanup := make(chan struct{})
	a.pushCleanup(func() {
		close(cleanupRunning)
		<-releaseCleanup // stands in for a worker writing its document
		order <- "cleanup"
	})

	teardownDone := make(chan struct{})
	nativeQuit := make(chan struct{})
	// Stands in for the shutdown goroutine in runHeadlessServerApp: it wakes as
	// soon as the quit is requested, and must wait rather than terminate us.
	go func() {
		awaitTeardown(teardownDone, 10*time.Second)
		order <- "native-quit"
		close(nativeQuit)
	}()

	go a.beginShutdown(func() { close(teardownDone) })

	<-cleanupRunning
	select {
	case <-nativeQuit:
		t.Fatal("the native quit was issued while a cleanup was still running — anything it had not yet reached is lost")
	case <-time.After(50 * time.Millisecond):
	}

	close(releaseCleanup)
	select {
	case <-nativeQuit:
	case <-time.After(10 * time.Second):
		t.Fatal("the native quit never landed after teardown finished")
	}

	got := []string{<-order, <-order}
	if want := []string{"cleanup", "native-quit"}; !slices.Equal(got, want) {
		t.Fatalf("shutdown order = %v, want %v", got, want)
	}
}

// TestAwaitTeardownGivesUpOnAWedgedCleanup keeps the other guarantee: waiting
// for teardown must not become a way to never quit at all. A cleanup that hangs
// costs us the budget and no more.
func TestAwaitTeardownGivesUpOnAWedgedCleanup(t *testing.T) {
	budget := 20 * time.Millisecond
	returned := make(chan struct{})
	go func() {
		awaitTeardown(make(chan struct{}), budget) // never signalled
		close(returned)
	}()

	select {
	case <-returned:
	case <-time.After(5 * time.Second):
		t.Fatal("a wedged cleanup blocked the native quit indefinitely")
	}
}

// TestBeginShutdownIsIdempotent covers the real call pattern: quit() runs the
// cleanups, then Run's deferred walk fires too if the native Run does return
// (Linux/Windows, or a macOS quit that unwinds cleanly). The second pass must
// be a no-op rather than a second server shutdown.
func TestBeginShutdownIsIdempotent(t *testing.T) {
	a := &App{}
	cleanups := 0
	quits := 0
	a.pushCleanup(func() { cleanups++ })

	a.beginShutdown(func() { quits++ })
	a.runCleanups()

	if cleanups != 1 {
		t.Errorf("cleanup ran %d times across beginShutdown + Run's defer, want 1", cleanups)
	}
	if quits != 1 {
		t.Errorf("native quit ran %d times, want 1", quits)
	}
}
