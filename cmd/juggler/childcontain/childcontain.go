//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package childcontain provides cross-platform best-effort OS-level containment
// for child processes. It has two jobs:
//
//   - parent-death containment where the OS supports it, so children do not
//     survive a crashed/killed parent;
//   - process-tree termination, so explicit shutdown/cancel kills the whole
//     child subtree rather than only the direct child process.
//
// Usage:
//
//	childcontain.Prepare(cmd)          // before cmd.Start()
//	if err := cmd.Start(); err != nil { ... }
//	child, err := childcontain.Adopt(cmd) // after cmd.Start()
//	if err != nil { ... }
//	defer child.Cleanup() // after Wait/child exit, releases OS resources
//	...
//	_ = child.Terminate() // on cancellation/escalation, kills contained tree
//
// Platform behaviour:
//
//	Linux:   Pdeathsig SIGTERM handles parent death; Setpgid creates a child
//	         process group; Terminate signals the whole process group.
//
//	macOS:   Setpgid creates a child process group; Terminate signals the whole
//	         process group. There is no kernel parent-death primitive, so Adopt
//	         registers the child with a small reaper process that holds a pipe
//	         from this one and kills whatever is still contained when that pipe
//	         reaches EOF — which is what every hard kill, crash, force-quit and
//	         same-PID re-exec of the parent produces. See reaper_other.go.
//
//	Windows: Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE contains the
//	         child process tree. Terminate closes the job handle, killing all job
//	         members. Cleanup closes the handle after natural child exit.
//
//	Other:   best-effort direct process kill only.
package childcontain

import (
	"os/exec"
	"sync"
)

// Child is a contained child process. It wraps the original exec.Cmd with the
// platform resources needed to kill/release its process tree. A Child is safe
// for concurrent use and must not be copied once created.
type Child struct {
	cmd      *exec.Cmd
	released sync.Once
	cleanup  func()
}

// Prepare sets pre-fork OS-level attributes on cmd to enable containment where
// the kernel supports it. Must be called before cmd.Start().
func Prepare(cmd *exec.Cmd) {
	prepare(cmd)
}

// Adopt completes OS-level containment after the child has been started. Must
// be called after a successful cmd.Start().
//
// Errors from Adopt are non-fatal for many call sites: explicit Terminate still
// falls back as far as the platform allows, and exec.CommandContext still covers
// direct-child cancellation. Callers should log and proceed if the process has
// already started.
func Adopt(cmd *exec.Cmd) (*Child, error) {
	cleanup, err := adopt(cmd)
	if cleanup == nil {
		cleanup = func() {}
	}
	return &Child{cmd: cmd, cleanup: cleanup}, err
}

// Cleanup releases OS containment resources after the child has exited. On
// Windows, calling Cleanup while the child is still running kills the job.
//
// It releases exactly once however many goroutines call it: Terminate routes
// through Cleanup on Windows and macOS, so a cancel watcher and an explicit
// kill of the same child arrive together. Concurrent callers block until the
// release they are sharing has finished.
func (c *Child) Cleanup() {
	if c == nil {
		return
	}
	c.released.Do(func() {
		if c.cleanup != nil {
			c.cleanup()
		}
	})
}

// Terminate kills the contained child process tree best-effort.
func (c *Child) Terminate() error {
	if c == nil || c.cmd == nil {
		return nil
	}
	return terminate(c.cmd, c)
}
