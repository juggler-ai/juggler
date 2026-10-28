//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"fmt"
	"os"
	"os/signal"
	"slices"
	"syscall"

	"github.com/mattn/go-isatty"

	"juggler/cmd/juggler/machineserver"
	"juggler/cmd/juggler/server"
)

// standaloneLaunch reports whether this launch serves its project in this
// process (the App) rather than riding the machine server as bare juggler
// does. Only a launch marked as more than a person's bare juggler does: a
// machine server's session child, the test harness (--test), the desktop
// app's own server (--exit-with-parent), a developer run (--dev,
// --assets-from-disk, which a machine server cannot pass to its children), or
// --standalone, which the suites that test one project's server pass.
func (f appFlags) standaloneLaunch() bool {
	return f.sessionChild || f.testMode || f.exitWithParent || f.dev || f.assetsFromDisk || f.standalone
}

// refusal is why this launch's flags are refused, or "": a retired flag on any
// launch, and --window on bare juggler, which has no server of its own to open
// a window on.
func (f appFlags) refusal() string {
	for _, name := range f.retired {
		switch name {
		case "kill-existing":
			return "juggler: --kill-existing is no longer needed: juggler uses the Juggler server already running."
		default:
			return fmt.Sprintf("juggler: --%s is no longer supported: Juggler runs one server for this computer, which accepts connections from this computer only.", name)
		}
	}
	if f.window && !f.standaloneLaunch() {
		return "juggler: --window is no longer supported: open the desktop app instead."
	}
	return ""
}

// retiredFlagNames are the flags a launch no longer takes: the per-project
// exposure flags (--public, and each registered tunnel mode's) and
// --kill-existing.
func retiredFlagNames() []string {
	names := []string{"public", "kill-existing"}
	for _, spec := range server.TunnelModes() {
		if spec.FlagName != "" {
			names = append(names, spec.FlagName)
		}
	}
	return names
}

// isRetiredFlag reports whether name is one of retiredFlagNames.
func isRetiredFlag(name string) bool {
	return slices.Contains(retiredFlagNames(), name)
}

// runBare runs bare juggler — `cd proj && juggler` — on the machine server
// (machineserver.RunTerminal): it serves in this terminal's foreground when no
// server is running, and otherwise attaches to the one that is. Its project
// is resolved as a standalone launch's is: --project, else a terminal's cwd
// unless that is a home or system folder; with none it opens no session and
// points at the sessions page.
func runBare(flags appFlags) int {
	printBanner()
	project, err := (&App{flags: flags}).resolveStartupProject()
	if err != nil {
		fmt.Fprintf(os.Stderr, "juggler: %v\n", err)
		return 2
	}
	defer machineserver.InitLogging(flags.verbose)()

	// SIGHUP too: a terminal closing under the server stops it as Ctrl-C
	// would, its sessions with it.
	sig := make(chan os.Signal, 4)
	signal.Notify(sig, os.Interrupt, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(sig)

	opts := machineserver.TerminalOptions{
		Project:     project,
		Port:        flags.port,
		AllowHosts:  flags.allowHosts,
		Stdout:      os.Stdout,
		Stderr:      os.Stderr,
		OpenBrowser: openInBrowser,
		Signals:     sig,
	}
	if flags.hasTerminal && isTerminal(os.Stdin) {
		opts.Stdin = os.Stdin
	}
	return machineserver.RunTerminal(opts)
}

// isTerminal reports whether f is a terminal a person can type at.
func isTerminal(f *os.File) bool {
	return isatty.IsTerminal(f.Fd()) || isatty.IsCygwinTerminal(f.Fd())
}
