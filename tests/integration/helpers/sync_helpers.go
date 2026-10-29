//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package helpers

import (
	"fmt"
	"testing"
	"time"

	"juggler/cmd/juggler/worker"
)

// ReadyTimeout is how long a test waits for a worker's "ready" reply after
// sending it an init.
//
// It is deliberately far longer than an init takes. Init is queued through the
// manager's actor, run on the worker's own goroutine and delivered through a
// client mailbox, and along the way it reads and writes the conversation from
// disk and takes the process-wide y-crdt lock that every other worker in the
// binary shares. This package's parallel tests all resume together the moment
// the serial ones finish, so dozens of inits contend for that lock at once and
// how long any one of them takes is a scheduling question, not a latency one.
// A ready that arrives costs nothing to have waited for; a ready that never
// arrives is a hang, and this deadline only has to name it.
const ReadyTimeout = 30 * time.Second

// WaitForReady blocks until ready is signalled — the channel an init's
// send-callback pushes to when it sees the worker's "ready" reply.
func WaitForReady(t *testing.T, ready <-chan struct{}) error {
	t.Helper()

	select {
	case <-ready:
		return nil
	case <-time.After(ReadyTimeout):
		return fmt.Errorf("timeout waiting for ready message after %v", ReadyTimeout)
	}
}

// WaitForDocumentCondition polls the document until the condition returns true or timeout.
// Uses exponential backoff (10ms -> 100ms) for efficient polling.
func WaitForDocumentCondition(
	t *testing.T,
	w *worker.ConversationWorker,
	timeout time.Duration,
	condition func(*worker.ConversationDocument) bool,
) error {
	t.Helper()

	deadline := time.Now().Add(timeout)
	backoff := 10 * time.Millisecond
	maxBackoff := 100 * time.Millisecond

	for time.Now().Before(deadline) {
		doc := w.Document()
		if doc != nil && condition(doc) {
			return nil
		}

		time.Sleep(backoff)
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}

	return fmt.Errorf("timeout waiting for document condition after %v", timeout)
}

// WaitForItemCount waits for the items array to reach the specified length.
func WaitForItemCount(t *testing.T, w *worker.ConversationWorker, count int, timeout time.Duration) error {
	t.Helper()

	return WaitForDocumentCondition(t, w, timeout, func(doc *worker.ConversationDocument) bool {
		items := doc.GetItems()
		return len(items) == count
	})
}

// WaitForMetadata waits for a metadata key to have the specified value.
func WaitForMetadata(
	t *testing.T,
	w *worker.ConversationWorker,
	key string,
	expectedValue any,
	timeout time.Duration,
) error {
	t.Helper()

	return WaitForDocumentCondition(t, w, timeout, func(doc *worker.ConversationDocument) bool {
		actualValue := doc.GetMetadata(key)
		if actualValue == nil {
			return false
		}
		return fmt.Sprintf("%v", actualValue) == fmt.Sprintf("%v", expectedValue)
	})
}

// WaitForWorkerState waits for the worker to reach the specified state.
// Uses exponential backoff (10ms -> 100ms) for efficient polling.
func WaitForWorkerState(t *testing.T, w *worker.ConversationWorker, state worker.WorkerState, timeout time.Duration) error {
	t.Helper()

	deadline := time.Now().Add(timeout)
	backoff := 10 * time.Millisecond
	maxBackoff := 100 * time.Millisecond

	for time.Now().Before(deadline) {
		if w.State() == state {
			return nil
		}

		time.Sleep(backoff)
		backoff *= 2
		if backoff > maxBackoff {
			backoff = maxBackoff
		}
	}

	return fmt.Errorf("timeout waiting for worker state %q (current: %q) after %v", state, w.State(), timeout)
}
