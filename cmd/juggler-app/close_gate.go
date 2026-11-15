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
// no work to confirm discarding — except the close of the last main window,
// which quits the app (handleWindowClosed) and so first asks what a quit asks
// (confirmCloseEndingTheApp).
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
// longer in the registry, which has nothing left to settle, and one whose page
// cannot answer (cannotAnswerFlush).
func (a *appState) closeReady(e *winEntry) bool {
	ready := false
	a.reg(func(st *regState) {
		w := st.windows[e.id]
		ready = st.quitting || w == nil || cannotAnswerFlush(w)
	})
	return ready
}

// cannotAnswerFlush reports whether w's page would never answer a flush, so
// announcing one would only spend the whole closeFlushTimeout: a window already
// settled (by the gate, or by a foreign page's fallback bar), or one showing a
// stand-in, whose static page has no drafts and no listener. Must run on the
// registry goroutine, inside a reg op.
func cannotAnswerFlush(w *winEntry) bool {
	return w.settled || w.view.standIn != nil
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

// closeEndsTheApp reports whether closing e quits the app: it is the last main
// window. Boards are not counted — each closes with the window that opened it —
// and a board's own close never ends the app while its opener is open.
func (a *appState) closeEndsTheApp(e *winEntry) bool {
	ends := false
	a.reg(func(st *regState) {
		if e.board != "" {
			return
		}
		for _, w := range st.windows {
			if w != e && w.board == "" {
				return
			}
		}
		ends = true
	})
	return ends
}

// confirmCloseEndingTheApp asks, for a close that quits the app, what a quit
// asks (confirmThenQuit): whether to stop the turns and background tasks
// letting the server go would stop. It reports whether the close goes ahead.
// Kept working, the window stays, and gives up its claim on the gate so a later
// close asks again. Runs on the gate's goroutine, which holds that claim.
func (a *appState) confirmCloseEndingTheApp(e *winEntry) bool {
	if !a.closeEndsTheApp(e) {
		return true
	}
	if stops := a.whatAQuitStops(); !stops.any() || confirmQuitDiscard(a, stops) {
		return true
	}
	a.reg(func(st *regState) {
		if w := st.windows[e.id]; w != nil {
			w.settling = false
		}
	})
	return false
}

// settleThenClose runs the gate off the main thread after a close was
// cancelled, then re-issues that close — unless the close would quit the app
// and the user, asked, keeps working.
func (a *appState) settleThenClose(e *winEntry) {
	if !a.confirmCloseEndingTheApp(e) {
		return
	}
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
