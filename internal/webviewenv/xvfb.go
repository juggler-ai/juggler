//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package webviewenv

import (
	"fmt"
	"os"
	"os/exec"
	"runtime"
)

// Auto-relaunch under a virtual framebuffer. A headless Linux host (no
// DISPLAY/WAYLAND_DISPLAY) cannot bring up the hidden engine webview, but a
// virtual framebuffer satisfies it completely — the engine paints nothing. So
// when xvfb-run is installed, the server re-execs itself under `xvfb-run -a`
// instead of failing the engine preflight, following the same philosophy as
// PrepareLinuxWebKit: detect the certain failure, apply the known fix, log a
// one-line note, and respect an explicit user override.

// noXvfbEnv is the user's escape hatch: set to any value to keep Juggler from
// relaunching itself under xvfb-run (it will then fail preflight with the
// usual diagnostic if no display can be found).
const noXvfbEnv = "JUGGLER_NO_XVFB"

// xvfbMarkerEnv marks a process already relaunched under xvfb-run, so a child
// that still sees no display (e.g. Xvfb itself failed to start) can never
// re-exec in a loop. The DISPLAY xvfb-run sets is the primary stop condition;
// this is the backstop.
const xvfbMarkerEnv = "JUGGLER_XVFB_RELAUNCHED"

// MaybeRelaunchUnderXvfb re-execs this process under `xvfb-run -a` when it is
// running on a Linux host with no display and xvfb-run is installed (see
// xvfbRelaunchArgv for the full conditions). On success it never returns — the
// process image is replaced. It returns "" when no relaunch was warranted, or
// a note describing a relaunch that was attempted but failed (for the caller
// to log before continuing to the normal preflight-failure path).
//
// Must be called early in startup — before any lock is taken, port bound, or
// GTK/WebKit state initialised — because the exec'd child redoes all of that
// from scratch.
func MaybeRelaunchUnderXvfb() string {
	exe, err := os.Executable()
	if err != nil {
		exe = os.Args[0]
	}
	argv := xvfbRelaunchArgv(runtime.GOOS,
		os.Getenv("DISPLAY"), os.Getenv("WAYLAND_DISPLAY"),
		os.LookupEnv, exec.LookPath, exe, os.Args[1:])
	if argv == nil {
		return ""
	}
	fmt.Fprintf(os.Stderr,
		"no display detected — relaunching under xvfb-run so the engine webview can start (set %s=1 to disable)\n",
		noXvfbEnv)
	env := append(os.Environ(), xvfbMarkerEnv+"=1")
	if err := execReplace(argv[0], argv, env); err != nil {
		return fmt.Sprintf("relaunch under xvfb-run failed: %v", err)
	}
	return "" // unreachable on Linux: a successful exec does not return
}

// xvfbRelaunchArgv decides whether this process should re-exec under xvfb-run
// and, if so, returns the full argv to exec (argv[0] is the resolved xvfb-run
// path). It returns nil when no relaunch should happen: not Linux, a display
// is already available, the user opted out via JUGGLER_NO_XVFB, this process
// is already the product of a relaunch, or xvfb-run is not installed.
func xvfbRelaunchArgv(goos, display, wayland string,
	lookupEnv func(string) (string, bool),
	lookPath func(string) (string, error),
	exe string, args []string) []string {
	if goos != "linux" || display != "" || wayland != "" {
		return nil
	}
	if _, ok := lookupEnv(noXvfbEnv); ok {
		return nil
	}
	if _, ok := lookupEnv(xvfbMarkerEnv); ok {
		return nil
	}
	xvfbRun, err := lookPath("xvfb-run")
	if err != nil {
		return nil
	}
	// -a picks a free display number, so parallel instances don't collide.
	return append([]string{xvfbRun, "-a", exe}, args...)
}
