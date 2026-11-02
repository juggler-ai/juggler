//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !darwin

package bundlelaunch

import "errors"

// Bundle reports no bundle: only macOS has app bundles to launch.
func Bundle(string) (string, bool) { return "", false }

// Start fails: only macOS has app bundles to launch.
func Start(string, []string, []string) (int, <-chan struct{}, error) {
	return 0, nil, errors.New("bundlelaunch: app bundles are launched only on macOS")
}
