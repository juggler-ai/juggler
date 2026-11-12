//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"path/filepath"

	"juggler/cmd/juggler/core"
	"juggler/internal/jlog"
)

// acquireInstance takes the project's lock (juggler.lock in its state folder),
// or refuses to start, first moving the project's state to where the "keep
// project state outside the project" setting says (core.PlaceProjectState).
// Only a session child and the test harness serve a project, and
// whoever spawns one has already arbitrated who owns it: the machine server
// keys its sessions by project and waits out a child it stopped before it
// spawns another. So a held lock is a live holder, and is reported — with the
// advice that explains it — never waited on, prompted about or killed.
func (a *App) acquireInstance() error {
	// The setting is read here, once, like every start-time setting; under
	// --test settings.json is not read and only projectpaths.StateDirEnv says.
	var gs core.GlobalSettings
	if !a.flags.testMode {
		if loaded, _ := core.LoadGlobalSettings(); loaded != nil {
			gs = *loaded
		}
	}
	lock, res, err := core.PlaceProjectState(a.projectPath, core.WantsProjectStateOutside(gs))
	a.lock = lock
	// The server normally takes ownership and releases this lock during Shutdown.
	// Register a startup-failure backstop now: any later phase can fail before the
	// server exists, and its cleanup must not leave the lock held by this process.
	a.pushCleanup(func() {
		if a.lock != nil {
			_ = a.lock.Release()
		}
	})
	if err != nil {
		jlog.Error("Failed to check instance lock: %v", err)
		return err
	}

	if res.FirstRun {
		jlog.Info("📁 Created %s for this project's state", filepath.Dir(lock.Path()))
		jlog.Info("   Juggler can read and modify files in this directory.")
		jlog.Info("   Review all AI-suggested changes before accepting.")
		jlog.Info("")
	}

	if !res.Acquired {
		return &core.ProjectLockedError{Project: a.projectPath, Info: res.Existing, Lock: lock.Path()}
	}

	// Lock ownership transfers to the server (via Config.BootLock), which
	// releases it at Shutdown. The cleanup registered above remains an
	// idempotent backstop for startup errors and abnormal paths which bypass
	// server construction.
	return nil
}
