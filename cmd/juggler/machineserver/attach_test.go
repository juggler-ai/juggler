//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"bufio"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"juggler/internal/hostcheck"
)

// heldAttach opens POST /api/server/attach by hand, so nothing beats for it,
// and returns its attachment id and a channel that closes when the server ends
// the attachment.
func heldAttach(t *testing.T, base string) (id string, ended <-chan struct{}) {
	t.Helper()
	req, err := http.NewRequest(http.MethodPost, base+"/api/server/attach", http.NoBody) //nolint:noctx // closed by the test
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set(TokenHeader, testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	t.Cleanup(func() { _ = resp.Body.Close() })
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("attach: %s", resp.Status)
	}
	br := bufio.NewReader(resp.Body)
	line, err := br.ReadBytes('\n')
	if err != nil {
		t.Fatalf("attach status line: %v", err)
	}
	var st attachStatus
	if err := json.Unmarshal(line, &st); err != nil || st.Status != "ok" || st.Attachment == "" {
		t.Fatalf("attach status line %q (%v): want the status with an attachment id", line, err)
	}
	done := make(chan struct{})
	go func() {
		_, _ = io.Copy(io.Discard, br)
		close(done)
	}()
	return st.Attachment, done
}

// beat posts one heartbeat for attachment id and returns the status.
func beat(t *testing.T, base, id string) int {
	t.Helper()
	return send(t, http.MethodPost, base+"/api/server/attach/"+id+"/beat", testToken, "")
}

// TestAttachmentIsDroppedAfterSixMissedChecks: an attachment that has not beaten
// since six of the server's own checks is dropped — its held response ends, the
// server stops counting it, and its id is no longer known — while one that beats
// between checks stands however many checks pass.
func TestAttachmentIsDroppedAfterSixMissedChecks(t *testing.T) {
	s := &Server{reg: newRegistry(), token: testToken}
	front := httptest.NewServer(s.routes())
	// A cleanup, not a defer: it must run after the held responses close,
	// which are cleanups registered later.
	t.Cleanup(front.Close)

	beating, _ := heldAttach(t, front.URL)
	silent, ended := heldAttach(t, front.URL)
	if got := s.attached.Load(); got != 2 {
		t.Fatalf("%d attached, want 2", got)
	}
	if code := beat(t, front.URL, "no-such-attachment"); code != http.StatusNotFound {
		t.Fatalf("beat for an unknown attachment: %d, want 404", code)
	}

	for i := 1; i < attachMissLimit; i++ {
		if code := beat(t, front.URL, beating); code != http.StatusNoContent {
			t.Fatalf("beat %d: %d, want 204", i, code)
		}
		s.checkAttachments()
	}
	select {
	case <-ended:
		t.Fatalf("the silent attachment ended after %d missed checks; want %d", attachMissLimit-1, attachMissLimit)
	default:
	}
	if got := s.attached.Load(); got != 2 {
		t.Fatalf("after %d checks: %d attached, want 2", attachMissLimit-1, got)
	}

	if code := beat(t, front.URL, beating); code != http.StatusNoContent {
		t.Fatalf("last beat: %d", code)
	}
	s.checkAttachments()
	<-ended
	waitAttached(t, s, 1)
	if code := beat(t, front.URL, silent); code != http.StatusNotFound {
		t.Fatalf("beat for the dropped attachment: %d, want 404", code)
	}
	if code := beat(t, front.URL, beating); code != http.StatusNoContent {
		t.Fatalf("beat for the beating attachment after the drop: %d, want 204", code)
	}
}

// TestAClientThatStopsBeatingSeesItsAttachmentEnd: a client whose beats stop
// reaching the server is dropped like any other, and sees Done close, which is
// what tells a live one to attach again. One that keeps beating is not dropped.
func TestAClientThatStopsBeatingSeesItsAttachmentEnd(t *testing.T) {
	s := &Server{reg: newRegistry(), token: testToken}
	front := httptest.NewServer(s.routes())
	// A cleanup, not a defer: it must run after the held responses close,
	// which are cleanups registered later.
	t.Cleanup(front.Close)
	addr := front.Listener.Addr().String()

	beats := make(chan string, 64)
	live := &Client{addr: addr, token: testToken, http: &http.Client{Timeout: 5 * time.Second},
		beatEvery: time.Millisecond, beaten: func(id string) {
			select {
			case beats <- id:
			default:
			}
		}}
	a, err := live.Attach()
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	t.Cleanup(a.Close)
	hung := &Client{addr: addr, token: testToken, http: &http.Client{Timeout: 5 * time.Second}, beatEvery: time.Hour}
	h, err := hung.Attach()
	if err != nil {
		t.Fatalf("attach: %v", err)
	}
	t.Cleanup(h.Close)

	for range 2 * attachMissLimit {
		// Each check comes after a beat the server has answered, so the live
		// client is never seen missing one, however slowly its beats run.
		<-beats
		for len(beats) > 0 {
			<-beats
		}
		<-beats
		s.checkAttachments()
	}
	select {
	case <-h.Done():
	case <-time.After(10 * time.Second):
		t.Fatal("the client that never beat was not told its attachment ended")
	}
	select {
	case <-a.Done():
		t.Fatal("the beating client's attachment ended")
	default:
	}
	waitAttached(t, s, 1)
}

