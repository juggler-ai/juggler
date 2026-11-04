//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package lanfind is how Juggler servers on one network find each other:
// DNS-SD over multicast DNS (RFC 6762/6763), service type _juggler._tcp. A
// machine server with LAN access on advertises itself (Advertise); the desktop
// app browses for the others (Browse) to offer them under "Connect to another
// computer".
//
// An announcement is unauthenticated — anyone on the network can send one —
// so what it carries is a hint of where to look, never a reason to trust. The
// mDNS layer reports an instance when it first resolves and when it changes,
// but never that it has gone (a server that stops sends no goodbye), so
// whether a found server still answers is the browser's caller's question,
// asked of the server itself.
package lanfind

import (
	"context"
	"maps"
	"net"
	"net/netip"
	"slices"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"unicode"
	"unicode/utf8"

	"github.com/pion/mdns/v2"
	"golang.org/x/net/ipv4"
	"golang.org/x/net/ipv6"
)

// ServiceType is the DNS-SD service type every Juggler server advertises.
const ServiceType = "_juggler._tcp"

// txtVersion is the TXT key carrying the advertising server's version.
const txtVersion = "v"

// maxInstanceName is the DNS label limit (RFC 6763 §4.1.1) on an instance
// name, in bytes.
const maxInstanceName = 63

// maxFound is how many instances a Browser records. Anyone on the network can
// announce, so a flood of instances must not grow the record, or the probes
// the app makes of each, without bound; a network with more Juggler servers on
// it than this is not one a list to pick from serves anyway.
const maxFound = 64

// Found is one server a Browser has seen.
type Found struct {
	// Name is its instance name: the advertising machine's name.
	Name string
	// Addrs are the addresses it resolved to, IPv4 first.
	Addrs []netip.Addr
	// Port is its HTTP port.
	Port int
	// Version is the version it announced, "" when it announced none.
	Version string
}

// transport is what this package asks of an mDNS responder: pion's *mdns.Conn,
// or a test's stand-in.
type transport interface {
	Register(svc mdns.ServiceInstance) error
	OnServiceDiscovered(handler func(mdns.ServiceEvent))
	Browse(ctx context.Context, serviceType string) error
	Close() error
}

// openTransport opens the responder; hostName is the name its SRV records
// point at, "" for a browser that answers nothing of its own.
var openTransport = openMulticast

// openMulticast opens an mDNS responder on every interface. The sockets bind
// the multicast group addresses, which is what makes Go set SO_REUSEADDR (and
// SO_REUSEPORT where there is one), so they share port 5353 with the system's
// own responder (mDNSResponder, avahi). Either family alone is enough.
func openMulticast(hostName string) (transport, error) {
	var v4 *ipv4.PacketConn
	var v6 *ipv6.PacketConn
	var firstErr error
	if addr, err := net.ResolveUDPAddr("udp4", mdns.DefaultAddressIPv4); err == nil {
		if l, err := net.ListenUDP("udp4", addr); err == nil {
			v4 = ipv4.NewPacketConn(l)
		} else {
			firstErr = err
		}
	}
	if addr, err := net.ResolveUDPAddr("udp6", mdns.DefaultAddressIPv6); err == nil {
		if l, err := net.ListenUDP("udp6", addr); err == nil {
			v6 = ipv6.NewPacketConn(l)
		} else if firstErr == nil {
			firstErr = err
		}
	}
	if v4 == nil && v6 == nil {
		return nil, firstErr
	}
	var opts []mdns.ServerOption
	if hostName != "" {
		opts = append(opts, mdns.WithLocalNames(hostName))
	}
	conn, err := mdns.NewServer(v4, v6, opts...)
	if err != nil {
		if v4 != nil {
			_ = v4.Close()
		}
		if v6 != nil {
			_ = v6.Close()
		}
		return nil, err
	}
	return conn, nil
}

// InstanceName is the name a server on the machine called hostname advertises
// as: the hostname's first label (a macOS "Mac.local" is "Mac"), without
// control characters, cut to the DNS-SD limit on a rune boundary. A hostname
// that leaves nothing is "Juggler".
func InstanceName(hostname string) string {
	name, _, _ := strings.Cut(hostname, ".")
	name = strings.Map(func(r rune) rune {
		if unicode.IsControl(r) || r == utf8.RuneError {
			return -1
		}
		return r
	}, name)
	name = strings.TrimSpace(name)
	for len(name) > maxInstanceName {
		_, size := utf8.DecodeLastRuneInString(name)
		name = name[:len(name)-size]
	}
	if name == "" {
		return "Juggler"
	}
	return name
}

