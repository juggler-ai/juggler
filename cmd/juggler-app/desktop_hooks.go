//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"errors"
	"runtime"

	"juggler/cmd/juggler/msg"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Build-injection seams for the desktop app.
//
// These are the extension points a packaged build can attach behaviour to
// without the stock source carrying the implementation. The stock build leaves
// them at the inert defaults below — it builds and runs exactly as written. A
// packaged build may compile extra files into this package (`go build
// -overlay`, passed through APP_GOFLAGS in the Makefile) that reassign them
// from an init(), so the added behaviour is compiled in for that build alone and
// the stock source stays free of it. Keeping the seams as swappable vars is what
// makes the source carry the call sites but none of the injected code.
//
// This file is the whole surface such files are written against: the seams,
// desktopHost, appMenuItem, UpdaterSnapshot, and the package logger logf. The
// rest of the package (the window registry, the menu builder, appState itself)
// is free to change under them.

// desktopHost is the running app as afterAppInit hands it to injected code.
type desktopHost struct {
	// app is the live Wails App: its Updater, Event bus and Quit.
	app *application.App
	// broadcastJS runs script in every open window's page, on the main thread.
	// Nothing about the script is escaped; the caller builds a safe one.
	broadcastJS func(script string)
}

// host is the desktopHost for a, once a.app is live.
func (a *appState) host() desktopHost {
	return desktopHost{app: a.app, broadcastJS: a.execJSInAllWindows}
}

// execJSInAllWindows runs script in the page of every open window.
func (a *appState) execJSInAllWindows(script string) {
	var wins []*application.WebviewWindow
	a.reg(func(st *regState) {
		for _, e := range st.windows {
			if e.win != nil {
				wins = append(wins, e.win)
			}
		}
	})
	for _, win := range wins {
		application.InvokeAsync(func() { win.ExecJS(script) })
	}
}

// afterAppInit runs once, immediately after the Wails App is constructed and
// before the menu is built, from initApplication. Default: no-op.
var afterAppInit = func(desktopHost) {}

// singleInstanceKey names the single-instance lock this launch takes. A build
// may give a launch a lock of its own, so it runs beside the app rather than
// handing its argv to it. It is asked before afterAppInit, from
// initApplication, so it must be filled at package initialization. Default:
// singleInstanceID.
var singleInstanceKey = func() string { return singleInstanceID }

// appMenuItem is an entry a build adds to the application menu, right after
// About. Its label is rendered in the UI language and relabelled with it.
type appMenuItem struct {
	label   msg.Message
	onClick func()
}

// appMenuItems returns the entries to add to the application menu. It is asked
// once, after afterAppInit, when the menu is built. Default: none.
var appMenuItems = func() []appMenuItem { return nil }

// buildAppMenu installs the application menu onto the root menu, from
// installAppMenu: appMenuNode, with appMenuItems after About.
//
// Like Wails' AppMenu role, it is macOS-only: nothing else shows an application
// menu (Linux is suppressed a caller up, and the frameless Windows window
// displays no menu bar at all).
func buildAppMenu(a *appState, menu *application.Menu) {
	if runtime.GOOS != "darwin" {
		return
	}
	var extra []menuNode
	for _, it := range appMenuItems() {
		onClick := it.onClick
		extra = append(extra, menuNode{label: it.label, onClick: func(*application.Context) {
			if onClick != nil {
				onClick()
			}
		}})
	}
	a.addMenuNode(menu, appMenuNode(a, extra...))
}

// UpdaterSnapshot is the in-app updater's current state, marshalled to the page
// (over the loopback control endpoint and pushed via broadcastJS). Present=false
// means this build has no in-app updater — a from-source, free, or non-macOS
// build — in which case the page relies on the server-side version notice alone
// (see cmd/juggler/server/update_status.go). The overlay that fills these seams
// keeps the struct up to date from the updater's own events.
type UpdaterSnapshot struct {
	Present    bool   `json:"present"`
	State      string `json:"state"`                // updater.State value, e.g. "downloading"
	Version    string `json:"version,omitempty"`    // target release version
	AppVersion string `json:"appVersion,omitempty"` // this app bundle's core.Version (for skew detection vs the viewed server)
	Written    int64  `json:"written,omitempty"`
	Total      int64  `json:"total,omitempty"`
	Error      string `json:"error,omitempty"`
	// ErrorMessage is Error as a message, for the page to show in its own
	// language, when the failure has one; Error stays the English.
	ErrorMessage *msg.Message `json:"errorMessage,omitempty"`
	// ErrorStage is which phase produced Error ("check", "download", "verify",
	// "install", "restart"). The page leads with it so a check that couldn't
	// reach the server doesn't claim an update failed — nothing was being
	// updated.
	ErrorStage string `json:"errorStage,omitempty"`
	// DownloadURL is where the release can be downloaded and installed by hand.
	// A failure leads with it: it is the way out that does not depend on the
	// updater working.
	DownloadURL string `json:"downloadURL,omitempty"`
	// OpenDialog asks the page to open the update dialog on this snapshot,
	// because the app has something to tell the user they did not ask about —
	// such as an update that never finished installing.
	OpenDialog bool `json:"openDialog,omitempty"`
	// Cancelling is set while a cancelled update finishes a step that can't be
	// interrupted, after which what it staged is discarded.
	Cancelling bool `json:"cancelling,omitempty"`
}

// updaterSnapshot returns the current updater state. Default: not present, so a
// stock build reports "no in-app updater" and the page hides all progress UI.
var updaterSnapshot = func() UpdaterSnapshot { return UpdaterSnapshot{Present: false} }

// updaterInstall starts (or no-ops if already running) the download+stage flow.
// The argument is userInitiated: true when a click asked for this, false for the
// page's own proactive kick. A failure the user did not ask for is logged, not
// shown, so an unreachable update server never puts an error in front of someone
// who never asked. Default: no-op — there is nothing to install without an overlay.
var updaterInstall = func(_ bool) {}

// updaterCheck runs a check-only probe: it asks the updater whether a newer
// release exists and pushes the resulting snapshot to the page, but never
// starts a download. It backs the settings tab's "Check for updates" button and
// (in notify/off mode) the macOS menu, where an explicit check must reveal
// availability without triggering an auto-download. Default: no-op.
var updaterCheck = func() {}

// updaterCancel stops an update that is downloading, or discards one that is
// downloaded and waiting for a restart, and the release is offered again. It
// returns an error only when it is too late: the restart into the update has
// begun. Default: nothing to cancel.
var updaterCancel = func() error { return nil }

// updaterRestart relaunches into the staged update. Synchronous; returns an
// error when no update is staged or the swap helper failed to spawn (the
// control handler turns that into a 409/500 and un-authorises the pending quit).
var updaterRestart = func() error { return errors.New("no in-app updater in this build") }
