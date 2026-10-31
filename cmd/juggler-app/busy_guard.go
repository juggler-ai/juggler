//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"juggler/cmd/juggler/msg"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Quitting the app lets this machine's server go, which stops its sessions and
// any turn running in them when a client started it on demand and no other
// client holds it. A server run in a terminal, or held by one, outlives the
// app, and a session with no viewer runs its turns to the end there, so a quit
// stops nothing on it. Closing a window stops nothing either: a session lives
// while it has viewers or a running turn. (A browser tab is different — it is
// never the server's client — so this guard lives only in the desktop app.)
// Before a quit or an update restart we ask the server which sessions running
// a turn letting it go would stop and, if any, confirm the discard with the
// user.
//
// The server is the source of truth: its status says whether it outlives the
// app, and its sessions list which sessions are running a turn
// (sessionsAQuitStops), so we read them on demand rather than caching state
// app-side. A turn merely parked on a pending tool approval is NOT
// counted — it survives a restart intact, so quitting then is fine and must not
// warn. Fail-open — if the server can't be reached there is nothing running to
// lose, so the quit proceeds.

// shouldQuit is the application ShouldQuit hook (Cmd+Q / Quit menu). It must
// answer synchronously, so it allows an already-authorised quit and otherwise
// vetoes, handing the real decision to confirmThenQuit on a background goroutine.
func (a *appState) shouldQuit() bool {
	var quitting bool
	a.reg(func(st *regState) { quitting = st.quitting })
	if quitting {
		return true
	}
	go a.confirmThenQuit()
	return false
}

// confirmThenQuit runs off the main thread after a quit was vetoed. It tallies
// the sessions running a turn, from one sessions list, and, if any are,
// confirms the discard; on approval it authorises the quit and re-issues it.
// One runs at a time (regState.confirmingQuit): a quit asked for while one is
// deciding — another Cmd+Q, the page's Exit — is that same quit, and does
// nothing more.
func (a *appState) confirmThenQuit() {
	claimed := false
	a.reg(func(st *regState) {
		if !st.confirmingQuit {
			st.confirmingQuit, claimed = true, true
		}
	})
	if !claimed {
		return
	}
	defer a.reg(func(st *regState) { st.confirmingQuit = false })
	if total := a.sessionsAQuitStops(); total > 0 {
		if !confirmQuitDiscard(a, total) {
			return // user chose to keep working
		}
	}
	a.reg(func(st *regState) { st.quitting = true })
	a.notifyAllWindowsCloseRequested()
	application.InvokeAsync(func() { a.app.Quit() })
}

// confirmQuitDiscard asks the user whether to quit with busy sessions running
// a turn, and blocks until they answer. A variable so a test can answer it
// without a native dialog.
var confirmQuitDiscard = func(a *appState, busy int) bool {
	return a.confirmDiscard(nil, quitDialogTitle, quitBusyMessage(busy), quitDialogConfirm)
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

// The busy prompts' wording. Each action that discards running work has its own
// whole sentences, so a translation never has to fit an action word into a
// sentence built around it.
var (
	quitDialogTitle   = msg.New("Quit Juggler?")
	quitDialogConfirm = msg.New("Quit anyway")
	keepWorkingLabel  = msg.New("Keep working")
)

// quitBusyMessage is the quit prompt's body for n in-flight conversations.
func quitBusyMessage(n int) msg.Message {
	return msg.New("{n, plural, one {A conversation is still working. Quitting will stop and discard it.} other {# conversations are still working. Quitting will stop and discard them.}}", "n", n)
}

// restartBusyMessage is the update-restart prompt's body for n in-flight
// conversations; the page shows it (handleUpdaterRestart).
func restartBusyMessage(n int) msg.Message {
	return msg.New("{n, plural, one {A conversation is still working. Restarting to update will stop and discard it.} other {# conversations are still working. Restarting to update will stop and discard them.}}", "n", n)
}

// confirmDiscard shows a modal question dialog and blocks (on its own goroutine)
// until the user answers. The safe choice ("Keep working") is both the default
// and the cancel action, so an accidental Return or Escape never discards work.
// parent attaches the dialog as a sheet on that window; nil makes it app-modal,
// as the app-wide quit prompt is.
func (a *appState) confirmDiscard(parent application.Window, title, message, confirmLabel msg.Message) bool {
	result := make(chan bool, 1)
	dialog := a.app.Dialog.Question().SetTitle(a.tr(title)).SetMessage(a.tr(message))
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
