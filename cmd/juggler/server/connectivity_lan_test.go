//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/mux"

	"juggler/internal/basepath"
	"juggler/internal/ingress"
)

// supervisorCall is one request a stand-in machine server received.
type supervisorCall struct {
	method, path, query, token, body string
	// prefix is the X-Forwarded-Prefix the call carried: where the viewer
	// reached the machine server.
	prefix string
}

// standInSupervisor serves the machine server's /api/server/lan and
// /api/server/tunnel, recording each call, and answers with its path.
func standInSupervisor(t *testing.T) (addr string, calls *[]supervisorCall) {
	t.Helper()
	var got []supervisorCall
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got = append(got, supervisorCall{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("X-Juggler-Token"), string(b), r.Header.Get(basepath.Header)})
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTeapot)
		_, _ = io.WriteString(w, `{"from":"`+r.URL.Path+`"}`)
	}))
	t.Cleanup(srv.Close)
	return strings.TrimPrefix(srv.URL, "http://"), &got
}

// connectivityServer is a server with only its connectivity routes, told of a
// machine server at addr ("" for none).
func connectivityServer(t *testing.T, addr string) *Server {
	t.Helper()
	s := newTestServerState(t)
	s.router = mux.NewRouter()
	if addr != "" {
		s.supervisor = Supervisor{Addr: addr, Token: "control-token", Session: "sess-1"}
	}
	s.setupConnectivityRoutes()
	return s
}

// localRequest is a request from a viewer on this machine; remoteRequest one
// the machine server forwarded from a caller off it.
func localRequest(method, path, body string) *http.Request {
	r := httptest.NewRequest(method, path, strings.NewReader(body))
	r.RemoteAddr = "127.0.0.1:50000"
	return r
}

func remoteRequest(method, path, body string) *http.Request {
	return MarkRemoteIngress(localRequest(method, path, body), supervisorIngressKind)
}

// TestSessionExposureIsTheMachineServers: LAN access and tunnels belong to the
// machine server, as does which of them opens whenever Juggler starts, and a
// session's viewer on this machine switches and saves them from the session's
// Settings → Connectivity. The child passes those calls to its
// machine server with the control token, which stays in the child, naming its
// session, so the answer carries the links that open it. A viewer
// off this machine is refused, as the machine server refuses one, and a child
// with no machine server has no exposure to offer.
func TestSessionExposureIsTheMachineServers(t *testing.T) {
	addr, calls := standInSupervisor(t)
	s := connectivityServer(t, addr)

	for _, c := range []struct{ method, path, body, want string }{
		{http.MethodGet, "/api/connectivity/lan", "", "/api/server/lan"},
		{http.MethodPut, "/api/connectivity/lan", `{"enabled":true}`, "/api/server/lan"},
		{http.MethodGet, "/api/connectivity/tunnel", "", "/api/server/tunnel"},
		{http.MethodPut, "/api/connectivity/tunnel", `{"mode":"p2p"}`, "/api/server/tunnel"},
		{http.MethodGet, "/api/connectivity/launch", "", "/api/server/launch"},
		{http.MethodPut, "/api/connectivity/launch", `{"lanOnLaunch":true}`, "/api/server/launch"},
		// Who started the machine server, which the tab says beside them.
		{http.MethodGet, "/api/connectivity/server", "", "/api/server/status"},
	} {
		*calls = nil
		rec := httptest.NewRecorder()
		s.router.ServeHTTP(rec, localRequest(c.method, c.path, c.body))
		if rec.Code != http.StatusTeapot || !strings.Contains(rec.Body.String(), c.want) {
			t.Fatalf("%s %s from this machine: %d %s, want the machine server's answer", c.method, c.path, rec.Code, rec.Body)
		}
		want := supervisorCall{method: c.method, path: c.want, query: "session=sess-1", token: "control-token", body: c.body}
		if len(*calls) != 1 || (*calls)[0] != want {
			t.Fatalf("%s %s: machine server got %+v, want %+v", c.method, c.path, *calls, want)
		}

		*calls = nil
		rec = httptest.NewRecorder()
		s.router.ServeHTTP(rec, remoteRequest(c.method, c.path, c.body))
		if rec.Code != http.StatusForbidden || len(*calls) != 0 {
			t.Fatalf("%s %s from off this machine: %d, %d calls passed on; want 403 and none", c.method, c.path, rec.Code, len(*calls))
		}
	}

	exposure := func(s *Server, r *http.Request) any {
		rec := httptest.NewRecorder()
		s.router.ServeHTTP(rec, r)
		var got map[string]any
		if err := json.Unmarshal(rec.Body.Bytes(), &got); rec.Code != http.StatusOK || err != nil {
			t.Fatalf("GET /api/connectivity: %d %s", rec.Code, rec.Body)
		}
		if _, ok := got["clients"]; !ok {
			t.Fatalf("GET /api/connectivity lost its clients: %s", rec.Body)
		}
		return got["exposure"]
	}
	if got := exposure(s, localRequest(http.MethodGet, "/api/connectivity", "")); got != true {
		t.Errorf("a local viewer of a supervised session: exposure %v, want true", got)
	}
	if got := exposure(s, remoteRequest(http.MethodGet, "/api/connectivity", "")); got != false {
		t.Errorf("a remote viewer: exposure %v, want false", got)
	}

	alone := connectivityServer(t, "")
	if got := exposure(alone, localRequest(http.MethodGet, "/api/connectivity", "")); got != false {
		t.Errorf("a session with no machine server: exposure %v, want false", got)
	}
	for _, path := range []string{"/api/connectivity/lan", "/api/connectivity/launch", "/api/connectivity/ways-in"} {
		rec := httptest.NewRecorder()
		alone.router.ServeHTTP(rec, localRequest(http.MethodGet, path, ""))
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s with no machine server: %d, want 404", path, rec.Code)
		}
	}
}

