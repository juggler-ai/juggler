//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package portbind binds a server to a known port, or the first free one
// after it, so its address stays one a person can remember.
package portbind

import (
	"fmt"
	"net"
	"strconv"

	"juggler/internal/jlog"
)

// MaxSearch is how many ports past the starting one FirstFree tries. A busy
// port fails its bind at once, so a long search costs nothing worth measuring.
const MaxSearch = 100

// FirstFree listens on host at port, or at the first of the next MaxSearch
// ports that is free. Only a port that is unavailable moves the search on;
// any other failure is returned as it is, since the next port would fail the
// same way.
func FirstFree(host string, port int, listen func(addr string) (net.Listener, error)) (net.Listener, error) {
	for i := 0; i <= MaxSearch; i++ {
		listener, err := listen(net.JoinHostPort(host, strconv.Itoa(port+i)))
		if err == nil {
			if i > 0 {
				jlog.Info("✅ Found available port: %d", port+i)
			}
			return listener, nil
		}
		if !unavailable(err) {
			return nil, err
		}
		if i == 0 {
			jlog.Info("⚠️  Port %d is busy, searching for available port...", port)
		}
	}
	return nil, fmt.Errorf("could not find available port after %d attempts", MaxSearch)
}
