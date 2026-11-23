//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"os"
	"strconv"
	"strings"

	"juggler/cmd/juggler/machineserver"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// Relaunching: this app quits and starts again from the binary now at its path,
// which may be another build than the one running — a rebuild, an installer or
// an update put it there. Nothing is swapped here; whatever replaced the file has
// already done that.
//
// The next launch is started first, with --after naming this process, and
// waits (waitForExit) for this one to exit before it takes the single-instance
// lock, which would otherwise hand its argv to this one and exit. Only then does
// this one quit, so nothing is left to start the next once it has gone.

// relaunchApp starts the next launch of a and quits a; quitInto has authorised
// the quit already. A variable so tests can stand in for a relaunch.
var relaunchApp = (*appState).relaunch

func (a *appState) relaunch() error {
	if _, err := startNextLaunch(); err != nil {
		return err
	}
	application.InvokeAsync(a.app.Quit)
	return nil
}

// relaunchWithServer starts the next launch of a, which follows c's server
// through its relaunch, and quits a. A variable so tests can stand in for it.
var relaunchWithServer = (*appState).relaunchHeldFor

// relaunchHeldFor is relaunch for an app whose server c is relaunching too
// (follow). The relaunched server holds itself up for this app (its handoff)
// only while this app lives, and this app exits before the next launch has
// attached: so it waits for that server to come back — while the old process
// lives or the machine lock is held, as follow does — and has it hold itself
// up for the next launch as well (Client.HoldFor), before quitting. A next
// launch whose process cannot be named (pid 0) is not held for: it finds the
// server if it is still there, and starts one if not.
func (a *appState) relaunchHeldFor(c *machineserver.Client) error {
	next, back := c.AwaitRelaunched(machineserver.ConnectOptions{ConfigDir: a.connectOpts.ConfigDir})
	pid, err := startNextLaunch()
	if err != nil {
		return err
	}
	if back && pid > 0 {
		if err := next.HoldFor(pid); err != nil {
			logf("relaunch: asking %s to hold itself up for the next launch (pid %d): %v", next.Addr(), pid, err)
		}
	}
	application.InvokeAsync(a.app.Quit)
	return nil
}

// startNextLaunch starts the next launch of this app, from the binary now at
// its path, waiting for this one to exit (--after), and returns its pid, or 0
// where the platform does not say.
func startNextLaunch() (int, error) {
	exe, err := os.Executable()
	if err != nil {
		return 0, err
	}
	pid, err := startRelaunch(exe, relaunchArgs(os.Args[1:], os.Getpid()))
	if err != nil {
		return 0, err
	}
	logf("relaunch: started %s (pid %d) to follow pid %d; quitting", exe, pid, os.Getpid())
	return pid, nil
}

// relaunchFlags are the flags the next launch keeps: how this one was run. The
// first window's --url and --project are not kept, since the windows that were
// open come back on their own, nor an --after of this launch's own.
var relaunchFlags = map[string]bool{"dev": true, "verbose": true}

// relaunchValueFlags are the flags dropped along with the value that follows
// them when it is not given with "=".
var relaunchValueFlags = map[string]bool{"url": true, "project": true, "after": true}

// relaunchArgs is the arguments for the next launch, from this launch's args:
// the relaunchFlags among them, then --after pid.
func relaunchArgs(args []string, pid int) []string {
	var out []string
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if !strings.HasPrefix(arg, "-") {
			continue
		}
		name, _, hasValue := strings.Cut(strings.TrimLeft(arg, "-"), "=")
		switch {
		case relaunchFlags[name]:
			out = append(out, arg)
		case relaunchValueFlags[name] && !hasValue:
			i++
		}
	}
	return append(out, "--after", strconv.Itoa(pid))
}
