//go:build !windows

//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"errors"
	"syscall"
)

// portUnavailable reports whether a listen failed because another socket holds
// the port, so that the next port is worth trying. It tests the errno, not the
// message text, which differs between platforms.
func portUnavailable(err error) bool {
	return errors.Is(err, syscall.EADDRINUSE)
}
