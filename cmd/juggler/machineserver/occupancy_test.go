//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

// occupiedServer is an implicit server with no sessions, clients or ways in,
// its listener, and a client of it.
func occupiedServer(t *testing.T) (*Server, *Client) {
	t.Helper()
	s := &Server{reg: newRegistry(), token: testToken, implicit: true, shutdownReq: make(chan struct{}, 1)}
	front := httptest.NewServer(s.routes())
	t.Cleanup(front.Close)
	s.addr = front.Listener.Addr().String()
	t.Cleanup(s.endLifetime)
	return s, &Client{addr: s.addr, token: testToken, http: &http.Client{Timeout: 5 * time.Second}}
}

// postShutdown posts body to the server's shutdown route and returns the
// status and the body it answered with.
func postShutdown(t *testing.T, s *Server, body string) (int, string) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, "http://"+s.addr+"/api/server/shutdown", strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(TokenHeader, testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	return resp.StatusCode, string(data)
}

// TestAShutdownIfIdleRefusesAnOccupiedServer: a shutdown asked only if the
// server holds nothing more than expected ({"expect": {}} is nothing at all)
// shuts down an idle server, and refuses with 409 and what it holds one with a
// session, an attached client, a starter still to attach, LAN access, a tunnel,
// or that was started by hand — leaving it running, its lifetime whole.
func TestAShutdownIfIdleRefusesAnOccupiedServer(t *testing.T) {
	for _, c := range []struct {
		name   string
		occupy func(*Server)
		want   int
	}{
		{"idle", func(*Server) {}, http.StatusAccepted},
		{"a session", func(s *Server) { s.reg.reserve("/work/alpha") }, http.StatusConflict},
		{"an attached client", func(s *Server) { s.attach() }, http.StatusConflict},
		{"a starter yet to attach", func(s *Server) { s.starter = os.Getpid() }, http.StatusConflict},
		{"LAN on", func(s *Server) { s.lan.Store(true) }, http.StatusConflict},
		{"a tunnel", func(s *Server) { s.tunnel.Store(&runningTunnel{mode: "p2p"}) }, http.StatusConflict},
		{"started by hand", func(s *Server) { s.implicit = false }, http.StatusConflict},
	} {
		t.Run(c.name, func(t *testing.T) {
			s, _ := occupiedServer(t)
			c.occupy(s)
			code, body := postShutdown(t, s, `{"expect":{}}`)
			if code != c.want {
				t.Fatalf("shutdown if idle: %d %s, want %d", code, body, c.want)
			}
			if c.want == http.StatusAccepted {
				if len(s.shutdownReq) != 1 || s.lifetime().Err() == nil {
					t.Fatalf("an idle server accepted the shutdown but did not begin it")
				}
				return
			}
			if len(s.shutdownReq) != 0 || s.lifetime().Err() != nil {
				t.Fatalf("an occupied server refused the shutdown but began it anyway")
			}
			var refusal struct {
				Occupancy *Occupancy `json:"occupancy"`
			}
			if err := json.Unmarshal([]byte(body), &refusal); err != nil || refusal.Occupancy == nil || refusal.Occupancy.Idle() {
				t.Fatalf("refusal %s: want what the server holds, which is not idle", body)
			}
		})
	}
}

// TestAShutdownIfCoveredStopsOnlyWhatTheUserWasShown: a restart the user
// confirmed stops the sessions and clients they were shown, and is refused
// once the server holds more — another session, another client, a way in.
// Sessions that went since are no reason to refuse.
func TestAShutdownIfCoveredStopsOnlyWhatTheUserWasShown(t *testing.T) {
	s, c := occupiedServer(t)
	a, _ := s.reg.reserve("/work/alpha")
	b, _ := s.reg.reserve("/work/beta")
	shown, err := c.Occupancy()
	if err != nil {
		t.Fatal(err)
	}
	if len(shown.Sessions) != 2 {
		t.Fatalf("occupancy %+v, want both sessions", shown)
	}
	s.reg.remove(b.ID)
	_, _ = s.reg.reserve("/work/gamma")
	var occupied *OccupiedError
	if err := c.ShutdownIf(shown); !errors.As(err, &occupied) || len(occupied.Now.Sessions) != 2 || len(s.shutdownReq) != 0 {
		t.Fatalf("shutdown with a session the user was not shown: %v; want refused, with what it holds now", err)
	}
	if _, ok := s.reg.get(a.ID); !ok {
		t.Fatal("a refused shutdown stopped a session")
	}
	if err := c.ShutdownIf(occupied.Now); err != nil || len(s.shutdownReq) != 1 {
		t.Fatalf("shutdown covering what it holds: %v, signalled %v; want it begun", err, len(s.shutdownReq) == 1)
	}
}

