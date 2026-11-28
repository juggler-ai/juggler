//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"strings"

	"juggler/cmd/juggler/machineserver"
	"juggler/cmd/juggler/msg"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Quitting the app lets this machine's server go, which stops its sessions —
// any turn running in them, and any background task (bash run_in_background,
// Monitor) they are running — when a client started it on demand and no other
// client holds it. A server run in a terminal, or held by one, outlives the
// app, and a session with no viewer runs its turns to the end there, so a quit
// stops nothing on it. Closing a window stops nothing either: a session lives
// while it has viewers or a running turn. (A browser tab is different — it is
// never the server's client — so this guard lives only in the desktop app.)
// Before a quit, an update restart or a relaunch we ask the server what
// letting it go would stop and, if anything, confirm the discard with the user,
// naming each background task and the project it runs in — one native question
// for all three (decideStopping), in the words the machine server's own
// relaunch asks in (machineserver.BusyWork.Prompt).
//
// The server is the source of truth: its status says whether it outlives the
// app, and its sessions list which sessions are running a turn and which held
// background tasks each runs (whatAQuitStops), so we read them on demand
// rather than caching state app-side. A turn merely parked on a pending tool approval is NOT
// counted — it survives a restart intact, so quitting then is fine and must not
// warn — and nor is a viewed background task (ops.LifetimeViewed), which is
// there for a view and holds nothing up. Fail-open — if the server can't be
// reached there is nothing running to lose, so the quit proceeds.

// shouldQuitLater is the application's ShouldQuitLater hook, which every
// request to quit reaches: Cmd+Q, the Quit menu, and on macOS a quit the
// system sends at logout, restart or shut down. An already-authorised quit is
// granted at once. Any other is held open while confirmThenQuit decides it on
// a background goroutine — which a logout waits for, where a refusal would
// cancel it — and granted by the app.Quit that ends an authorised one (App.Quit
// decides a held-open request yes), or refused.
func (a *appState) shouldQuitLater(decide func(quit bool)) {
	var quitting bool
	a.reg(func(st *regState) { quitting = st.quitting })
	if quitting {
		decide(true)
		return
	}
	go func() {
		if !a.confirmThenQuit() {
			decide(false)
		}
	}()
}

// confirmThenQuit decides a quit, off the main thread (decideStopping); on
// approval it authorises the quit and issues it, and reports true. A quit asked
// for while a decision is up — another Cmd+Q, the page's Exit — is that same
// quit, and does nothing more; it reports false.
func (a *appState) confirmThenQuit() bool {
	_, went := a.decideStopping(nil, quitAction, func() {
		a.reg(func(st *regState) { st.quitting = true })
		a.notifyAllWindowsCloseRequested()
		application.InvokeAsync(func() { a.app.Quit() })
	})
	return went
}

// decideStopping decides an action that lets the server go: it tallies what that
// would stop, from one sessions list, and, if anything, asks the user — as a
// sheet on parent, or app-modal when parent is nil — then, unless they keep
// working, runs proceed, which authorises the action. A quit already authorised
// has been agreed to, so proceed runs unasked.
//
// One decision at a time (regState.confirmingQuit), held through proceed so
// that a quit asked for once proceed has authorised one is granted, never asked
// again: asked while another is up, it reports claimed false and does nothing.
// went reports whether proceed ran.
func (a *appState) decideStopping(parent application.Window, action stoppingAction, proceed func()) (claimed, went bool) {
	agreed := false
	a.reg(func(st *regState) {
		if !st.confirmingQuit {
			st.confirmingQuit, claimed = true, true
			agreed = st.quitting
		}
	})
	if !claimed {
		return false, false
	}
	defer a.reg(func(st *regState) { st.confirmingQuit = false })
	if !agreed {
		if stops := a.whatAQuitStops(); !stops.Quiet() && !confirmStopsDiscard(a, parent, action, stops) {
			return true, false // user chose to keep working
		}
	}
	proceed()
	return true, true
}

// confirmStopsDiscard asks the user whether to go ahead with action though it
// stops the turns and background tasks in stops, and blocks until they answer.
// A variable so a test can answer it without a native dialog.
var confirmStopsDiscard = func(a *appState, parent application.Window, action stoppingAction, stops machineserver.BusyWork) bool {
	return a.confirmDiscard(parent, action.title, stops.Prompt(action.kind), action.confirm)
}

// dialogParent is the native window a question about e's request is a sheet
// on: e's own, or none — app-modal — for a request with no window.
func dialogParent(e *winEntry) application.Window {
	if e == nil || e.win == nil {
		return nil
	}
	return e.win
}

// wmEndSession is Windows' WM_ENDSESSION: the user is signing out or shutting
// down (wParam non-zero), or something cancelled a shutdown that had been asked
// about (wParam zero).
const wmEndSession = 0x0016

// interceptWndProc sees every Windows message to the app's windows before
// Wails does (the WndProcInterceptor option). Wails quits on any WM_ENDSESSION
// to its hidden window, whether or not the session is really ending. A
// cancelled one is kept from it. An ending one authorises the quit, which the
// busy guard would otherwise veto and hand to a confirmation that Windows kills
// unanswered — skipping the shutdown that records the whole window set. There
// is nothing to ask at that point: the session ends whatever is running.
func (a *appState) interceptWndProc(_ uintptr, msg uint32, wParam, _ uintptr) (uintptr, bool) {
	if msg != wmEndSession {
		return 0, false
	}
	if wParam == 0 {
		return 0, true
	}
	a.reg(func(st *regState) { st.quitting = true })
	return 0, false
}

// stoppingAction is one thing the app does that lets the server go, with the
// words of the question it asks first when that would stop work: the title, the
// button that goes ahead, and the kind of body (machineserver.BusyWork.Prompt).
type stoppingAction struct {
	kind           machineserver.StoppingAction
	title, confirm msg.Message
}

var (
	quitAction     = stoppingAction{machineserver.StopByQuitting, msg.New("Quit Juggler?"), msg.New("Quit anyway")}
	restartAction  = stoppingAction{machineserver.StopByRestartingToUpdate, msg.New("Restart to update?"), msg.New("Restart anyway")}
	relaunchAction = stoppingAction{machineserver.StopByRelaunching, msg.New("Relaunch Juggler?"), msg.New("Relaunch anyway")}

	keepWorkingLabel = msg.New("Keep working")
)

// confirmDiscard shows a modal question dialog and blocks (on its own goroutine)
// until the user answers. The safe choice ("Keep working") is both the default
// and the cancel action, so an accidental Return or Escape never discards work.
// parent attaches the dialog as a sheet on that window; nil makes it app-modal,
// as the app-wide quit prompt is.
func (a *appState) confirmDiscard(parent application.Window, title, message, confirmLabel msg.Message) bool {
	result := make(chan bool, 1)
	// A body naming no task ends in the blank lines its list would have filled.
	dialog := a.app.Dialog.Question().SetTitle(a.tr(title)).SetMessage(strings.TrimSpace(a.tr(message)))
	if parent != nil {
		dialog.AttachToWindow(parent)
	}
	dialog.AddButton(a.tr(confirmLabel)).OnClick(func() { result <- true })
	stay := dialog.AddButton(a.tr(keepWorkingLabel))
	stay.OnClick(func() { result <- false })
	dialog.SetDefaultButton(stay)
	dialog.SetCancelButton(stay)
	dialog.Show()
	return <-result
}
