//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

// restartServer is a machine server whose children are stand-ins, with a
// restart policy fast enough to test.
func restartServer(t *testing.T, p restartPolicy) (*Server, *httptest.Server) {
	t.Helper()
	useHelperChildren(t)
	s := &Server{reg: newRegistry(), token: testToken, restart: p}
	front := httptest.NewServer(s.routes())
	t.Cleanup(func() {
		front.Close()
		s.stopAllChildren()
	})
	return s, front
}

// openStandIn opens a session for a fresh folder and returns its record.
func openStandIn(t *testing.T, front *httptest.Server) Session {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"project": t.TempDir()})
	req, _ := http.NewRequest("POST", front.URL+"/api/server/sessions", strings.NewReader(string(body)))
	req.Header.Set(TokenHeader, testToken)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var sess Session
	if err := json.NewDecoder(resp.Body).Decode(&sess); err != nil || resp.StatusCode != http.StatusCreated {
		t.Fatalf("open: status %d, %v", resp.StatusCode, err)
	}
	return sess
}

// exitChild makes the stand-in child behind sess exit with code.
func exitChild(t *testing.T, sess Session, code string) {
	t.Helper()
	if status, body := get(t, "http://"+sess.Addr+"/exit/"+code); status != http.StatusAccepted {
		t.Fatalf("ask child %s to exit: status %d: %s", sess.ID, status, body)
	}
}

// waitForRecord polls the registry until ok accepts the session's record (or
// its absence, ok(Session{}, false)), failing after timeout.
func waitForRecord(t *testing.T, s *Server, id, what string, timeout time.Duration, ok func(Session, bool) bool) Session {
	t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		sess, found := s.reg.get(id)
		if ok(sess, found) {
			return sess
		}
		if time.Now().After(deadline) {
			t.Fatalf("session %s never became %s; last: found=%v %+v", id, what, found, sess)
		}
		time.Sleep(5 * time.Millisecond)
	}
}

// TestCrashedSessionRestartsUnderItsID: a child that crashes is respawned
// after a backoff, under the same session ID, so the /s/<id>/ URL a user holds
// keeps working. While it waits the record says so, with when it will try.
func TestCrashedSessionRestartsUnderItsID(t *testing.T) {
	s, front := restartServer(t, restartPolicy{base: 300 * time.Millisecond, max: time.Second, limit: 3, stable: time.Hour})
	sess := openStandIn(t, front)

	exitChild(t, sess, "3")
	waiting := waitForRecord(t, s, sess.ID, "restarting", 5*time.Second, func(r Session, found bool) bool {
		return found && r.State == SessionRestarting
	})
	if waiting.NextRestartAt == nil || waiting.Restarts != 0 || waiting.Error == "" || waiting.PID != 0 || waiting.Addr != "" {
		t.Fatalf("restarting record = %+v, want a next attempt, an error, no pid, no address", waiting)
	}

	back := waitForRecord(t, s, sess.ID, "running again", 5*time.Second, func(r Session, found bool) bool {
		return found && r.State == SessionRunning && r.PID != 0 && r.PID != sess.PID
	})
	if back.Restarts != 1 || back.NextRestartAt != nil || back.Error != "" {
		t.Fatalf("restarted record = %+v, want restarts 1, no next attempt, no error", back)
	}
	if code, _ := get(t, front.URL+"/s/"+sess.ID+"/"); code != http.StatusOK {
		t.Fatalf("proxy to the restarted session: status %d, want 200", code)
	}
}

// TestKilledSessionRestarts: death by signal is a crash too.
func TestKilledSessionRestarts(t *testing.T) {
	s, front := restartServer(t, restartPolicy{base: 10 * time.Millisecond, max: 10 * time.Millisecond, limit: 3, stable: time.Hour})
	sess := openStandIn(t, front)
	p, err := os.FindProcess(sess.PID)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.Kill(); err != nil {
		t.Fatal(err)
	}
	waitForRecord(t, s, sess.ID, "running again", 5*time.Second, func(r Session, found bool) bool {
		return found && r.State == SessionRunning && r.PID != sess.PID && r.Restarts == 1
	})
}

// TestCleanExitEndsTheSession: a child that exits 0 was shut down on purpose —
// its own shutdown route, or a standalone server taking its project — so it is
// not restarted, which would fight that server for the project, and its
// session goes.
func TestCleanExitEndsTheSession(t *testing.T) {
	s, front := restartServer(t, restartPolicy{base: 10 * time.Millisecond, max: 10 * time.Millisecond, limit: 3, stable: time.Hour})
	sess := openStandIn(t, front)
	exitChild(t, sess, "0")
	waitForRecord(t, s, sess.ID, "removed", 5*time.Second, func(_ Session, found bool) bool { return !found })
}