// TestRemoteCallersCannotAttach checks both direct LAN and allowed-host ingress.
func TestRemoteCallersCannotAttach(t *testing.T) {
	allowed, err := hostcheck.NewAllowList([]string{"box.tailnet.ts.net"})
	if err != nil {
		t.Fatal(err)
	}
	s := &Server{reg: newRegistry(), token: testToken, allowedHosts: allowed}
	s.lan.Store(true)
	for _, c := range []struct{ name, addr, host string }{
		{"LAN", "192.0.2.1:1234", "localhost"},
		{"proxy", "127.0.0.1:1234", "box.tailnet.ts.net"},
	} {
		t.Run(c.name, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodPost, "http://"+c.host+"/api/server/attach", nil)
			req.RemoteAddr = c.addr
			req.Header.Set(TokenHeader, testToken)
			ctx, cancel := context.WithCancel(req.Context())
			cancel() // A wrongly admitted held route must not wedge this assertion.
			w := httptest.NewRecorder()
			s.routes().ServeHTTP(w, req.WithContext(ctx))
			if w.Code != http.StatusForbidden {
				t.Fatalf("attach: %d, want 403", w.Code)
			}
		})
	}
}

// TestLastDetachImmediatelyStopsImplicitServer needs no tick or idle clock.
func TestLastDetachImmediatelyStopsImplicitServer(t *testing.T) {
	s := &Server{implicit: true, shutdownReq: make(chan struct{}, 1)}
	first, last := s.attach(), s.attach()
	first()
	if len(s.shutdownReq) != 0 {
		t.Fatal("shutdown with another client attached")
	}
	last()
	if len(s.shutdownReq) != 1 {
		t.Fatal("last detach did not immediately request shutdown")
	}
	last()
	if s.attached.Load() != 0 {
		t.Fatal("repeated detach changed the count")
	}
}

// TestOnlyStarterAttachmentReleasesStartupHold proves the transfer never
// exposes an unheld server, and another client cannot consume the starter hold.
func TestOnlyStarterAttachmentReleasesStartupHold(t *testing.T) {
	s := &Server{reg: newRegistry(), token: testToken, implicit: true, starter: os.Getpid(), shutdownReq: make(chan struct{}, 1)}
	front := httptest.NewServer(s.routes())
	t.Cleanup(front.Close)
	_, otherEnded := heldAttach(t, front.URL)
	s.check()
	if s.starterGone.Load() {
		t.Fatal("another client released starter hold")
	}
	s.attachments.Range(func(_, v any) bool { v.(*attachment).drop(); return true })
	<-otherEnded
	if len(s.shutdownReq) != 0 {
		t.Fatal("other client leaving ended starter hold")
	}
	c := &Client{addr: front.Listener.Addr().String(), token: testToken}
	a, err := c.Attach()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(a.Close)
	if !s.starterGone.Load() || s.attached.Load() != 1 || len(s.shutdownReq) != 0 {
		t.Fatal("starter attachment did not transfer its hold to the counted client")
	}
	s.check()
	a.Close()
	waitAttached(t, s, 0)
	<-s.shutdownReq
}

func TestLastDroppedAttachmentImmediatelyStopsImplicitServer(t *testing.T) {
	s := &Server{reg: newRegistry(), token: testToken, implicit: true, shutdownReq: make(chan struct{}, 1)}
	front := httptest.NewServer(s.routes())
	t.Cleanup(front.Close)
	_, ended := heldAttach(t, front.URL)
	for range attachMissLimit - 1 {
		s.check()
	}
	if len(s.shutdownReq) != 0 {
		t.Fatal("shutdown before attachment dropped")
	}
	s.check()
	if s.attached.Load() != 0 || len(s.shutdownReq) != 1 {
		t.Fatal("last drop did not synchronously release client and request shutdown")
	}
	<-ended
}

// A named attachment must never acknowledge a hold on a missing or stopped session.
func TestNamedAttachmentRefusesUnavailableSession(t *testing.T) {
	s := &Server{reg: newRegistry(), token: testToken}
	sess, _ := s.reg.reserve("/starting")
	for _, id := range []string{"missing", sess.ID} {
		req := httptest.NewRequest(http.MethodPost, "/api/server/attach", strings.NewReader(`{"session":"`+id+`"}`))
		req.RemoteAddr = "127.0.0.1:1234"
		ctx, cancel := context.WithCancel(req.Context())
		cancel()
		w := httptest.NewRecorder()
		s.handleAttach(w, req.WithContext(ctx))
		want := http.StatusServiceUnavailable
		if id == "missing" {
			want = http.StatusNotFound
		}
		if w.Code != want {
			t.Errorf("attach %q: status %d, want %d", id, w.Code, want)
		}
		if s.attached.Load() != 0 {
			t.Fatal("refused attachment counted a client")
		}
	}
}
