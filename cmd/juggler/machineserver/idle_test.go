//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/gorilla/websocket"

	"juggler/internal/hostcheck"
	"juggler/internal/userpaths"
	"juggler/internal/userpaths/userpathstest"
)

// idleRun is a watchIdle driven by the test: it checks only on the ticks the
// test sends, at the times the test names, and reports each check.
type idleRun struct {
	ticks   chan time.Time
	checked chan time.Duration
	done    chan struct{}
}

// watchIdleOf starts s.watchIdle under the test's control. It ends with the
// test, as it does with the server's lifetime.
func watchIdleOf(t *testing.T, s *Server) *idleRun {
	t.Helper()
	r := &idleRun{ticks: make(chan time.Time), checked: make(chan time.Duration), done: make(chan struct{})}
	go func() {
		s.watchIdle(r.ticks, func(idle time.Duration) { r.checked <- idle })
		close(r.done)
	}()
	t.Cleanup(func() {
		s.endLifetime()
		<-r.done
	})
	return r
}

// tick has the watcher check at now, and returns once it has: the idle span it
// measured, or exited when it asked the server to shut down instead.
func (r *idleRun) tick(t *testing.T, now time.Time) (idle time.Duration, exited bool) {
	t.Helper()
	select {
	case r.ticks <- now:
	case <-r.done:
		t.Fatalf("the idle watcher returned before the tick at %s", now)
	}
	select {
	case idle := <-r.checked:
		return idle, false
	case <-r.done:
		return 0, true
	}
}

// idleServer is an implicit server with a one-minute idle timeout.
func idleServer() *Server {
	return &Server{reg: newRegistry(), shutdownReq: make(chan struct{}, 1), implicit: true, idleTimeout: time.Minute}
}

// TestImplicitServerExitsOnceIdleForItsTimeout: with nothing holding it up, an
// implicit server asks to shut down — through shutdownReq, the path every
// shutdown takes — once it has been idle for its timeout, and not before.
func TestImplicitServerExitsOnceIdleForItsTimeout(t *testing.T) {
	s := idleServer()
	r := watchIdleOf(t, s)
	// In the future, so no real request or attachment can stir the clock.
	t0 := time.Now().Add(time.Hour)
	if idle, exited := r.tick(t, t0); exited || idle != 0 {
		t.Fatalf("first check: idle %s, exited %v; want 0, still up", idle, exited)
	}
	if idle, exited := r.tick(t, t0.Add(59*time.Second)); exited || idle != 59*time.Second {
		t.Fatalf("59s on: idle %s, exited %v; want 59s, still up", idle, exited)
	}
	if len(s.shutdownReq) != 0 {
		t.Fatal("shutdown requested before the timeout")
	}
	if _, exited := r.tick(t, t0.Add(time.Minute)); !exited || len(s.shutdownReq) != 1 {
		t.Fatalf("a minute on: exited %v, shutdown requested %v; want both", exited, len(s.shutdownReq) == 1)
	}
}

