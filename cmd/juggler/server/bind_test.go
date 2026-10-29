//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"net"
	"testing"
)

// TestEveryInProcessServerBindsLoopback: a session child — and the --test
// harness, the only other in-process server — listens on loopback alone. It has
// no LAN gate of its own: callers from elsewhere reach it only through the
// machine server, which owns all exposure and vouches for them.
func TestEveryInProcessServerBindsLoopback(t *testing.T) {
	s := &Server{addr: "localhost:0"}
	ln, _, err := s.findAvailablePort()
	if err != nil {
		t.Fatalf("findAvailablePort: %v", err)
	}
	defer func() { _ = ln.Close() }()
	if ip := ln.Addr().(*net.TCPAddr).IP; !ip.IsLoopback() {
		t.Fatalf("bound %s, want loopback", ip)
	}
}
