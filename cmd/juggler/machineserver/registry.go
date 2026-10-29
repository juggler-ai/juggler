//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"sort"
	"sync"
	"time"
)

// SessionState is the lifecycle state of a session child in the registry.
type SessionState string

const (
	// SessionStarting: reserved in the registry, child spawn in progress.
	SessionStarting SessionState = "starting"
	// SessionRunning: child is up and its address is proxyable.
	SessionRunning SessionState = "running"
	// SessionStopping: a stop was requested; the child is being torn down.
	SessionStopping SessionState = "stopping"
	// SessionError: the child failed to start, or crashed more often than the
	// restart policy allows; Error says why. A stop dismisses it, and the next
	// open for its project replaces it.
	SessionError SessionState = "error"
	// SessionRestarting: the child crashed and a replacement will be spawned
	// at NextRestartAt, under the same ID; Error says how it ended.
	SessionRestarting SessionState = "restarting"
)

// Session is the public registry record for one session child, as served by
// the control API.
type Session struct {
	ID        string       `json:"id"`
	Project   string       `json:"project"`
	Addr      string       `json:"addr,omitempty"`
	PID       int          `json:"pid,omitempty"`
	State     SessionState `json:"state"`
	Error     string       `json:"error,omitempty"`
	StartedAt time.Time    `json:"startedAt"`
	// Busy and LastActive come from polling the child (see pollActivity), so
	// both trail the child by up to activityPollInterval, and a turn that
	// starts and ends between two polls is never seen.
	//
	// Busy is what the latest successful poll reported: a turn is running,
	// not merely parked on a tool approval.
	Busy bool `json:"busy"`
	// LastActive is the time of the latest poll that found the child busy;
	// absent when no poll has.
	LastActive *time.Time `json:"lastActive,omitempty"`
	// Restarts counts the times a crashed child has been respawned for this
	// session since it was opened.
	Restarts int `json:"restarts,omitempty"`
	// NextRestartAt is when a restarting session's next spawn is due; absent
	// in every other state.
	NextRestartAt *time.Time `json:"nextRestartAt,omitempty"`
}

// sessionEntry pairs the public record with the live child handle.
type sessionEntry struct {
	Session
	child *child
	// cancel ends the session's context (claim.ctx), and done is the claim's
	// channel, closed once its spawner or supervisor has let the session go.
	// Both are nil only for an entry no claim was made for.
	cancel context.CancelFunc
	done   chan struct{}
	// started is open while the session is starting, and closes as it leaves
	// that state or the registry (see setState) — what an open that waits for a
	// spawn in flight blocks on.
	started chan struct{}
	// viewers belongs to the registry actor; unviewedSince is when the last
	// viewer left, or an open renewed the session's grace.
	viewers       int
	unviewedSince time.Time
	// stopped closes only after teardown has finished and the entry leaves.
	stopped chan struct{}
	// retiring is open while the child is asked whether to retire, and closes
	// once it has answered or exited (see retireUnviewed).
	retiring chan struct{}
	// retireTaken marks a decision an explicit stop has taken over
	// (takeRetirement): whatever the child answers, the stop removes the
	// session.
	retireTaken bool
}

// setState moves the entry to st, opening started as it enters starting and
// closing it as it leaves. Every state change goes through here.
func (e *sessionEntry) setState(st SessionState) {
	if st == SessionStarting && e.started == nil {
		e.started = make(chan struct{})
	}
	if st == SessionStopping && e.stopped == nil {
		e.stopped = make(chan struct{})
	}
	e.State = st
	if st != SessionStarting {
		e.closeStarted()
	}
}

// closeStarted wakes whatever waits on the session's spawn.
func (e *sessionEntry) closeStarted() {
	if e.started != nil {
		close(e.started)
		e.started = nil
	}
}

// claim is a spawner's hold on the session it opened (registry.open): the
// session's context, which a stop of a session with no live child, or
// shutdown, cancels; and release, which the spawner — or the supervisor it
// hands the session to — calls once it is done with the session. A stop
// waits for that, and shutdown waits for every claim through work.
type claim struct {
	ctx  context.Context
	done chan struct{}
	work *sync.WaitGroup
}

// release lets the session go: the count in work drops first, so whatever
// done wakes sees it dropped.
func (cl *claim) release() {
	cl.work.Done()
	close(cl.done)
}

// errShuttingDown is open's answer once the server's lifetime has ended.
var errShuttingDown = errors.New("the machine server is shutting down")

