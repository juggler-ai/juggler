//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build darwin

package main

import (
	"fmt"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"

	"juggler/internal/detach"
)

// startRelaunch starts the next launch. An app in a bundle is launched as the
// bundle, through LaunchServices (open -n: a new instance, though this one is
// still running), so it is the app's own launch and not a child of this one;
// a binary in no bundle is started detached. It returns the next launch's pid,
// or 0 when it cannot be found.
func startRelaunch(exe string, args []string) (int, error) {
	bundle := enclosingAppBundle(exe)
	if bundle == "" {
		cmd := detach.Command(exe, args...)
		cmd.Dir = filepath.Dir(exe)
		started, err := detach.Start(cmd)
		if err != nil {
			return 0, err
		}
		pid := started.Process.Pid
		return pid, started.Process.Release()
	}
	open := exec.Command("/usr/bin/open", append([]string{"-n", bundle, "--args"}, args...)...) //nolint:gosec // this app's own bundle and its own flags
	if out, err := open.CombinedOutput(); err != nil {
		return 0, fmt.Errorf("open -n %s: %w: %s", bundle, err, strings.TrimSpace(string(out)))
	}
	return launchedAfter(args), nil
}

// launchedAfter is the pid of the launch open started with args, which end
// with --after and this process's pid (relaunchArgs): LaunchServices names no
// pid, but open returns once the app is running, and only that launch is
// waiting on this process. 0 when none is found.
func launchedAfter(args []string) int {
	if len(args) < 2 {
		return 0
	}
	pattern := "--after " + args[len(args)-1] + "$"
	out, err := exec.Command("/usr/bin/pgrep", "-n", "-f", "--", pattern).Output() //nolint:gosec // a pattern of this app's own flags
	if err != nil {
		return 0
	}
	pid, err := strconv.Atoi(strings.TrimSpace(string(out)))
	if err != nil {
		return 0
	}
	return pid
}

// enclosingAppBundle is the .app directory exe is inside, or "".
func enclosingAppBundle(exe string) string {
	for dir := filepath.Dir(exe); dir != filepath.Dir(dir); dir = filepath.Dir(dir) {
		if strings.HasSuffix(dir, ".app") {
			return dir
		}
	}
	return ""
}
