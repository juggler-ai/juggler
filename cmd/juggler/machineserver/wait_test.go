//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

// waitedOpen is the answer to one POST /api/server/sessions.
type waitedOpen struct {
	status int
	sess   Session
	body   string
}

// TestOpenWithWaitAwaitsASpawnInFlight: an open with "wait" for a project
// whose session is still starting answers only once that spawn has settled —
// with the running record, the errored one (502), or 409 when a stop took the
// session — where an open without it answers at once with "starting".
func TestOpenWithWaitAwaitsASpawnInFlight(t *testing.T) {
	cases := []struct {
		name   string
		settle func(s *Server, id string)
		want   int
		state  SessionState
	}{
		{"running", func(s *Server, id string) { s.reg.setRunning(id, &child{addr: "127.0.0.1:1"}, 7) }, http.StatusOK, SessionRunning},
		{"error", func(s *Server, id string) { s.reg.setError(id, "it broke") }, http.StatusBadGateway, SessionError},
		{"stopped", func(s *Server, id string) { s.reg.remove(id) }, http.StatusConflict, ""},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			s := &Server{reg: newRegistry(), token: testToken}
			// The spawn is settled only once the open is waiting on it.
			arrived := make(chan struct{}, 1)
			orig := awaitingSpawn
			awaitingSpawn = func(string) { arrived <- struct{}{} }
			t.Cleanup(func() { awaitingSpawn = orig })
			front := httptest.NewServer(s.routes())
			defer front.Close()
			project := t.TempDir()
			pending, _ := s.reg.reserve(project)

			body, _ := json.Marshal(map[string]any{"project": project, "wait": true})
			answered := make(chan waitedOpen, 1)
			go func() { answered <- postOpen(t, front.URL, string(body)) }()
			select {
			case <-arrived:
			case got := <-answered:
				t.Fatalf("open with wait answered without waiting for the spawn: %d %+v", got.status, got.sess)
			}
			tc.settle(s, pending.ID)
			got := <-answered
			if got.status != tc.want || got.sess.State != tc.state {
				t.Fatalf("open with wait: status %d state %q (%s), want %d %q", got.status, got.sess.State, got.body, tc.want, tc.state)
			}
			if tc.state != "" && got.sess.ID != pending.ID {
				t.Fatalf("open with wait answered session %s, want %s", got.sess.ID, pending.ID)
			}
		})
	}
}

// TestOpenWithoutWaitAnswersStarting pins the sessions page's behaviour: an
// open for a project whose spawn is in flight answers at once, "starting".
func TestOpenWithoutWaitAnswersStarting(t *testing.T) {
	s := &Server{reg: newRegistry(), token: testToken}
	front := httptest.NewServer(s.routes())
	defer front.Close()
	project := t.TempDir()
	pending, _ := s.reg.reserve(project)
	body, _ := json.Marshal(map[string]any{"project": project})
	got := postOpen(t, front.URL, string(body))
	if got.status != http.StatusOK || got.sess.ID != pending.ID || got.sess.State != SessionStarting {
		t.Fatalf("open without wait: %d %+v, want 200 starting %s", got.status, got.sess, pending.ID)
	}
}

// postOpen POSTs body to the control API's sessions route.
func postOpen(t *testing.T, base, body string) waitedOpen {
	req, err := http.NewRequest("POST", base+"/api/server/sessions", strings.NewReader(body))
	if err != nil {
		t.Error(err)
		return waitedOpen{}
	}
	req.Header.Set(TokenHeader, testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Error(err)
		return waitedOpen{}
	}
	defer resp.Body.Close()
	data, _ := io.ReadAll(resp.Body)
	var sess Session
	_ = json.Unmarshal(data, &sess)
	return waitedOpen{status: resp.StatusCode, sess: sess, body: string(data)}
}