// end cancels the entry's context, and wakes whatever waits on its spawn, as
// it leaves the registry.
func (e *sessionEntry) end() {
	if e.cancel != nil {
		e.cancel()
	}
	e.closeStarted()
	e.closeRetiring()
	if e.stopped != nil {
		close(e.stopped)
		e.stopped = nil
	}
}

// registry is the actor owning the session table. All access is serialized
// through the ops channel — no locks. It lives for the process lifetime.
type registry struct {
	ops chan func(map[string]*sessionEntry)
}

func newRegistry() *registry {
	r := &registry{ops: make(chan func(map[string]*sessionEntry))}
	go func() {
		m := make(map[string]*sessionEntry)
		for fn := range r.ops {
			fn(m)
		}
	}()
	return r
}

// do runs fn inside the actor and returns after it completes.
func (r *registry) do(fn func(map[string]*sessionEntry)) {
	done := make(chan struct{})
	r.ops <- func(m map[string]*sessionEntry) {
		fn(m)
		close(done)
	}
	<-done
}

// snapshot returns a copy of every session, oldest first.
func (r *registry) snapshot() []Session {
	out := make([]Session, 0)
	r.do(func(m map[string]*sessionEntry) {
		for _, e := range m {
			out = append(out, e.Session)
		}
	})
	sort.Slice(out, func(i, j int) bool { return out[i].StartedAt.Before(out[j].StartedAt) })
	return out
}

// get returns the public record for id.
func (r *registry) get(id string) (Session, bool) {
	var s Session
	var ok bool
	r.do(func(m map[string]*sessionEntry) {
		if e, found := m[id]; found {
			s, ok = e.Session, true
		}
	})
	return s, ok
}

// route returns the public record for id together with its live child's
// ingress secret ("" with no live child) — what the proxy needs to forward a
// request. The secret stays out of Session so it can never be served.
func (r *registry) route(id string) (s Session, secret string, ok bool) {
	r.do(func(m map[string]*sessionEntry) {
		if e, found := m[id]; found {
			s, ok = e.Session, true
			if e.child != nil {
				secret = e.child.ingressSecret
			}
		}
	})
	return s, secret, ok
}

// whenStarted returns the channel that closes once session id is no longer
// starting — running, errored, stopped or gone — or nil when it is not
// starting now.
func (r *registry) whenStarted(id string) <-chan struct{} {
	var ch chan struct{}
	r.do(func(m map[string]*sessionEntry) {
		if e, found := m[id]; found && e.State == SessionStarting {
			ch = e.started
		}
	})
	return ch
}

// open returns the live session for project when one exists (any state but
// error — an errored entry is replaced), with a nil claim. Otherwise it
// inserts a starting entry with a fresh ID and returns the claim on it: the
// caller now owns the spawn, and holds the claim — counted in work — until it
// releases it. The session's context derives from parent; once parent is done
// nothing is opened and the error is errShuttingDown. The count is taken
// inside the actor, so a shutdown that cancels parent and then makes any
// registry call before waiting on work never misses a claim.
func (r *registry) open(parent context.Context, project string, work *sync.WaitGroup) (s Session, cl *claim, err error) {
	id := newSessionID()
	r.do(func(m map[string]*sessionEntry) {
		if parent.Err() != nil {
			err = errShuttingDown
			return
		}
		for key, e := range m {
			if e.Project != project {
				continue
			}
			if e.State == SessionError {
				e.end()
				delete(m, key)
				continue
			}
			if e.viewers == 0 {
				e.unviewedSince = time.Now()
			}
			s = e.Session
			return
		}
		ctx, cancel := context.WithCancel(parent)
		e := &sessionEntry{Session: Session{
			ID:        id,
			Project:   project,
			StartedAt: time.Now(),
		}, cancel: cancel, done: make(chan struct{}), unviewedSince: time.Now()}
		e.setState(SessionStarting)
		m[id] = e
		work.Add(1)
		s, cl = e.Session, &claim{ctx: ctx, done: e.done, work: work}
	})
	return s, cl, err
}

// setRunning records a successful spawn: address, pid, and the child handle.
// Returns false when the session is no longer starting — removed, or claimed
// by a stop while the child was in its handshake — and the caller then owns
// stopping the just-spawned child rather than leaking it unsupervised.
func (r *registry) setRunning(id string, c *child, pid int) bool {
	var ok bool
	r.do(func(m map[string]*sessionEntry) {
		e, found := m[id]
		if !found || e.State != SessionStarting {
			return
		}
		e.setState(SessionRunning)
		e.Error = ""
		e.Addr = c.addr
		e.PID = pid
		e.child = c
		if e.viewers == 0 {
			e.unviewedSince = time.Now()
		}
		ok = true
	})
	return ok
}

