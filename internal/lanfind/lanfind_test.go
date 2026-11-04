//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package lanfind

import (
	"context"
	"fmt"
	"net/netip"
	"reflect"
	"strings"
	"testing"

	"github.com/pion/mdns/v2"
)

// fakeTransport records what was asked of it and hands its browse handler to
// the test.
type fakeTransport struct {
	host       string
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
	openTransport = func(host string) (transport, error) { f.host = host; return f, nil }
	t.Cleanup(func() { openTransport = prev })
	return f
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
	stop, err := Advertise("Jules's Mac", 3939, "v1.2.3")
	if err != nil {
		t.Fatal(err)
	}
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
