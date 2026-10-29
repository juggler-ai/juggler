//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"slices"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
)

// heldLock returns a project directory whose instance lock this test holds,
// plus a func reporting whether the lock has since been released.
func heldLock(t *testing.T) (*core.InstanceLock, func() bool) {
	t.Helper()
	dir := t.TempDir()
	lock := core.NewInstanceLock(dir)
	res, err := lock.TryAcquire()
	if err != nil || !res.Acquired {
		t.Fatalf("could not take the lock: acquired=%v err=%v", res.Acquired, err)
	}
	t.Cleanup(func() { _ = lock.Release() })

	return lock, func() bool {
		probe := core.NewInstanceLock(dir)
		res, err := probe.TryAcquire()
		if err != nil || !res.Acquired {
			return false
		}
		_ = probe.Release()
		return true
	}
}

// TestTeardownReleasesTheLockWhenAStageWedges is the regression test for the
// leaked lockfile.
//
// Shutdown closes the listener before it runs any of this, so from the moment
// teardown begins the process holds the project lock and answers nothing. If a
// stage can then block forever, the lock outlives every attempt to relaunch and
// only deleting the file by hand recovers the project. The wait must be bounded
// and the lock must come off even when the teardown behind it never finishes.
func TestTeardownReleasesTheLockWhenAStageWedges(t *testing.T) {
	lock, released := heldLock(t)

	wedged := make(chan struct{})
	t.Cleanup(func() { close(wedged) })

	// Go cannot abort a blocked goroutine, so the stage after the wedge is not
	// prevented from ever running — it is merely prevented from being waited
	// for. What must be bounded is our own return, and the lock.
	steps := []teardownStep{
		{name: "file watcher", run: func() {}},
		{name: "workers", run: func() { <-wedged }},
		{name: "session manager", run: func() {}},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()

	done := make(chan error, 1)
	go func() { done <- runTeardown(ctx, steps, lock.Release) }()

	select {
	case err := <-done:
		if err == nil {
			t.Fatal("a wedged teardown reported a clean shutdown")
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Shutdown never returned — the context bounding it is not honoured")
	}

	if !released() {
		t.Fatal("the project lock is still held after a wedged shutdown — this is the leaked lockfile")
	}
}

// TestTeardownRunsEveryStageInOrderThenReleases keeps the ordering guarantees
// the stages depend on. Workers save conversations through the session manager,
// so a session manager stopped early deadlocks them; and the lock must come off
// only once that writing is done, or a relaunch could start while this process
// is still saving state.
func TestTeardownRunsEveryStageInOrderThenReleases(t *testing.T) {
	lock, released := heldLock(t)

	var order []string
	steps := []teardownStep{
		{name: "workers", run: func() { order = append(order, "workers") }},
		{name: "conversations", run: func() { order = append(order, "conversations") }},
		{name: "session manager", run: func() {
			order = append(order, "session manager")
			if released() {
				t.Error("the lock was released before state finished being written")
			}
		}},
	}

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()

	if err := runTeardown(ctx, steps, lock.Release); err != nil {
		t.Fatalf("clean teardown reported an error: %v", err)
	}
	if want := []string{"workers", "conversations", "session manager"}; !slices.Equal(order, want) {
		t.Fatalf("stages ran %v, want %v", order, want)
	}
	if !released() {
		t.Fatal("a clean teardown left the project lock held")
	}
}

// TestShutdownDropsTheWakeSubscription: the system-wake subscription New takes
// is process-global, so a server that shuts down without dropping it stays
// reachable and keeps being woken for the life of the process.
func TestShutdownDropsTheWakeSubscription(t *testing.T) {
	s := newTestServerState(t)
	dropped := 0
	s.stopWake = func() { dropped++ }

	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err := s.Shutdown(ctx); err != nil {
		t.Fatalf("Shutdown: %v", err)
	}
	if dropped != 1 {
		t.Fatalf("the wake subscription was dropped %d times, want once", dropped)
	}
}
