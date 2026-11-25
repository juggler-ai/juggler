//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import "errors"

// errNoOSTrash is moveToOSTrash's answer where there is no OS trash to move
// to, which sends trashOrRemove to its permanent delete.
var errNoOSTrash = errors.New("no OS trash")

// DisableOSTrash makes every trashOrRemove from here on a permanent delete,
// for a process whose deletions are not the user's: a server under --test, or
// a test binary. The OS trash keeps what it is given until the user empties
// it, and is a shell operation that slows as it fills. Call it before the
// session manager is made.
func DisableOSTrash() {
	moveToOSTrash = func(string) error { return errNoOSTrash }
}
