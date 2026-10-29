//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"context"
	"sync"
	"testing"
	"time"
)

// lifetimeSession stands in for a spawner and supervisor, without a process.
// Tests advance registry time inside the actor rather than waiting out grace.
func lifetimeSession(t *testing.T) (*registry, string, *child, *claim, time.Time) {
	t.Helper()
	r := newRegistry()
	s, cl, err := r.open(context.Background(), "/lifetime", new(sync.WaitGroup))
	if err != nil || cl == nil {
		t.Fatalf("open: claim=%v err=%v", cl, err)
	}
	t.Cleanup(func() {
		select {
		case <-cl.done:
		default:
			cl.release()
		}
		r.remove(s.ID)
	})
	c := &child{addr: "127.0.0.1:1"}
	if !r.setRunning(s.ID, c, 1) {
		t.Fatal("setRunning refused reservation")
	}
	at := time.Date(2026, 10, 29, 12, 0, 0, 0, time.UTC)
	r.do(func(m map[string]*sessionEntry) { m[s.ID].unviewedSince = at })
	return r, s.ID, c, cl, at
}

func TestSessionLifetimeGraceAndStopping(t *testing.T) {
	r, id, c, _, at := lifetimeSession(t)
	if sessionViewerGrace != 10*time.Second {
		t.Fatalf("viewer grace = %s, want 10s", sessionViewerGrace)
	}
	if r.retireUnviewed(id, c, at.Add(sessionViewerGrace-time.Nanosecond)) {
		t.Fatal("retired before grace elapsed")
	}
	if r.whenStopped(id) != nil || r.whenStopped("absent") != nil {
		t.Fatal("non-stopping entry returned a teardown wait")
	}
	if !r.retireUnviewed(id, c, at.Add(sessionViewerGrace)) {
		t.Fatal("did not retire at grace boundary")
	}
	if cur, _ := r.get(id); cur.State != SessionStopping {
		t.Fatalf("retirement state = %s", cur.State)
	}
	if release, ok := r.holdViewer(id); ok || release != nil {
		t.Fatal("stopping session accepted a viewer")
	}
	if r.retireUnviewed(id, c, at.Add(2*sessionViewerGrace)) {
		t.Fatal("retirement claimed twice")
	}
	if r.setRestarting(id, c, "exit", at) || r.removeOwned(id, c) {
		t.Fatal("supervisor took a retirement claim")
	}
	done := r.whenStopped(id)
	if done == nil {
		t.Fatal("stopping entry has no teardown wait")
	}
	select {
	case <-done:
		t.Fatal("teardown completed before removal")
	default:
	}
	r.remove(id)
	select {
	case <-done:
	default:
		t.Fatal("removal did not wake teardown waiters")
	}
}

func TestSessionLifetimeViewersAndReconnect(t *testing.T) {
	r, id, c, _, at := lifetimeSession(t)
	first, ok := r.holdViewer(id)
	if !ok {
		t.Fatal("first viewer refused")
	}
	second, ok := r.holdViewer(id)
	if !ok {
		t.Fatal("second viewer refused")
	}
	first()
	first()
	r.do(func(m map[string]*sessionEntry) {
		if m[id].viewers != 1 || !m[id].unviewedSince.Equal(at) {
			t.Errorf("first release changed last-viewer grace: viewers=%d since=%s", m[id].viewers, m[id].unviewedSince)
		}
	})
	if r.retireUnviewed(id, c, at.Add(100*sessionViewerGrace)) {
		t.Fatal("retired with a remaining viewer")
	}
	second()
	var since time.Time
	r.do(func(m map[string]*sessionEntry) {
		e := m[id]
		if e.viewers != 0 || e.unviewedSince.Equal(at) || e.unviewedSince.IsZero() {
			t.Errorf("last release did not start grace: viewers=%d since=%s", e.viewers, e.unviewedSince)
		}
		since = e.unviewedSince
	})
	second()
	reconnect, ok := r.holdViewer(id)
	if !ok {
		t.Fatal("reconnect refused during grace")
	}
	reconnect()
	var reconnected time.Time
	r.do(func(m map[string]*sessionEntry) { reconnected = m[id].unviewedSince })
	if !reconnected.After(since) {
		t.Fatal("reconnect's departure did not restart the grace")
	}
	r.do(func(m map[string]*sessionEntry) {
		// Pin the last disconnect to actor time to check both grace boundaries.
		m[id].unviewedSince = since.Add(sessionViewerGrace)
	})
	if r.retireUnviewed(id, c, since.Add(2*sessionViewerGrace-time.Nanosecond)) {
		t.Fatal("reconnect did not reset grace")
	}
	if !r.retireUnviewed(id, c, since.Add(2*sessionViewerGrace)) {
		t.Fatal("did not retire after reconnect grace")
	}
}

func TestSessionLifetimeStaleChild(t *testing.T) {
	r, id, c, _, at := lifetimeSession(t)
	if !r.setRestarting(id, c, "crash", at) {
		t.Fatal("could not simulate crash")
	}
	if _, ok := r.beginRestart(id); !ok {
		t.Fatal("could not begin replacement")
	}
	replacement := &child{addr: "127.0.0.1:2"}
	if !r.setRunning(id, replacement, 2) {
		t.Fatal("could not install replacement")
	}
	r.do(func(m map[string]*sessionEntry) { m[id].unviewedSince = at })
	if r.retireUnviewed(id, c, at.Add(2*sessionViewerGrace)) {
		t.Fatal("old child's poller claimed the replacement")
	}
	if !r.retireUnviewed(id, replacement, at.Add(2*sessionViewerGrace)) {
		t.Fatal("replacement's poller could not claim it")
	}
}

