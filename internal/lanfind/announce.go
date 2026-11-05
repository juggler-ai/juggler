//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package lanfind

import (
	"errors"
	"fmt"
	"net"
	"net/netip"
	"runtime"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"

	"github.com/pion/mdns/v2"
	"golang.org/x/net/dns/dnsmessage"
	"golang.org/x/net/ipv4"
	"golang.org/x/net/ipv6"
)

// ErrLocalNetworkDenied is an announcement macOS refused to send: its Local
// Network privacy refuses every multicast send of a process it has not been
// allowed to let onto the network — "no route to host" on every interface,
// whether the user turned it off or has yet to answer the prompt asking. The
// refusal holds for the process as a whole, and lifts for every socket it has
// open as soon as the user allows it.
var ErrLocalNetworkDenied = errors.New("macOS Local Network privacy refused the announcement")

// errNoInterface is an announcement with no interface to go out on.
var errNoInterface = errors.New("no network interface with an address to announce on")

// goos is the system an announcement's outcome is read for (outcome).
var goos = runtime.GOOS

// cacheFlush is the mDNS cache-flush bit of a record's class (RFC 6762 §10.2):
// the record is its owner's alone, and replaces what a cache held for it.
const cacheFlush = 1 << 15

// recordTTL is the TTL of every record announced, the one the responder
// answers with too.
const recordTTL = 120

// Advertisement is a server's place on the network, from Advertise until Stop.
// The responder answers whoever asks for Juggler servers; Announce says so
// unasked, and is how its owner finds out whether the network hears it.
type Advertisement struct {
	conn transport
	svc  mdns.ServiceInstance
	once sync.Once
	// sendFailed is a send by the responder that failed since the last
	// Announce (responderLogs).
	sendFailed atomic.Bool
}

// sendAnnouncement is how Announce sends: the packet built for each
// interface's addresses, to the mDNS group on that interface, answering each
// send's error (nil for one that left). A seam: tests send nothing.
var sendAnnouncement = sendMulticast

// Announce sends the server's records unasked (RFC 6762 §8.3) on every
// interface, and says whether they left the machine: nil when a send on any
// interface did, ErrLocalNetworkDenied when macOS refused them all, and
// otherwise why the first failed. Sends refused now may be taken later, so
// each call tries again.
func (a *Advertisement) Announce() error {
	a.sendFailed.Store(false)
	return outcome(sendAnnouncement(a.packet), goos)
}

// SendFailed is whether a send by the responder (an answer to someone who
// asked) has failed since the last Announce: a reason to Announce again before
// believing the last one.
func (a *Advertisement) SendFailed() bool { return a.sendFailed.Load() }

// Stop ends the advertisement. Stopping it again does nothing.
func (a *Advertisement) Stop() {
	a.once.Do(func() { _ = a.conn.Close() })
}

// outcome is what an announcement's sends add up to, on the system goos: nil
// when any left; ErrLocalNetworkDenied, wrapping the refusal, when on macOS
// they failed with "no route to host" (which a send there returns only when
// Local Network privacy refuses it); otherwise the first failure.
func outcome(errs []error, goos string) error {
	if len(errs) == 0 {
		return errNoInterface
	}
	var refused error
	for _, err := range errs {
		if err == nil {
			return nil
		}
		if refused == nil && errors.Is(err, syscall.EHOSTUNREACH) {
			refused = err
		}
	}
	if refused != nil && goos == "darwin" {
		return fmt.Errorf("%w: %w", ErrLocalNetworkDenied, refused)
	}
	return errs[0]
}

// packet is the announcement for an interface with addrs: the service's PTR,
// the instance's SRV and TXT, and the host's addresses there.
func (a *Advertisement) packet(addrs []netip.Addr) ([]byte, error) {
	service, err := dnsmessage.NewName(a.svc.Service + ".local.")
	if err != nil {
		return nil, err
	}
	instance, err := dnsmessage.NewName(escapeInstance(a.svc.Instance) + "." + a.svc.Service + ".local.")
	if err != nil {
		return nil, err
	}
	host, err := dnsmessage.NewName(a.svc.Host)
	if err != nil {
		return nil, err
	}
	txt := make([]string, 0, len(a.svc.Text))
	for _, e := range a.svc.Text {
		if e.Value == nil {
			txt = append(txt, e.Key) // a key alone is a boolean attribute
		} else {
			txt = append(txt, e.Key+"="+string(e.Value))
		}
	}
	if len(txt) == 0 {
		txt = []string{""}
	}
	header := func(name dnsmessage.Name, typ dnsmessage.Type, flush bool) dnsmessage.ResourceHeader {
		class := dnsmessage.ClassINET
		if flush {
			class |= cacheFlush
		}
		return dnsmessage.ResourceHeader{Name: name, Type: typ, Class: class, TTL: recordTTL}
	}
	msg := dnsmessage.Message{
		Header: dnsmessage.Header{Response: true, Authoritative: true},
		Answers: []dnsmessage.Resource{
			{Header: header(service, dnsmessage.TypePTR, false), Body: &dnsmessage.PTRResource{PTR: instance}},
			{Header: header(instance, dnsmessage.TypeSRV, true), Body: &dnsmessage.SRVResource{Target: host, Port: a.svc.Port}},
			{Header: header(instance, dnsmessage.TypeTXT, true), Body: &dnsmessage.TXTResource{TXT: txt}},
		},
	}
	for _, addr := range addrs {
		if addr.Is4() {
			msg.Additionals = append(msg.Additionals, dnsmessage.Resource{
				Header: header(host, dnsmessage.TypeA, true), Body: &dnsmessage.AResource{A: addr.As4()},
			})
		} else {
			msg.Additionals = append(msg.Additionals, dnsmessage.Resource{
				Header: header(host, dnsmessage.TypeAAAA, true), Body: &dnsmessage.AAAAResource{AAAA: addr.As16()},
			})
		}
	}
	return msg.Pack()
}

