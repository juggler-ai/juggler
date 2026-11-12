//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"reflect"
	"slices"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"juggler/internal/lanfind"
)

// fakeSource is a browse that has found what it was given.
type fakeSource struct {
	found  []lanfind.Found
	closed atomic.Int32
	failed atomic.Bool
}

func (f *fakeSource) Snapshot() []lanfind.Found { return f.found }
func (f *fakeSource) Close()                    { f.closed.Add(1) }
func (f *fakeSource) SendFailed() bool          { return f.failed.Load() }

func addrs(s ...string) []netip.Addr {
	out := make([]netip.Addr, len(s))
	for i, a := range s {
		out[i] = netip.MustParseAddr(a)
	}
	return out
}

// TestDiscoverListsTheServersThatAnswer: the discover action lists each server
// found on the network at the first of its addresses that answers as a Juggler
// server, with the version that answer gave. A server on this machine's own
// address is this machine's and is not listed; one whose addresses do not
// answer is gone (or never was) and is not listed either.
func TestDiscoverListsTheServersThatAnswer(t *testing.T) {
	src := &fakeSource{found: []lanfind.Found{
		{Name: "Alpha", Addrs: addrs("192.168.1.9", "fd00::9"), Port: 3939, Version: "announced"},
		{Name: "Beta", Addrs: addrs("192.168.1.10", "fd00::10"), Port: 4000},
		{Name: "Gone", Addrs: addrs("192.168.1.11"), Port: 3939},
		{Name: "Me", Addrs: addrs("192.168.1.2"), Port: 3939},
	}}
	answers := map[string]string{
		"http://192.168.1.9:3939": "v1.0.0",
		"http://[fd00::10]:4000":  "v1.1.0", // Beta's IPv4 address does not answer
	}
	var asked []string
	askedCh := make(chan string, 16)
	a := newTestAppState(t)
	a.finder = &lanFinder{
		browse: func() (serverSource, error) { return src, nil },
		probe: func(_ context.Context, u string) (string, bool) {
			askedCh <- u
			v, ok := answers[u]
			return v, ok
		},
		localAddrs: func() map[netip.Addr]bool { return map[netip.Addr]bool{netip.MustParseAddr("192.168.1.2"): true} },
	}
	registerTestWindow(a, "w1")

	rec := controlRequest(a, http.MethodPost, "/win/w1/discover")
	close(askedCh)
	for u := range askedCh {
		asked = append(asked, u)
	}
	if rec.Code != http.StatusOK {
		t.Fatalf("discover = %d %s, want 200", rec.Code, rec.Body)
	}
	var got struct{ Servers []foundServer }
	if err := json.Unmarshal(rec.Body.Bytes(), &got); err != nil {
		t.Fatal(err)
	}
	want := []foundServer{
		{Name: "Alpha", URL: "http://192.168.1.9:3939", URLs: []string{"http://192.168.1.9:3939", "http://[fd00::9]:3939"}, Version: "v1.0.0"},
		{Name: "Beta", URL: "http://[fd00::10]:4000", URLs: []string{"http://192.168.1.10:4000", "http://[fd00::10]:4000"}, Version: "v1.1.0"},
	}
	if !reflect.DeepEqual(got.Servers, want) {
		t.Errorf("discover listed %+v, want %+v", got.Servers, want)
	}
	for _, u := range asked {
		if strings.Contains(u, "192.168.1.2:") {
			t.Errorf("asked this machine's own server, %s", u)
		}
	}
}