// hostLabel is the .local host name a server's SRV record points at: its own
// name, so this responder never contends with the system's for the
// machine's hostname.
func hostLabel(instance string) string {
	label := strings.Map(func(r rune) rune {
		switch {
		case r >= 'a' && r <= 'z', r >= '0' && r <= '9':
			return r
		case r >= 'A' && r <= 'Z':
			return r + ('a' - 'A')
		default:
			return '-'
		}
	}, instance)
	label = strings.Trim(label, "-")
	if label == "" {
		label = "server"
	}
	if len(label) > maxInstanceName-len("juggler-") {
		label = label[:maxInstanceName-len("juggler-")]
	}
	return "juggler-" + label + ".local"
}

// Advertise announces a Juggler server called name, at port, on every
// interface until stop is called.
func Advertise(name string, port int, version string) (stop func(), err error) {
	host := hostLabel(name)
	conn, err := openTransport(host)
	if err != nil {
		return nil, err
	}
	var text []mdns.TXTEntry
	if version != "" {
		text = append(text, mdns.NewTXTString(txtVersion, version))
	}
	if err := conn.Register(mdns.ServiceInstance{
		Instance: name,
		Service:  ServiceType,
		Host:     host + ".",
		Port:     uint16(port), //nolint:gosec // a listening TCP port
		Text:     text,
	}); err != nil {
		_ = conn.Close()
		return nil, err
	}
	var once sync.Once
	return func() { once.Do(func() { _ = conn.Close() }) }, nil
}

// Browser keeps the Juggler servers it has seen on the network, from Browse
// until Close.
type Browser struct {
	conn   transport
	cancel context.CancelFunc

	// found is every instance seen, by seen's key. The map is never written
	// once published: seen swaps in a changed copy, so a Snapshot reads one
	// whole state however the responder's readers interleave.
	found atomic.Pointer[map[string]Found]
}

// Browse starts looking for Juggler servers.
func Browse() (*Browser, error) {
	conn, err := openTransport("")
	if err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(context.Background())
	b := &Browser{conn: conn, cancel: cancel}
	b.found.Store(&map[string]Found{})
	conn.OnServiceDiscovered(b.seen)
	if err := conn.Browse(ctx, ServiceType); err != nil {
		cancel()
		_ = conn.Close()
		return nil, err
	}
	return b, nil
}

// seen records one resolved instance. An instance is keyed by its name and
// port; each address it resolves to is added to it, IPv4 first. Once maxFound
// are recorded, an instance not among them is ignored.
func (b *Browser) seen(evt mdns.ServiceEvent) {
	inst := evt.Instance
	if !strings.EqualFold(strings.TrimSuffix(inst.Service, "."), ServiceType) || inst.Port == 0 {
		return
	}
	var version string
	for _, e := range inst.Text {
		if e.Key == txtVersion && e.Value != nil {
			version = string(e.Value)
		}
	}
	addr := evt.Addr.Unmap()
	key := inst.Instance + "\x00" + strconv.Itoa(int(inst.Port))
	for {
		old := b.found.Load()
		f, known := (*old)[key]
		if !known && len(*old) >= maxFound {
			return
		}
		next := maps.Clone(*old)
		f.Name, f.Port, f.Version = inst.Instance, int(inst.Port), version
		if addr.IsValid() && !slices.Contains(f.Addrs, addr) {
			f.Addrs = append(slices.Clone(f.Addrs), addr)
			slices.SortStableFunc(f.Addrs, func(a, b netip.Addr) int {
				switch {
				case a.Is4() == b.Is4():
					return 0
				case a.Is4():
					return -1
				default:
					return 1
				}
			})
		}
		next[key] = f
		if b.found.CompareAndSwap(old, &next) {
			return
		}
	}
}

// Snapshot is every server seen so far that resolved to an address, by name.
func (b *Browser) Snapshot() []Found {
	found := *b.found.Load()
	out := make([]Found, 0, len(found))
	for _, f := range found {
		if len(f.Addrs) == 0 {
			continue
		}
		f.Addrs = slices.Clone(f.Addrs)
		out = append(out, f)
	}
	slices.SortFunc(out, func(a, b Found) int {
		if c := strings.Compare(strings.ToLower(a.Name), strings.ToLower(b.Name)); c != 0 {
			return c
		}
		return a.Port - b.Port
	})
	return out
}

// Close stops looking.
func (b *Browser) Close() {
	b.cancel()
	_ = b.conn.Close()
}
