//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package portbind

import (
	"errors"

	"golang.org/x/sys/windows"
)

// unavailable reports whether a listen failed because the port cannot be
// had, so that the next port is worth trying. It tests the Winsock error code,
// never the message text: Windows words a busy port differently from Unix and
// translates the wording into the system language. syscall.EADDRINUSE does not
// match either, because on Windows it is a placeholder value Winsock never
// returns.
//
// WSAEACCES counts as unavailable too. Windows gives it for a port inside a
// range the system has reserved (Hyper-V and WSL reserve whole blocks; `netsh
// int ipv4 show excludedportrange protocol=tcp` lists them), which is a port to
// step past just like a busy one.
func unavailable(err error) bool {
	return errors.Is(err, windows.WSAEADDRINUSE) || errors.Is(err, windows.WSAEACCES)
}
