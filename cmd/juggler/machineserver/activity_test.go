//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"juggler/internal/apipaths"
)

// stubChildToken is the API token a stubChild demands, as a real child demands
// the one its spawner minted for it.
const stubChildToken = "stub-child-token"

// stubChild stands in for a session child's activity endpoint: it answers
// /api/health/active from busy, or 500 while failing is set, and counts the
// polls it has answered. A poll without the child's token is refused and not
// counted.
type stubChild struct {
	srv     *httptest.Server
	busy    atomic.Bool
	failing atomic.Bool
	polls   atomic.Int64
}

func newStubChild(t *testing.T) *stubChild {
	t.Helper()
	sc := &stubChild{}
	sc.srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != apipaths.HealthActive {
			http.NotFound(w, r)
			return
		}
		if r.Header.Get(TokenHeader) != stubChildToken {
			http.Error(w, "Unauthorized", http.StatusUnauthorized)
			return
		}
		defer sc.polls.Add(1)
		if sc.failing.Load() {
			http.Error(w, "boom", http.StatusInternalServerError)
			return
		}
		ids := []string{}
		if sc.busy.Load() {
			ids = append(ids, "conv-a")
		}
		_ = json.NewEncoder(w).Encode(map[string]any{"active": len(ids) > 0, "conversationIds": ids})
	}))
	t.Cleanup(sc.srv.Close)
	return sc
}

// runningSession registers a running session whose child is the stub, and
// starts polling it. The returned stop ends the poll as a child exit does and
// waits for the poller to return.
func runningSession(t *testing.T, sc *stubChild) (*registry, string, func()) {
	t.Helper()
	r := newRegistry()
	s := &Server{reg: r}
	sess, _ := r.reserve("/p")
	c := &child{addr: sc.srv.Listener.Addr().String(), apiToken: stubChildToken, exited: make(chan struct{})}
	r.setRunning(sess.ID, c, 1)
	done := make(chan struct{})
	go func() {
		s.pollActivity(sess.ID, c, 5*time.Millisecond)
		close(done)
	}()
	stopped := false
	stop := func() {
		if stopped {
			return
		}
		stopped = true
		close(c.exited)
		select {
		case <-done:
		case <-time.After(5 * time.Second):
			t.Fatal("pollActivity did not return after its child exited")
		}
	}
	t.Cleanup(stop)
	return r, sess.ID, stop
}

// waitPolls returns once the stub has answered n more polls.
func (sc *stubChild) waitPolls(t *testing.T, n int64) {
	t.Helper()
	target := sc.polls.Load() + n
	deadline := time.Now().Add(5 * time.Second)
	for sc.polls.Load() < target {
		if time.Now().After(deadline) {
			t.Fatalf("stub child answered %d polls, want %d", sc.polls.Load(), target)
		}
		time.Sleep(time.Millisecond)
	}
}

func TestActivityPollTracksBusyAndLastActive(t *testing.T) {
	sc := newStubChild(t)
	r, id, _ := runningSession(t, sc)

	sc.waitPolls(t, 2)
	if s, _ := r.get(id); s.Busy || s.LastActive != nil {
		t.Fatalf("idle child: session = %+v, want idle with no last activity", s)
	}

	before := time.Now()
	sc.busy.Store(true)
	sc.waitPolls(t, 2)
	busy, _ := r.get(id)
	if !busy.Busy || busy.LastActive == nil || busy.LastActive.Before(before) {
		t.Fatalf("busy child: session = %+v, want busy with a last activity after %s", busy, before)
	}
	// Each busy poll moves the last activity on.
	sc.waitPolls(t, 2)
	if later, _ := r.get(id); !later.LastActive.After(*busy.LastActive) {
		t.Fatalf("still busy: last activity %s did not advance past %s", later.LastActive, busy.LastActive)
	}

	sc.busy.Store(false)
	sc.waitPolls(t, 2)
	idle, _ := r.get(id)
	if idle.Busy || idle.LastActive == nil {
		t.Fatalf("idle again: session = %+v, want idle with the last activity kept", idle)
	}
	sc.waitPolls(t, 2)
	if still, _ := r.get(id); !still.LastActive.Equal(*idle.LastActive) {
		t.Fatalf("idle: last activity moved from %s to %s", idle.LastActive, still.LastActive)
	}
}

// A poll that fails says nothing about the child, so it changes nothing: a
// child that stops answering mid-turn stays busy rather than looking idle.
func TestActivityPollFailureKeepsLastKnownState(t *testing.T) {
	sc := newStubChild(t)
	r, id, _ := runningSession(t, sc)

	sc.busy.Store(true)
	sc.waitPolls(t, 2)
	sc.failing.Store(true)
	sc.waitPolls(t, 1)
	failed, _ := r.get(id)
	sc.waitPolls(t, 2)
	if s, _ := r.get(id); !s.Busy || !s.LastActive.Equal(*failed.LastActive) {
		t.Fatalf("failing polls: session = %+v, want busy with last activity unchanged at %s", s, failed.LastActive)
	}
}

func TestActivityPollStopsWhenChildExits(t *testing.T) {
	sc := newStubChild(t)
	_, _, stop := runningSession(t, sc)
	sc.waitPolls(t, 1)
	stop() // fails the test if the poller is still running
	n := sc.polls.Load()
	time.Sleep(50 * time.Millisecond)
	if got := sc.polls.Load(); got != n {
		t.Fatalf("child polled %d more times after the poller returned", got-n)
	}
}

// Activity is recorded only against the entry that still owns the polled
// child, so a poll that lands after a crash or a replacement can't mark the
// errored or replacing entry busy. A crash clears busy along with the rest of
// the child's state.
func TestRegistryActivityBelongsToItsChild(t *testing.T) {
	r := newRegistry()
	c := &child{addr: "127.0.0.1:1", exited: make(chan struct{})}
	s, _ := r.reserve("/p")
	r.setRunning(s.ID, c, 1)

	at := time.Now()
	r.setActivity(s.ID, &child{addr: "127.0.0.1:2"}, true, at)
	if cur, _ := r.get(s.ID); cur.Busy || cur.LastActive != nil {
		t.Fatalf("activity from another child was recorded: %+v", cur)
	}

	r.setActivity(s.ID, c, true, at)
	if cur, _ := r.get(s.ID); !cur.Busy || cur.LastActive == nil || !cur.LastActive.Equal(at) {
		t.Fatalf("activity from the owning child: session = %+v, want busy at %s", cur, at)
	}

	r.setRestarting(s.ID, c, "crashed", time.Now().Add(time.Second))
	r.setActivity(s.ID, c, true, at.Add(time.Second))
	cur, _ := r.get(s.ID)
	if cur.Busy {
		t.Fatalf("crashed session still busy: %+v", cur)
	}
	if cur.LastActive == nil || !cur.LastActive.Equal(at) {
		t.Fatalf("crashed session: last activity = %v, want %s kept", cur.LastActive, at)
	}
}