// escapeInstance escapes an instance name's dots and backslashes (RFC 6763
// §4.3), as the responder does for the names it answers with.
func escapeInstance(name string) string {
	return strings.NewReplacer(`\`, `\\`, `.`, `\.`).Replace(name)
}

// sendMulticast sends, on every interface the responder answers on (up, not
// loopback, multicast, with an address), the packet built for its addresses,
// to the mDNS group of each family it has an address in, from port 5353 with
// the hop limit mDNS requires (RFC 6762 §11). Its sockets are its own, open
// only while it sends, so they never contend with the responder's for which
// interface a send goes out on.
func sendMulticast(build func([]netip.Addr) ([]byte, error)) []error {
	ifaces, err := net.Interfaces()
	if err != nil {
		return []error{err}
	}
	var v4 *ipv4.PacketConn
	var v6 *ipv6.PacketConn
	var v4Err, v6Err error
	defer func() {
		if v4 != nil {
			_ = v4.Close()
		}
		if v6 != nil {
			_ = v6.Close()
		}
	}()
	group4 := &net.UDPAddr{IP: net.IPv4(224, 0, 0, 251), Port: 5353}
	group6 := &net.UDPAddr{IP: net.ParseIP("ff02::fb"), Port: 5353}
	var errs []error
	for _, ifc := range ifaces {
		if ifc.Flags&net.FlagUp == 0 || ifc.Flags&net.FlagLoopback != 0 || ifc.Flags&net.FlagMulticast == 0 {
			continue
		}
		var addrs []netip.Addr
		var has4, has6 bool
		ifAddrs, err := ifc.Addrs()
		if err != nil {
			continue
		}
		for _, a := range ifAddrs {
			ipNet, ok := a.(*net.IPNet)
			if !ok {
				continue
			}
			addr, ok := netip.AddrFromSlice(ipNet.IP)
			if !ok {
				continue
			}
			addr = addr.Unmap()
			addrs = append(addrs, addr)
			has4 = has4 || addr.Is4()
			has6 = has6 || addr.Is6()
		}
		if len(addrs) == 0 {
			continue
		}
		pkt, err := build(addrs)
		if err != nil {
			return []error{err}
		}
		if has4 {
			if v4 == nil && v4Err == nil {
				v4, v4Err = openSender4(group4)
			}
			if v4Err != nil {
				errs = append(errs, v4Err)
			} else {
				errs = append(errs, send4(v4, &ifc, pkt, group4))
			}
		}
		if has6 {
			if v6 == nil && v6Err == nil {
				v6, v6Err = openSender6(group6)
			}
			if v6Err != nil {
				errs = append(errs, v6Err)
			} else {
				errs = append(errs, send6(v6, &ifc, pkt, &net.UDPAddr{IP: group6.IP, Port: group6.Port, Zone: ifc.Name}))
			}
		}
	}
	return errs
}

// openSender4 is an IPv4 socket that sends as an mDNS responder: bound to
// the group's address and port, as the responder's own are, so it shares port
// 5353 and is handed no unicast meant for another.
func openSender4(group *net.UDPAddr) (*ipv4.PacketConn, error) {
	l, err := net.ListenUDP("udp4", group)
	if err != nil {
		return nil, err
	}
	p := ipv4.NewPacketConn(l)
	_ = p.SetMulticastTTL(255)
	return p, nil
}

// openSender6 is openSender4 for IPv6.
func openSender6(group *net.UDPAddr) (*ipv6.PacketConn, error) {
	l, err := net.ListenUDP("udp6", group)
	if err != nil {
		return nil, err
	}
	p := ipv6.NewPacketConn(l)
	_ = p.SetMulticastHopLimit(255)
	return p, nil
}

func send4(p *ipv4.PacketConn, ifc *net.Interface, pkt []byte, dst net.Addr) error {
	if err := p.SetMulticastInterface(ifc); err != nil {
		return err
	}
	_, err := p.WriteTo(pkt, &ipv4.ControlMessage{IfIndex: ifc.Index}, dst)
	return err
}

func send6(p *ipv6.PacketConn, ifc *net.Interface, pkt []byte, dst net.Addr) error {
	if err := p.SetMulticastInterface(ifc); err != nil {
		return err
	}
	_, err := p.WriteTo(pkt, &ipv6.ControlMessage{IfIndex: ifc.Index}, dst)
	return err
}
