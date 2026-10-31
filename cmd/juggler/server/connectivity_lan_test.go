//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/gorilla/mux"
)

// supervisorCall is one request a stand-in machine server received.
type supervisorCall struct {
	method, path, query, token, body string
}

// standInSupervisor serves the machine server's /api/server/lan and
// /api/server/tunnel, recording each call, and answers with its path.
func standInSupervisor(t *testing.T) (addr string, calls *[]supervisorCall) {
	t.Helper()
	var got []supervisorCall
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got = append(got, supervisorCall{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("X-Juggler-Token"), string(b)})
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
		want := supervisorCall{c.method, c.want, "session=sess-1", "control-token", c.body}
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
	for _, path := range []string{"/api/connectivity/lan", "/api/connectivity/launch"} {
		rec := httptest.NewRecorder()
		alone.router.ServeHTTP(rec, localRequest(http.MethodGet, path, ""))
		if rec.Code != http.StatusNotFound {
			t.Errorf("GET %s with no machine server: %d, want 404", path, rec.Code)
		}
	}
}
