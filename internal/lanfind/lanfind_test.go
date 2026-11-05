//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package lanfind

import (
	"context"
	"errors"
	"fmt"
	"net"
	"net/netip"
	"os"
	"reflect"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/pion/logging"
	"github.com/pion/mdns/v2"
	"golang.org/x/net/dns/dnsmessage"
)

// fakeTransport records what was asked of it and hands its browse handler to
// the test.
type fakeTransport struct {
	host       string
	logs       logging.LoggerFactory
	registered []mdns.ServiceInstance
	browsed    []string
	handler    func(mdns.ServiceEvent)
	closed     int
}

func (f *fakeTransport) Register(svc mdns.ServiceInstance) error {
	f.registered = append(f.registered, svc)
	return nil
}
func (f *fakeTransport) OnServiceDiscovered(h func(mdns.ServiceEvent)) { f.handler = h }
func (f *fakeTransport) Browse(_ context.Context, st string) error {
	f.browsed = append(f.browsed, st)
	return nil
}
func (f *fakeTransport) Close() error { f.closed++; return nil }

func useFake(t *testing.T) *fakeTransport {
	t.Helper()
	f := &fakeTransport{}
	prev := openTransport
	openTransport = func(host string, logs logging.LoggerFactory) (transport, error) {
		f.host, f.logs = host, logs
		return f, nil
	}
	t.Cleanup(func() { openTransport = prev })
	return f
}

// fakeSends stands in for the network an announcement is sent on: one
// interface with addrs, whose sends answer errs (one that is taken while errs
// is empty), recording each packet.
type fakeSends struct {
	addrs   []netip.Addr
	errs    []error
	packets [][]byte
}

func useSends(t *testing.T, addrs []netip.Addr, errs ...error) *fakeSends {
	t.Helper()
	f := &fakeSends{addrs: addrs, errs: errs}
	prev := sendAnnouncement
	sendAnnouncement = func(build func([]netip.Addr) ([]byte, error)) []error {
		pkt, err := build(f.addrs)
		if err != nil {
			return []error{err}
		}
		f.packets = append(f.packets, pkt)
		if len(f.errs) == 0 {
			return []error{nil}
		}
		return f.errs
	}
	t.Cleanup(func() { sendAnnouncement = prev })
	return f
}

// logged records what reaches the log, with a clock the test moves.
type logged struct {
	lines []string
	at    time.Time
}

func useLog(t *testing.T) *logged {
	t.Helper()
	l := &logged{at: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC)}
	prevLog, prevNow := logLine, now
	logLine = func(format string, args ...any) { l.lines = append(l.lines, fmt.Sprintf(format, args...)) }
	now = func() time.Time { return l.at }
	reset := func() { warned.Clear() }
	reset()
	t.Cleanup(func() { logLine, now = prevLog, prevNow; reset() })
	return l
}

// writeFailed is a failed send as the responder's sockets report one.
func writeFailed(errno syscall.Errno) error {
	return &net.OpError{Op: "write", Net: "udp", Err: &os.SyscallError{Syscall: "sendmsg", Err: errno}}
}

// TestAnnounceSaysWhetherTheAnnouncementLeft: an announcement has left when
// a send of it on any interface succeeded. When none did, every send refused
// with "no route to host" is, on macOS, Local Network privacy refusing this
// process (as it does while its prompt is still unanswered, too); anywhere
// else, or for any other error, it is the error itself.
func TestAnnounceSaysWhetherTheAnnouncementLeft(t *testing.T) {
	unreachable, down := writeFailed(syscall.EHOSTUNREACH), writeFailed(syscall.ENETDOWN)
	for _, c := range []struct {
		name   string
		errs   []error
		goos   string
		left   bool
		denied bool
	}{
		{"one interface takes it", []error{unreachable, nil}, "darwin", true, false},
		{"macOS refuses every send", []error{unreachable, unreachable}, "darwin", false, true},
		{"no route anywhere else is the network's", []error{unreachable}, "linux", false, false},
		{"another failure is itself", []error{down}, "darwin", false, false},
		{"no interface to send on", nil, "darwin", false, false},
	} {
		err := outcome(c.errs, c.goos)
		if (err == nil) != c.left || errors.Is(err, ErrLocalNetworkDenied) != c.denied {
			t.Errorf("%s: outcome = %v; want left %v, denied %v", c.name, err, c.left, c.denied)
		}
		if err != nil && !c.denied && len(c.errs) > 0 && !errors.Is(err, c.errs[0]) {
			t.Errorf("%s: outcome = %v, want the send's own error", c.name, err)
		}
	}
}

