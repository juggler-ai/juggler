//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"

	"github.com/mattn/go-isatty"

	"juggler/cmd/juggler/machineserver"
	"juggler/web"
)

// standaloneLaunch reports whether this launch serves its project in this
// process (the App) rather than riding the machine server as bare juggler
// does. Only a session child (of a machine server, or of `juggler run`) and the
// test harness (--test) do. A developer's --dev and --assets-from-disk ride
// with bare juggler to the server it starts, which passes them to its children.
func (f appFlags) standaloneLaunch() bool {
	return f.sessionChild || f.testMode
}

// refusal is why this launch's command line is refused, or "".
//
// An argument after the flags is refused: juggler takes none, and ignoring one
// would open nothing for a folder given that way and start a server for a
// mistyped subcommand. A folder is given with --project.
//
// --window is refused anywhere but the test harness, which opens its debug
// lane with it. Bare juggler has no server of its own to open a window on, and
// a session child's windows are the desktop app's to open.
func (f appFlags) refusal() string {
	if len(f.args) > 0 {
		return fmt.Sprintf("juggler: unexpected argument %q. To open a session for a folder: juggler --project <folder>", f.args[0])
	}
	if f.window && !f.testMode {
		return "juggler: --window is no longer supported: open the desktop app instead."
	}
	return ""
}

// runBare runs bare juggler on the machine server (machineserver.RunTerminal):
// it serves in this terminal's foreground when no server is running, and
// otherwise attaches to the one that is. It opens a session only for the
// folder --project names (resolveStartupProject); with none it opens no
// session and points at the sessions page.
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
		Project:        project,
		Port:           flags.port,
		AllowHosts:     flags.allowHosts,
		Dev:            flags.dev,
		AssetsFromDisk: flags.assetsFromDisk,
		Stdout:         os.Stdout,
		Stderr:         os.Stderr,
		OpenBrowser:    openInBrowser,
		Signals:        sig,
		Assets:         web.Files,
		Peer:           machinePeer(),
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
