//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"juggler/internal/hostcheck"
	"juggler/internal/userpaths"
	"juggler/internal/userpaths/userpathstest"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"
	"time"
)

func TestOnlyLocalClientsHoldImplicitServer(t *testing.T) {
	for _, name := range []string{"LAN", "allowed host", "starting", "restarting", "busy"} {
		t.Run(name, func(t *testing.T) {
			s := &Server{reg: newRegistry(), implicit: true, shutdownReq: make(chan struct{}, 1)}
			switch name {
			case "LAN":
				s.lan.Store(true)
			case "allowed host":
				var err error
				s.allowedHosts, err = hostcheck.NewAllowList([]string{"box.tailnet.ts.net"})
				if err != nil {
					t.Fatal(err)
				}
			default:
				sess, _ := s.reg.reserve("/p")
				if name != "starting" {
					c := &child{addr: "127.0.0.1:1", exited: make(chan struct{})}
					s.reg.setRunning(sess.ID, c, 1)
					if name == "busy" {
						s.reg.setActivity(sess.ID, c, true, time.Now())
					} else {
						s.reg.setRestarting(sess.ID, c, "crashed", time.Now())
					}
				}
			}
			s.check()
			if s.heldUp() || len(s.shutdownReq) != 1 {
				t.Fatal("exposure or session held server up")
			}
		})
	}
}

func TestExplicitServerStaysWithoutClients(t *testing.T) {
	s := &Server{shutdownReq: make(chan struct{}, 1)}
	detach := s.attach()
	detach()
	s.check()
	if len(s.shutdownReq) != 0 {
		t.Fatal("hand-started server requested shutdown")
	}
}

func TestStarterHoldEndsOnDeath(t *testing.T) {
	for _, pid := range []int{0, deadPID(t), os.Getpid()} {
		s := &Server{starter: pid, implicit: true, shutdownReq: make(chan struct{}, 1)}
		s.check()
		wantHeld := pid == os.Getpid()
		if s.heldUp() != wantHeld || (len(s.shutdownReq) == 0) != wantHeld {
			t.Fatalf("starter %d: held %v, shutdown %v", pid, s.heldUp(), len(s.shutdownReq) != 0)
		}
	}
}

// waitAttached returns once s counts n attached clients. A detach happens when
// the server notices the client has gone, which a client's own call does not
// wait for.
func waitAttached(t *testing.T, s *Server, n int64) {
	t.Helper()
	deadline, bounded := t.Deadline()
	for s.attached.Load() != n {
		if bounded && time.Now().After(deadline) {
			t.Fatalf("%d clients attached, want %d", s.attached.Load(), n)
		}
		time.Sleep(time.Millisecond)
	}
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
// `serve --implicit` (the stand-in) through a last-client
// exit: it takes the shutdown path, so it lets the lock go and removes
// server.json, and the next Connect that may start a server starts a fresh one.
func TestAnIdleImplicitServerExitsAndTheNextConnectStartsAnother(t *testing.T) {
	userpathstest.Isolate(t)
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
	a, err := first.Attach()
	if err != nil {
		t.Fatal(err)
	}
	a.Close()
	<-exited[0]
	lock := NewMachineLock(userpaths.ConfigDir())
	if (lock.probe() == lockHeld) || lock.readInfo() != nil {
		t.Fatalf("after the idle exit: lock held %v, server.json %+v; want neither", (lock.probe() == lockHeld), lock.readInfo())
	}

	second, err := Connect(ConnectOptions{Start: recording})
	if err != nil || !second.Started || started() != 2 {
		t.Fatalf("second connect: %+v, %v, %d servers started; want a second server it started", second, err, started())
	}
}
