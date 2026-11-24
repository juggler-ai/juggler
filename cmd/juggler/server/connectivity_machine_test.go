//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"juggler/internal/basepath"
)

// TestSessionRelaysOpenStopAndFolders: a project page's switcher opens and
// stops the machine's sessions, and makes a folder to open, without holding
// the control token. Its child passes each call on to the machine server with
// the token it holds, the body as sent, and hands back the answer as it
// stands — for any viewer the child's own auth admits, as the sessions page
// lets any viewer do the same.
func TestSessionRelaysOpenStopAndFolders(t *testing.T) {
	addr, calls := standInSupervisor(t)
	s := connectivityServer(t, addr)
	for _, c := range []struct {
		method, path, body, upstream string
	}{
		{http.MethodPost, "/api/machine/sessions", `{"project":"/x","wait":true}`, "/api/server/sessions"},
		{http.MethodDelete, "/api/machine/sessions/sess-other", "", "/api/server/sessions/sess-other"},
		{http.MethodPost, "/api/machine/folders", `{"parent":"~","name":"new"}`, "/api/server/folders"},
	} {
		*calls = nil
		rec := httptest.NewRecorder()
		s.router.ServeHTTP(rec, remoteRequest(c.method, c.path, c.body))
		if rec.Code != http.StatusTeapot || rec.Body.String() != `{"from":"`+c.upstream+`"}` {
			t.Errorf("%s %s: %d %s, want the machine server's answer as it stands", c.method, c.path, rec.Code, rec.Body.String())
		}
		want := []supervisorCall{{method: c.method, path: c.upstream, token: "control-token", body: c.body}}
		if len(*calls) != 1 || (*calls)[0] != want[0] {
			t.Errorf("%s %s: machine server got %+v, want %+v", c.method, c.path, *calls, want)
		}
	}

	// Only those: the list is the events stream's.
	*calls = nil
	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, localRequest(http.MethodGet, "/api/machine/sessions", ""))
	if rec.Code < 400 || len(*calls) != 0 {
		t.Errorf("GET /api/machine/sessions: %d with %d calls passed on, want it refused and none", rec.Code, len(*calls))
	}
}

// TestStoppingItsOwnSessionAnswersAtOnce: a stop of the child's own session is
// answered before the machine server is asked. The machine server's stop
// waits for this child to exit, and the child's shutdown waits for its
// handlers, so a relay that waited for the answer would hold its own teardown
// up. The stop still reaches the machine server.
func TestStoppingItsOwnSessionAnswersAtOnce(t *testing.T) {
	asked := make(chan supervisorCall, 1)
	release := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		asked <- supervisorCall{r.Method, r.URL.Path, r.URL.RawQuery, r.Header.Get("X-Juggler-Token"), string(b), r.Header.Get(basepath.Header)}
		<-release
		w.WriteHeader(http.StatusNoContent)
	}))
	t.Cleanup(srv.Close)
	t.Cleanup(func() { close(release) })
	s := connectivityServer(t, strings.TrimPrefix(srv.URL, "http://"))

	rec := httptest.NewRecorder()
	s.router.ServeHTTP(rec, localRequest(http.MethodDelete, "/api/machine/sessions/sess-1", ""))
	if rec.Code != http.StatusAccepted {
		t.Fatalf("DELETE of its own session: %d, want 202 at once", rec.Code)
	}
	select {
	case call := <-asked:
		want := supervisorCall{method: http.MethodDelete, path: "/api/server/sessions/sess-1", token: "control-token"}
		if call != want {
			t.Fatalf("machine server got %+v, want %+v", call, want)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("the stop never reached the machine server")
	}
}

// TestARelaunchIsRelayed: a project page asks for the machine server's
// relaunch through its child, which passes it on with the control token, for
// a viewer on this machine or off it, and hands back the answer as it stands.
func TestARelaunchIsRelayed(t *testing.T) {
	type asked struct{ path, token, body string }
	got := make(chan asked, 1)
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		b, _ := io.ReadAll(r.Body)
		got <- asked{r.URL.Path, r.Header.Get("X-Juggler-Token"), string(b)}
		w.WriteHeader(http.StatusConflict)
		_, _ = io.WriteString(w, `{"error":"busy"}`)
	}))
	t.Cleanup(srv.Close)
	s := connectivityServer(t, strings.TrimPrefix(srv.URL, "http://"))
	for _, c := range []struct {
		name string
		req  *http.Request
	}{
		{"a viewer on this machine", localRequest(http.MethodPost, "/api/machine/relaunch", `{"expect":{}}`)},
		{"a viewer off it", remoteRequest(http.MethodPost, "/api/machine/relaunch", `{"expect":{}}`)},
	} {
		rec := httptest.NewRecorder()
		s.router.ServeHTTP(rec, c.req)
		if rec.Code != http.StatusConflict || rec.Body.String() != `{"error":"busy"}` {
			t.Errorf("%s: %d %s, want the machine server's answer as it stands", c.name, rec.Code, rec.Body.String())
		}
		select {
		case a := <-got:
			want := asked{"/api/server/relaunch", "control-token", `{"expect":{}}`}
			if a != want {
				t.Errorf("%s: machine server got %+v, want %+v", c.name, a, want)
			}
		default:
			t.Errorf("%s: the relaunch never reached the machine server", c.name)
		}
	}
}

// TestTheRelayIsAbsentWithoutAMachineServer: a session run on its own has no
// machine to open or stop sessions on.
func TestTheRelayIsAbsentWithoutAMachineServer(t *testing.T) {
	s := connectivityServer(t, "")
	for _, c := range []struct{ method, path string }{
		{http.MethodPost, "/api/machine/sessions"},
		{http.MethodDelete, "/api/machine/sessions/sess-1"},
		{http.MethodPost, "/api/machine/folders"},
		{http.MethodPost, "/api/machine/relaunch"},
	} {
		rec := httptest.NewRecorder()
		s.router.ServeHTTP(rec, localRequest(c.method, c.path, "{}"))
		if rec.Code != http.StatusNotFound {
			t.Errorf("%s %s with no machine server: %d, want 404", c.method, c.path, rec.Code)
		}
	}
}
