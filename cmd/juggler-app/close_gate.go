//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"time"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// The close gate is what a window close must settle while its page is still
// there to answer: giving the page its chance to rescue composer drafts and
// report them safely on disk. A close stops nothing on the server, so there is
// no work to confirm discarding.
//
// It needs a live webview, and by the time a WindowClosing *listener* runs
// there is no longer one. Wails registers its own WindowClosing listener as the
// window is built, ahead of any of ours, and that listener marks the window
// destroyed and closes the webview immediately. Listeners for one event all run
// concurrently, so anything ours schedules onto the main thread arrives after
// that destroy — and ExecJS discards work aimed at a destroyed window silently,
// with no error to notice.
//
// Hooks are the seam that still has a page. They run synchronously, ahead of
// every listener, and one that cancels the event stops the listeners from
// running at all. So the gate cancels the close, settles on its own goroutine
// against a live page, and re-issues Close() — which finds the gate satisfied
// and falls through to the teardown in handleWindowClosed.

// closeReady reports whether a WindowClosing for e may proceed to teardown.
//
// A quit is exempt: confirmThenQuit notifies every window together before
// quitting, so gating each window again would only repeat it. So is a window no
// longer in the registry, which has nothing left to settle.
func (a *appState) closeReady(e *winEntry) bool {
	ready := false
	a.reg(func(st *regState) {
		w := st.windows[e.id]
		ready = st.quitting || w == nil || w.settled
	})
	return ready
}

// claimSettle gives exactly one goroutine the right to run the gate for e,
// reporting whether this one won it. The window stays clickable while the gate
// runs, so a second close arriving meanwhile is cancelled by the hook and
// dropped here — rather than announcing a second handshake that would orphan
// the first.
func (a *appState) claimSettle(e *winEntry) bool {
	first := false
	a.reg(func(st *regState) {
		w := st.windows[e.id]
		if w == nil || w.settling {
			return
		}
		w.settling = true
		first = true
	})
	return first
}

// settleThenClose runs the gate off the main thread after a close was
// cancelled, then re-issues that close.
func (a *appState) settleThenClose(e *winEntry) {
	// The page is live here, which is the whole reason the gate exists. A window
	// with nothing to rescue answers in a few milliseconds; the deadline is for
	// one that cannot answer at all.
	a.awaitFlush(e.id, a.notifyWindowCloseRequested(e), time.Now().Add(closeFlushTimeout))
	a.reg(func(st *regState) {
		if w := st.windows[e.id]; w != nil {
			w.settled = true
		}
	})
	application.InvokeAsync(func() { e.win.Close() })
}
