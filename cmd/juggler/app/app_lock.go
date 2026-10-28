//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"bufio"
	"fmt"
	"os"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/jlog"
)

// acquireInstance enforces single-instance-per-project. The happy path is one
// TryAcquire call; the rest of this method handles the contended case where
// .juggler/juggler.lock is held — possibly by a live instance, possibly by a
// crashed one that left stale info.
func (a *App) acquireInstance() error {
	if a.projectPath == "" {
		// No-project mode: nothing to lock. The user picks a project at
		// runtime; locking happens then via the server's project switch.
		return nil
	}
	lock := core.NewInstanceLock(a.projectPath)
	a.lock = lock
	// The server normally takes ownership and releases this lock during Shutdown.
	// Register a startup-failure backstop now: any later phase can fail before the
	// server exists, and its cleanup must not leave the lock held by this process.
	a.pushCleanup(func() {
		if a.lock != nil {
			_ = a.lock.Release()
		}
	})

	res, err := lock.TryAcquire(a.cfg.Server.Port, a.cfg.Server.Host)
	if err != nil {
		jlog.Error("Failed to check instance lock: %v", err)
		return err
	}

	if res.FirstRun {
		jlog.Info("📁 Created .juggler/ folder for this project")
		jlog.Info("   Juggler can read and modify files in this directory.")
		jlog.Info("   Review all AI-suggested changes before accepting.")
		jlog.Info("")
	}

	if !res.Acquired {
		if a.flags.sessionChild {
			// A session child is only ever spawned by a supervisor that has
			// already arbitrated ownership, so a held lock means a genuinely
			// live holder: refuse and report, never prompt or kill.
			return fmt.Errorf("project %s is locked by another juggler instance", a.projectPath)
		}
		if err := a.handleExistingInstance(res.Existing); err != nil {
			return err
		}
	}

	// Lock ownership transfers to the server (via Config.BootLock) so that
	// runtime project switches can release it before acquiring a new one. The
	// cleanup registered above remains an idempotent backstop for startup errors
	// and abnormal paths which bypass server construction.
	return nil
}

// handleExistingInstance handles the case where TryAcquire failed: work out
// what kind of holder we are contending with, and either supersede it or wait
// for it to finish leaving. Returns nil only when the lock is now held by us.
func (a *App) handleExistingInstance(existing *core.InstanceInfo) error {
	// Classify rather than merely verify. A holder that answers for this
	// project is only a live peer worth prompting about if it intends to stay:
	// an --exit-with-parent orphan whose parent has already gone is on its way
	// out, and waiting beats offering to kill something that is killing itself.
	if core.ClassifyRunningInstance(existing, a.projectPath) == core.InstanceReusable {
		return a.supersedeRunningInstance(existing)
	}

	// Everything else — unreachable, or an orphan mid-exit — is a holder on its
	// way out. A nil `existing` lands here too, and should: Release deletes
	// instance.json before it unlocks, so "held, with no metadata" is a moment
	// inside someone else's teardown, not a corrupt lock.
	return a.waitForDepartingInstance(existing)
}

// waitForDepartingInstance polls for a lock whose holder can no longer speak
// for itself.
//
// A server closes its listener in the first step of Shutdown and releases this
// lock in the last, so for the whole span between them it holds the lock and
// answers no health probe. That span is the normal appearance of a peer that is
// still tearing down — the same grace the kill path below takes for granted,
// owed to the far more common case where nobody had to be killed at all.
func (a *App) waitForDepartingInstance(existing *core.InstanceInfo) error {
	start := time.Now()
	deadline := start.Add(staleLockGrace)
	explained := false

	for {
		res, err := a.lock.TryAcquire(a.cfg.Server.Port, a.cfg.Server.Host)
		if err == nil && res.Acquired {
			if explained {
				fmt.Println("The previous instance has gone. Starting.")
			}
			return nil
		}
		if !time.Now().Before(deadline) {
			return &core.ProjectLockedError{Project: a.projectPath, Info: existing}
		}
		if !explained && time.Since(start) >= staleLockNoticeAfter {
			explained = true
			fmt.Println("Waiting for the previous instance to shut down…")
		}
		time.Sleep(staleLockPollInterval)
	}
}

// supersedeRunningInstance handles a live holder that means to stay: report it,
// then prompt to stop it and take the lock.
func (a *App) supersedeRunningInstance(existing *core.InstanceInfo) error {
	fmt.Println()
	fmt.Println("⚠️  Juggler is already running for this project!")
	fmt.Printf("   URL: http://%s:%d/\n", existing.Host, existing.Port)
	fmt.Println()

	shouldKill := promptKillInstance()
	if !shouldKill {
		fmt.Println("Exiting. Use the URL above to open the existing instance.")
		os.Exit(0)
	}

	fmt.Println("🔄 Requesting existing instance to shut down...")
	if err := core.KillExistingInstance(existing, a.projectPath); err != nil {
		return fmt.Errorf("failed to stop existing instance: %w", err)
	}
	fmt.Println("✅ Existing instance stopped")

	time.Sleep(postKillSettleDelay)

	// The instance acknowledged the shutdown, but acknowledging is not the same
	// as having finished: it still has its own teardown to walk before the lock
	// comes free. Wait for it on the same terms as any other departing holder.
	if err := a.waitForDepartingInstance(existing); err != nil {
		return fmt.Errorf("couldn't take the lock after stopping the existing instance: %w", err)
	}
	return nil
}

// postKillSettleDelay gives the previous instance's OS-level resources
// (port binding, flock) a moment to be reclaimed before we retry TryAcquire.
const postKillSettleDelay = 500 * time.Millisecond

// staleLockGrace bounds the wait for a lock whose holder no longer answers a
// health probe. A server closes its listener at the start of its shutdown and
// releases this lock at the end, so "holds the lock, answers nothing" is the
// normal appearance of a peer that is still tearing down — worth waiting out,
// but not forever. Variables rather than constants so tests can shorten them.
var (
	staleLockGrace        = 3 * time.Second
	staleLockPollInterval = 100 * time.Millisecond

	// staleLockNoticeAfter is how long the wait must run before it explains
	// itself. Under this a launch just looks fractionally slow, and a line
	// about locks would be noise on a start that was about to succeed.
	staleLockNoticeAfter = 500 * time.Millisecond
)

// promptKillInstance asks the user whether to kill the existing instance.
func promptKillInstance() bool {
	fmt.Print("Kill existing instance and start new one? [y/N]: ")
	resp, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil {
		return false
	}
	resp = strings.TrimSpace(strings.ToLower(resp))
	return resp == "y" || resp == "yes"
}
