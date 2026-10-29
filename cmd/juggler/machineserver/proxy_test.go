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
	"time"

	"github.com/gorilla/websocket"

	"juggler/internal/ingress"
)

// get performs a GET and returns (statusCode, body).
func get(t *testing.T, url string) (int, string) {
	t.Helper()
	resp, err := http.Get(url) //nolint:gosec // test-local httptest URL
	if err != nil {
		t.Fatalf("GET %s: %v", url, err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("read body: %v", err)
	}
	return resp.StatusCode, string(body)
}

func TestSessionProxyRoutesAndStripsPrefix(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, "path="+r.URL.Path)
	}))
	defer backend.Close()

	s := &Server{reg: newRegistry()}
	sess, _ := s.reg.reserve("/p")
	s.reg.setRunning(sess.ID, &child{addr: strings.TrimPrefix(backend.URL, "http://")}, 1)

	front := httptest.NewServer(s.routes())
	defer front.Close()

	if code, body := get(t, front.URL+"/s/"+sess.ID+"/api/health"); code != http.StatusOK || body != "path=/api/health" {
		t.Fatalf("proxied request: code=%d body=%q", code, body)
	}
	// The session root proxies to the child's "/".
	if code, body := get(t, front.URL+"/s/"+sess.ID+"/"); code != http.StatusOK || body != "path=/" {
		t.Fatalf("session root: code=%d body=%q", code, body)
	}
	// A bare /s/<id> redirects to /s/<id>/ (the default client follows it).
	if code, body := get(t, front.URL+"/s/"+sess.ID); code != http.StatusOK || body != "path=/" {
		t.Fatalf("bare session path: code=%d body=%q", code, body)
	}
}

// TestSessionProxyForwardsPrefix checks the child is told the prefix it is
// being served under, and that a client cannot choose it: a forged
// X-Forwarded-Prefix is replaced, not passed on.
func TestSessionProxyForwardsPrefix(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, strings.Join(r.Header.Values("X-Forwarded-Prefix"), ","))
	}))
	defer backend.Close()

	s := &Server{reg: newRegistry()}
	sess, _ := s.reg.reserve("/p")
	s.reg.setRunning(sess.ID, &child{addr: strings.TrimPrefix(backend.URL, "http://")}, 1)
	front := httptest.NewServer(s.routes())
	defer front.Close()

	req, err := http.NewRequest("GET", front.URL+"/s/"+sess.ID+"/", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("X-Forwarded-Prefix", "/evil")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if got, want := string(body), "/s/"+sess.ID; got != want {
		t.Fatalf("child saw X-Forwarded-Prefix %q, want %q", got, want)
	}
}

// asCaller serves h as if every request came from addr. A test server listens
// on loopback, so this is the only way a test can put a caller off loopback in
// front of the proxy.
func asCaller(addr string, h http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		r.RemoteAddr = addr
		h.ServeHTTP(w, r)
	})
}

// TestSessionProxyIdentifiesRemoteCallers checks the proxy's half of caller
// identity: a caller off loopback is forwarded with the child's ingress secret,
// a loopback caller with none, and a client's own copy of the header never
// reaches the child either way.
func TestSessionProxyIdentifiesRemoteCallers(t *testing.T) {
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.WriteString(w, strings.Join(r.Header.Values(ingress.Header), ","))
	}))
	defer backend.Close()

	s := &Server{reg: newRegistry()}
	s.lan.Store(true)
	sess, _ := s.reg.reserve("/p")
	s.reg.setRunning(sess.ID, &child{addr: strings.TrimPrefix(backend.URL, "http://"), ingressSecret: "child-secret"}, 1)

	for _, c := range []struct {
		caller, want string
	}{
		{"127.0.0.1:5000", ""},
		{"[::1]:5000", ""},
		{"203.0.113.7:54321", "child-secret"},
		{"192.168.1.20:54321", "child-secret"},
	} {
		front := httptest.NewServer(asCaller(c.caller, s.routes()))
		req, err := http.NewRequest("GET", front.URL+"/s/"+sess.ID+"/", nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set(ingress.Header, "forged")
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		_ = resp.Body.Close()
		front.Close()
		if resp.StatusCode != http.StatusOK || string(body) != c.want {
			t.Errorf("caller %s: child saw %s %q (status %d), want %q", c.caller, ingress.Header, body, resp.StatusCode, c.want)
		}
	}
}

