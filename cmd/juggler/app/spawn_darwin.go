//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build darwin

package app

import (
	"os/exec"
	"path/filepath"
	"strings"

	"juggler/internal/detach"
)

// launchDetached starts a new juggler instance on macOS.
//
// When running from inside a .app bundle (the normal install), we must launch
// via `open -n`: macOS LaunchServices treats a second launch of the same
// bundle as an activation of the running instance (the bundle has no
// LSMultipleInstances key), so exec-ing the inner binary or `open`-ing the
// bundle without -n would just foreground the existing window instead of
// starting a new one. `open -n` forces a fresh instance and fully detaches it,
// giving the child its own LaunchServices registration, Dock icon, and
// activation — none of which an inline exec would set up correctly.
//
// When not in a bundle (a bare `go build` binary or `go run` during
// development), there's no LaunchServices involvement, so we exec the binary
// directly in a new session.
func launchDetached(exe string, args []string) error {
	if bundle := appBundlePath(exe); bundle != "" {
		// open -n -a <Juggler.app> --args <args...>
		openArgs := append([]string{"-n", "-a", bundle, "--args"}, args...)
		cmd := exec.Command("open", openArgs...)
		return cmd.Start()
	}
	return execDetached(exe, args)
}

// appBundlePath returns the path to the enclosing .app bundle for the running
// executable, or "" if the executable does not live inside a standard
// Contents/MacOS layout. A bundle binary sits at
// <Name>.app/Contents/MacOS/<binary>, so the bundle is three directories up.
//
// Symlinks are resolved first: the dev layout links bin/juggler-app →
// Juggler.app/Contents/MacOS/juggler-app, and detection must follow the link to
// its real in-bundle location. Otherwise the symlink's bin/ parent hides the
// bundle, the launch falls through to a direct exec, and the child loses its
// bundle identity (wrong menu-bar app name, no Info.plist).
func appBundlePath(exe string) string {
	if resolved, err := filepath.EvalSymlinks(exe); err == nil {
		exe = resolved
	}
	macOSDir := filepath.Dir(exe)          // <Name>.app/Contents/MacOS
	contentsDir := filepath.Dir(macOSDir)  // <Name>.app/Contents
	bundleDir := filepath.Dir(contentsDir) // <Name>.app
	if filepath.Base(macOSDir) == "MacOS" &&
		filepath.Base(contentsDir) == "Contents" &&
		strings.HasSuffix(bundleDir, ".app") {
		return bundleDir
	}
	return ""
}

// execDetached runs the binary directly, detached (see the detach package),
// so it survives this process exiting.
func execDetached(exe string, args []string) error {
	cmd, err := detach.Start(detach.Command(exe, args...))
	if err != nil {
		return err
	}
	// Release so the OS reaps the child instead of leaving a zombie when this
	// process keeps running.
	return cmd.Process.Release()
}
