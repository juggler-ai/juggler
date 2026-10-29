//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"juggler/internal/apipaths"
)

// retirementRaceWait uses the test's deadline for goroutine joins, rather than
// giving a slow child or actor a separate nominal time budget.
func retirementRaceWait(t *testing.T, done <-chan struct{}, what string) {
	t.Helper()
	select {
	case <-done:
		return
	default:
	}
	ctx := t.Context()
	if deadline, ok := t.Deadline(); ok {
		var cancel context.CancelFunc
		ctx, cancel = context.WithDeadline(ctx, deadline)
		defer cancel()
	}
	select {
	case <-done:
	case <-ctx.Done():
		t.Fatalf("test deadline waiting for %s", what)
	}
}

// heldRetirement runs the actual poller and supervisor against a real stand-in
// process. Only its health address points at a gated HTTP server in the test;
// its original address still permits deliberate clean exits and crashes. The
// child's answer to the retirement request waits for release.
func heldRetirement(t *testing.T, accepted bool) (*Server, Session, *child, *claim, func(), <-chan struct{}) {
	t.Helper()
	c := spawnHelperChildren(t, 1)[0]
	originalAddr := c.addr
	entered, allow := make(chan struct{}), make(chan struct{})
	var enteredOnce, allowOnce sync.Once
	release := func() { allowOnce.Do(func() { close(allow) }) }
	backend := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == apipaths.HealthRetire {
			enteredOnce.Do(func() { close(entered) })
			select {
			case <-allow:
			case <-r.Context().Done():
				return
			}
			if accepted {
				w.WriteHeader(http.StatusAccepted)
			} else {
				w.WriteHeader(http.StatusConflict)
			}
			return
		}
		// Once asked, the child reports a running turn, so no second
		// retirement races the stop or supervisor under test.
		active := false
		select {
		case <-entered:
			active = true
		default:
		}
		_ = json.NewEncoder(w).Encode(map[string]bool{"active": active})
	}))
	c.addr = strings.TrimPrefix(backend.URL, "http://")
	s := &Server{reg: newRegistry(), restart: sleepless}
	sess, cl, err := s.reg.open(s.lifetime(), t.TempDir(), &s.work)
	if err != nil || cl == nil || !s.reg.setRunning(sess.ID, c, c.cmd.Process.Pid) {
		t.Fatalf("register stand-in: claim=%v err=%v", cl, err)
	}
	sess, _ = s.reg.get(sess.ID)
	sess.Addr = originalAddr
	s.reg.do(func(m map[string]*sessionEntry) { m[sess.ID].unviewedSince = time.Now().Add(-sessionViewerGrace) })
	s.startSupervising(sess.ID, c, cl)
	polled := make(chan struct{})
	go func() {
		s.pollActivity(sess.ID, c, time.Millisecond)
		close(polled)
	}()
	t.Cleanup(func() {
		release()
		s.stopAllChildren()
		<-polled
		backend.Close()
	})
	retirementRaceWait(t, entered, "held retirement request")
	if cur, ok := s.reg.get(sess.ID); !ok || cur.State != SessionStopping {
		t.Fatalf("retirement did not claim the session stopping first: exists=%v session=%+v", ok, cur)
	}
	return s, sess, c, cl, release, polled
}

// stopBound is what an explicit stop owes its caller: the child's interrupt
// grace, then its kill grace (child.stop), with one more for the bookkeeping.
const stopBound = 3 * childStopGrace

// A stop or shutdown that meets a decision the child never answers does not
// wait on it: it stops the child itself, and the child's exit ends the
// decision. The stand-in's answer is never released.
func TestRetirementRaceStopOrShutdown(t *testing.T) {
	for _, action := range []string{"stop", "shutdown"} {
		t.Run(action, func(t *testing.T) {
			s, sess, c, cl, _, polled := heldRetirement(t, true)
			decision := s.reg.retirementDecision(sess.ID, c)
			completed := make(chan struct{})
			var found bool
			go func() {
				if action == "shutdown" {
					s.stopAllChildren()
				} else {
					found = s.stopSession(sess.ID)
				}
				close(completed)
			}()
			select {
			case <-completed:
			case <-time.After(stopBound):
				t.Fatalf("%s waited on a retirement the child never answers (child exited: %v)", action, closed(c.exited))
			}
			for name, done := range map[string]<-chan struct{}{
				"stopped child": c.exited, "retirement decision": decision,
				"released supervisor": cl.done, "retirement poller": polled,
			} {
				retirementRaceWait(t, done, name)
			}
			if action == "stop" && !found {
				t.Fatal("explicit stop did not find the retiring session")
			}
			if _, ok := s.reg.get(sess.ID); ok {
				t.Fatal("stop/shutdown left the session")
			}
		})
	}
}

// A child that exits while it decides has decided by exiting: the wait for its
// answer ends with the process, never left hanging. A clean exit is the end of
// the session; a crash goes back to its supervisor, which restarts it.
func TestRetirementRaceChildExitDecision(t *testing.T) {
	for _, exit := range []string{"clean-exit", "crash"} {
		t.Run(exit, func(t *testing.T) {
			s, sess, c, cl, _, polled := heldRetirement(t, true)
			decision, stopped := s.reg.retirementDecision(sess.ID, c), s.reg.whenStopped(sess.ID)
			code := "0"
			if exit == "crash" {
				code = "3"
			}
			exitChild(t, sess, code)
			retirementRaceWait(t, c.exited, "child exit during the decision")
			// Never released: the exit alone must end the decision.
			retirementRaceWait(t, decision, "decision after the child's exit")
			retirementRaceWait(t, stopped, "original stop waiter")
			retirementRaceWait(t, polled, "retirement poller after child exit")
			if exit == "crash" {
				waitForRecord(t, s, sess.ID, "supervised restart backoff", time.Until(testRetirementDeadline(t)), func(cur Session, ok bool) bool {
					return ok && cur.State == SessionRestarting
				})
				s.stopAllChildren()
			}
			retirementRaceWait(t, cl.done, "supervisor after child exit")
			if _, ok := s.reg.get(sess.ID); ok {
				t.Fatal("completed child exit left a session")
			}
		})
	}
}

func testRetirementDeadline(t *testing.T) time.Time {
	t.Helper()
	if deadline, ok := t.Deadline(); ok {
		return deadline
	}
	t.Fatal("retirement race tests require a test deadline")
	return time.Time{}
}
