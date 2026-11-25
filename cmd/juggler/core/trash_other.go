//go:build !windows

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"os"
	"sync"

	gotrash "github.com/laurent22/go-trash"
)

// probeTrash serialises go-trash's first availability check. Its Linux build
// caches the probe result and the tool name in plain package globals with no
// synchronisation, so two concurrent first callers race — and a caller that
// sees the availability flag set before the tool name is written execs an
// empty command. Doing the first probe under a sync.Once orders every later
// read of those globals behind it.
var probeTrash sync.Once

// trashOrRemove moves path to the OS trash if available, falling back to
// permanent removal. On macOS/Linux this uses go-trash (Finder trash on
// darwin, gio/gvfs on Linux).
func trashOrRemove(path string) error {
	if err := moveToOSTrash(path); err == nil {
		return nil
	}
	// No trash, or it failed (e.g. network volume) — permanent delete.
	return os.RemoveAll(path)
}

// moveToOSTrash is trashOrRemove's trip to the OS trash (DisableOSTrash).
var moveToOSTrash = moveToGoTrash

func moveToGoTrash(path string) error {
	probeTrash.Do(func() { gotrash.IsAvailable() })
	if !gotrash.IsAvailable() {
		return errNoOSTrash
	}
	_, err := gotrash.MoveToTrash(path)
	return err
}
