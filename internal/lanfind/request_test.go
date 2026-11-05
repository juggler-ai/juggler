//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package lanfind

import (
	"errors"
	"net"
	"sync/atomic"
	"testing"
)

// prefixed is addr as an interface lists it: the address, in its network.
func prefixed(t *testing.T, cidr string) net.Addr {
	t.Helper()
	ip, n, err := net.ParseCIDR(cidr)
	if err != nil {
		t.Fatal(err)
	}
	n.IP = ip
	return n
}

// TestRequestTargets: the addresses RequestLocalNetwork connects to are two
// random hosts on each up, broadcast-capable interface's link-local IPv6
// network, at the discard port, scoped to that interface — never the
// interface's own address, and none on a loopback, point-to-point or down
// interface, or on a network that is not link-local.
func TestRequestTargets(t *testing.T) {
	own := "fe80::1c2d:3e4f:5a6b:7c8d"
	ifaces := []ifaceAddrs{
		{name: "en0", flags: net.FlagUp | net.FlagBroadcast | net.FlagMulticast, addrs: []net.Addr{
			prefixed(t, own+"/64"), prefixed(t, "192.168.1.2/24"), prefixed(t, "2001:db8::5/64"),
		}},
		{name: "lo0", flags: net.FlagUp | net.FlagLoopback, addrs: []net.Addr{prefixed(t, "fe80::1/64")}},
		{name: "utun0", flags: net.FlagUp | net.FlagPointToPoint, addrs: []net.Addr{prefixed(t, "fe80::aa/64")}},
		{name: "en1", flags: net.FlagBroadcast, addrs: []net.Addr{prefixed(t, "fe80::bb/64")}},
	}
	got := requestTargets(ifaces)
	if len(got) != 2 {
		t.Fatalf("targets = %v, want two, both on en0", got)
	}
	ownIP := net.ParseIP(own)
	for _, a := range got {
		if a.Zone != "en0" || a.Port != 9 || !a.IP.IsLinkLocalUnicast() || !a.IP.Mask(net.CIDRMask(64, 128)).Equal(ownIP.Mask(net.CIDRMask(64, 128))) {
			t.Errorf("target %v: want a host on en0's fe80::/64, port 9, zone en0", a)
		}
		if a.IP.Equal(ownIP) {
			t.Errorf("target %v is the interface's own address", a)
		}
	}
	if got[0].IP.Equal(got[1].IP) {
		t.Errorf("both targets are %v, want two random hosts", got[0].IP)
	}
}

// fakeConn is a connected socket that counts its closing.
type fakeConn struct{ closed *atomic.Int32 }

func (c fakeConn) Close() error { c.closed.Add(1); return nil }

// TestRequestLocalNetworkOnlyConnects: on macOS, RequestLocalNetwork connects
// a socket to each target and closes it, sending nothing, and carries on past
// any that cannot connect. Elsewhere it does nothing.
func TestRequestLocalNetworkOnlyConnects(t *testing.T) {
	prevOS, prevIfaces, prevDial := goos, listInterfaces, connectUDP
	t.Cleanup(func() { goos, listInterfaces, connectUDP = prevOS, prevIfaces, prevDial })
	listInterfaces = func() []ifaceAddrs {
		return []ifaceAddrs{{name: "en0", flags: net.FlagUp | net.FlagBroadcast, addrs: []net.Addr{prefixed(t, "fe80::5/64")}}}
	}
	var dials, closed atomic.Int32
	connectUDP = func(*net.UDPAddr) (closer, error) {
		if dials.Add(1) == 1 {
			return nil, errors.New("connect: no route to host")
		}
		return fakeConn{&closed}, nil
	}

	goos = "linux"
	RequestLocalNetwork()
	if n := dials.Load(); n != 0 {
		t.Fatalf("on linux connected %d sockets, want none", n)
	}

	goos = "darwin"
	RequestLocalNetwork()
	if d, c := dials.Load(), closed.Load(); d != 2 || c != 1 {
		t.Errorf("on darwin connected %d sockets and closed %d, want 2 tried (one refused) and the other closed", d, c)
	}
}
