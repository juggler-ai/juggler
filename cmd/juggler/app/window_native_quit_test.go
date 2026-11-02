//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"sync/atomic"
	"testing"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// A quit reaches a session server from outside it — a logout, a `quit app`,
// or, for a server macOS files under the app that started it (one run from a
// bundle without a bundle of its own for the server), a Quit from a Dock click
// that reached the server instead of the app — as [NSApp terminate:], which
// ends the process without unwinding: the session and any turn running in it
// are gone, with no teardown.
//
// Such a quit must instead run the server's own shutdown, the one a SIGTERM
// gets, and be held open meanwhile — neither granted, which skips the
// teardown, nor refused, which at a logout cancels the logout. The server's own
// native quit at the end of that shutdown is what grants it (a Quit while a
// request is held open decides it yes).
func TestAnOutsideQuitRunsTheServersOwnShutdownFirst(t *testing.T) {
	teardownDone := make(chan struct{})
	var nativeQuit atomic.Bool
	var requested atomic.Int64
	opts := headlessServerAppOptions(serverShouldQuitLater(teardownDone, &nativeQuit, func() { requested.Add(1) }))

	if opts.ShouldQuitLater == nil || opts.ShouldQuit != nil {
		t.Fatal("the headless server does not decide a quit later: a terminate: from outside either skips the teardown or cancels a logout")
	}
	var decisions []bool
	decide := func(quit bool) { decisions = append(decisions, quit) }
	opts.ShouldQuitLater(decide)
	if len(decisions) != 0 {
		t.Errorf("a quit from outside, before the server's teardown has run, was decided %v at once; want it held open", decisions)
	}
	if got := requested.Load(); got != 1 {
		t.Errorf("a quit from outside requested the server's shutdown %d times, want 1", got)
	}

	close(teardownDone)
	opts.ShouldQuitLater(decide)
	if len(decisions) != 1 || !decisions[0] {
		t.Errorf("the native quit after the server's teardown finished was decided %v, want granted at once", decisions)
	}
	if got := requested.Load(); got != 1 {
		t.Errorf("the native quit after teardown requested another shutdown (%d requests, want 1)", got)
	}
}

// TestAQuitAfterAStalledTeardownGoesAhead: a teardown that outlives its budget
// is given up on (awaitTeardown), and the native quit that follows must not be
// held up for want of it.
func TestAQuitAfterAStalledTeardownGoesAhead(t *testing.T) {
	var nativeQuit atomic.Bool
	shouldQuitLater := serverShouldQuitLater(make(chan struct{}), &nativeQuit, func() {})
	nativeQuit.Store(true)
	granted := false
	shouldQuitLater(func(quit bool) { granted = quit })
	if !granted {
		t.Error("the native quit issued after the teardown budget lapsed was not granted")
	}
}

// TestTheServerIsNotNamedAsTheDesktopApp: on Linux the program name is the
// Wayland app_id and X11 WM_CLASS the shell groups windows under, and the
// directory WebKitGTK keeps its persistent storage in. The desktop app is
// "Juggler"; a server sharing the name would be listed as the app and share
// its WebKit store from another process.
func TestTheServerIsNotNamedAsTheDesktopApp(t *testing.T) {
	if got := headlessServerAppOptions(nil).Linux.ProgramName; got == "Juggler" || got == "" {
		t.Errorf("the server's Linux program name is %q: it must be its own, not the desktop app's \"Juggler\" (nor unset, which GTK takes from the executable, \"juggler\")", got)
	}
}

// recordedHooks stands in for the Wails event manager, keeping each hook
// registered on it.
type recordedHooks map[events.ApplicationEventType][]func(*application.ApplicationEvent)

func (r recordedHooks) RegisterApplicationEventHook(t events.ApplicationEventType, hook func(*application.ApplicationEvent)) func() {
	r[t] = append(r[t], hook)
	return func() {}
}

// TestADockClickLeavesTheEngineWindowHidden: Wails answers a Dock click with no
// visible window by showing every hidden one. The server's only window is the
// hidden engine page, so a click that reaches the server shows a small blank
// window and brings the server to the front, menu bar and Quit included. The
// server cancels the event before Wails' handler sees it.
func TestADockClickLeavesTheEngineWindowHidden(t *testing.T) {
	hooks := recordedHooks{}
	declineDockReopen(hooks)

	registered := hooks[events.Mac.ApplicationShouldHandleReopen]
	if len(registered) == 0 {
		t.Fatal("no hook on the Dock's reopen event: Wails shows the hidden engine window")
	}
	ev := &application.ApplicationEvent{}
	for _, hook := range registered {
		hook(ev)
	}
	if !ev.IsCancelled() {
		t.Error("the Dock's reopen event reached Wails' handler, which shows the hidden engine window")
	}
}