// A remote caller forwarded without the tag would look local to the child, so
// a child with no secret to send is not proxied to at all for one.
func TestSessionProxyRefusesRemoteCallerItCannotIdentify(t *testing.T) {
	var reached atomic.Int64
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reached.Add(1)
	}))
	defer backend.Close()

	s := &Server{reg: newRegistry()}
	s.lan.Store(true)
	sess, _ := s.reg.reserve("/p")
	s.reg.setRunning(sess.ID, &child{addr: strings.TrimPrefix(backend.URL, "http://")}, 1)

	remote := httptest.NewServer(asCaller("203.0.113.7:54321", s.routes()))
	defer remote.Close()
	if code, _ := get(t, remote.URL+"/s/"+sess.ID+"/"); code != http.StatusBadGateway || reached.Load() != 0 {
		t.Fatalf("remote caller, child without a secret: status %d after %d proxied requests, want 502 after none", code, reached.Load())
	}

	local := httptest.NewServer(s.routes())
	defer local.Close()
	if code, _ := get(t, local.URL+"/s/"+sess.ID+"/"); code != http.StatusOK || reached.Load() != 1 {
		t.Fatalf("loopback caller: status %d after %d proxied requests, want 200 after one", code, reached.Load())
	}
}

func TestSessionProxyRejectsUnknownAndNotRunning(t *testing.T) {
	s := &Server{reg: newRegistry()}
	starting, _ := s.reg.reserve("/p")

	front := httptest.NewServer(s.routes())
	defer front.Close()

	if code, _ := get(t, front.URL+"/s/nope/anything"); code != http.StatusNotFound {
		t.Fatalf("unknown session: code=%d, want 404", code)
	}
	if code, _ := get(t, front.URL+"/s/"+starting.ID+"/anything"); code != http.StatusServiceUnavailable {
		t.Fatalf("starting session: code=%d, want 503", code)
	}
}

// TestHostGuardRejectsRebindingHosts is the machine server's DNS-rebinding
// defence. A page whose own domain an attacker has pointed at this machine
// sends that domain as Host, and passes the Origin guard because its Origin
// names the same domain. So every request — the control API, the proxy, a
// WebSocket upgrade, from loopback or off it — must name this machine in its
// Host, or it is refused before it reaches anything.
func TestHostGuardRejectsRebindingHosts(t *testing.T) {
	var reached atomic.Int64
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		reached.Add(1)
	}))
	defer backend.Close()

	// LAN access on, so what refuses the off-loopback caller is the Host guard
	// and not the LAN gate in front of it.
	s := &Server{reg: newRegistry(), token: testToken}
	s.lan.Store(true)
	sess, _ := s.reg.reserve("/p")
	s.reg.setRunning(sess.ID, &child{addr: strings.TrimPrefix(backend.URL, "http://"), ingressSecret: "child-secret"}, 1)

	paths := []string{"/api/server/status", "/api/server/sessions", "/s/" + sess.ID + "/", "/s/" + sess.ID + "/api/ws"}
	for _, caller := range []string{"127.0.0.1:5000", "192.168.1.20:54321"} {
		front := httptest.NewServer(asCaller(caller, s.routes()))
		for _, host := range []string{"attacker.com", "attacker.com:8080", "localhost.attacker.com", "notlocalhost.com:8080"} {
			for _, p := range paths {
				before := reached.Load()
				req, err := http.NewRequest("GET", front.URL+p, nil)
				if err != nil {
					t.Fatal(err)
				}
				req.Host = host
				// The rebinding page is same-origin with itself, and is given
				// the token so only the Host can be what refuses it.
				req.Header.Set("Origin", "http://"+host)
				req.Header.Set(TokenHeader, testToken)
				resp, err := http.DefaultClient.Do(req)
				if err != nil {
					t.Fatal(err)
				}
				_ = resp.Body.Close()
				if resp.StatusCode != http.StatusForbidden || reached.Load() != before {
					t.Errorf("caller %s, Host %q, GET %s: status %d, reached child %v; want 403, not reached",
						caller, host, p, resp.StatusCode, reached.Load() != before)
				}
			}
		}
		front.Close()
	}

	// Every name that can only mean this machine still gets through.
	front := httptest.NewServer(s.routes())
	defer front.Close()
	for _, host := range []string{"127.0.0.1:8317", "localhost:8317", "LocalHost", "myproject.localhost:8317", "192.168.1.5:8317", "[::1]:8317"} {
		for _, p := range []string{"/api/server/status", "/s/" + sess.ID + "/"} {
			req, err := http.NewRequest("GET", front.URL+p, nil)
			if err != nil {
				t.Fatal(err)
			}
			req.Host = host
			req.Header.Set(TokenHeader, testToken)
			resp, err := http.DefaultClient.Do(req)
			if err != nil {
				t.Fatal(err)
			}
			_ = resp.Body.Close()
			if resp.StatusCode != http.StatusOK {
				t.Errorf("Host %q, GET %s: status %d, want 200", host, p, resp.StatusCode)
			}
		}
	}
}

