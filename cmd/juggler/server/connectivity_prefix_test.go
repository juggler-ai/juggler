//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"juggler/internal/basepath"
)

// TestSessionRelaysTheMachinesPrefix: behind a reverse proxy that mounts the
// machine server under a path, the machine server tells a child that path
// (basepath.MachineHeader), and the child names it, as X-Forwarded-Prefix, on
// every call it relays for the page's switcher — opens, folders and the events
// stream — so the project links those answer with are addressed as the viewer
// reaches them. The calls for LAN access and tunnels never name it: the links
// they answer with reach the machine server directly. A malformed prefix is
// not passed on.
func TestSessionRelaysTheMachinesPrefix(t *testing.T) {
	addr, calls := standInSupervisor(t)
	s := connectivityServer(t, addr)
	for _, c := range []struct {
		method, path, header, want string
	}{
		{http.MethodPost, "/api/machine/sessions", "/juggler", "/juggler"},
		{http.MethodPost, "/api/machine/folders", "/juggler", "/juggler"},
		{http.MethodDelete, "/api/machine/sessions/sess-other", "/juggler", "/juggler"},
		{http.MethodPost, "/api/machine/sessions", "", ""},
		{http.MethodPost, "/api/machine/sessions", "/a b", ""},
		{http.MethodGet, "/api/connectivity/lan", "/juggler", ""},
		{http.MethodGet, "/api/connectivity/tunnel", "/juggler", ""},
	} {
		*calls = nil
		r := localRequest(c.method, c.path, "{}")
		if c.header != "" {
			r.Header.Set(basepath.MachineHeader, c.header)
		}
		s.router.ServeHTTP(httptest.NewRecorder(), r)
		if len(*calls) != 1 || (*calls)[0].prefix != c.want {
			t.Errorf("%s %s with the machine's prefix %q: machine server got %+v, want the prefix %q", c.method, c.path, c.header, *calls, c.want)
		}
	}

	sup := newStreamingSupervisor(t)
	streaming := connectivityServer(t, sup.addr)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := localRequest(http.MethodGet, "/api/machine/events", "").WithContext(ctx)
	r.Header.Set(basepath.MachineHeader, "/juggler")
	go streaming.router.ServeHTTP(httptest.NewRecorder(), r)
	select {
	case call := <-sup.calls:
		if call.prefix != "/juggler" {
			t.Errorf("the events stream was asked for with the prefix %q, want %q", call.prefix, "/juggler")
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the machine server was never asked for its events")
	}
}
