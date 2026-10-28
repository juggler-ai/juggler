//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"sync"
	"time"

	"juggler/internal/jlog"
)

// defaultIdleTimeout is how long an implicit server stays up once nothing
// holds it up (see watchIdle). Long enough that quitting and reopening the
// desktop app, or a short break, finds the sessions still running; short
// enough that an abandoned server gives its children's memory back.
const defaultIdleTimeout = 10 * time.Minute

// serveIdleTimeout is the idle timeout RunCommand gives the server. A seam for
// the stand-in server in tests.
var serveIdleTimeout = defaultIdleTimeout

// idleCheckEvery is how often a server whose idle timeout is d checks whether
// it is idle: often enough that it exits within a sixtieth of d of its
// timeout.
func idleCheckEvery(d time.Duration) time.Duration {
	return max(d/60, time.Millisecond)
}

// attach counts one more client holding the server up, until the returned
// detach (which may be called more than once) lets it go. Every client is
// counted this way: a proxied WebSocket, a held POST /api/server/attach, and a
// process that serves in its own foreground.
func (s *Server) attach() (detach func()) {
	s.attached.Add(1)
	s.stir()
	var once sync.Once
	return func() {
		once.Do(func() {
			s.attached.Add(-1)
			s.stir()
		})
	}
}

// stir records that a client did something here just now. The idle clock
// runs from no earlier than that.
func (s *Server) stir() {
	s.stirred.Store(time.Now().UnixNano())
}

// heldUp reports whether anything keeps the server up whatever the idle clock
// says: an attached client; a session running a turn, starting, or waiting to
// restart; LAN access on; or allowed hosts configured, whose reverse proxy
// would answer 502 to a caller who cannot restart the server. A turn parked
// only on an approval is not running (Session.Busy), so it holds nothing up.
func (s *Server) heldUp() bool {
	if s.attached.Load() > 0 || s.lan.Load() || len(s.allowedHosts.Names()) > 0 {
		return true
	}
	for _, sess := range s.reg.snapshot() {
		if sess.Busy || sess.State == SessionStarting || sess.State == SessionRestarting {
			return true
		}
	}
	return false
}

// watchIdle shuts an implicit server down once it has been idle for its
// timeout (idleTimeout, zero meaning defaultIdleTimeout). It checks on each
// tick, at the time the tick carries. The idle span runs from the latest of
// the server starting, a check that found it held up (heldUp), and a client
// stirring it (stir), so a turn that ran or a client that came and went
// between two checks still restarts the clock. A busy session is seen only as
// often as its activity is polled, which a timeout of minutes does not notice.
//
// The shutdown it asks for is any other shutdown's (shutdownReq), and it
// returns then, when ticks closes, or when the server's lifetime ends. checked,
// when set, is told each idle span measured short of the timeout. A server
// started by hand (not implicit) never exits idle, so it checks nothing.
func (s *Server) watchIdle(ticks <-chan time.Time, checked func(idle time.Duration)) {
	if !s.implicit {
		return
	}
	timeout := s.idleTimeout
	if timeout == 0 {
		timeout = defaultIdleTimeout
	}
	since := s.startedAt
	for {
		var now time.Time
		select {
		case t, ok := <-ticks:
			if !ok {
				return
			}
			now = t
		case <-s.lifetime().Done():
			return
		}
		if since.IsZero() || s.heldUp() {
			since = now
		}
		if n := s.stirred.Load(); n != 0 {
			if at := time.Unix(0, n); at.After(since) {
				since = at
			}
		}
		idle := now.Sub(since)
		if idle >= timeout {
			jlog.Info("[machineserver] idle for %s with no clients and no work — shutting down", idle.Round(time.Second))
			s.requestShutdown()
			return
		}
		if checked != nil {
			checked(idle)
		}
	}
}
