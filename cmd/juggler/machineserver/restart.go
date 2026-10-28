//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"fmt"
	"time"

	"juggler/internal/jlog"
)

// restartPolicy governs respawning a session child that crashed. The zero
// value means defaultRestartPolicy.
type restartPolicy struct {
	// base is the delay before the first restart; each further crash in a
	// row doubles it, up to max.
	base, max time.Duration
	// limit is how many restarts in a row are attempted. The crash after the
	// last of them gives the session up (SessionError).
	limit int
	// stable is how long a child must run for its crash to start a fresh
	// count, rather than continue the one that led to it.
	stable time.Duration
}

var defaultRestartPolicy = restartPolicy{base: time.Second, max: 30 * time.Second, limit: 5, stable: 5 * time.Minute}

func (p restartPolicy) orDefault() restartPolicy {
	if p == (restartPolicy{}) {
		return defaultRestartPolicy
	}
	return p
}

// delay is the wait before the n-th restart in a row (n from 1).
func (p restartPolicy) delay(n int) time.Duration {
	d := p.base
	for i := 1; i < n && d < p.max; i++ {
		d *= 2
	}
	return min(d, p.max)
}

// startSupervising hands a freshly running child, and the claim on its
// session, to the session's supervisor, which releases the claim when it
// returns.
func (s *Server) startSupervising(id string, c *child, cl *claim) {
	go s.supervise(id, c, cl)
}

// supervise watches a session's child for as long as the session is its to
// watch, polling its activity while it runs.
//
//   - A clean exit (status 0) is a deliberate shutdown — the child's own
//     shutdown route, or a standalone server that took the project over — so
//     the session goes. Restarting it would fight that server for the
//     project lock.
//   - A crash (any other status, or a signal) turns the session to restarting
//     and respawns its project under the same ID after restartPolicy.delay,
//     so the /s/<id>/ a user holds keeps working. A respawn that fails counts
//     as another crash.
//   - Past restartPolicy.limit crashes in a row, the session is given up and
//     turns to error.
//
// A stop or shutdown that claims the session ends supervision: every registry
// transition here applies only while the session is still this child's (see
// sessionEntry.owned). A stop of a running session stops the child, and the
// supervisor then finds the session no longer its own. A stop during the
// backoff or a respawn's handshake, and shutdown, cancel the session's
// context, which ends the backoff at once and kills a child still in its
// handshake (spawnChild).
func (s *Server) supervise(id string, c *child, cl *claim) {
	defer cl.release()
	p := s.restart.orDefault()
	crashes := 0
	for {
		started := time.Now()
		go s.pollActivity(id, c, activityPollInterval)
		<-c.exited
		if c.exitedCleanly() {
			if s.reg.removeOwned(id, c) {
				jlog.Info("[machineserver] session %s: child exited cleanly; session ended", id)
			}
			return
		}
		if time.Since(started) >= p.stable {
			crashes = 0
		}
		reason := c.exitReason()
		var next *child
		for next == nil {
			crashes++
			if crashes > p.limit {
				jlog.Error("[machineserver] session %s: giving up after %d crashes: %s", id, crashes, reason)
				s.reg.failOwned(id, c, fmt.Sprintf("session child crashed %d times in a row; last: %s", crashes, reason))
				return
			}
			wait := p.delay(crashes)
			if !s.reg.setRestarting(id, c, reason, time.Now().Add(wait)) {
				return
			}
			jlog.Error("[machineserver] session %s: %s; restarting in %s", id, reason, wait)
			c = nil
			backoff := time.NewTimer(wait)
			select {
			case <-backoff.C:
			case <-cl.ctx.Done():
				backoff.Stop()
				return
			}
			project, ok := s.reg.beginRestart(id)
			if !ok {
				return
			}
			spawned, err := spawnChild(cl.ctx, s.childBin, project, s.childExtraArgs(id))
			if err != nil {
				if cl.ctx.Err() != nil {
					return
				}
				reason = err.Error()
				continue
			}
			if !s.reg.setRunning(id, spawned, spawned.cmd.Process.Pid) {
				spawned.stop()
				return
			}
			jlog.Info("[machineserver] session %s: restarted at %s (pid %d)", id, spawned.addr, spawned.cmd.Process.Pid)
			next = spawned
		}
		c = next
	}
}
