//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package core

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"juggler/internal/jlog"

	"github.com/gofrs/flock"
)

// InstanceInfo is what a project's lock holder records about itself in
// instance.json: its PID for the advice a refused launch prints
// (ProjectLockedError), and the address it bound (UpdateAddr), which is how a
// test finds the server a `juggler run` spawned for a project.
type InstanceInfo struct {
	PID       int       `json:"pid"`
	Port      int       `json:"port,omitempty"`
	Host      string    `json:"host,omitempty"`
	StartedAt time.Time `json:"startedAt"`
}

// InstanceLock manages the single-instance lock for a project
type InstanceLock struct {
	projectPath string
	lockPath    string
	infoPath    string
	flock       *flock.Flock
	info        InstanceInfo
}

// NewInstanceLock creates a new instance lock manager for the given project path
func NewInstanceLock(projectPath string) *InstanceLock {
	jugglerDir := filepath.Join(projectPath, ".juggler")
	return &InstanceLock{
		projectPath: projectPath,
		lockPath:    filepath.Join(jugglerDir, "juggler.lock"),
		infoPath:    filepath.Join(jugglerDir, "instance.json"),
	}
}

// AcquireResult is the outcome of InstanceLock.TryAcquire.
// Existing is only meaningful when Acquired is false.
// FirstRun is only meaningful when Acquired is true (it reports whether the
// .juggler directory had to be created).
type AcquireResult struct {
	Acquired bool
	Existing *InstanceInfo
	FirstRun bool
}

// TryAcquire attempts to acquire the lock.
func (l *InstanceLock) TryAcquire() (AcquireResult, error) {
	// Check if this is first-time setup (directory doesn't exist yet)
	jugglerDir := filepath.Dir(l.lockPath)
	isFirstRun := false
	if _, statErr := os.Stat(jugglerDir); os.IsNotExist(statErr) {
		isFirstRun = true
	}

	// Ensure .juggler directory exists
	if err := os.MkdirAll(jugglerDir, 0700); err != nil {
		return AcquireResult{}, fmt.Errorf("failed to create .juggler directory: %w", err)
	}

	// Create flock instance
	l.flock = flock.New(l.lockPath)

	// Try to acquire exclusive lock (non-blocking)
	locked, err := l.flock.TryLock()
	if err != nil {
		return AcquireResult{}, fmt.Errorf("failed to acquire lock: %w", err)
	}

	if !locked {
		// Lock is held by another process - read existing instance info
		existing, readErr := l.readInstanceInfo()
		if readErr != nil {
			// Can't read info, but lock is held
			return AcquireResult{}, nil
		}
		return AcquireResult{Existing: existing}, nil
	}

	// Lock acquired - write our instance info
	l.info = InstanceInfo{
		PID:       os.Getpid(),
		StartedAt: time.Now(),
	}

	if err := l.writeInstanceInfo(); err != nil {
		// Release lock if we can't write info; failure here is non-fatal but
		// leaves a stale lock that the next acquire would have to break.
		if unlockErr := l.flock.Unlock(); unlockErr != nil {
			jlog.Error("[lockfile] failed to release lock after writeInstanceInfo failure: %v", unlockErr)
		}
		return AcquireResult{}, fmt.Errorf("failed to write instance info: %w", err)
	}

	return AcquireResult{Acquired: true, FirstRun: isFirstRun}, nil
}

// UpdateAddr records in instance.json the address the server bound, which
// TryAcquire runs too early to know. No-op if the lock isn't held by us.
func (l *InstanceLock) UpdateAddr(host string, port int) error {
	if l == nil || l.flock == nil || !l.flock.Locked() {
		return nil
	}
	l.info.Host = host
	l.info.Port = port
	return l.writeInstanceInfo()
}

// Release releases the lock and cleans up instance info
func (l *InstanceLock) Release() error {
	if l.flock == nil {
		return nil
	}

	// Remove instance info file — non-fatal if it fails; the file is
	// rewritten on next Acquire and the lock release below is what actually
	// matters for other instances.
	if err := os.Remove(l.infoPath); err != nil && !os.IsNotExist(err) {
		jlog.Error("[lockfile] failed to remove instance info file: %v", err)
	}

	return l.flock.Unlock()
}

// writeInstanceInfo writes the current instance info to disk
func (l *InstanceLock) writeInstanceInfo() error {
	data, err := json.MarshalIndent(l.info, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(l.infoPath, data, 0600)
}

// readInstanceInfo reads instance info from disk
func (l *InstanceLock) readInstanceInfo() (*InstanceInfo, error) {
	data, err := os.ReadFile(l.infoPath)
	if err != nil {
		return nil, err
	}

	var info InstanceInfo
	if err := json.Unmarshal(data, &info); err != nil {
		return nil, err
	}

	return &info, nil
}

// ProjectLockedError reports a project whose lock another process holds — a
// session still shutting down, or a process that wedged mid-teardown and never
// let go.
//
// It carries its own recovery advice, which the process that failed to start
// prints after its startup failure (reportStartupFailure). Info is nil when the
// lock was held but instance.json could not be read, which is itself a moment
// inside someone else's Release.
type ProjectLockedError struct {
	Project string
	Info    *InstanceInfo
}

func (e *ProjectLockedError) Error() string {
	return fmt.Sprintf("project %s is still locked by another process", e.Project)
}

// LockPath is the file a person has to delete if the advice runs out.
func (e *ProjectLockedError) LockPath() string {
	return filepath.Join(e.Project, ".juggler", "juggler.lock")
}

// Advice explains the situation and the way out of it, in the order someone
// stuck needs them: what happened, which file, what usually fixes it, and only
// then the manual step that cannot be undone.
func (e *ProjectLockedError) Advice() string {
	msg := "This project is locked by another Juggler process.\n\n" +
		"The lock file is:\n" + e.LockPath() + "\n\n" +
		"This usually clears by itself within a few seconds, while the previous session finishes shutting down — try again first. " +
		"If it persists, and you are sure no other Juggler process is running for this project, delete that file and start again."
	if e.Info != nil {
		msg += fmt.Sprintf("\n\nThe lock records Juggler process %d.", e.Info.PID)
	}
	return msg
}

// CheckProjectLocked probes whether another juggler instance holds the lock for
// projectPath. It is read-only: it never creates directories or writes files,
// and it immediately releases the flock if it was able to acquire it.
//
// Returns (locked bool, info *InstanceInfo, err error).
// locked==false means the path is free (or the lock file doesn't exist yet).
func CheckProjectLocked(projectPath string) (bool, *InstanceInfo, error) {
	lockPath := filepath.Join(projectPath, ".juggler", "juggler.lock")
	infoPath := filepath.Join(projectPath, ".juggler", "instance.json")

	// If the lock file doesn't exist yet, the project is definitely free.
	if _, err := os.Stat(lockPath); os.IsNotExist(err) {
		return false, nil, nil
	}

	f := flock.New(lockPath)
	acquired, err := f.TryLock()
	if err != nil {
		// Can't tell — treat as unlocked to avoid false positives.
		return false, nil, nil
	}
	if acquired {
		_ = f.Unlock()
		return false, nil, nil
	}

	// Lock is held — read the instance info for a useful error message.
	data, err := os.ReadFile(infoPath)
	if err != nil {
		return true, nil, nil
	}
	var info InstanceInfo
	if err := json.Unmarshal(data, &info); err != nil {
		return true, nil, nil
	}
	return true, &info, nil
}