// TestIdleExitWaitsForEverythingThatHoldsTheServerUp: each of decision 7's
// conditions alone keeps an implicit server up however long it lasts, and the
// idle clock starts only once it ends.
func TestIdleExitWaitsForEverythingThatHoldsTheServerUp(t *testing.T) {
	running := func(s *Server) (string, *child) {
		sess, _ := s.reg.reserve("/p")
		c := &child{addr: "127.0.0.1:1", exited: make(chan struct{})}
		s.reg.setRunning(sess.ID, c, 1)
		return sess.ID, c
	}
	for _, c := range []struct {
		name string
		hold func(t *testing.T, s *Server) (release func())
	}{
		{"an attached client", func(_ *testing.T, s *Server) func() { return s.attach() }},
		{"a busy session", func(_ *testing.T, s *Server) func() {
			id, c := running(s)
			s.reg.setActivity(id, c, true, time.Now())
			return func() { s.reg.setActivity(id, c, false, time.Now()) }
		}},
		{"a starting session", func(_ *testing.T, s *Server) func() {
			sess, _ := s.reg.reserve("/p")
			return func() { s.reg.remove(sess.ID) }
		}},
		{"a restarting session", func(_ *testing.T, s *Server) func() {
			id, c := running(s)
			s.reg.setRestarting(id, c, "crashed", time.Now().Add(time.Hour))
			return func() { s.reg.remove(id) }
		}},
		{"LAN access on", func(_ *testing.T, s *Server) func() {
			s.lan.Store(true)
			return func() { s.lan.Store(false) }
		}},
		{"an allowed host", func(t *testing.T, s *Server) func() {
			allowed, err := hostcheck.NewAllowList([]string{"box.tailnet.ts.net"})
			if err != nil {
				t.Fatal(err)
			}
			s.allowedHosts = allowed
			return func() { s.allowedHosts = hostcheck.AllowList{} }
		}},
	} {
		t.Run(c.name, func(t *testing.T) {
			s := idleServer()
			release := c.hold(t, s)
			r := watchIdleOf(t, s)
			t0 := time.Now().Add(time.Hour)
			r.tick(t, t0)
			if idle, exited := r.tick(t, t0.Add(2*time.Minute)); exited || idle != 0 {
				t.Fatalf("held for twice the timeout: idle %s, exited %v; want 0, still up", idle, exited)
			}
			release()
			if idle, exited := r.tick(t, t0.Add(2*time.Minute+30*time.Second)); exited || idle != 30*time.Second {
				t.Fatalf("30s after the hold ended: idle %s, exited %v; want 30s, still up", idle, exited)
			}
			if _, exited := r.tick(t, t0.Add(3*time.Minute)); !exited || len(s.shutdownReq) != 1 {
				t.Fatalf("a minute after the hold ended: exited %v, shutdown requested %v; want both", exited, len(s.shutdownReq) == 1)
			}
		})
	}
}

// TestAControlAPIRequestRestartsTheIdleClock: a client that has just found the
// server (Connect's status probe), or opened a session for a URL it will load
// later, gets the whole timeout before the server can go. A request the token
// guard refuses buys nothing.
func TestAControlAPIRequestRestartsTheIdleClock(t *testing.T) {
	s := idleServer()
	s.token = testToken
	front := httptest.NewServer(s.routes())
	defer front.Close()
	r := watchIdleOf(t, s)

	// A second in the past, so the request is stamped after it: Windows' wall
	// clock advances in steps of a millisecond or so, and a request within the
	// same step as t0 would be stamped t0 itself.
	t0 := time.Now().Add(-time.Second)
	r.tick(t, t0)
	if code := send(t, "GET", front.URL+"/api/server/status", testToken, ""); code != http.StatusOK {
		t.Fatalf("status: %d", code)
	}
	afterRequest := time.Now()
	if code := send(t, "GET", front.URL+"/api/server/status", "wrong", ""); code != http.StatusUnauthorized {
		t.Fatalf("status with the wrong token: %d", code)
	}
	if idle, exited := r.tick(t, t0.Add(time.Minute)); exited || idle >= time.Minute {
		t.Fatalf("a minute after the server last looked idle, with a request since: idle %s, exited %v; want under a minute, still up", idle, exited)
	}
	if _, exited := r.tick(t, afterRequest.Add(time.Minute)); !exited {
		t.Fatal("a minute after the last authorised request: still up; the refused request restarted the clock")
	}
}

// TestExplicitServerNeverIdlesOut: a server started by `juggler serve` stays
// until it is stopped — its watcher checks nothing and asks for nothing.
func TestExplicitServerNeverIdlesOut(t *testing.T) {
	s := idleServer()
	s.implicit = false
	ticks := make(chan time.Time, 2)
	t0 := time.Now().Add(time.Hour)
	ticks <- t0
	ticks <- t0.Add(24 * time.Hour)
	close(ticks)
	s.watchIdle(ticks, func(idle time.Duration) { t.Errorf("an explicit server checked its idle clock (idle %s)", idle) })
	if len(s.shutdownReq) != 0 {
		t.Fatal("an explicit server asked to shut down when idle")
	}
}