// Opening an unviewed session renews its grace, so the window that loads it
// has the whole grace to connect.
func TestSessionLifetimeOpenRenewsGrace(t *testing.T) {
	r, id, c, _, _ := lifetimeSession(t)
	before := time.Now()
	s, created := r.reserve("/lifetime")
	after := time.Now()
	if created || s.ID != id {
		t.Fatal("open did not reuse running session")
	}
	if r.retireUnviewed(id, c, before.Add(sessionViewerGrace-time.Nanosecond)) {
		t.Fatal("an open did not renew its session's grace")
	}
	if !r.retireUnviewed(id, c, after.Add(sessionViewerGrace)) {
		t.Fatal("a renewed grace never ran out")
	}
}

func TestSessionLifetimeUnavailableViewedOrNoClock(t *testing.T) {
	for _, state := range []SessionState{SessionError, SessionRestarting} {
		for _, viewed := range []bool{false, true} {
			t.Run(string(state)+map[bool]string{false: "/no-clock", true: "/viewed"}[viewed], func(t *testing.T) {
				r, id, _, cl, at := lifetimeSession(t)
				if viewed {
					release, ok := r.holdViewer(id)
					if !ok {
						t.Fatal("viewer refused")
					}
					defer release()
				}
				r.do(func(m map[string]*sessionEntry) {
					m[id].setState(state)
					if !viewed {
						m[id].unviewedSince = time.Time{}
					}
				})
				if len(r.expireUnavailable(at.Add(sessionViewerGrace))) != 0 {
					t.Fatal("claimed viewed entry or entry without a grace clock")
				}
				if cur, ok := r.get(id); !ok || cur.State != state || cl.ctx.Err() != nil {
					t.Fatalf("expiry touched protected unavailable entry: exists=%v session=%+v canceled=%v", ok, cur, cl.ctx.Err())
				}
			})
		}
	}
}

func TestSessionLifetimeCheckWaitsForClaimOffTick(t *testing.T) {
	ctx := t.Context()
	if deadline, ok := t.Deadline(); ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(ctx, deadline)
		defer cancel()
	}
	r, id, _, cl, _ := lifetimeSession(t)
	s := &Server{reg: r}
	r.do(func(m map[string]*sessionEntry) {
		e := m[id]
		e.setState(SessionRestarting)
		e.unviewedSince = time.Now().Add(-sessionViewerGrace)
	})
	checked := make(chan struct{})
	go func() {
		s.check()
		close(checked)
	}()
	select {
	case <-checked:
	case <-ctx.Done():
		t.Fatal("attachment check blocked on the supervisor claim")
	}
	cur, ok := r.get(id)
	if !ok || cur.State != SessionStopping || cl.ctx.Err() == nil {
		t.Fatalf("check did not claim expired backoff: exists=%v session=%+v canceled=%v", ok, cur, cl.ctx.Err())
	}
	done := r.whenStopped(id)
	if done == nil {
		t.Fatal("expired backoff has no teardown wait")
	}
	select {
	case <-done:
		t.Fatal("backoff removed before supervisor released its claim")
	default:
	}
	// Repeated ticks must neither wait nor create a second removal owner.
	s.check()
	cl.release()
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatal("released backoff was not removed")
	}
	if _, ok := r.get(id); ok {
		t.Fatal("teardown wait completed before registry removal")
	}
}

func TestSessionLifetimeUnavailable(t *testing.T) {
	for _, state := range []SessionState{SessionError, SessionRestarting, SessionStarting, SessionRunning} {
		t.Run(string(state), func(t *testing.T) {
			r, id, _, cl, at := lifetimeSession(t)
			r.do(func(m map[string]*sessionEntry) {
				e := m[id]
				e.setState(state)
				if state == SessionRestarting {
					next := at.Add(time.Hour)
					e.NextRestartAt = &next
				}
			})
			if pending := r.expireUnavailable(at.Add(sessionViewerGrace - time.Nanosecond)); len(pending) != 0 {
				t.Fatal("claimed unavailable entry before grace")
			}
			if _, ok := r.get(id); !ok {
				t.Fatal("removed unavailable entry before grace")
			}
			pending := r.expireUnavailable(at.Add(sessionViewerGrace))
			cur, exists := r.get(id)
			switch state {
			case SessionError:
				if exists || len(pending) != 0 || cl.ctx.Err() == nil {
					t.Fatalf("error expiry: exists=%v pending=%v canceled=%v", exists, pending, cl.ctx.Err())
				}
			case SessionRestarting:
				if !exists || cur.State != SessionStopping || len(pending) != 1 || cl.ctx.Err() == nil {
					t.Fatalf("backoff expiry: session=%+v pending=%v canceled=%v", cur, pending, cl.ctx.Err())
				}
				if pending[0].id != id || pending[0].done != cl.done {
					t.Fatalf("backoff claim did not retain original supervisor: %+v", pending[0])
				}
				if cur.NextRestartAt != nil {
					t.Fatal("claimed backoff still advertises a scheduled restart")
				}
				if _, ok := r.beginRestart(id); ok {
					t.Fatal("expired backoff accepted a respawn")
				}
				if len(r.expireUnavailable(at.Add(2*sessionViewerGrace))) != 0 {
					t.Fatal("backoff claimed twice")
				}
			default:
				if !exists || cur.State != state || len(pending) != 0 || cl.ctx.Err() != nil {
					t.Fatalf("expiry touched %s: session=%+v pending=%v", state, cur, pending)
				}
			}
		})
	}
}
