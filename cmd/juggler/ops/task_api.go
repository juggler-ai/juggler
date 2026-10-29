//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import "time"

// Public read/stop accessors for background tasks, for consumers outside this
// package (the worker's generic task-output delivery, cmd/juggler/worker). They
// run in the same process as this registry but in another package, so they
// cannot reach the unexported helpers — these thin wrappers expose exactly the
// generic read/stop surface and nothing more. Every call is serialized through
// the registry goroutine, so they are safe from any goroutine.

// TaskOutputState is everything a background task's run produces: what it is
// doing, what it wrote, and how it ended. It is the one shape carried from the
// registry actor to every reader — the shell's own state copy, the read
// accessor's answer, and the durable snapshot persisted on a tool action all
// embed this rather than restating it, so a field added here reaches all three.
type TaskOutputState struct {
	Status          string `json:"status"` // "running" | "completed" | "failed"
	Output          string `json:"output"` // accumulated stdout+stderr (head+tail capped)
	ExitCode        int    `json:"exitCode"`
	Error           string `json:"error,omitempty"`
	OutputFile      string `json:"outputFile,omitempty"`
	OutputBytes     int64  `json:"outputBytes,omitempty"`
	OutputTruncated bool   `json:"truncated,omitempty"`
}

// TaskSnapshot is an immutable view of a background task's state.
type TaskSnapshot struct {
	TaskOutputState
	Found bool // false when no task with this id exists (or it was reaped)
}

// BackgroundTaskSnapshot is the durable, observable state of a background task.
// The live process handle remains in the shell registry; consumers persist this
// bounded snapshot so its output and terminal result survive registry reaping.
//
// The embedded state flattens into the same JSON object as the three ids, so the
// payload the worker decodes is one flat object.
type BackgroundTaskSnapshot struct {
	TaskID    string `json:"taskId"`
	ConvID    string `json:"-"`
	ToolUseID string `json:"toolUseId"`
	TaskOutputState
}

// BackgroundTaskObserver receives bounded snapshots outside the registry actor.
type BackgroundTaskObserver func(BackgroundTaskSnapshot)

// SetBackgroundTaskObserver installs the process-wide persistence sink. The
// server wires it to the owning conversation worker; tests may replace or clear it.
func SetBackgroundTaskObserver(observer BackgroundTaskObserver) {
	setBackgroundTaskObserver(observer)
}

// TaskState returns a snapshot of a background task by id. Found is false when
// no such task exists. A registered task always has a non-empty status, so an
// empty status uniquely means "not found".
func TaskState(taskID string) TaskSnapshot {
	s := getShellState(taskID)
	if s.Status == "" {
		return TaskSnapshot{}
	}
	return TaskSnapshot{TaskOutputState: s, Found: true}
}

// StopBackgroundTasks stops every running background task under projectRoot, or
// under every project when projectRoot is empty, and returns how many it
// signalled. reason is recorded as each task's error text, so say what happened
// in words the user will read on the tool action later.
//
// Background tasks run in their own process group precisely so that a cancelled
// turn cannot take them with it, which also means process exit does not signal
// them: without this they are reparented to init and keep running with no handle
// anywhere. Every task therefore has to be stopped deliberately when the handle
// stops being reachable: at shutdown, which stops them all.
//
// Blocks for at most grace between the polite signal and taking the process
// group, so a caller on the shutdown path pays a bounded, known cost.
func StopBackgroundTasks(projectRoot, reason string, grace time.Duration) int {
	return stopMatchingTasks(registryOp{projectRoot: projectRoot}, reason, grace)
}

// stopBackgroundTasksWithin stops every running background task rooted at dir or
// anywhere under it — the third moment a task's handle stops being useful, when
// the directory it runs in is about to be deleted. dir must be symlink-resolved.
func stopBackgroundTasksWithin(dir, reason string, grace time.Duration) int {
	return stopMatchingTasks(registryOp{projectRoot: dir, within: true}, reason, grace)
}

// stopMatchingTasks is both stops: the registry signals whatever the op matches,
// and the escalation happens here, off the registry goroutine.
func stopMatchingTasks(op registryOp, reason string, grace time.Duration) int {
	resp := make(chan registryResp, 1)
	op.kind, op.errMsg, op.resp = regKillMatching, reason, resp
	registryCh() <- op
	result := <-resp
	stopping := result.stopping
	if len(stopping) == 0 {
		return result.stopped
	}

	// One grace for the batch rather than one each: they were all signalled
	// together, so they are all equally far through it. Each escalation then
	// skips itself if its task was reaped during the grace — by then the pid it
	// would name belongs to whoever the OS gave it to next.
	if grace > 0 {
		time.Sleep(grace)
	}
	for _, task := range stopping {
		task.forceKillGroup()
	}
	return result.stopped
}

// KillTask terminates a running background task by id. Returns true if the task
// was running and is now stopped. Idempotent: a no-op (returns false) for an
// already-finished or unknown task.
func KillTask(taskID string) bool {
	if getBackgroundShell(taskID) == nil {
		return false
	}
	// killShell sets status to "failed" when it stops a running shell; for a
	// task that was not running it returns the unchanged status.
	return killShell(taskID).Status == "failed"
}