// waitAttached returns once s counts n attached clients. A detach happens when
// the server notices the client has gone, which a client's own call does not
// wait for.
func waitAttached(t *testing.T, s *Server, n int64) {
	t.Helper()
	deadline := time.Now().Add(10 * time.Second)
	for s.attached.Load() != n {
		if time.Now().After(deadline) {
			t.Fatalf("%d clients attached, want %d", s.attached.Load(), n)
		}
		time.Sleep(time.Millisecond)
	}
}

// TestProxiedWebSocketCountsAsAnAttachedClient: a viewer's socket to its
// session holds the server up for as long as it is open. A plain proxied
// request does not.
func TestProxiedWebSocketCountsAsAnAttachedClient(t *testing.T) {
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
	if got := s.attached.Load(); got != 1 {
		t.Fatalf("with a proxied socket open: %d attached, want 1", got)
	}
	_ = conn.Close()
	waitAttached(t, s, 0)
}

// TestAttachHoldsTheServerUpUntilTheClientLetsGo: Client.Attach returns once
// the server counts it, Close lets go, and the server ending its lifetime ends
// every attachment, which Done reports.
func TestAttachHoldsTheServerUpUntilTheClientLetsGo(t *testing.T) {
	s := &Server{reg: newRegistry(), token: testToken}
	front := httptest.NewServer(s.routes())
	defer front.Close()
	c := &Client{addr: front.Listener.Addr().String(), token: testToken, http: &http.Client{Timeout: 5 * time.Second}}

	a, err := c.Attach()
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	if got := s.attached.Load(); got != 1 {
		t.Fatalf("after Attach returned: %d attached, want 1", got)
	}
	a.Close()
	waitAttached(t, s, 0)

	if _, err := (&Client{addr: c.addr, token: "wrong"}).Attach(); err == nil {
		t.Fatal("attach with the wrong token succeeded")
	}
	if got := s.attached.Load(); got != 0 {
		t.Fatalf("after a refused attach: %d attached, want none", got)
	}

	a, err = c.Attach()
	if err != nil {
		t.Fatalf("second attach: %v", err)
	}
	s.endLifetime()
	<-a.Done()
	waitAttached(t, s, 0)
	a.Close()
}

// TestAnIdleImplicitServerExitsAndTheNextConnectStartsAnother runs the real
// `serve --implicit` (the stand-in, with a tiny idle timeout) through an idle
// exit: it takes the shutdown path, so it lets the lock go and removes
// server.json, and the next Connect that may start a server starts a fresh one.
func TestAnIdleImplicitServerExitsAndTheNextConnectStartsAnother(t *testing.T) {
	userpathstest.Isolate(t)
	t.Setenv(helperIdleEnv, "1")
	start, started := helperStarter(t)
	var exited []<-chan struct{}
	recording := func() (int, <-chan struct{}, error) {
		pid, done, err := start()
		exited = append(exited, done)
		return pid, done, err
	}

	first, err := Connect(ConnectOptions{Start: recording})
	if err != nil || !first.Started {
		t.Fatalf("first connect: %+v, %v; want a server it started", first, err)
	}
	select {
	case <-exited[0]:
	case <-time.After(30 * time.Second):
		t.Fatal("the implicit server, idle with nothing holding it, did not exit")
	}
	lock := NewMachineLock(userpaths.ConfigDir())
	if lock.held() || lock.readInfo() != nil {
		t.Fatalf("after the idle exit: lock held %v, server.json %+v; want neither", lock.held(), lock.readInfo())
	}

	second, err := Connect(ConnectOptions{Start: recording})
	if err != nil || !second.Started || started() != 2 {
		t.Fatalf("second connect: %+v, %v, %d servers started; want a second server it started", second, err, started())
	}
}