// TestRepeatedCrashesEndInError: a child that keeps crashing is given up on
// after limit restarts, and the session shows why.
func TestRepeatedCrashesEndInError(t *testing.T) {
	s, front := restartServer(t, restartPolicy{base: 10 * time.Millisecond, max: 20 * time.Millisecond, limit: 2, stable: time.Hour})
	sess := openStandIn(t, front)
	for i := 1; i <= 2; i++ {
		exitChild(t, sess, "1")
		prev := sess.PID
		sess = waitForRecord(t, s, sess.ID, "running again", 5*time.Second, func(r Session, found bool) bool {
			return found && r.State == SessionRunning && r.PID != prev && r.Restarts == i
		})
	}
	exitChild(t, sess, "1")
	failed := waitForRecord(t, s, sess.ID, "error", 5*time.Second, func(r Session, found bool) bool {
		return found && r.State == SessionError
	})
	if !strings.Contains(failed.Error, "3 times") || failed.NextRestartAt != nil {
		t.Fatalf("given-up record = %+v, want an error naming the 3 crashes and no next attempt", failed)
	}
}

// sleepless is a restart policy whose backoff no test can sleep out, so a
// supervisor that returns during it was cancelled.
var sleepless = restartPolicy{base: time.Hour, max: time.Hour, limit: 3, stable: time.Hour}

// supervisorsEnded fails unless every spawner and supervisor has released its
// claim, allowing a second for one that is returning as the check starts.
func supervisorsEnded(t *testing.T, s *Server, after string) {
	t.Helper()
	ended := make(chan struct{})
	go func() {
		s.work.Wait()
		close(ended)
	}()
	select {
	case <-ended:
	case <-time.After(time.Second):
		t.Fatalf("%s: a supervisor is still running", after)
	}
}

// shutDownWithin runs the server's shutdown of its sessions and fails unless
// it returns within d.
func shutDownWithin(t *testing.T, s *Server, d time.Duration) {
	t.Helper()
	done := make(chan struct{})
	go func() {
		s.stopAllChildren()
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(d):
		t.Fatalf("shutdown did not return within %s", d)
	}
}

// hangingChildren makes every spawn after the first normal ones start a
// stand-in that hangs in its handshake (helperHangEnv), dialling the returned
// listener as it does.
func hangingChildren(t *testing.T, normal int) net.Listener {
	t.Helper()
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = ln.Close() })
	var spawns atomic.Int64
	helper := newChildCommand
	newChildCommand = func(bin, project string, extra []string) *exec.Cmd {
		cmd := helper(bin, project, extra)
		if spawns.Add(1) > int64(normal) {
			cmd.Env = append(cmd.Env, helperHangEnv+"="+ln.Addr().String())
		}
		return cmd
	}
	t.Cleanup(func() { newChildCommand = helper })
	return ln
}

// acceptHungChild waits for a hanging stand-in to dial in, which it does from
// inside spawnChild's handshake.
func acceptHungChild(t *testing.T, ln net.Listener) net.Conn {
	t.Helper()
	_ = ln.(*net.TCPListener).SetDeadline(time.Now().Add(10 * time.Second))
	conn, err := ln.Accept()
	if err != nil {
		t.Fatalf("no hanging child dialled in: %v", err)
	}
	t.Cleanup(func() { _ = conn.Close() })
	return conn
}

// hungChildGone fails unless the hanging stand-in on conn has died — its end
// of the connection closed — within d.
func hungChildGone(t *testing.T, conn net.Conn, d time.Duration, after string) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(d))
	_, err := conn.Read(make([]byte, 1))
	var ne net.Error
	if err == nil || errors.As(err, &ne) && ne.Timeout() {
		t.Fatalf("%s: the child in its handshake was still alive %s later", after, d)
	}
}

// TestStopDuringBackoffCancelsTheRestart: stopping a session that is waiting
// to restart removes it, ends its supervisor without waiting out the backoff,
// and nothing is spawned for it afterwards.
func TestStopDuringBackoffCancelsTheRestart(t *testing.T) {
	s, front := restartServer(t, sleepless)
	var spawns atomic.Int64
	helper := newChildCommand
	newChildCommand = func(bin, project string, extra []string) *exec.Cmd {
		spawns.Add(1)
		return helper(bin, project, extra)
	}
	sess := openStandIn(t, front)
	exitChild(t, sess, "1")
	waitForRecord(t, s, sess.ID, "restarting", 5*time.Second, func(r Session, found bool) bool {
		return found && r.State == SessionRestarting
	})
	if code := send(t, "DELETE", front.URL+"/api/server/sessions/"+sess.ID, testToken, ""); code != http.StatusNoContent {
		t.Fatalf("stop during backoff: status %d, want 204", code)
	}
	supervisorsEnded(t, s, "after a stop during backoff")
	if list := s.reg.snapshot(); len(list) != 0 || spawns.Load() != 1 {
		t.Fatalf("after a stop during backoff: sessions %+v, %d spawns; want none, and only the first spawn", list, spawns.Load())
	}
}

