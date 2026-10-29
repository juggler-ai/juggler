//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"context"
	"io"
	"net/http"

	"juggler/internal/apipaths"
)

// retireOutcome is how a retirement request ended.
type retireOutcome int

const (
	// retireRefused: the child answered that something holds its session, or
	// that it could not decide. Nothing was committed and it runs on.
	retireRefused retireOutcome = iota
	// retireAccepted: the child committed — its admission is closed for good —
	// and is shutting down.
	retireAccepted
	// retireExited: the child exited before it answered.
	retireExited
)

// retireHTTP carries retirement requests. It has no timeout: the child's
// answer is bounded by its workers' progress, and the wait for it by the
// child's life (requestRetirement).
var retireHTTP = &http.Client{}

// requestRetirement asks c to retire and waits for its answer or its exit,
// whichever comes first, and for nothing else. A child slow to settle its
// workers is still deciding, and a commit it made after the caller had given
// up would shut it down regardless, under a session handed back as running.
func requestRetirement(c *child) retireOutcome {
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	go func() {
		select {
		case <-c.exited:
			cancel()
		case <-ctx.Done():
		}
	}()
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, "http://"+c.addr+apipaths.HealthRetire, nil)
	if err != nil {
		return retireRefused
	}
	req.Header.Set(TokenHeader, c.apiToken)
	resp, err := retireHTTP.Do(req)
	if err != nil {
		select {
		case <-c.exited:
			return retireExited
		default:
			// The child lives and no answer came, so nothing was committed: a
			// child writes its commit before it begins to shut down, and its
			// shutdown drains the response.
			return retireRefused
		}
	}
	defer resp.Body.Close()
	_, _ = io.Copy(io.Discard, resp.Body)
	if resp.StatusCode == http.StatusAccepted {
		return retireAccepted
	}
	return retireRefused
}

// retire asks c, whose session retireUnviewed has claimed, whether it may
// retire, and acts on the outcome. Reports whether c is finished with — gone,
// or exited and left to its supervisor.
//
//   - Accepted: the child is stopped (it is already on its way) and the
//     session removed. An open that joined the decision then spawns afresh.
//   - Exited cleanly before answering: a commit whose answer was lost, or a
//     deliberate shutdown; either way the session is over, and it is removed
//     here rather than handed back, so a joined open is never given it.
//   - Crashed before answering: the session is handed back to its supervisor,
//     which restarts it.
//   - Refused: the session is handed back running.
func (s *Server) retire(id string, c *child) (finished bool) {
	switch requestRetirement(c) {
	case retireAccepted:
		c.stop()
		s.reg.remove(id)
		return true
	case retireExited:
		if c.exitedCleanly() {
			s.reg.remove(id)
		} else {
			s.reg.retirementRefused(id, c)
		}
		return true
	default:
		s.reg.retirementRefused(id, c)
		return false
	}
}

// retirementRefused hands a session claimed by retireUnviewed back to its
// child: running again, it admits viewers, and opens and stops waiting on the
// decision retry. Its supervisor, waiting on the decision if the child exited,
// takes it from here.
func (r *registry) retirementRefused(id string, c *child) {
	r.do(func(m map[string]*sessionEntry) {
		e := m[id]
		if e == nil || e.child != c || e.State != SessionStopping || e.retiring == nil || e.retireTaken {
			return
		}
		if e.stopped != nil {
			close(e.stopped)
			e.stopped = nil
		}
		e.setState(SessionRunning)
		e.closeRetiring()
	})
}

// takeRetirement hands an explicit stop the child of a session whose
// retirement is being decided. The stop does not wait on the child's answer —
// a wedged child would never give one — but stops the child itself; its exit
// ends the decision, and the stop removes the session whatever the answer.
// ok is false when no decision is open, or another stop has taken it.
func (r *registry) takeRetirement(id string) (c *child, ok bool) {
	r.do(func(m map[string]*sessionEntry) {
		e := m[id]
		if e == nil || e.State != SessionStopping || e.retiring == nil || e.retireTaken || e.child == nil {
			return
		}
		e.retireTaken = true
		c, ok = e.child, true
	})
	return c, ok
}

// closeRetiring ends the entry's retirement question, waking a supervisor
// waiting on it.
func (e *sessionEntry) closeRetiring() {
	if e.retiring != nil {
		close(e.retiring)
		e.retiring = nil
	}
}

// retirementDecision is what a supervisor whose child has exited waits on
// before it acts: the question retireUnviewed opened, if one is open. It
// closes once the session is removed or handed back, so the supervisor then
// finds it gone or its own.
func (r *registry) retirementDecision(id string, c *child) (decision <-chan struct{}) {
	r.do(func(m map[string]*sessionEntry) {
		if e := m[id]; e != nil && e.child == c {
			decision = e.retiring
		}
	})
	return decision
}