func TestOriginGuardRejectsCrossOrigin(t *testing.T) {
	s := &Server{reg: newRegistry(), token: testToken}
	front := httptest.NewServer(s.routes())
	defer front.Close()

	req, err := http.NewRequest("GET", front.URL+"/api/server/status", nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(TokenHeader, testToken)
	req.Header.Set("Origin", "http://evil.example")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusForbidden {
		t.Fatalf("cross-origin request: code=%d, want 403", resp.StatusCode)
	}

	// Same-origin passes.
	req2, err := http.NewRequest("GET", front.URL+"/api/server/status", nil)
	if err != nil {
		t.Fatal(err)
	}
	req2.Header.Set(TokenHeader, testToken)
	req2.Header.Set("Origin", front.URL)
	resp2, err := http.DefaultClient.Do(req2)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != http.StatusOK {
		t.Fatalf("same-origin request: code=%d, want 200", resp2.StatusCode)
	}
}

// TestProxiedWebSocketDoesNotAttachToServer: a viewer's socket to its
// session is a session viewer, not a local client holding the server up.
func TestProxiedWebSocketDoesNotAttachToServer(t *testing.T) {
	upgrader := websocket.Upgrader{CheckOrigin: func(*http.Request) bool { return true }}
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !websocket.IsWebSocketUpgrade(r) {
			return
		}
		conn, err := upgrader.Upgrade(w, r, nil)
		if err != nil {
			return
		}
		defer conn.Close()
		for {
			if _, _, err := conn.ReadMessage(); err != nil {
				return
			}
		}
	}))
	defer backend.Close()

	s := &Server{reg: newRegistry()}
	sess, _ := s.reg.reserve("/p")
	s.reg.setRunning(sess.ID, &child{addr: strings.TrimPrefix(backend.URL, "http://")}, 1)
	front := httptest.NewServer(s.routes())
	defer front.Close()

	if code, _ := get(t, front.URL+"/s/"+sess.ID+"/api/health"); code != http.StatusOK || s.attached.Load() != 0 {
		t.Fatalf("plain proxied request: status %d, %d attached; want 200, none", code, s.attached.Load())
	}
	conn, resp, err := websocket.DefaultDialer.Dial("ws"+strings.TrimPrefix(front.URL, "http")+"/s/"+sess.ID+"/api/ws", nil)
	if err != nil {
		t.Fatalf("dial through the proxy: %v", err)
	}
	_ = resp.Body.Close()
	defer conn.Close()
	viewers := func() (n int) {
		s.reg.do(func(m map[string]*sessionEntry) { n = m[sess.ID].viewers })
		return n
	}
	if got := viewers(); got != 1 {
		t.Fatalf("with a proxied socket open: %d session viewers, want 1", got)
	}
	if got := s.attached.Load(); got != 0 {
		t.Fatalf("with a proxied socket open: %d attached, want none", got)
	}
	_ = conn.Close()
	deadline := time.NewTimer(5 * time.Second)
	defer deadline.Stop()
	tick := time.NewTicker(time.Millisecond)
	defer tick.Stop()
	for viewers() != 0 {
		select {
		case <-tick.C:
		case <-deadline.C:
			t.Fatal("closed proxied socket still holds a session viewer")
		}
	}
	s.reg.do(func(m map[string]*sessionEntry) {
		if m[sess.ID].unviewedSince.IsZero() {
			t.Error("last socket departure did not start viewer grace")
		}
	})
	waitAttached(t, s, 0)
}
