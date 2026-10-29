//go:build !windows

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package portbind

import (
	"errors"
	"syscall"
)

// unavailable reports whether a listen failed because another socket holds
// the port, so that the next port is worth trying. It tests the errno, not the
// message text, which differs between platforms.
func unavailable(err error) bool {
	return errors.Is(err, syscall.EADDRINUSE)
}
