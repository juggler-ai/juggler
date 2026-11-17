//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package gitops

import (
	"context"
	"errors"
	"sync"
)

// ErrClosed is a turn asked of a queue that has been closed.
var ErrClosed = errors.New("the git write queue is closed")

// Queue serializes the git client's writes, one repository at a time.
//
// A repository is its common directory, not a working tree: every
// worktree of a repository shares its refs, packed-refs and stash, so a commit
// in one tree and a branch rename in another collide just as two commits in the
// same tree would. Index-only writes could run per tree, but one turn per
// repository is simpler and the writes are short. Writes to different
// repositories run at once, and reads never queue at all — they take no locks.
//
// Turns are granted first come, first served. A waiter that gives up before
// its turn comes is removed without ever running.
//
// The state is owned by one goroutine and reached through cmds.
type Queue struct {
	cmds      chan func()
	done      chan struct{}
	closeOnce sync.Once

	// Owned by the run goroutine.
	lanes  map[string]*lane
	closed bool
}

// lane is one repository's turn: whether it is taken, and who is waiting.
type lane struct {
	waiters []*waiter
}

// waiter is one Wait not yet answered. grant receives true for the turn or
// false for a closed queue, exactly once.
type waiter struct {
	grant   chan bool
	granted bool
}

// Turn is a repository held for one write. Done hands it on.
type Turn struct {
	q    *Queue
	key  string
	once sync.Once
}

// NewQueue starts an empty queue.
func NewQueue() *Queue {
	q := &Queue{cmds: make(chan func()), done: make(chan struct{}), lanes: map[string]*lane{}}
	go q.run()
	return q
}

func (q *Queue) run() {
	for {
		select {
		case fn := <-q.cmds:
			fn()
		case <-q.done:
			return
		}
	}
}

// do runs fn on the queue's goroutine and waits for it; false when the queue
// is closed and fn never ran.
func (q *Queue) do(fn func()) bool {
	ran := make(chan struct{})
	select {
	case q.cmds <- func() { fn(); close(ran) }:
		<-ran
		return true
	case <-q.done:
		return false
	}
}

// Wait returns once every turn asked of key before this one has been done, or
// with ctx's error if ctx ends first, or ErrClosed.
func (q *Queue) Wait(ctx context.Context, key string) (*Turn, error) {
	w := &waiter{grant: make(chan bool, 1)}
	if !q.do(func() { q.enqueue(key, w) }) {
		return nil, ErrClosed
	}
	select {
	case ok := <-w.grant:
		if !ok {
			return nil, ErrClosed
		}
		return &Turn{q: q, key: key}, nil
	case <-ctx.Done():
		q.do(func() { q.withdraw(key, w) })
		return nil, ctx.Err()
	}
}

// Done hands the repository to the next waiter. Calling it again, or after
// the queue has closed, does nothing.
func (t *Turn) Done() {
	t.once.Do(func() { t.q.do(func() { t.q.release(t.key) }) })
}

// Close refuses every waiter and every later Wait. Turns already granted run
// to their end; their Done does nothing.
func (q *Queue) Close() {
	q.closeOnce.Do(func() {
		q.do(func() {
			q.closed = true
			for key, l := range q.lanes {
				for _, w := range l.waiters {
					w.grant <- false
				}
				delete(q.lanes, key)
			}
		})
		close(q.done)
	})
}

// enqueue grants the turn at once to a repository nobody holds, or puts the
// waiter at the back of its line.
func (q *Queue) enqueue(key string, w *waiter) {
	if q.closed {
		w.grant <- false
		return
	}
	l, held := q.lanes[key]
	if !held {
		q.lanes[key] = &lane{}
		w.granted = true
		w.grant <- true
		return
	}
	l.waiters = append(l.waiters, w)
}

// withdraw removes a waiter that gave up. One whose turn was granted in the
// moment it gave up has the turn handed straight on.
func (q *Queue) withdraw(key string, w *waiter) {
	if w.granted {
		q.release(key)
		return
	}
	if l := q.lanes[key]; l != nil {
		for i, queued := range l.waiters {
			if queued == w {
				l.waiters = append(l.waiters[:i], l.waiters[i+1:]...)
				return
			}
		}
	}
}

// release hands key's turn to the first waiter, or frees the repository.
func (q *Queue) release(key string) {
	l := q.lanes[key]
	if l == nil {
		return
	}
	if len(l.waiters) == 0 {
		delete(q.lanes, key)
		return
	}
	next := l.waiters[0]
	l.waiters = l.waiters[1:]
	next.granted = true
	next.grant <- true
}
