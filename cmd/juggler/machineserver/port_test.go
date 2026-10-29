//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"net"
	"strconv"
	"testing"
)

// TestTheServerListensOnItsPortOrTheNextFreeOne: the machine server listens on
// every interface — the LAN gate, not the bind, decides who gets in — at the
// port it is given (DefaultPort unless told otherwise) or, when that is taken,
// the first free port after it, so its address stays one a person can
// remember. A port something else holds on loopback alone counts as taken: on
// some systems a bind on every interface still succeeds beside it, and every
// client on this machine, which dials loopback, would reach that other thing.
// Port 0 is any port the OS assigns. Clients dial the loopback address.
func TestTheServerListensOnItsPortOrTheNextFreeOne(t *testing.T) {
	if DefaultPort != 3939 {
		t.Fatalf("DefaultPort = %d, want 3939", DefaultPort)
	}
	held, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer func() { _ = held.Close() }()
	busy := held.Addr().(*net.TCPAddr).Port

	ln, err := listenAll(busy)
	if err != nil {
		t.Fatalf("listen from busy port %d: %v", busy, err)
	}
	got := ln.Addr().(*net.TCPAddr)
	dial := dialAddr(ln)
	_ = ln.Close()
	if got.Port <= busy || got.Port > busy+10 || !got.IP.IsUnspecified() {
		t.Fatalf("starting from port %d, busy on loopback, listened on %s; want every interface, a port just after it", busy, got)
	}
	if want := "127.0.0.1:" + strconv.Itoa(got.Port); dial != want {
		t.Errorf("dial address %q, want %q", dial, want)
	}

	ln, err = listenAll(0)
	if err != nil {
		t.Fatalf("listen on port 0: %v", err)
	}
	got = ln.Addr().(*net.TCPAddr)
	defer func() { _ = ln.Close() }()
	if got.Port == 0 || !got.IP.IsUnspecified() {
		t.Fatalf("port 0 listened on %s; want an OS-assigned port on every interface", got)
	}

	// Reachable at this machine's own LAN address, not only on loopback.
	addrs := lanAddresses()
	if len(addrs) == 0 {
		t.Skip("this machine has no LAN address to dial")
	}
	conn, err := net.Dial("tcp", net.JoinHostPort(addrs[0].ip, strconv.Itoa(got.Port)))
	if err != nil {
		t.Fatalf("dial %s on the LAN address %s: %v", got, addrs[0].ip, err)
	}
	_ = conn.Close()
}