// TestASessionOpenedAfterTheLookSurvivesAReplacement: a client that read the
// server idle and asks for a shutdown if it still is, after a session has
// opened in between, is refused, and the session runs on. Once an idle
// shutdown has begun, nothing more opens or attaches: the decision and the
// lifetime's end are one step on the registry.
func TestASessionOpenedAfterTheLookSurvivesAReplacement(t *testing.T) {
	s, c := occupiedServer(t)
	seen, err := c.Occupancy()
	if err != nil || !seen.Idle() {
		t.Fatalf("occupancy %+v, %v; want idle", seen, err)
	}
	sess, _ := s.reg.reserve("/work/alpha")
	var occupied *OccupiedError
	if err := c.ShutdownIf(Occupancy{}); !errors.As(err, &occupied) {
		t.Fatalf("shutdown if idle after a session opened: %v; want refused", err)
	}
	if _, ok := s.reg.get(sess.ID); !ok || len(s.shutdownReq) != 0 {
		t.Fatal("the session opened after the look did not survive")
	}

	s2, c2 := occupiedServer(t)
	if err := c2.ShutdownIf(Occupancy{}); err != nil {
		t.Fatalf("shutdown if idle: %v", err)
	}
	if res := s2.openSession(t.Context(), t.TempDir(), false); res.status != http.StatusServiceUnavailable {
		t.Fatalf("open after an idle shutdown began: %d, want 503", res.status)
	}
	if _, err := c2.Attach(); !ServerGoing(err) {
		t.Fatalf("attach after an idle shutdown began: %v, want the server going", err)
	}
}

// TestReplacementIsAllowedOnlyForAnIdleClientStartedServer is the policy
// itself: a client replaces a server of another build without asking only when
// a client started it on demand and nothing is using it. Anything else is the
// user's to decide, told every thing a restart stops.
func TestReplacementIsAllowedOnlyForAnIdleClientStartedServer(t *testing.T) {
	for _, c := range []struct {
		name  string
		occ   Occupancy
		idle  bool
		stops []string
	}{
		{"nothing", Occupancy{}, true, nil},
		{"sessions", Occupancy{Sessions: []Session{{Project: "/work/alpha"}, {Project: "/work/beta"}}}, false, []string{"2 sessions", "/work/alpha", "/work/beta"}},
		{"a client", Occupancy{Clients: 1}, false, []string{"1 other app or terminal"}},
		{"LAN", Occupancy{LAN: true}, false, []string{"LAN access"}},
		{"a tunnel", Occupancy{Tunnel: "p2p"}, false, []string{"p2p"}},
		{"by hand", Occupancy{HandStarted: true}, false, []string{"juggler serve"}},
	} {
		t.Run(c.name, func(t *testing.T) {
			if c.occ.Idle() != c.idle {
				t.Fatalf("Idle() = %v, want %v", c.occ.Idle(), c.idle)
			}
			var text strings.Builder
			for _, m := range c.occ.Stops() {
				text.WriteString(m.English() + "\n")
			}
			if c.idle && text.Len() != 0 {
				t.Fatalf("an idle server stops %q, want nothing", text.String())
			}
			for _, want := range c.stops {
				if !strings.Contains(text.String(), want) {
					t.Errorf("stops %q, want it to say %q", text.String(), want)
				}
			}
		})
	}

	shown := Occupancy{Sessions: []Session{{ID: "a"}, {ID: "b"}}, Clients: 1, LAN: true, Tunnel: "p2p", HandStarted: true}
	for _, c := range []struct {
		name   string
		now    Occupancy
		covers bool
	}{
		{"the same", shown, true},
		{"less", Occupancy{Sessions: []Session{{ID: "a"}}}, true},
		{"another session", Occupancy{Sessions: []Session{{ID: "c"}}}, false},
		{"another client", Occupancy{Clients: 2}, false},
		{"another tunnel", Occupancy{Tunnel: "cloudflared"}, false},
	} {
		if got := shown.Covers(c.now); got != c.covers {
			t.Errorf("Covers(%s) = %v, want %v", c.name, got, c.covers)
		}
	}
	if (Occupancy{}).Covers(Occupancy{LAN: true}) || (Occupancy{}).Covers(Occupancy{HandStarted: true}) {
		t.Error("nothing covers LAN access, or a server started by hand")
	}
}