// setError records a failed spawn (or supervisor-observed failure).
func (r *registry) setError(id, msg string) {
	r.do(func(m map[string]*sessionEntry) {
		if e, ok := m[id]; ok {
			e.setState(SessionError)
			e.Error = msg
			e.clearChild()
		}
	})
}

// beginStop marks the session stopping and hands the caller the child to tear
// down. ok is false when the session doesn't exist or has no live child.
func (r *registry) beginStop(id string) (*child, bool) {
	var c *child
	r.do(func(m map[string]*sessionEntry) {
		if e, ok := m[id]; ok && e.child != nil && e.State == SessionRunning {
			e.setState(SessionStopping)
			c = e.child
		}
	})
	return c, c != nil
}

// cancelPending claims a session with no live child yet — starting, or
// restarting — for a stop. It turns stopping, which setRunning and
// beginRestart refuse, and its context is cancelled, which ends a backoff or a
// spawn's handshake at once. It returns the channel that closes once the
// session's spawner or supervisor has let it go; ok is false in any other
// state, or for an entry no claim was made for.
func (r *registry) cancelPending(id string) (done <-chan struct{}, ok bool) {
	r.do(func(m map[string]*sessionEntry) {
		e, found := m[id]
		if !found || e.done == nil || (e.State != SessionStarting && e.State != SessionRestarting) {
			return
		}
		e.setState(SessionStopping)
		e.NextRestartAt = nil
		if e.cancel != nil {
			e.cancel()
		}
		done, ok = e.done, true
	})
	return done, ok
}

// remove drops the session from the registry.
func (r *registry) remove(id string) {
	r.do(func(m map[string]*sessionEntry) {
		if e, found := m[id]; found {
			e.end()
			delete(m, id)
		}
	})
}

// owned reports whether e is still c's to supervise: its child is c (nil for a
// supervisor between children, whose restart spawn failed) and no stop has
// claimed it. A stopping entry belongs to its stopper, which removes it.
func (e *sessionEntry) owned(c *child) bool {
	return e.child == c && e.State != SessionStopping
}

// clearChild drops the live child from the record.
func (e *sessionEntry) clearChild() {
	e.Addr = ""
	e.PID = 0
	e.Busy = false
	e.child = nil
}

// removeOwned drops the session after its child c exited cleanly, unless the
// session has moved on (stopped, replaced). Reports whether it was removed.
func (r *registry) removeOwned(id string, c *child) bool {
	var ok bool
	r.do(func(m map[string]*sessionEntry) {
		if e, found := m[id]; found && e.owned(c) {
			e.end()
			delete(m, id)
			ok = true
		}
	})
	return ok
}

// setRestarting records that the session's child c crashed (reason) and a
// replacement will be spawned at next. Reports false when the session has
// moved on, and the supervisor must then stop supervising it.
func (r *registry) setRestarting(id string, c *child, reason string, next time.Time) bool {
	var ok bool
	r.do(func(m map[string]*sessionEntry) {
		e, found := m[id]
		if !found || !e.owned(c) {
			return
		}
		e.setState(SessionRestarting)
		e.Error = reason
		e.NextRestartAt = &next
		e.clearChild()
		ok = true
	})
	return ok
}

// beginRestart claims a restarting session for its respawn: it turns to
// starting, which a stop cancels (see cancelPending), and the restart is
// counted. It returns the project to spawn for; ok is false when the session
// was stopped during the backoff.
func (r *registry) beginRestart(id string) (project string, ok bool) {
	r.do(func(m map[string]*sessionEntry) {
		e, found := m[id]
		if !found || e.State != SessionRestarting {
			return
		}
		e.setState(SessionStarting)
		e.NextRestartAt = nil
		e.Restarts++
		project, ok = e.Project, true
	})
	return project, ok
}

// failOwned gives the session up: it turns to error with msg, unless it has
// moved on.
func (r *registry) failOwned(id string, c *child, msg string) {
	r.do(func(m map[string]*sessionEntry) {
		if e, found := m[id]; found && e.owned(c) {
			e.setState(SessionError)
			e.Error = msg
			e.NextRestartAt = nil
			e.clearChild()
		}
	})
}

// newSessionID returns a short random hex ID for a session.
func newSessionID() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		panic("newSessionID: crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}