// TestWayInIsTheViewersOwn: a viewer off this machine reads the way in it came
// by, to bring another device into the session the same way, and no wider
// one. A LAN viewer gets LAN access's addresses, cut to them, and never the
// running tunnel's link, which works from anywhere; a tunnel's viewer gets
// that tunnel's link while it runs, and never the LAN addresses; anyone else
// gets neither.
func TestWayInIsTheViewersOwn(t *testing.T) {
	const tunnelLink = "https://quiet-fox.example/"
	running := testTunnelMode
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("X-Juggler-Token") != "control-token" || r.URL.Query().Get("session") != "sess-1" {
			http.Error(w, "unnamed", http.StatusForbidden)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/api/server/lan":
			_, _ = io.WriteString(w, `{"enabled":true,"urls":[{"url":"http://192.168.1.4:3939/","session":{"url":"http://192.168.1.4:3939/p/k/"}}],"announced":true,"notAnnounced":{"reason":"failed"},"firewall":{"port":3939}}`)
		case "/api/server/tunnel":
			_, _ = io.WriteString(w, `{"modes":[{"mode":"`+testTunnelMode+`","title":"Test relay"},{"mode":"other"}],"running":{"mode":"`+running+`","url":"`+tunnelLink+`","relay":true}}`)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	s := connectivityServer(t, strings.TrimPrefix(srv.URL, "http://"))

	wayIn := func(r *http.Request) (map[string]json.RawMessage, string) {
		t.Helper()
		rec := httptest.NewRecorder()
		s.router.ServeHTTP(rec, r)
		var got map[string]json.RawMessage
		if err := json.Unmarshal(rec.Body.Bytes(), &got); rec.Code != http.StatusOK || err != nil {
			t.Fatalf("GET /api/connectivity/ways-in: %d %s", rec.Code, rec.Body)
		}
		return got, rec.Body.String()
	}
	lanViewer := remoteRequest(http.MethodGet, "/api/connectivity/ways-in", "")
	lanViewer = lanViewer.WithContext(context.WithValue(lanViewer.Context(), supervisedLANCallerKey{}, "192.168.1.9"))

	got, body := wayIn(lanViewer)
	if _, ok := got["tunnel"]; ok || strings.Contains(body, tunnelLink) {
		t.Errorf("a LAN viewer was told the tunnel's link: %s", body)
	}
	if !strings.Contains(string(got["lan"]), "/p/k/") || strings.Contains(body, "firewall") || strings.Contains(body, "notAnnounced") {
		t.Errorf("a LAN viewer's way in: %s; want LAN access's addresses alone", body)
	}

	got, body = wayIn(MarkRemoteIngress(localRequest(http.MethodGet, "/api/connectivity/ways-in", ""), testTunnelMode))
	if _, ok := got["lan"]; ok || strings.Contains(body, "192.168.1.4") {
		t.Errorf("a tunnel's viewer was told the LAN addresses: %s", body)
	}
	if !strings.Contains(string(got["tunnel"]), tunnelLink) || strings.Contains(body, `"other"`) {
		t.Errorf("a tunnel's viewer's way in: %s; want its tunnel alone", body)
	}

	for name, r := range map[string]*http.Request{
		"a viewer on this machine":  localRequest(http.MethodGet, "/api/connectivity/ways-in", ""),
		"a reverse proxy's viewer":  MarkRemoteIngress(localRequest(http.MethodGet, "/api/connectivity/ways-in", ""), ingress.KindProxy),
		"a viewer of no known kind": remoteRequest(http.MethodGet, "/api/connectivity/ways-in", ""),
	} {
		if got, body := wayIn(r); len(got) != 0 {
			t.Errorf("%s was told a way in: %s", name, body)
		}
	}

	// A tunnel that is no longer the one its viewer came by is not its way in.
	running = "other"
	if got, body := wayIn(MarkRemoteIngress(localRequest(http.MethodGet, "/api/connectivity/ways-in", ""), testTunnelMode)); len(got) != 0 {
		t.Errorf("a viewer of a closed tunnel was told another's link: %s", body)
	}
}
