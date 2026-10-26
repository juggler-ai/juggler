//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Process-wide throttle on concurrently-streaming claude CLI turns.
//
// One Client (and one persistent CLI) exists per conversation, so without a
// shared cap a fan-out of N subthreads spawns N CLIs whose first turns all hit
// the account's API at once. That synchronized burst is the most likely
// trigger for the "exited unexpectedly" failure: the concurrent streams
// momentarily exceed the account's concurrency / usage limits and the CLIs are
// killed. cliTurnSlots bounds how many turns may ACTIVELY STREAM at the same
// time; the rest queue (with backpressure, never failure).
//
// Deadlock-freedom — the key property the cap must not break:
//
//   - A slot is held ONLY while a turn is actively streaming (the body of
//     streamMessage). The instant a turn pauses for tool approval it returns
//     from streamMessage and releases its slot. A turn that spawned subthreads
//     and is "waiting" for them has therefore already released — it is parked
//     at a tool_use boundary, holding NO slot. So a parent can never hold a
//     slot a child needs: the parent→child wait does not pass through the
//     semaphore.
//   - A slot holder only ever blocks on its own CLI's stdout (or ctx), never
//     on another conversation making progress. So no slot holder waits on a
//     slot seeker, the wait graph has no cycle, and the cap cannot deadlock.
//     That holds because a turn takes its session's ownership token BEFORE a
//     slot: a turn queued behind another on the same session waits holding
//     nothing, so however long the turn ahead of it runs, it cannot drain the
//     pool for every other conversation.
//   - acquire is ctx-aware: a turn cancelled while queued for a slot bails
//     immediately rather than hanging, so even a misconfigured cap of 1 can't
//     wedge a cancellable turn.

package claudecode

import (
	"context"
	"os"
	"strconv"
)

// defaultCLIMaxConcurrency is the default ceiling on simultaneously-streaming
// CLI turns. Chosen to permit real subthread parallelism while staying well
// under the burst that trips account limits. Override with the
// JUGGLER_CLAUDECODE_MAX_CONCURRENCY env var.
const defaultCLIMaxConcurrency = 4

// cliTurnSlots is the single process-wide turn throttle (one logical instance
// app-wide → a package singleton, discovered by import). Tests swap it via a
// helper to exercise a specific capacity.
var cliTurnSlots = newTurnSemaphore(resolveCLIMaxConcurrency(os.Getenv("JUGGLER_CLAUDECODE_MAX_CONCURRENCY")))

// resolveCLIMaxConcurrency parses the env override, falling back to the
// default for an empty / unparseable / non-positive value. Pure for testing.
func resolveCLIMaxConcurrency(env string) int {
	if env != "" {
		if n, err := strconv.Atoi(env); err == nil && n >= 1 {
			return n
		}
	}
	return defaultCLIMaxConcurrency
}

// turnSemaphore is a counting semaphore built on a buffered channel (channels,
// not mutexes — see the Concurrency note in CLAUDE.md). A token in the buffer
// is one in-flight streaming turn.
type turnSemaphore struct {
	slots chan struct{}
}

func newTurnSemaphore(n int) *turnSemaphore {
	if n < 1 {
		n = 1
	}
	return &turnSemaphore{slots: make(chan struct{}, n)}
}

// acquire blocks until a slot is free or ctx is done. On success it returns a
// release func that frees the slot; release is safe to call exactly once from
// the acquiring goroutine (idempotent against an accidental second call). On
// ctx cancellation it returns ctx.Err() and no slot is held.
func (s *turnSemaphore) acquire(ctx context.Context) (release func(), err error) {
	select {
	case s.slots <- struct{}{}:
		released := false
		return func() {
			// Single-goroutine release: the guard only protects against an
			// accidental double-call in sequence, never concurrent callers.
			if released {
				return
			}
			released = true
			<-s.slots
		}, nil
	case <-ctx.Done():
		return nil, ctx.Err()
	}
}

// inFlight reports how many slots are currently held. Used by tests to assert
// that a paused/parked turn holds none.
func (s *turnSemaphore) inFlight() int { return len(s.slots) }
