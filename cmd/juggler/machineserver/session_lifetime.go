//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"sync"
	"time"
)

// sessionViewerGrace covers reloads, reconnects and opening a window before its
// WebSocket is connected. A live turn holds the session beyond this grace.
const sessionViewerGrace = 10 * time.Second

// holdViewer counts one proxied socket or terminal, not a machine-server client.
// Its idempotent release starts the grace when the last viewer goes.
func (r *registry) holdViewer(id string) (release func(), ok bool) {
	var entry *sessionEntry
	r.do(func(m map[string]*sessionEntry) {
		e := m[id]
		if e == nil || e.State != SessionRunning {
			return
		}
		e.viewers++
		entry, ok = e, true
	})
	if !ok {
		return nil, false
	}
	var once sync.Once
	return func() {
		once.Do(func() {
			r.do(func(m map[string]*sessionEntry) {
				if m[id] != entry {
					return
				}
				entry.viewers--
				if entry.viewers == 0 {
					entry.unviewedSince = time.Now()
				}
			})
		})
	}, true
}

// retireUnviewed claims c's session, running with no viewer for the grace as
// of at, for the question whether its child may retire: the session turns
// stopping before the child is asked, so no viewer can arrive while it
// decides, and an open or stop joins the decision (whenStopped). The claim
// says nothing about the child's work — only the child's answer may authorize
// a teardown (Server.retire). The claimer owns removal, or hands the session
// back (retirementRefused).
func (r *registry) retireUnviewed(id string, c *child, at time.Time) (claimed bool) {
	r.do(func(m map[string]*sessionEntry) {
		e := m[id]
		if e == nil || e.child != c || e.State != SessionRunning || e.viewers != 0 ||
			e.unviewedSince.IsZero() || at.Sub(e.unviewedSince) < sessionViewerGrace {
			return
		}
		e.setState(SessionStopping)
		e.retiring = make(chan struct{})
		claimed = true
	})
	return claimed
}

// whenStopped waits for the owner of an existing stop to finish tearing down.
func (r *registry) whenStopped(id string) (done <-chan struct{}) {
	r.do(func(m map[string]*sessionEntry) {
		if e := m[id]; e != nil && e.State == SessionStopping {
			done = e.stopped
		}
	})
	return done
}

// unavailableStop is an expired backoff claimed for teardown. Its supervisor
// releases done after relinquishing the session; only then may it be removed.
type unavailableStop struct {
	id   string
	done <-chan struct{}
}

// expireUnavailable dismisses viewerless errors and claims viewerless backoffs
// for cancellation. Starting children get their grace once they are running.
func (r *registry) expireUnavailable(at time.Time) (pending []unavailableStop) {
	r.do(func(m map[string]*sessionEntry) {
		for id, e := range m {
			if e.viewers != 0 || e.unviewedSince.IsZero() || at.Sub(e.unviewedSince) < sessionViewerGrace {
				continue
			}
			switch e.State {
			case SessionError:
				e.end()
				delete(m, id)
			case SessionRestarting:
				e.setState(SessionStopping)
				e.NextRestartAt = nil
				if e.cancel != nil {
					e.cancel()
				}
				pending = append(pending, unavailableStop{id: id, done: e.done})
			}
		}
	})
	return pending
}

// expireUnavailable keeps supervisor teardown off the attachment-check tick.
// Claiming stopping inside the actor gives each backoff exactly one remover.
func (s *Server) expireUnavailable(at time.Time) {
	if s.reg == nil {
		return
	}
	for _, pending := range s.reg.expireUnavailable(at) {
		go func() {
			if pending.done != nil {
				<-pending.done
			}
			s.reg.remove(pending.id)
		}()
	}
}
