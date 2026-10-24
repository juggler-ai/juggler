//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"fmt"
	"io"
	"sync"
	"syscall"
	"time"
)

// ShellStreamChunk represents a chunk of streaming output.
//
// A normal chunk carries Data (with Done=false) or is the terminal completion
// chunk (Done=true, optional ExitCode/Error). A *status* chunk is neither: it
// carries Status (e.g. "awaiting-permission" or "running") with empty Data and
// Done=false, so the UI can surface why a silent command is still running
// without it being mistaken for output or completion. Status is empty on every
// data/completion chunk.
//
// OutputFile/OutputBytes/Truncated carry the full-output spill accounting and
// appear only on the terminal Done chunk (empty/zero when nothing spilled).
type ShellStreamChunk struct {
	ShellID     string `json:"shellId"`
	Data        string `json:"data"`
	Done        bool   `json:"done"`
	ExitCode    int    `json:"exitCode,omitempty"`
	Error       string `json:"error,omitempty"`
	Status      string `json:"status,omitempty"`  // "awaiting-permission" | "running"; empty for data/done chunks
	Hint        string `json:"hint,omitempty"`    // human-readable explanation for the status
	Blocked     bool   `json:"blocked,omitempty"` // true when the command was refused and never ran
	OutputFile  string `json:"outputFile,omitempty"`
	OutputBytes int64  `json:"outputBytes,omitempty"`
	Truncated   bool   `json:"truncated,omitempty"`
}

