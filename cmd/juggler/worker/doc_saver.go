//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"sync/atomic"
	"time"
)

// docSaver decides when the document is written: it debounces a burst of
// changes into one save, and carries a forced save to the run loop. It holds
// three things:
//
//   - The unsaved bit, which any goroutine may raise and a successful write
//     clears.
//   - The debounce timer, and the two hand-offs around it: a change asking the
//     loop to re-arm it, and the timer telling the loop it fired.
//   - The flush queue, a synchronous save request with a reply channel.
//
// The write itself, and what a save sweeps afterwards, are the worker's (see
// persistence.go); this type touches neither the document nor the disk. Every
// field is read and written only by the methods in this file
// (TestWorkerSeamsOwnTheirState).
type docSaver struct {
	// unsaved is true when the doc has changes since the last successful save.
	// Atomic because the Yjs sync callback raises it on whichever goroutine did
	// the Transact().
	unsaved atomic.Bool
	// debounceTimer is touched ONLY on the run() goroutine (see rearm). The
	// change path cannot re-arm it directly: the Yjs sync callback runs on
	// whichever goroutine did the Transact(), and a turn goroutine writing the
	// document makes that genuinely concurrent with run(). So noteChange posts
	// to rearmQueue and the run loop owns the timer.
	debounceTimer *time.Timer
	// rearmQueue carries "the document changed, re-arm the debounce" from any
	// goroutine to the run loop. Buffered by one and sent to non-blockingly: a
	// burst coalesces into a single re-arm, which is what a debounce wants
	// anyway.
	rearmQueue chan struct{}
	// fireQueue is where the timer's goroutine says the debounce has elapsed;
	// the run loop does the actual save. Buffered by one, sent to
	// non-blockingly: a save already pending covers a second firing.
	fireQueue chan struct{}
	// flushQueue lets tests (or shutdown) force a save synchronously without
	// waiting on the SaveDebounceTime timer. Each request carries a reply chan
	// that the run loop signals after the save completes.
	flushQueue chan chan error
}

// newDocSaver builds a saver with nothing pending.
func newDocSaver() docSaver {
	return docSaver{
		rearmQueue: make(chan struct{}, 1),
		fireQueue:  make(chan struct{}, 1),
		flushQueue: make(chan chan error, 4),
	}
}

// noteChange marks the document unsaved and asks the run loop to re-arm the
// debounce. Callable from ANY goroutine: it touches nothing but an atomic and a
// buffered channel.
func (s *docSaver) noteChange() {
	s.unsaved.Store(true)
	select {
	case s.rearmQueue <- struct{}{}:
	default: // a re-arm is already queued — the debounce is about to be reset anyway
	}
}

// isUnsaved reports whether the document has changes no save has written.
func (s *docSaver) isUnsaved() bool { return s.unsaved.Load() }

// markSaved records a successful write.
func (s *docSaver) markSaved() { s.unsaved.Store(false) }

// rearmRequests is where the run loop hears noteChange.
func (s *docSaver) rearmRequests() <-chan struct{} { return s.rearmQueue }

// rearm (re)starts the debounce timer. Run goroutine only — it is the sole
// writer of debounceTimer.
func (s *docSaver) rearm() {
	if s.debounceTimer != nil {
		s.debounceTimer.Stop()
	}
	s.debounceTimer = time.AfterFunc(SaveDebounceTime, func() {
		// Signal the run loop to save — never save from the timer goroutine, as
		// that races with the run loop accessing the doc.
		select {
		case s.fireQueue <- struct{}{}:
		default: // save already pending
		}
	})
}

// fired is where the run loop hears the debounce elapse.
func (s *docSaver) fired() <-chan struct{} { return s.fireQueue }

// holdDebounce stops a pending debounce from firing, for a save the caller is
// about to make itself. A firing already posted to fired() still arrives.
func (s *docSaver) holdDebounce() {
	if s.debounceTimer != nil {
		s.debounceTimer.Stop()
	}
}

// cancel stops the debounce for good and drops a firing already posted, which
// is what shutdown wants before its own final write.
func (s *docSaver) cancel() {
	if s.debounceTimer != nil {
		s.debounceTimer.Stop()
		s.debounceTimer = nil
	}
	select {
	case <-s.fireQueue:
	default:
	}
}

// flushRequests is where the run loop hears a forced save.
func (s *docSaver) flushRequests() <-chan chan error { return s.flushQueue }

// postFlush is where a caller sends a forced save, with the channel the run
// loop answers on.
func (s *docSaver) postFlush() chan<- chan error { return s.flushQueue }
