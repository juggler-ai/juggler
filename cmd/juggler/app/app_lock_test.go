//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"errors"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
)

// lockedProject returns a project directory whose .juggler/juggler.lock is held
// by an in-process holder, along with the holder itself. flock is held per open
// file description, so a second InstanceLock in this process contends with it
// exactly as another process would.
func lockedProject(t *testing.T) (string, *core.InstanceLock) {
	t.Helper()
	dir := t.TempDir()
	holder := core.NewInstanceLock(dir)
	res, err := holder.TryAcquire()
	if err != nil || !res.Acquired {
		t.Fatalf("holder could not take the lock: acquired=%v err=%v", res.Acquired, err)
	}
	t.Cleanup(func() { _ = holder.Release() })
	return dir, holder
}

// appUnder returns an App wired up to acquire dir's lock, as startup does.
func appUnder(t *testing.T, dir string) *App {
	t.Helper()
	a := &App{projectPath: dir, cfg: &core.Config{}}
	t.Cleanup(a.runCleanups)
	return a
}

// TestAcquireInstanceRefusesAHeldLockAtOnce: a project's lock is held only by
// a session child, or by the test harness, and whoever spawns one has already
// arbitrated who owns the project — the machine server keys sessions by
// project and waits out a child it stopped. So a held lock is refused at once,
// with the advice that explains it, whatever the holder is doing: it is not
// waited on, prompted about or killed, even when it lets go a moment later.
func TestAcquireInstanceRefusesAHeldLockAtOnce(t *testing.T) {
	for _, child := range []bool{false, true} {
		dir, holder := lockedProject(t)
		go func() {
			time.Sleep(300 * time.Millisecond)
			_ = holder.Release()
		}()

		a := appUnder(t, dir)
		a.flags.sessionChild = child
		start := time.Now()
		err := a.acquireInstance()
		var locked *core.ProjectLockedError
		if !errors.As(err, &locked) || locked.Project != dir {
			t.Fatalf("session child %v: acquireInstance = %v, want a ProjectLockedError for %s", child, err, dir)
		}
		if took := time.Since(start); took >= 300*time.Millisecond {
			t.Errorf("session child %v: refusing a held lock took %v; it waited for the holder", child, took)
		}
	}
}