// ExecuteStreaming runs a shell command with real-time output streaming.
// Output is sent via the output channel as chunks arrive.
// The function returns when the command completes or context is cancelled.
// On cancellation, sends SIGTERM to gracefully stop the process.
func (ops *ShellOperations) ExecuteStreaming(
	ctx context.Context,
	shellID string,
	convID string,
	command string,
	cwd string,
	timeoutMs int,
	output chan<- ShellStreamChunk,
) {
	defer close(output)

	// Blocked marks the one error the caller must not retry: the command was
	// refused outright, so there is no output and nothing about the environment
	// to fix. Without it a refusal is indistinguishable from a command that ran
	// and failed, and the model retries it until it runs out of patience.
	if err := bestEffortShellSanityCheck(command); err != nil {
		output <- ShellStreamChunk{
			ShellID: shellID,
			Done:    true,
			Error:   fmt.Sprintf("invalid command: %v", err),
			Blocked: true,
		}
		return
	}

	// Default and cap timeout
	if timeoutMs <= 0 {
		timeoutMs = defaultExecTimeoutMs
	}
	timeout := capTimeout(timeoutMs)

	// Working directory, validated to stay within the project root.
	workingDir, err := validateCwd(ops.scope.Root(), cwd)
	if err != nil {
		output <- ShellStreamChunk{
			ShellID: shellID,
			Done:    true,
			Error:   err.Error(),
		}
		return
	}

	// Create timeout context
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// Build command
	cmd := newShellCmd(ctx, command)
	setProcGroup(cmd)
	cmd.Dir = workingDir
	ops.applyProjectEnv(cmd)

	// Create pipe for merged stdout/stderr
	pipeReader, pipeWriter := io.Pipe()
	cmd.Stdout = pipeWriter
	cmd.Stderr = pipeWriter

	// Start command
	if err := startContained(cmd); err != nil {
		output <- ShellStreamChunk{
			ShellID: shellID,
			Done:    true,
			Error:   fmt.Sprintf("command start failed: %v", err),
		}
		return
	}

	// Channel to signal command completion, and the channel that closes the
	// moment the process is reaped and its pid stops naming it (see stoppingTask).
	cmdDone := make(chan error, 1)
	reaped := make(chan struct{})
	go func() {
		waitErr := cmd.Wait()
		releaseContainment(cmd)
		close(reaped)
		cmdDone <- waitErr
		pipeWriter.Close()
	}()

	// WaitGroup to track reader goroutine
	var readerWG sync.WaitGroup

	// firstByteCh is closed the moment the command emits its first output byte.
	// The watchdog (below) uses it to stand down — a chatty/normal command never
	// triggers any status chunk.
	firstByteCh := make(chan struct{})
	var firstByteOnce sync.Once
	signalFirstByte := func() { firstByteOnce.Do(func() { close(firstByteCh) }) }

	// Output-volume guard. We forward the first outputHeadLimit bytes live, then
	// stop forwarding and retain only the last outputTailLimit bytes in a ring.
	// The reader keeps draining the pipe at full speed regardless (discarding the
	// middle) so the child process never blocks on a full pipe, and clients are
	// never flooded with tens of thousands of chunks. The retained tail is
	// delivered once, appended to the completion chunk below.
	// Head/tail-capped, UTF-8-safe forwarder: forwards output chunks live up to
	// outputHeadLimit bytes, then retains only the last outputTailLimit bytes.
	// fwd.suffix() yields the dropped-middle marker + retained tail, appended to
	// the completion chunk below; signalFirstByte fires the moment output first
	// appears so the watchdog can stand down.
	fwd := newCappedForwarder(outputHeadLimit, outputTailLimit, func(s string) {
		output <- ShellStreamChunk{ShellID: shellID, Data: s}
	}).withSpill(ops.scope.Root(), newSpillFile(spillDirFor(ops.scope.ProjectRoot(), convID), shellID))

	// Stream output chunks
	readerWG.Go(func() {
		fwd.drain(pipeReader, signalFirstByte)
	})

	// Watchdog: while the command is silent and unfinished, surface *why*.
	// A short filesystem-access probe runs in its own goroutine; a pending
	// macOS TCC consent dialog makes it block. If the probe is still blocked
	// past its deadline (and no output has arrived) we emit the specific
	// "awaiting-permission" status. Otherwise, after a longer heartbeat
	// interval of continued silence, we emit a neutral "running" status that
	// asserts nothing about permissions. Both are non-Done, empty-Data chunks.
	probe := ops.probeFnOrDefault()
	probeDeadline := ops.probeDeadlineOrDefault()
	heartbeatInterval := ops.heartbeatIntervalOrDefault()

	watchdogStop := make(chan struct{})
	var watchdogWG sync.WaitGroup
	var stopOnce sync.Once
	// stopWatchdog signals the watchdog to exit and joins it. It MUST complete
	// before any final chunk is sent and before output is closed, so the
	// watchdog can never send on output after close. Idempotent.
	stopWatchdog := func() {
		stopOnce.Do(func() { close(watchdogStop) })
		watchdogWG.Wait()
	}
	// Registered after `defer close(output)` (top of func) so, by LIFO order,
	// this runs first — the watchdog is always joined before the channel closes.
	defer stopWatchdog()

	watchdogWG.Go(func() {
		// Run the probe off this goroutine so a blocking stat doesn't wedge the
		// watchdog itself; probeReturned closes when the probe decides.
		probeReturned := make(chan struct{})
		go func() {
			probe(workingDir)
			close(probeReturned)
		}()

		probeTimer := time.NewTimer(probeDeadline)
		defer probeTimer.Stop()
		heartbeatTimer := time.NewTimer(heartbeatInterval)
		defer heartbeatTimer.Stop()

		for {
			select {
			case <-watchdogStop:
				return
			case <-firstByteCh:
				return
			case <-ctx.Done():
				return
			case <-probeTimer.C:
				select {
				case <-probeReturned:
					// Probe decided in time — not a permission block. The
					// heartbeat still owns the generic-silence case below.
				default:
					// Probe still blocked past its deadline: a consent dialog is
					// almost certainly pending. This is the ONLY path that claims
					// permission.
					output <- ShellStreamChunk{
						ShellID: shellID,
						Status:  "awaiting-permission",
						Hint:    "Waiting for filesystem-access permission — check for a system dialog",
					}
					return
				}
			case <-heartbeatTimer.C:
				select {
				case <-probeReturned:
					// Generic silence with a decided probe — say nothing about
					// permissions.
					output <- ShellStreamChunk{
						ShellID: shellID,
						Status:  "running",
						Hint:    "Running… (no output yet)",
					}
				default:
					// Probe still pending: the awaiting-permission path owns
					// this. (Unreachable while probeDeadline < heartbeatInterval;
					// defensive against misconfiguration.)
				}
				return
			}
		}
	})

	// Wait for completion or cancellation
	select {
	case <-ctx.Done():
		stopWatchdog()
		// Context cancelled or timeout - send SIGTERM for graceful shutdown
		if cmd.Process != nil {
			_ = cmd.Process.Signal(syscall.SIGTERM)
			// Give process time to clean up, then force kill the group — unless it
			// has gone by then and its pid names a stranger.
			task := stoppingTask{cmd: cmd, reaped: reaped}
			time.AfterFunc(ops.killGraceOrDefault(), task.forceKillGroup)
		}
		// Bound the wait for the process to exit. Normally cmd.Wait() returns
		// promptly once SIGTERM/SIGKILL lands and cmdDone fires. But because
		// cmd.Stdout/Stderr are a non-*os.File pipe, os/exec's internal output
		// copier — and thus cmd.Wait() and cmdDone — stays blocked until every fd
		// holder exits. A grandchild that escaped the process group (setsid /
		// double-fork / detached daemon) survives killProcessGroup, keeps the
		// pipe's write end open, and would otherwise wedge this branch
		// indefinitely, long past the deadline. So cap the wait; on expiry, force
		// the pipe closed so the reader unblocks and we return. cmd.Wait() is left
		// to its own goroutine (cmdDone is buffered, so that send never leaks).
		select {
		case <-cmdDone:
		case <-time.After(ops.reapGraceOrDefault()):
		}
		pipeReader.Close() // unblock the reader even if the pipe's writer is still open
		readerWG.Wait()    // bounded: the reader returns once the pipe is closed
		fwd.closeSpill()   // flush the spill before suffix() names it in the marker

		errMsg := "command cancelled"
		if ctx.Err() == context.DeadlineExceeded {
			errMsg = fmt.Sprintf("command timeout (exceeded %v)", timeout)
		}
		output <- ShellStreamChunk{
			ShellID:     shellID,
			Data:        fwd.suffix(),
			Done:        true,
			Error:       errMsg,
			OutputFile:  fwd.spillPath(),
			OutputBytes: fwd.spillBytes(),
			Truncated:   fwd.spilled(),
		}
		return

	case err := <-cmdDone:
		stopWatchdog()
		readerWG.Wait() // Wait for reader to exit before closing pipeReader
		pipeReader.Close()
		fwd.closeSpill() // flush the spill before suffix() names it in the marker
		exitCode := 0
		if err != nil {
			if code, ok := exitCodeOf(err); ok {
				exitCode = code
			}
		}
		output <- ShellStreamChunk{
			ShellID:     shellID,
			Data:        fwd.suffix(),
			Done:        true,
			ExitCode:    exitCode,
			OutputFile:  fwd.spillPath(),
			OutputBytes: fwd.spillBytes(),
			Truncated:   fwd.spilled(),
		}
	}
}