// TestShutdownDuringBackoffEndsTheSupervisor: shutting the server down while a
// session waits to restart ends its supervisor at once, before shutdown
// returns, rather than leaving it to sleep out the backoff.
func TestShutdownDuringBackoffEndsTheSupervisor(t *testing.T) {
	s, front := restartServer(t, sleepless)
	sess := openStandIn(t, front)
	exitChild(t, sess, "1")
	waitForRecord(t, s, sess.ID, "restarting", 5*time.Second, func(r Session, found bool) bool {
		return found && r.State == SessionRestarting
	})
	shutDownWithin(t, s, 5*time.Second)
	supervisorsEnded(t, s, "after shutdown during backoff")
	if list := s.reg.snapshot(); len(list) != 0 {
		t.Fatalf("after shutdown: sessions %+v, want none", list)
	}
}

// TestShutdownMidRespawnKillsTheHandshakingChild: shutting the server down
// while a crashed session's replacement is still in its handshake kills that
// child, and shutdown returns only once it and its supervisor are gone —
// not when the handshake would have timed out.
func TestShutdownMidRespawnKillsTheHandshakingChild(t *testing.T) {
	s, front := restartServer(t, restartPolicy{base: 10 * time.Millisecond, max: 10 * time.Millisecond, limit: 3, stable: time.Hour})
	hung := hangingChildren(t, 1)
	sess := openStandIn(t, front)
	exitChild(t, sess, "1")
	conn := acceptHungChild(t, hung)
	shutDownWithin(t, s, 5*time.Second)
	hungChildGone(t, conn, 2*time.Second, "shutdown mid-respawn")
	supervisorsEnded(t, s, "after shutdown mid-respawn")
	if list := s.reg.snapshot(); len(list) != 0 {
		t.Fatalf("after shutdown: sessions %+v, want none", list)
	}
}

// TestStopWhileStartingCancelsTheSpawn: stopping a session whose first child
// is still in its handshake kills that child and removes the session (204),
// rather than refusing until the spawn ends; the open that started it fails.
func TestStopWhileStartingCancelsTheSpawn(t *testing.T) {
	s, front := restartServer(t, restartPolicy{base: 10 * time.Millisecond, max: 10 * time.Millisecond, limit: 3, stable: time.Hour})
	hung := hangingChildren(t, 0)
	body, _ := json.Marshal(map[string]string{"project": t.TempDir()})
	opened := make(chan int, 1)
	go func() {
		req, _ := http.NewRequest("POST", front.URL+"/api/server/sessions", strings.NewReader(string(body)))
		req.Header.Set(TokenHeader, testToken)
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			opened <- 0
			return
		}
		_ = resp.Body.Close()
		opened <- resp.StatusCode
	}()
	conn := acceptHungChild(t, hung)
	list := s.reg.snapshot()
	if len(list) != 1 || list[0].State != SessionStarting {
		t.Fatalf("while the child is in its handshake: sessions %+v, want one starting", list)
	}
	if code := send(t, "DELETE", front.URL+"/api/server/sessions/"+list[0].ID, testToken, ""); code != http.StatusNoContent {
		t.Fatalf("stop while starting: status %d, want 204", code)
	}
	hungChildGone(t, conn, 2*time.Second, "stop while starting")
	select {
	case code := <-opened:
		if code == http.StatusCreated || code == http.StatusOK {
			t.Fatalf("the open whose session was stopped while starting answered %d", code)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("the open whose session was stopped while starting never answered")
	}
	if list := s.reg.snapshot(); len(list) != 0 {
		t.Fatalf("after a stop while starting: sessions %+v, want none", list)
	}
}

// TestRestartBackoff: the delay doubles from base up to max.
func TestRestartBackoff(t *testing.T) {
	p := restartPolicy{base: time.Second, max: 30 * time.Second}
	want := []time.Duration{time.Second, 2 * time.Second, 4 * time.Second, 8 * time.Second, 16 * time.Second, 30 * time.Second, 30 * time.Second}
	for i, w := range want {
		if got := p.delay(i + 1); got != w {
			t.Errorf("delay(%d) = %s, want %s", i+1, got, w)
		}
	}
}
