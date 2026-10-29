//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"testing"
	"time"
)

// A held send that fires is the user's send, made at the moment it fires: it
// does to the thread whatever an explicit send into an idle thread does then —
// lifts the pause standing over it and the usage cap on its provider, names a
// new conversation — or the message it queued lands and nobody answers it.

// fireAt moves the clock to at and runs the held-send timer's case, then lets
// the worker settle.
func fireAt(t *testing.T, w *ConversationWorker, fc *fakeClock, at time.Time) {
	t.Helper()
	fc.set(at)
	w.currentRun().fireHeldSends()
	w.quiesce(t)
}