// TestDiscoverDoesNotWaitOnADeadAddress: a server's addresses are asked at
// once, and the first to answer is the one listed, so an address that does not
// answer (one the server had before it moved) costs the ask nothing while
// another answers; the asks still out are called off.
func TestDiscoverDoesNotWaitOnADeadAddress(t *testing.T) {
	const live = "http://[fd00::9]:3939"
	liveAsked, calledOff := make(chan struct{}), make(chan struct{})
	var heldUp atomic.Bool
	f := &lanFinder{
		browse: func() (serverSource, error) {
			return &fakeSource{found: []lanfind.Found{{Name: "Moved", Addrs: addrs("192.168.1.9", "fd00::9"), Port: 3939}}}, nil
		},
		probe: func(ctx context.Context, u string) (string, bool) {
			if u == live {
				close(liveAsked)
				return "v1.0.0", true
			}
			select {
			case <-liveAsked:
			case <-time.After(10 * time.Second):
				heldUp.Store(true)
				return "", false
			}
			<-ctx.Done()
			close(calledOff)
			return "", false
		},
		localAddrs: func() map[netip.Addr]bool { return nil },
	}
	got, _, err := f.servers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if heldUp.Load() {
		t.Error("the dead address was asked before the live one was")
	}
	want := []foundServer{{Name: "Moved", URL: live, URLs: []string{"http://192.168.1.9:3939", live}, Version: "v1.0.0"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("discover listed %+v, want %+v", got, want)
	}
	select {
	case <-calledOff:
	case <-time.After(10 * time.Second):
		t.Error("the ask of the dead address was not called off once the live one answered")
	}
}

// TestDiscoverKeepsTheAddressItListed: a server answering at several addresses
// is listed at the one it was listed at before, whichever answers first, so a
// window on it stays the server listed as current; and its row names every
// address it was announced at, the window's among them, whichever that is.
func TestDiscoverKeepsTheAddressItListed(t *testing.T) {
	const v4, v6 = "http://192.168.1.9:3939", "http://[fd00::9]:3939"
	// first is the address that answers first on each ask; the other is slower,
	// answering only once the lead's probe has returned. While nothing is
	// listed (unlisted) the ask has no address to wait for and takes the first
	// answer to reach it, and a probe's return is not its answer reaching the
	// ask — so there the slower address answers only once the ask has been
	// called off, which is the lead's answer taken.
	var first atomic.Value
	first.Store(v4)
	var unlisted atomic.Bool
	answered := map[string]chan struct{}{}
	f := &lanFinder{
		browse: func() (serverSource, error) {
			return &fakeSource{found: []lanfind.Found{{Name: "Box", Addrs: addrs("192.168.1.9", "fd00::9"), Port: 3939}}}, nil
		},
		probe: func(ctx context.Context, u string) (string, bool) {
			lead := first.Load().(string)
			if u == lead {
				defer close(answered[lead])
				return "v1", true
			}
			if unlisted.Load() {
				<-ctx.Done()
				return "", false
			}
			select {
			case <-answered[lead]:
				return "v1", true
			case <-ctx.Done():
				return "", false
			}
		},
		localAddrs: func() map[netip.Addr]bool { return nil },
	}
	unlisted.Store(true)
	for i, lead := range []string{v4, v6, v6} {
		first.Store(lead)
		answered[lead] = make(chan struct{})
		got, _, err := f.servers(context.Background())
		unlisted.Store(false)
		if err != nil {
			t.Fatal(err)
		}
		if len(got) != 1 || got[0].URL != v4 {
			t.Fatalf("ask %d, with %s answering first, listed %+v; want Box at %s, as first listed", i+1, lead, got, v4)
		}
	}

	a := newTestAppState(t)
	a.finder = f
	registerTestWindow(a, "w1")
	first.Store(v4)
	answered[v4] = make(chan struct{})
	var listed struct {
		Servers []map[string]any `json:"servers"`
	}
	if err := json.Unmarshal(controlRequest(a, http.MethodPost, "/win/w1/discover").Body.Bytes(), &listed); err != nil {
		t.Fatal(err)
	}
	if len(listed.Servers) != 1 || !reflect.DeepEqual(listed.Servers[0]["urls"], []any{v4, v6}) {
		t.Errorf("discover listed %+v; want Box's row to name both its addresses", listed.Servers)
	}
}

// TestDiscoverForgivesAMissedAnswer: a server listed before that misses an
// ask's probe — busy, or a packet lost — is still listed as it was, until it
// has missed missesForgiven asks in a row; one that answers again is listed
// again, and a server never yet listed is not listed for being announced.
func TestDiscoverForgivesAMissedAnswer(t *testing.T) {
	var answers atomic.Bool
	f := &lanFinder{
		browse: func() (serverSource, error) {
			return &fakeSource{found: []lanfind.Found{{Name: "Box", Addrs: addrs("192.168.1.9"), Port: 3939}}}, nil
		},
		probe:      func(context.Context, string) (string, bool) { return "v1", answers.Load() },
		localAddrs: func() map[netip.Addr]bool { return nil },
	}
	ask := func() int {
		got, _, err := f.servers(context.Background())
		if err != nil {
			t.Fatal(err)
		}
		return len(got)
	}
	if n := ask(); n != 0 {
		t.Fatalf("a server that never answered is listed (%d)", n)
	}
	answers.Store(true)
	if n := ask(); n != 1 {
		t.Fatalf("a server that answers is not listed (%d)", n)
	}
	answers.Store(false)
	for i := range missesForgiven {
		if n := ask(); n != 1 {
			t.Fatalf("missed ask %d of %d forgiven dropped the server", i+1, missesForgiven)
		}
	}
	if n := ask(); n != 0 {
		t.Fatalf("a server that missed %d asks in a row is still listed", missesForgiven+1)
	}
	answers.Store(true)
	if n := ask(); n != 1 {
		t.Fatalf("a server that answers again is not listed (%d)", n)
	}
}

// TestDiscoverSkipsLinkLocalAddresses: a link-local IPv6 address is usable
// only with its zone, and a URL cannot carry one that a window's web view will
// open, so neither a zoned nor a bare one is asked or listed — the server is
// listed at an address it has that a window can open.
func TestDiscoverSkipsLinkLocalAddresses(t *testing.T) {
	asked := make(chan string, 4)
	f := &lanFinder{
		browse: func() (serverSource, error) {
			return &fakeSource{found: []lanfind.Found{
				{Name: "Near", Addrs: addrs("192.168.1.9", "fe80::9%en0", "fe80::10"), Port: 3939},
				{Name: "OnlyLinkLocal", Addrs: addrs("fe80::11%en0"), Port: 3939},
			}}, nil
		},
		probe: func(_ context.Context, u string) (string, bool) {
			asked <- u
			return "v1.0.0", true
		},
		localAddrs: func() map[netip.Addr]bool { return nil },
	}
	got, _, err := f.servers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	close(asked)
	var urls []string
	for u := range asked {
		urls = append(urls, u)
	}
	if !reflect.DeepEqual(urls, []string{"http://192.168.1.9:3939"}) {
		t.Fatalf("asked %q, want only the IPv4 address", urls)
	}
	want := []foundServer{{Name: "Near", URL: "http://192.168.1.9:3939", URLs: []string{"http://192.168.1.9:3939"}, Version: "v1.0.0"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("listed %+v, want %+v", got, want)
	}
}

// TestDiscoverListsTheServersWindowsWereOn: a server a window has been on this
// run is listed while it answers, as the name it answered with, whether or not
// the network announces it — so one whose announcements never arrive can be
// switched back to — and even when no browse can start. One also announced is
// listed once, as announced; one that does not answer is not listed.
func TestDiscoverListsTheServersWindowsWereOn(t *testing.T) {
	announced := serverByURL(t, true, nil)
	byURL := serverByURL(t, true, nil)
	down := addressWithNoServer(t)
	host, port, err := net.SplitHostPort(strings.TrimPrefix(announced, "http://"))
	if err != nil {
		t.Fatal(err)
	}
	portNum, err := strconv.Atoi(port)
	if err != nil {
		t.Fatal(err)
	}
	var browseFails atomic.Bool
	a := newTestAppState(t)
	a.finder = &lanFinder{
		browse: func() (serverSource, error) {
			if browseFails.Load() {
				return nil, errors.New("no route to host")
			}
			return &fakeSource{found: []lanfind.Found{{Name: "Announced", Addrs: addrs(host), Port: portNum}}}, nil
		},
		probe:      probeVersion,
		localAddrs: func() map[netip.Addr]bool { return nil },
	}
	localServer(t, a)
	for _, u := range []string{announced, byURL, down} {
		a.planWindow(windowSpec{url: u, connected: true}, windowOpts{})
	}
	// A window onto a server that never answered leaves nothing to ask after:
	// every ask would wait out its probe.
	if p := a.finder.visited.Load(); p == nil || slices.ContainsFunc(*p, func(v visit) bool { return v.url == down }) {
		t.Errorf("remembered %+v; want the servers that answered, and not %s", p, down)
	}
	registerTestWindow(a, "w1")
	discover := func() []foundServer {
		t.Helper()
		rec := controlRequest(a, http.MethodPost, "/win/w1/discover")
		var got struct{ Servers []foundServer }
		if rec.Code != http.StatusOK || json.Unmarshal(rec.Body.Bytes(), &got) != nil {
			t.Fatalf("discover = %d %s, want 200", rec.Code, rec.Body)
		}
		return got.Servers
	}

	browseFails.Store(true)
	want := []foundServer{
		{Name: byURLName, URL: announced, URLs: []string{announced}, Version: "v1.0.0"},
		{Name: byURLName, URL: byURL, URLs: []string{byURL}, Version: "v1.0.0"},
	}
	if got := discover(); !reflect.DeepEqual(got, want) {
		t.Errorf("with no browse, discover listed %+v, want %+v", got, want)
	}

	browseFails.Store(false)
	want = []foundServer{
		{Name: "Announced", URL: announced, URLs: []string{announced}, Version: "v1.0.0"},
		{Name: byURLName, URL: byURL, URLs: []string{byURL}, Version: "v1.0.0"},
	}
	if got := discover(); !reflect.DeepEqual(got, want) {
		t.Errorf("discover listed %+v, want %+v", got, want)
	}
}

// TestDiscoverListsAServerVisitedAtAnotherAddressOnce: a server a window was on
// at an address it does not announce — its hostname, say — is the server the
// network announces under the name and port it answered with, so it is listed
// once, as announced, with the window's address among its addresses for the
// page to match the window against. Another server of that name, on another
// port, is another server; and one announced but not answering at what it
// announced is listed at the address the window reached it at.
func TestDiscoverListsAServerVisitedAtAnotherAddressOnce(t *testing.T) {
	const (
		ip       = "http://192.168.1.9:3939"
		hostname = "http://box.lan:3939"
		other    = "http://box.lan:4000"
	)
	var announcedAnswers atomic.Bool
	announcedAnswers.Store(true)
	f := &lanFinder{
		browse: func() (serverSource, error) {
			return &fakeSource{found: []lanfind.Found{{Name: "Box", Addrs: addrs("192.168.1.9"), Port: 3939}}}, nil
		},
		probe: func(_ context.Context, u string) (string, bool) {
			return "v1", u != ip || announcedAnswers.Load()
		},
		localAddrs: func() map[netip.Addr]bool { return nil },
	}
	f.remember(hostname, "Box")
	f.remember(other, "Box")
	got, _, err := f.servers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	want := []foundServer{
		{Name: "Box", URL: ip, URLs: []string{ip, hostname}, Version: "v1"},
		{Name: "Box", URL: other, URLs: []string{other}, Version: "v1"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("listed %+v, want %+v", got, want)
	}

	announcedAnswers.Store(false)
	for range missesForgiven + 1 {
		if got, _, err = f.servers(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	want = []foundServer{
		{Name: "Box", URL: hostname, URLs: []string{hostname}, Version: "v1"},
		{Name: "Box", URL: other, URLs: []string{other}, Version: "v1"},
	}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("with the announced address silent, listed %+v, want %+v", got, want)
	}
}

// TestDiscoverWithNoBrowseListsNothing: a browse that cannot start answers an
// empty list, not an error — the page offers its address field either way —
// and the next ask tries again, as permission to use the network may since
// have been given.
func TestDiscoverWithNoBrowseListsNothing(t *testing.T) {
	tries := 0
	a := newTestAppState(t)
	a.finder = &lanFinder{
		browse:     func() (serverSource, error) { tries++; return nil, errors.New("no route to host") },
		localAddrs: func() map[netip.Addr]bool { return nil },
	}
	registerTestWindow(a, "w1")
	for range 2 {
		rec := controlRequest(a, http.MethodPost, "/win/w1/discover")
		if rec.Code != http.StatusOK || strings.TrimSpace(rec.Body.String()) != `{"servers":[]}` {
			t.Fatalf("discover with no browse = %d %s, want 200 with no servers", rec.Code, rec.Body)
		}
	}
	if tries != 2 {
		t.Errorf("browse tried %d times over two asks, want 2", tries)
	}
}

// TestDiscoverNamesTheFirewallWhenItHearsOnlyItself: on Linux, where a host
// firewall drops other computers' answers unseen, an ask whose browse has heard
// no server but this machine's says so (firewall), so the page can say what to
// let in. One that heard another server — listed or not — says nothing of it,
// nor does one on another system, nor one whose browse could not start.
func TestDiscoverNamesTheFirewallWhenItHearsOnlyItself(t *testing.T) {
	prev := discoverOS
	t.Cleanup(func() { discoverOS = prev })
	me := lanfind.Found{Name: "Me", Addrs: addrs("192.168.1.2"), Port: 3939}
	other := lanfind.Found{Name: "Other", Addrs: addrs("192.168.1.9"), Port: 3939}
	ask := func(goos string, found []lanfind.Found, browseErr error) string {
		t.Helper()
		discoverOS = goos
		a := newTestAppState(t)
		a.finder = &lanFinder{
			browse: func() (serverSource, error) {
				if browseErr != nil {
					return nil, browseErr
				}
				return &fakeSource{found: found}, nil
			},
			probe:      func(context.Context, string) (string, bool) { return "", false },
			localAddrs: func() map[netip.Addr]bool { return map[netip.Addr]bool{netip.MustParseAddr("192.168.1.2"): true} },
		}
		registerTestWindow(a, "w1")
		rec := controlRequest(a, http.MethodPost, "/win/w1/discover")
		if rec.Code != http.StatusOK {
			t.Fatalf("discover = %d %s, want 200", rec.Code, rec.Body)
		}
		return strings.TrimSpace(rec.Body.String())
	}
	for _, c := range []struct {
		what  string
		goos  string
		found []lanfind.Found
		err   error
		want  string
	}{
		{"linux, heard only itself", "linux", []lanfind.Found{me}, nil, `{"firewall":true,"servers":[]}`},
		{"linux, heard nothing", "linux", nil, nil, `{"firewall":true,"servers":[]}`},
		{"linux, heard another that did not answer", "linux", []lanfind.Found{me, other}, nil, `{"servers":[]}`},
		{"linux, no browse", "linux", nil, errors.New("no route to host"), `{"servers":[]}`},
		{"darwin, heard only itself", "darwin", []lanfind.Found{me}, nil, `{"servers":[]}`},
		{"windows, heard only itself", "windows", []lanfind.Found{me}, nil, `{"servers":[]}`},
	} {
		if got := ask(c.goos, c.found, c.err); got != c.want {
			t.Errorf("%s: discover = %s, want %s", c.what, got, c.want)
		}
	}
}

// TestDiscoverBrowsesOnce: every ask shares one browse.
func TestDiscoverBrowsesOnce(t *testing.T) {
	starts := 0
	src := &fakeSource{}
	f := &lanFinder{
		browse:     func() (serverSource, error) { starts++; return src, nil },
		localAddrs: func() map[netip.Addr]bool { return nil },
	}
	for range 3 {
		if _, _, err := f.servers(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if starts != 1 || src.closed.Load() != 0 {
		t.Errorf("three asks started %d browses and closed %d, want 1 and 0", starts, src.closed.Load())
	}
}

// TestDiscoverReopensABrowseThatCannotSend: a browse whose queries failed and
// that has found nothing — opened while macOS refused the app the local
// network, as at the first ask, when its prompt comes up — is closed at the
// next ask and another opened, so the one opened once the user allows it
// hears answers. A browse that has found servers is hearing, and is kept
// whatever its sends did.
func TestDiscoverReopensABrowseThatCannotSend(t *testing.T) {
	deaf := &fakeSource{}
	deaf.failed.Store(true)
	hearing := &fakeSource{found: []lanfind.Found{{Name: "Box", Addrs: addrs("192.168.1.9"), Port: 3939}}}
	hearing.failed.Store(true)
	sources := []*fakeSource{deaf, hearing}
	starts := 0
	f := &lanFinder{
		browse: func() (serverSource, error) {
			src := sources[min(starts, len(sources)-1)]
			starts++
			return src, nil
		},
		probe:      func(context.Context, string) (string, bool) { return "v1", true },
		localAddrs: func() map[netip.Addr]bool { return nil },
	}
	if _, _, err := f.servers(context.Background()); err != nil {
		t.Fatal(err)
	}
	got, _, err := f.servers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if starts != 2 || deaf.closed.Load() != 1 {
		t.Fatalf("after a browse that found nothing failed to send: %d browses started, the first closed %d times; want 2 and 1", starts, deaf.closed.Load())
	}
	if len(got) != 1 || got[0].Name != "Box" {
		t.Errorf("the reopened browse lists %+v, want Box", got)
	}
	for range 3 {
		if _, _, err := f.servers(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if starts != 2 || hearing.closed.Load() != 0 {
		t.Errorf("a browse that has found servers was reopened: %d started, closed %d times", starts, hearing.closed.Load())
	}
}

// TestProbeVersionWantsAJugglerAnswer: a server is taken as one only when its
// GET /api/version answers 200 with a version.
func TestProbeVersionWantsAJugglerAnswer(t *testing.T) {
	for _, c := range []struct {
		name, body string
		status     int
		want       string
		ok         bool
	}{
		{"a Juggler server", `{"version":"v1.2.3","protocolVersion":1}`, 200, "v1.2.3", true},
		{"something else on the port", `<html>`, 200, "", false},
		{"no version", `{}`, 200, "", false},
		{"LAN access off", `{"error":"x"}`, 403, "", false},
	} {
		srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/api/version" {
				http.NotFound(w, r)
				return
			}
			w.WriteHeader(c.status)
			_, _ = w.Write([]byte(c.body))
		}))
		v, ok := probeVersion(context.Background(), srv.URL)
		srv.Close()
		if v != c.want || ok != c.ok {
			t.Errorf("%s: probe = %q, %v; want %q, %v", c.name, v, ok, c.want, c.ok)
		}
	}
}

// TestProbeVersionFollowsNoRedirect: an address that redirects is not taken as
// a Juggler server, even to one: the row would show, and Connect would open,
// the address that redirected, not the one that answered.
func TestProbeVersionFollowsNoRedirect(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, _ = w.Write([]byte(`{"version":"v1.2.3"}`))
	}))
	defer server.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, server.URL+"/api/version", http.StatusFound)
	}))
	defer redirect.Close()
	if v, ok := probeVersion(context.Background(), redirect.URL); ok {
		t.Errorf("a redirect to a Juggler server was taken as one, version %q", v)
	}
}
