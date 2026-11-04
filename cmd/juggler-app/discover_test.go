//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"reflect"
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
}

func (f *fakeSource) Snapshot() []lanfind.Found { return f.found }
func (f *fakeSource) Close()                    { f.closed.Add(1) }

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
		{Name: "Alpha", URL: "http://192.168.1.9:3939", Version: "v1.0.0"},
		{Name: "Beta", URL: "http://[fd00::10]:4000", Version: "v1.1.0"},
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
	got, err := f.servers(context.Background())
	if err != nil {
		t.Fatal(err)
	}
	if heldUp.Load() {
		t.Error("the dead address was asked before the live one was")
	}
	want := []foundServer{{Name: "Moved", URL: live, Version: "v1.0.0"}}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("discover listed %+v, want %+v", got, want)
	}
	select {
	case <-calledOff:
	case <-time.After(10 * time.Second):
		t.Error("the ask of the dead address was not called off once the live one answered")
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

// TestDiscoverBrowsesOnce: every ask shares one browse.
func TestDiscoverBrowsesOnce(t *testing.T) {
	starts := 0
	src := &fakeSource{}
	f := &lanFinder{
		browse:     func() (serverSource, error) { starts++; return src, nil },
		localAddrs: func() map[netip.Addr]bool { return nil },
	}
	for range 3 {
		if _, err := f.servers(context.Background()); err != nil {
			t.Fatal(err)
		}
	}
	if starts != 1 || src.closed.Load() != 0 {
		t.Errorf("three asks started %d browses and closed %d, want 1 and 0", starts, src.closed.Load())
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
