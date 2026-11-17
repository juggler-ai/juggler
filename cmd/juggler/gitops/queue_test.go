//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"context"
	"errors"
	"runtime"
	"testing"

	"juggler/cmd/juggler/gitview"
)

// Every wait here is for the queue's own progress — a turn granted, a waiter
// enqueued — and none for the clock, so nothing in these tests asserts that
// something did not happen in time. "Not yet started" is read off a waiter
// known to be queued behind a turn still held, which cannot have started.

// waiting is how many turns are queued on key behind the one held.
func (q *Queue) waiting(key string) int {
	n := 0
	q.do(func() {
		if l := q.lanes[key]; l != nil {
			n = len(l.waiters)
		}
	})
	return n
}

// queuedSoon waits until n turns are waiting on key.
func queuedSoon(t *testing.T, q *Queue, key string, n int) {
	t.Helper()
	for q.waiting(key) != n {
		if t.Context().Err() != nil {
			t.Fatalf("never saw %d waiting on %q", n, key)
		}
		runtime.Gosched()
	}
}

// turnAsync asks for a turn in a goroutine; the channel yields the turn once
// granted, or nil if refused.
func turnAsync(ctx context.Context, q *Queue, key string) <-chan *Turn {
	got := make(chan *Turn, 1)
	go func() {
		turn, err := q.Wait(ctx, key)
		if err != nil {
			turn = nil
		}
		got <- turn
	}()
	return got
}

func TestQueueSameKeyIsSerial(t *testing.T) {
	t.Parallel()
	q := NewQueue()
	defer q.Close()

	first, err := q.Wait(t.Context(), "repo")
	if err != nil {
		t.Fatal(err)
	}
	second := turnAsync(t.Context(), q, "repo")
	queuedSoon(t, q, "repo", 1)
	select {
	case <-second:
		t.Fatal("a second write ran while the first held the repository")
	default:
	}
	first.Done()
	if turn := <-second; turn == nil {
		t.Fatal("the second write was refused")
	} else {
		turn.Done()
	}
}

func TestQueueOtherRepositoriesOverlap(t *testing.T) {
	t.Parallel()
	q := NewQueue()
	defer q.Close()

	held, err := q.Wait(t.Context(), "one")
	if err != nil {
		t.Fatal(err)
	}
	defer held.Done()
	// Would never return if "two" queued behind "one".
	other, err := q.Wait(t.Context(), "two")
	if err != nil {
		t.Fatal(err)
	}
	other.Done()
}

func TestQueueIsFIFO(t *testing.T) {
	t.Parallel()
	q := NewQueue()
	defer q.Close()

	held, err := q.Wait(t.Context(), "repo")
	if err != nil {
		t.Fatal(err)
	}
	b := turnAsync(t.Context(), q, "repo")
	queuedSoon(t, q, "repo", 1)
	c := turnAsync(t.Context(), q, "repo")
	queuedSoon(t, q, "repo", 2)

	held.Done()
	turnB := <-b
	select {
	case <-c:
		t.Fatal("the third write ran before the second finished")
	default:
	}
	turnB.Done()
	(<-c).Done()
}

func TestQueueCancelledWaiterNeverRuns(t *testing.T) {
	t.Parallel()
	q := NewQueue()
	defer q.Close()

	held, err := q.Wait(t.Context(), "repo")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(t.Context())
	cancelled := make(chan error, 1)
	go func() {
		_, err := q.Wait(ctx, "repo")
		cancelled <- err
	}()
	queuedSoon(t, q, "repo", 1)
	cancel()
	if err := <-cancelled; !errors.Is(err, context.Canceled) {
		t.Fatalf("cancelled wait = %v", err)
	}
	queuedSoon(t, q, "repo", 0)
	held.Done()

	// The repository is free: the cancelled waiter took no turn.
	next, err := q.Wait(t.Context(), "repo")
	if err != nil {
		t.Fatal(err)
	}
	next.Done()
}

func TestQueueClosedRefuses(t *testing.T) {
	t.Parallel()
	q := NewQueue()
	held, err := q.Wait(t.Context(), "repo")
	if err != nil {
		t.Fatal(err)
	}
	waiting := turnAsync(t.Context(), q, "repo")
	queuedSoon(t, q, "repo", 1)
	q.Close()
	if turn := <-waiting; turn != nil {
		t.Error("a waiter was granted a turn by a closed queue")
	}
	held.Done() // harmless after Close
	if _, err := q.Wait(t.Context(), "repo"); !errors.Is(err, ErrClosed) {
		t.Errorf("Wait after Close = %v, want ErrClosed", err)
	}
}

// queueKey is what Run queues a tree's writes on: its common directory.
func queueKey(t *testing.T, dir string) string {
	t.Helper()
	_, common, err := gitview.GitDirs(t.Context(), dir)
	if err != nil {
		t.Fatal(err)
	}
	return common
}

// Two worktrees of one repository share refs, so they share a turn.
func TestQueueKeyIsTheCommonDir(t *testing.T) {
	t.Parallel()
	main, linked := withLinkedWorktree(t)
	mainKey := queueKey(t, main.dir)
	linkedKey := queueKey(t, linked)
	if mainKey != linkedKey {
		t.Errorf("main tree key %q, linked tree key %q: one repository, two queues", mainKey, linkedKey)
	}
	other := newRepo(t)
	if otherKey := queueKey(t, other.dir); otherKey == mainKey {
		t.Error("two repositories share a queue key")
	}
}
