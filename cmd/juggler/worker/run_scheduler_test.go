//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"fmt"
	"testing"
)

// TestRunSchedulerAdmission drives the admission rule on a bare scheduler, with
// no worker: a running thread is refused, write-capable runs exclude one
// another, read-only runs share the writer slot up to the pacing ceiling, and a
// retirement frees a place.
func TestRunSchedulerAdmission(t *testing.T) {
	s := newRunScheduler(make(chan struct{}))
	defer s.releaseActivity()

	if !s.admits("root", false) || !s.admits("ro", true) {
		t.Fatal("an idle scheduler refused a thread")
	}
	root := newTurnState()
	s.register(liveRunEntry{threadItemID: "root", t: root})
	if s.admits("root", false) {
		t.Fatal("a thread already running was admitted again")
	}
	if s.admits("writer", false) {
		t.Fatal("a second write-capable run was admitted beside the first")
	}

	ro := make([]*turnState, maxConcurrentReadOnlyThreads)
	for i := range ro {
		id := fmt.Sprintf("ro-%d", i)
		if !s.admits(id, true) {
			t.Fatalf("read-only child %d refused below the ceiling", i)
		}
		ro[i] = newTurnState()
		s.register(liveRunEntry{threadItemID: id, readOnly: true, t: ro[i]})
	}
	if s.admits("ro-extra", true) {
		t.Fatal("a read-only child past the ceiling was admitted")
	}
	if got := s.unregister(ro[0]); got != "ro-0" {
		t.Fatalf("unregister returned thread %q, want ro-0", got)
	}
	if !s.admits("ro-extra", true) {
		t.Fatal("a retirement did not free a read-only place")
	}
	if !s.owns(root) || s.owns(ro[0]) {
		t.Fatal("owns does not follow the registry")
	}
	if live := s.runOn("ro-1"); live == nil || live.t != ro[1] {
		t.Fatal("runOn did not find a registered thread")
	}
	if threads := s.liveThreads(); len(threads) != maxConcurrentReadOnlyThreads || threads["ro-0"] {
		t.Fatalf("liveThreads = %v after one retirement", threads)
	}
}

// TestRunSchedulerHandOffs pins the reconcile bit and the run loop's queues: a
// burst of wakes coalesces into one, taking the bit clears it, a full dispatch
// queue refuses rather than blocks, and a retirement after shutdown falls
// through.
func TestRunSchedulerHandOffs(t *testing.T) {
	done := make(chan struct{})
	s := newRunScheduler(done)

	s.wakeReconcile()
	s.wakeReconcile()
	if n := len(s.wakes()); n != 1 {
		t.Fatalf("two wakes queued %d loop iterations, want 1", n)
	}
	if !s.takeReconcile() || s.reconcilePending() || s.takeReconcile() {
		t.Fatal("takeReconcile does not clear the bit exactly once")
	}
	s.markReconcile()
	s.dropReconcile()
	if s.reconcilePending() {
		t.Fatal("dropReconcile left the bit set")
	}

	for i := 0; i < cap(s.dispatches()); i++ {
		if !s.postDispatch(newTurnState()) {
			t.Fatalf("dispatch %d refused before the queue was full", i)
		}
	}
	if s.postDispatch(newTurnState()) {
		t.Fatal("a full dispatch queue accepted another turn")
	}

	for i := 0; i < cap(s.retirements()); i++ {
		s.retire(newTurnState())
	}
	close(done)
	s.retire(newTurnState()) // would block forever if shutdown did not release it
}

// TestRunSchedulerBoundariesAreThreadOwned pins that a filed boundary seeds only
// a run on the same thread.
func TestRunSchedulerBoundariesAreThreadOwned(t *testing.T) {
	s := newRunScheduler(make(chan struct{}))
	settled := newTurnState()
	settled.processingStartedAt.Store(42)
	settled.lastProviderNotice = "notice-a"
	s.fileBoundary("thread-a", settled)

	sameThread, otherThread := newTurnState(), newTurnState()
	s.seedBoundary("thread-a", sameThread)
	s.seedBoundary("thread-b", otherThread)
	if sameThread.processingStartedAt.Load() != 42 || sameThread.lastProviderNotice != "notice-a" {
		t.Fatal("a run on the same thread was not seeded with its boundary")
	}
	if otherThread.processingStartedAt.Load() != 0 || otherThread.lastProviderNotice != "" {
		t.Fatal("a run on another thread inherited a boundary that is not its own")
	}
}
