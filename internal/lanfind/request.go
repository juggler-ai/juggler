//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package lanfind

import (
	"crypto/rand"
	"net"
)

// RequestLocalNetwork asks macOS to let this process onto the local network:
// the first local network operation of a process macOS has not yet asked the
// user about brings up its Local Network prompt, and nothing else can. It
// connects a UDP socket to two random hosts on each broadcast-capable
// interface's link-local IPv6 network, at the discard port, and closes it —
// a connect that sends nothing, as Apple's TN3179 describes. Best effort and
// silent: macOS promises no prompt (none once the user has answered, perhaps
// none for a process that exits at once), and a connect that fails is
// ignored. Elsewhere it does nothing.
func RequestLocalNetwork() {
	if goos != "darwin" {
		return
	}
	for _, addr := range requestTargets(listInterfaces()) {
		if c, err := connectUDP(addr); err == nil {
			_ = c.Close()
		}
	}
}

// ifaceAddrs is a network interface as RequestLocalNetwork reads it.
type ifaceAddrs struct {
	name  string
	flags net.Flags
	addrs []net.Addr
}

// listInterfaces is this machine's interfaces. A seam for tests.
var listInterfaces = func() []ifaceAddrs {
	ifaces, err := net.Interfaces()
	if err != nil {
		return nil
	}
	out := make([]ifaceAddrs, 0, len(ifaces))
	for _, ifc := range ifaces {
		addrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		out = append(out, ifaceAddrs{name: ifc.Name, flags: ifc.Flags, addrs: addrs})
	}
	return out
}

// closer is a connected socket, as RequestLocalNetwork uses one.
type closer interface{ Close() error }

// connectUDP connects a UDP socket to addr. A seam: tests connect nothing.
var connectUDP = func(addr *net.UDPAddr) (closer, error) {
	return net.DialUDP("udp6", nil, addr)
}

// discardPort is the discard service's port: anything that did reach a host
// there would be thrown away.
const discardPort = 9

// requestTargets is where RequestLocalNetwork connects: for each link-local
// IPv6 address of an up, broadcast-capable interface, two hosts on its
// network, their interface identifiers random, at the discard port.
func requestTargets(ifaces []ifaceAddrs) []*net.UDPAddr {
	var out []*net.UDPAddr
	for _, ifc := range ifaces {
		if ifc.flags&net.FlagUp == 0 || ifc.flags&net.FlagBroadcast == 0 || ifc.flags&net.FlagLoopback != 0 {
			continue
		}
		for _, a := range ifc.addrs {
			n, ok := a.(*net.IPNet)
			if !ok || n.IP.To4() != nil || !n.IP.IsLinkLocalUnicast() {
				continue
			}
			for range 2 {
				ip := make(net.IP, net.IPv6len)
				copy(ip, n.IP.To16())
				_, _ = rand.Read(ip[8:])
				out = append(out, &net.UDPAddr{IP: ip, Port: discardPort, Zone: ifc.name})
			}
		}
	}
	return out
}
