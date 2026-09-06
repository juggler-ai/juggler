//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !darwin

// Package windowchrome paints a Wails window's native chrome to match the page
// theme. Everything it does is macOS-specific, so off macOS the package is
// empty and nothing imports it: each host's own platform files say what happens
// there instead — the desktop app (cmd/juggler-app) watches the OS colour
// scheme over D-Bus on Linux and trusts the page's guess on Windows, and the
// server's test-pool window (cmd/juggler/app) does nothing either place. This
// file carries no declarations; it exists so the directory is still a buildable
// package everywhere, which is what keeps it inside the ./internal/... vet,
// lint and deadcode patterns.
package windowchrome