// TestAnnounceSendsTheServersRecords: an announcement is an unasked mDNS
// response (RFC 6762 §8.3) naming the service, its instance's host, port and
// version, and the host's addresses on the interface it goes out on, the
// instance's own records marked as its alone (cache-flush).
func TestAnnounceSendsTheServersRecords(t *testing.T) {
	useFake(t)
	sends := useSends(t, addrs("192.168.1.4", "fe80::4%en0"))
	ad, err := Advertise("Jules-MBP", 3939, "v1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	defer ad.Stop()
	if err := ad.Announce(); err != nil {
		t.Fatalf("Announce = %v with every send taken", err)
	}
	if len(sends.packets) != 1 {
		t.Fatalf("sent %d announcements, want 1", len(sends.packets))
	}
	var msg dnsmessage.Message
	if err := msg.Unpack(sends.packets[0]); err != nil {
		t.Fatal(err)
	}
	if !msg.Response || !msg.Authoritative || len(msg.Questions) != 0 {
		t.Errorf("header %+v with %d questions, want an authoritative response asking nothing", msg.Header, len(msg.Questions))
	}
	var got []string
	for _, r := range append(msg.Answers, msg.Additionals...) {
		flush := ""
		if r.Header.Class&cacheFlush != 0 {
			flush = " flush"
		}
		var body string
		switch b := r.Body.(type) {
		case *dnsmessage.PTRResource:
			body = b.PTR.String()
		case *dnsmessage.SRVResource:
			body = fmt.Sprintf("%s:%d", b.Target, b.Port)
		case *dnsmessage.TXTResource:
			body = strings.Join(b.TXT, ",")
		case *dnsmessage.AResource:
			body = netip.AddrFrom4(b.A).String()
		case *dnsmessage.AAAAResource:
			body = netip.AddrFrom16(b.AAAA).String()
		}
		got = append(got, fmt.Sprintf("%s %s %d%s %s", r.Header.Name, r.Header.Type, r.Header.TTL, flush, body))
	}
	want := []string{
		"_juggler._tcp.local. TypePTR 120 Jules-MBP._juggler._tcp.local.",
		"Jules-MBP._juggler._tcp.local. TypeSRV 120 flush juggler-jules-mbp.local.:3939",
		"Jules-MBP._juggler._tcp.local. TypeTXT 120 flush v=v1.2.3",
		"juggler-jules-mbp.local. TypeA 120 flush 192.168.1.4",
		"juggler-jules-mbp.local. TypeAAAA 120 flush fe80::4",
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("announced\n %s\nwant\n %s", strings.Join(got, "\n "), strings.Join(want, "\n "))
	}
}

// TestAnnounceReportsRefusedSends: Announce answers how its sends went, every
// time it is asked, so one refused for now is retried and seen to leave once
// it does.
func TestAnnounceReportsRefusedSends(t *testing.T) {
	useFake(t)
	sends := useSends(t, addrs("192.168.1.4"), writeFailed(syscall.EHOSTUNREACH))
	prevOS := goos
	goos = "darwin"
	t.Cleanup(func() { goos = prevOS })
	ad, err := Advertise("Jules-MBP", 3939, "")
	if err != nil {
		t.Fatal(err)
	}
	defer ad.Stop()
	if err := ad.Announce(); !errors.Is(err, ErrLocalNetworkDenied) {
		t.Fatalf("Announce with every send refused = %v, want ErrLocalNetworkDenied", err)
	}
	sends.errs = nil
	if err := ad.Announce(); err != nil {
		t.Errorf("Announce once sends are taken = %v, want nil", err)
	}
}

// TestResponderLogsWarningsRateLimited: the responder's warnings and errors
// reach the log, and its chatter below that does not. A warning repeated (a
// blocked machine fails every answer it sends) is logged once a minute, with
// how many were left out meanwhile. A failed send by the responder marks the
// advertisement for a fresh look until it next announces.
func TestResponderLogsWarningsRateLimited(t *testing.T) {
	f := useFake(t)
	useSends(t, addrs("192.168.1.4"))
	l := useLog(t)
	ad, err := Advertise("Jules-MBP", 3939, "")
	if err != nil {
		t.Fatal(err)
	}
	defer ad.Stop()
	if f.logs == nil {
		t.Fatal("the responder was opened with no logger")
	}
	lg := f.logs.NewLogger("mdns")
	lg.Debugf("writing answer to %s", "224.0.0.251")
	lg.Infof("info %d", 1)
	sendFail := "[%s] failed to send mDNS packet on IPv4 interface %d: %v"
	lg.Warnf(sendFail, "mdns", 14, writeFailed(syscall.EHOSTUNREACH))
	if !ad.SendFailed() {
		t.Error("a failed send by the responder did not mark the advertisement")
	}
	for range 5 {
		lg.Warnf(sendFail, "mdns", 14, writeFailed(syscall.EHOSTUNREACH))
	}
	lg.Errorf("broken: %v", errors.New("x"))
	l.at = l.at.Add(time.Minute)
	lg.Warnf(sendFail, "mdns", 15, writeFailed(syscall.EHOSTUNREACH))
	want := []string{
		"mDNS: [mdns] failed to send mDNS packet on IPv4 interface 14: write udp: sendmsg: no route to host",
		"mDNS: broken: x",
		"mDNS: [mdns] failed to send mDNS packet on IPv4 interface 15: write udp: sendmsg: no route to host (and 5 more like it)",
	}
	if !reflect.DeepEqual(l.lines, want) {
		t.Errorf("logged\n %s\nwant\n %s", strings.Join(l.lines, "\n "), strings.Join(want, "\n "))
	}
	if err := ad.Announce(); err != nil || ad.SendFailed() {
		t.Errorf("after an announcement that left (%v), the advertisement is still marked", err)
	}
	lg.Warnf("[%s] failed to parse mDNS packet %v", "mdns", errors.New("garbage"))
	if ad.SendFailed() {
		t.Error("a packet that did not parse marked the advertisement as failing to send")
	}
}

// TestBrowseNotesFailedSends: a query the browse sends that fails marks it,
// so its owner can open another — one opened while macOS refused this process
// the local network hears nothing even once it is allowed. Anything else the
// responder warns of does not.
func TestBrowseNotesFailedSends(t *testing.T) {
	f := useFake(t)
	useLog(t)
	b, err := Browse()
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	lg := f.logs.NewLogger("mdns")
	lg.Warnf("[%s] failed to parse mDNS packet %v", "mdns", errors.New("garbage"))
	if b.SendFailed() {
		t.Error("a packet that did not parse marked the browse as failing to send")
	}
	lg.Warnf("[%s] failed to send mDNS packet (multicast) on IPv4 interface %d: %v", "mdns", 14, writeFailed(syscall.EHOSTUNREACH))
	if !b.SendFailed() {
		t.Error("a failed query did not mark the browse")
	}
}

func addrs(s ...string) []netip.Addr {
	out := make([]netip.Addr, len(s))
	for i, a := range s {
		out[i] = netip.MustParseAddr(a)
	}
	return out
}

func TestInstanceName(t *testing.T) {
	long := strings.Repeat("é", 40) // 80 bytes
	for _, c := range []struct{ in, want string }{
		{"Jules-MacBook.local", "Jules-MacBook"},
		{"devbox", "devbox"},
		{"  spaced\tout \x07 ", "spacedout"},
		{"", "Juggler"},
		{".local", "Juggler"},
		{long, strings.Repeat("é", 31)},
	} {
		if got := InstanceName(c.in); got != c.want {
			t.Errorf("InstanceName(%q) = %q, want %q", c.in, got, c.want)
		}
		if got := InstanceName(c.in); len(got) > maxInstanceName {
			t.Errorf("InstanceName(%q) is %d bytes, over the DNS-SD limit", c.in, len(got))
		}
	}
}

func TestAdvertiseRegistersTheServerAndStopsOnce(t *testing.T) {
	f := useFake(t)
	ad, err := Advertise("Jules's Mac", 3939, "v1.2.3")
	if err != nil {
		t.Fatal(err)
	}
	stop := ad.Stop
	if f.host != "juggler-jules-s-mac.local" {
		t.Errorf("SRV host = %q, want juggler-jules-s-mac.local", f.host)
	}
	want := []mdns.ServiceInstance{{
		Instance: "Jules's Mac", Service: ServiceType, Host: "juggler-jules-s-mac.local.", Port: 3939,
		Text: []mdns.TXTEntry{mdns.NewTXTString("v", "v1.2.3")},
	}}
	if !reflect.DeepEqual(f.registered, want) {
		t.Errorf("registered %+v, want %+v", f.registered, want)
	}
	stop()
	stop()
	if f.closed != 1 {
		t.Errorf("closed %d times, want 1", f.closed)
	}
}

func TestBrowseSnapshot(t *testing.T) {
	f := useFake(t)
	b, err := Browse()
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(f.browsed, []string{ServiceType}) || f.handler == nil {
		t.Fatalf("browsed %v, handler set %v; want one browse of %s", f.browsed, f.handler != nil, ServiceType)
	}
	ev := func(name string, port uint16, addr, version string) mdns.ServiceEvent {
		e := mdns.ServiceEvent{Instance: mdns.ServiceInstance{Instance: name, Service: ServiceType + ".", Port: port}}
		if addr != "" {
			e.Addr = netip.MustParseAddr(addr)
		}
		if version != "" {
			e.Instance.Text = []mdns.TXTEntry{mdns.NewTXTString("v", version)}
		}
		return e
	}
	f.handler(ev("zed", 3939, "fd00::5", "v1"))
	f.handler(ev("zed", 3939, "::ffff:192.168.1.5", "v2")) // a v4 address, later: sorts first
	f.handler(ev("zed", 3939, "fd00::5", "v2"))            // a repeat adds nothing
	f.handler(ev("Alpha", 4000, "192.168.1.9", ""))
	f.handler(ev("unresolved", 3939, "", ""))
	other := ev("printer", 631, "192.168.1.2", "")
	other.Instance.Service = "_ipp._tcp"
	f.handler(other)

	want := []Found{
		{Name: "Alpha", Addrs: []netip.Addr{netip.MustParseAddr("192.168.1.9")}, Port: 4000},
		{Name: "zed", Addrs: []netip.Addr{netip.MustParseAddr("192.168.1.5"), netip.MustParseAddr("fd00::5")}, Port: 3939, Version: "v2"},
	}
	if got := b.Snapshot(); !reflect.DeepEqual(got, want) {
		t.Errorf("Snapshot() =\n %+v\nwant\n %+v", got, want)
	}
	b.Close()
	if f.closed != 1 {
		t.Errorf("Close closed the transport %d times, want 1", f.closed)
	}
}

// TestBrowseKeepsAtMostMaxFound: anyone on the network can announce, so a
// flood of instances stops being recorded at maxFound; one already recorded
// still takes its new addresses.
func TestBrowseKeepsAtMostMaxFound(t *testing.T) {
	f := useFake(t)
	b, err := Browse()
	if err != nil {
		t.Fatal(err)
	}
	defer b.Close()
	ev := func(name, addr string) mdns.ServiceEvent {
		return mdns.ServiceEvent{
			Instance: mdns.ServiceInstance{Instance: name, Service: ServiceType, Port: 3939},
			Addr:     netip.MustParseAddr(addr),
		}
	}
	for i := range maxFound + 10 {
		f.handler(ev(fmt.Sprintf("flood-%03d", i), "192.168.1.9"))
	}
	f.handler(ev("flood-000", "fd00::9"))
	got := b.Snapshot()
	if len(got) != maxFound {
		t.Fatalf("recorded %d instances, want at most %d", len(got), maxFound)
	}
	if got[0].Name != "flood-000" || len(got[0].Addrs) != 2 {
		t.Errorf("a recorded instance did not take its new address: %+v", got[0])
	}
}
