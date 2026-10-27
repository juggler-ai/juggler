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

// reserve opens a session for project as a test's own spawner would, outside
// any server's lifetime and uncounted, and reports whether it was created. The
// claim is dropped: a test that registers its own child stands in for both
// spawner and supervisor.
func (r *registry) reserve(project string) (Session, bool) {
	s, cl, _ := r.open(context.Background(), project, new(sync.WaitGroup))
	return s, cl != nil
}

func TestRegistryReserveReuseAndErrorReplace(t *testing.T) {
	r := newRegistry()

	s1, created := r.reserve("/proj/a")
	if !created || s1.State != SessionStarting {
		t.Fatalf("first reserve: created=%v state=%s", created, s1.State)
	}

	// A second reserve for the same project reuses the in-flight reservation.
	s2, created := r.reserve("/proj/a")
	if created || s2.ID != s1.ID {
		t.Fatalf("expected reuse of starting session, got created=%v id=%s (want %s)", created, s2.ID, s1.ID)
	}

	// A different project gets its own reservation.
	other, created := r.reserve("/proj/b")
	if !created || other.ID == s1.ID {
		t.Fatalf("distinct project should create: created=%v", created)
	}

	if !r.setRunning(s1.ID, &child{addr: "127.0.0.1:1"}, 42) {
		t.Fatal("setRunning on a live reservation should succeed")
	}
	s3, created := r.reserve("/proj/a")
	if created || s3.State != SessionRunning || s3.PID != 42 || s3.Addr != "127.0.0.1:1" {
		t.Fatalf("expected reuse of running session, got created=%v %+v", created, s3)
	}

	// An errored entry is replaced by a fresh reservation.
	r.setError(s1.ID, "boom")
	s4, created := r.reserve("/proj/a")
	if !created || s4.ID == s1.ID {
		t.Fatalf("errored session should be replaced: created=%v id=%s", created, s4.ID)
	}
	if _, ok := r.get(s1.ID); ok {
		t.Fatal("errored entry should have been dropped on replace")
	}
}

func TestRegistryStopAndExitInterplay(t *testing.T) {
	r := newRegistry()
	c := &child{addr: "127.0.0.1:2", exited: make(chan struct{})}

	s, _ := r.reserve("/p")
	r.setRunning(s.ID, c, 7)

	got, ok := r.beginStop(s.ID)
	if !ok || got != c {
		t.Fatalf("beginStop should hand back the live child (ok=%v)", ok)
	}
	// The child's exit during a supervised stop is not its supervisor's to
	// act on — the stopper owns removing it.
	if r.setRestarting(s.ID, c, "exit", time.Now()) || r.removeOwned(s.ID, c) {
		t.Fatal("the supervisor acted on a session a stop had claimed")
	}
	r.failOwned(s.ID, c, "boom")
	if cur, _ := r.get(s.ID); cur.State != SessionStopping {
		t.Fatalf("state after exit-during-stop = %s, want stopping", cur.State)
	}
	r.remove(s.ID)
	if _, ok := r.get(s.ID); ok {
		t.Fatal("removed session still present")
	}

	// A crash turns the entry to restarting, with the child cleared; a stop
	// can't claim a child it no longer has, and the respawn claims it.
	s2, _ := r.reserve("/p")
	r.setRunning(s2.ID, c, 8)
	if !r.setRestarting(s2.ID, c, "crashed", time.Now()) {
		t.Fatal("setRestarting on the supervisor's own running session failed")
	}
	cur, _ := r.get(s2.ID)
	if cur.State != SessionRestarting || cur.PID != 0 || cur.Addr != "" || cur.Error != "crashed" {
		t.Fatalf("crashed session should be restarting and cleared, got %+v", cur)
	}
	if _, ok := r.beginStop(s2.ID); ok {
		t.Fatal("beginStop on a restarting session should fail")
	}
	if project, ok := r.beginRestart(s2.ID); !ok || project != "/p" {
		t.Fatalf("beginRestart = %q, %v; want /p, true", project, ok)
	}
	if cur, _ := r.get(s2.ID); cur.State != SessionStarting || cur.Restarts != 1 {
		t.Fatalf("after beginRestart: %+v, want starting with one restart", cur)
	}
	if _, ok := r.beginRestart(s2.ID); ok {
		t.Fatal("a second beginRestart claimed a session already claimed")
	}

	// A respawn that failed leaves the supervisor owning the session with no
	// child; giving up turns it to error.
	r.failOwned(s2.ID, nil, "gave up")
	if cur, _ := r.get(s2.ID); cur.State != SessionError || cur.Error != "gave up" {
		t.Fatalf("after failOwned: %+v, want error", cur)
	}
}

func TestRegistrySetRunningOnRemovedReservation(t *testing.T) {
	r := newRegistry()
	s, _ := r.reserve("/p")
	r.remove(s.ID)
	if r.setRunning(s.ID, &child{addr: "x"}, 1) {
		t.Fatal("setRunning on a removed reservation should report failure")
	}
}
