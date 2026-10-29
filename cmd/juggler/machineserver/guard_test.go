//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"

	"juggler/internal/ingress"
)

const testToken = "test-control-token"

// send performs one request against front, with the control-API token when
// token is non-empty, and returns the status.
func send(t *testing.T, method, url, token, body string) int {
	t.Helper()
	req, err := http.NewRequest(method, url, strings.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	if token != "" {
		req.Header.Set(TokenHeader, token)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("%s %s: %v", method, url, err)
	}
	_ = resp.Body.Close()
	return resp.StatusCode
}

// TestControlAPIRequiresToken checks every control-API route refuses a caller
// without the token from server.json, before the route does anything — the
// shutdown request in particular is never signalled — and that a server with
// no token refuses everyone rather than matching an empty header.
func TestControlAPIRequiresToken(t *testing.T) {
	routes := []struct{ method, path, body string }{
		{"GET", "/api/server/status", ""},
		{"GET", "/api/server/sessions", ""},
		{"POST", "/api/server/sessions", `{"project":"/"}`},
		{"DELETE", "/api/server/sessions/nope", ""},
		{"GET", "/api/server/recents", ""},
		{"POST", "/api/server/folders", `{"parent":"/","name":"x"}`},
		{"POST", "/api/server/shutdown", ""},
	}
	for _, serverToken := range []string{testToken, ""} {
		s := &Server{reg: newRegistry(), token: serverToken, shutdownReq: make(chan struct{}, 1)}
		front := httptest.NewServer(s.routes())
		for _, rt := range routes {
			for _, sent := range []string{"", "wrong-token", testToken[:len(testToken)-1]} {
				if serverToken == "" && sent != "" {
					continue
				}
				if code := send(t, rt.method, front.URL+rt.path, sent, rt.body); code != http.StatusUnauthorized {
					t.Errorf("server token %q: %s %s with token %q: status %d, want 401", serverToken, rt.method, rt.path, sent, code)
				}
			}
		}
		if len(s.shutdownReq) != 0 {
			t.Errorf("server token %q: an unauthorised shutdown request was signalled", serverToken)
		}
		front.Close()
	}

	s := &Server{reg: newRegistry(), token: testToken, shutdownReq: make(chan struct{}, 1)}
	front := httptest.NewServer(s.routes())
	defer front.Close()
	if code := send(t, "GET", front.URL+"/api/server/status", testToken, ""); code != http.StatusOK {
		t.Errorf("GET status with the token: status %d, want 200", code)
	}
	if code := send(t, "POST", front.URL+"/api/server/shutdown", testToken, ""); code != http.StatusAccepted || len(s.shutdownReq) != 1 {
		t.Errorf("POST shutdown with the token: status %d, signalled %v; want 202, signalled", code, len(s.shutdownReq) == 1)
	}
}

// TestSessionProxyNeedsNoControlToken: a session's pages and API are the
// child's to guard, with its own token, so the proxy forwards them without the
// machine server's.
func TestSessionProxyNeedsNoControlToken(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {}))
	defer backend.Close()
	s := &Server{reg: newRegistry(), token: testToken}
	sess, _ := s.reg.reserve("/p")
	s.reg.setRunning(sess.ID, &child{addr: strings.TrimPrefix(backend.URL, "http://")}, 1)
	front := httptest.NewServer(s.routes())
	defer front.Close()
	if code := send(t, "GET", front.URL+"/s/"+sess.ID+"/", "", ""); code != http.StatusOK {
		t.Fatalf("proxied page without the control token: status %d, want 200", code)
	}
}

// TestLANGateRefusesRemoteCallersWhileOff checks the machine server's LAN
// gate: while LAN access is off, a caller off loopback is refused everything —
// the control API even with the token, and every session — before anything is
// forwarded. A loopback caller is unaffected, and turning LAN access on admits
// the remote caller.
func TestLANGateRefusesRemoteCallersWhileOff(t *testing.T) {
	var reached atomic.Int64
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reached.Add(1)
	}))
	defer backend.Close()

	s := &Server{reg: newRegistry(), token: testToken}
	sess, _ := s.reg.reserve("/p")
	s.reg.setRunning(sess.ID, &child{addr: strings.TrimPrefix(backend.URL, "http://"), ingressSecret: "child-secret"}, 1)
	paths := []string{"/api/server/status", "/s/" + sess.ID + "/", "/s/" + sess.ID + "/api/ws"}

	for _, caller := range []string{"192.168.1.20:54321", "203.0.113.7:54321", "not-an-address"} {
		front := httptest.NewServer(asCaller(caller, s.routes()))
		for _, p := range paths {
			before := reached.Load()
			if code := send(t, "GET", front.URL+p, testToken, ""); code != http.StatusForbidden || reached.Load() != before {
				t.Errorf("LAN off, caller %s, GET %s: status %d, reached child %v; want 403, not reached", caller, p, code, reached.Load() != before)
			}
		}
		front.Close()
	}

	local := httptest.NewServer(s.routes())
	defer local.Close()
	for _, p := range paths[:2] {
		if code := send(t, "GET", local.URL+p, testToken, ""); code != http.StatusOK {
			t.Errorf("LAN off, loopback caller, GET %s: status %d, want 200", p, code)
		}
	}

	s.lan.Store(true)
	remote := httptest.NewServer(asCaller("192.168.1.20:54321", s.routes()))
	defer remote.Close()
	for _, p := range paths[:2] {
		if code := send(t, "GET", remote.URL+p, testToken, ""); code != http.StatusOK {
			t.Errorf("LAN on, remote caller, GET %s: status %d, want 200", p, code)
		}
	}
}

// TestSessionProxyNamesTheCallersTransport checks the proxy tells the child
// how a remote caller reached it and from where, alongside the secret that
// makes the child believe it — and that a client cannot supply either itself.
func TestSessionProxyNamesTheCallersTransport(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, strings.Join(r.Header.Values(ingress.KindHeader), ",")+"|"+strings.Join(r.Header.Values(ingress.AddrHeader), ","))
	}))
	defer backend.Close()

	s := &Server{reg: newRegistry(), token: testToken}
	s.lan.Store(true)
	sess, _ := s.reg.reserve("/p")
	s.reg.setRunning(sess.ID, &child{addr: strings.TrimPrefix(backend.URL, "http://"), ingressSecret: "child-secret"}, 1)

	for _, c := range []struct{ caller, want string }{
		{"127.0.0.1:5000", "|"},
		{"192.168.1.20:54321", ingress.KindLAN + "|192.168.1.20:54321"},
		{"[fe80::1]:54321", ingress.KindLAN + "|[fe80::1]:54321"},
	} {
		front := httptest.NewServer(asCaller(c.caller, s.routes()))
		req, err := http.NewRequest("GET", front.URL+"/s/"+sess.ID+"/", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set(ingress.KindHeader, "forged-kind")
		req.Header.Set(ingress.AddrHeader, "10.9.9.9:1")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		front.Close()
		if resp.StatusCode != http.StatusOK || string(body) != c.want {
			t.Errorf("caller %s: child saw kind|addr %q (status %d), want %q", c.caller, body, resp.StatusCode, c.want)
		}
	}
}
