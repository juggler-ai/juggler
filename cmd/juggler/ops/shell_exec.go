//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"fmt"
	"io"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

// Timeout bounds shared by the shell/python execution paths, in milliseconds.
const (
	defaultExecTimeoutMs = 30000   // default per-command timeout; mirrors DEFAULT_EXEC_TIMEOUT_MS in web/js/services/ops-api.js
	maxExecTimeoutMs     = 1200000 // hard cap on any requested timeout
)

// noDeadlineTimeoutMs is the "timeout" a caller passes to ask for a background
// task with no deadline at all. Zero cannot mean this: it is a legitimate
// duration that context.WithTimeout treats as already expired, so a caller who
// meant "forever" and typed 0 would get a task that died immediately. Negative
// is not a duration anybody means literally, which is what makes it safe to
// spend as a sentinel.
const noDeadlineTimeoutMs = -1

// shellParams are the params execute and startBackground read. Code and
// Command are pointers because an empty one is still the caller's choice: an
// empty code runs as Python, and only a missing command is the error.
type shellParams struct {
	Timeout   *float64 `param:"timeout"`
	Code      *string  `param:"code"`
	Command   *string  `param:"command"`
	Cwd       string   `param:"cwd"`
	ConvID    string   `param:"convId"`
	ToolUseID string   `param:"toolUseId"`
}

// timeoutFrom is the optional "timeout" (milliseconds), defaultMs when absent,
// capped at maxExecTimeoutMs.
func timeoutFrom(timeout *float64, defaultMs int) time.Duration {
	timeoutMs := defaultMs
	if timeout != nil {
		timeoutMs = int(*timeout)
	}
	return capTimeout(timeoutMs)
}

// wantsNoDeadline reports whether the timeout asked for a task that runs until
// it is stopped. Only startBackground can honour it; the foreground paths
// refuse it with errNoDeadlineForeground.
func wantsNoDeadline(timeout *float64) bool {
	return timeout != nil && int(*timeout) == noDeadlineTimeoutMs
}

// errNoDeadlineForeground is what a foreground command asking for no deadline
// gets. A command whose caller waits for its output must have something that
// ends it, and the sentinel read as an ordinary duration is a negative one,
// which context.WithTimeout treats as already expired — so the alternative to
// saying this is a command that returns instantly for reasons nobody can see.
var errNoDeadlineForeground = fmt.Errorf(
	"timeout %d asks for no deadline, which only a background task can have", noDeadlineTimeoutMs)

// capTimeout caps a millisecond timeout at maxExecTimeoutMs and converts it to
// a Duration.
func capTimeout(timeoutMs int) time.Duration {
	if timeoutMs > maxExecTimeoutMs {
		timeoutMs = maxExecTimeoutMs
	}
	return time.Duration(timeoutMs) * time.Millisecond
}

// spillDirFor returns the per-conversation directory that holds a command's
// full-output spill file. convID=="" falls back to the _unassigned bucket, which
// the store sweeps by age. The directory lives under the project's .juggler/ so
// the model can read the spill back without an approval prompt, and it stays out
// of git status.
//
// The PROJECT's .juggler/, note, even when the command ran somewhere else: a
// command in a workspace spills here too. A worktree that grew an untracked
// .juggler/ would be reported dirty by anything reading `git status`, and
// removing the tree would take the spill of every conversation bound to it. It
// also keeps one sweep covering every spill there is.
func spillDirFor(root, convID string) string {
	if convID == "" {
		convID = "_unassigned"
	}
	return filepath.Join(root, ".juggler", "bash-output", convID)
}

// exitCodeOf reports the process exit code for a command error. The bool is
// true only when err is an *exec.ExitError (a real process exit); callers use
// it to distinguish a non-zero exit from a non-exit failure (spawn error,
// context cancellation) that they handle differently.
func exitCodeOf(err error) (int, bool) {
	if exitErr, ok := err.(*exec.ExitError); ok {
		return exitErr.ExitCode(), true
	}
	return 0, false
}

// startBackground starts a command in the background and returns immediately
func (ops *ShellOperations) startBackground(params map[string]any) (any, error) {
	p, err := decodeParams[shellParams](params)
	if err != nil {
		return nil, err
	}
	if p.Command == nil || *p.Command == "" {
		return nil, fmt.Errorf("missing command parameter")
	}
	command := *p.Command

	// Normalize newlines to && — LLMs sometimes use \n to separate commands
	command = normalizeCommandNewlines(command)

	if err := bestEffortShellSanityCheck(command); err != nil {
		return nil, fmt.Errorf("invalid command: %w", err)
	}

	// Get timeout from params (default: the 20-minute cap for background tasks).
	// Read even for a task that will not have one, because it is what names the
	// deadline in the failure message — which only a task that has one can reach.
	noDeadline := wantsNoDeadline(p.Timeout)
	timeout := timeoutFrom(p.Timeout, maxExecTimeoutMs)

	// Extract conversation/tool-use tracking params (optional)
	convID, toolUseID := p.ConvID, p.ToolUseID

	// Generate unique shell ID
	shellID := fmt.Sprintf("bg-%d", time.Now().UnixNano())

	// Create context with timeout and cancellation. A task asked for with no
	// deadline gets cancellation alone: something meant to run until it is
	// stopped — a dev server, a patch host an extension is embedding — has no
	// business dying twenty minutes in, and the caller that started it is the
	// thing that knows when it is done. `cancel` is the only way either kind
	// ends, and `kill` is what calls it, so the two are the same task downstream.
	var ctx context.Context
	var cancel context.CancelFunc
	if noDeadline {
		ctx, cancel = context.WithCancel(context.Background())
	} else {
		ctx, cancel = context.WithTimeout(context.Background(), timeout)
	}

	// Create background shell entry (mutable state initialized here,
	// owned by registry goroutine once registered)
	reaped := make(chan struct{})
	shell := &BackgroundShell{
		ID:          shellID,
		ConvID:      convID,
		ToolUseID:   toolUseID,
		Command:     command,
		StartTime:   time.Now(),
		ProjectRoot: ops.scope.Root(),
		cancel:      cancel,
		reaped:      reaped,
		status:      "running",
	}

	// Register the shell (registry goroutine now owns mutable state)
	registerBackgroundShell(shell)
	go publishBackgroundTaskSnapshots(shellID)

	// Start command execution in goroutine
	go func() {
		defer cancel()

		// Build command
		cmd := newShellCmd(ctx, command)
		setProcGroup(cmd)
		cmd.Dir = ops.scope.Root()
		ops.applyProjectEnv(cmd)

		// Merge stdout/stderr through a pipe and publish output to the registry
		// incrementally as it arrives, so readers (ops.TaskState) see a running
		// command's output before it exits. The reader keeps draining at full
		// speed so the child never blocks on a full pipe.
		//
		// Memory safety with no delivery pump watching (plain run_in_background):
		// we append live only up to outputHeadLimit bytes, then stop appending
		// and retain the last outputTailLimit bytes in a ring. The dropped middle
		// is flushed once at completion as a truncation marker + tail, so the
		// final registry output matches the capped result the old cappedBuffer
		// produced.
		pipeReader, pipeWriter := io.Pipe()
		cmd.Stdout = pipeWriter
		cmd.Stderr = pipeWriter

		if startErr := startContained(cmd); startErr != nil {
			pipeWriter.Close()
			pipeReader.Close()
			updateShellStatus(shellID, "failed", "", -1, fmt.Sprintf("command start failed: %v", startErr), "", 0, false)
			time.AfterFunc(1*time.Hour, func() { removeBackgroundShell(shellID) })
			return
		}

		// Hand the command to the registry only now that it is started. Start
		// writes cmd.Process, and the registry reads it (signalShellStop) from its
		// own goroutine — publishing beforehand puts the handle in reach of a
		// reader with nothing ordering it after that write. A kill arriving in the
		// gap still stops the task: it cancels the context, and a command built
		// with CommandContext dies at Start rather than escaping.
		updateShellCmd(shellID, cmd)

		cmdDone := make(chan error, 1)
		go func() {
			waitErr := cmd.Wait()
			releaseContainment(cmd)
			close(reaped) // from here the pid may name something else
			cmdDone <- waitErr
			pipeWriter.Close()
		}()

		// Head/tail-capped, UTF-8-safe forwarder: publishes output to the
		// registry live up to outputHeadLimit bytes, then retains only the last
		// outputTailLimit bytes; the dropped middle is flushed once at stream end
		// (see suffix() below) so the final registry output matches the capped
		// head+tail the non-streaming cappedBuffer produces.
		fwd := newCappedForwarder(outputHeadLimit, outputTailLimit, func(s string) {
			appendShellOutput(shellID, s)
		}).withSpill(ops.scope.Root(), newSpillFile(spillDirFor(ops.scope.ProjectRoot(), convID), shellID))

		readerDone := make(chan struct{})
		go func() {
			defer close(readerDone)
			fwd.drain(pipeReader, nil)
		}()

		// Wait for the process to exit, then for the reader to drain fully before
		// reading the cap accounting (happens-before its final writes).
		var err error
		select {
		case err = <-cmdDone:
		case <-ctx.Done():
			// The deadline has to end the task, not just the process fronting it.
			// exec.CommandContext kills the leader alone, so anything that leader
			// started — a shell that forked rather than exec'd, something
			// backgrounded — lives on in the process group setProcGroup gave it,
			// holding the output pipe's write end open. cmd.Wait() waits on every
			// holder of that pipe, so the task would sit at "running" long past the
			// deadline, waiting on the processes the deadline was meant to take.
			//
			// Only a deadline kills here. A stop asked for by hand has had its
			// polite SIGTERM from the kill op, which takes the group itself if the
			// task ignores it; this branch just bounds the wait for that to land.
			if ctx.Err() == context.DeadlineExceeded {
				stoppingTask{cmd: cmd, reaped: reaped}.forceKillGroup()
			}
			select {
			case err = <-cmdDone:
			case <-time.After(ops.reapGraceOrDefault()):
				// A grandchild that escaped the process group (setsid, double fork)
				// survives the kill and holds the pipe open. Force it closed so the
				// reader returns and the task reaches a terminal status; cmd.Wait()
				// keeps its own goroutine and cmdDone is buffered, so nothing leaks.
				pipeReader.Close()
			}
		}
		<-readerDone
		pipeReader.Close()

		// Close the spill before suffix() composes the marker, so the announced
		// path always points at a complete, flushed file.
		fwd.closeSpill()

		// Flush the retained tail (and the dropped-middle marker) so the final
		// registry output is the capped head+tail.
		if suffix := fwd.suffix(); suffix != "" {
			appendShellOutput(shellID, suffix)
		}

		// Determine final status
		var status, errMsg string
		var exitCode int

		if ctx.Err() == context.DeadlineExceeded {
			status = "failed"
			errMsg = fmt.Sprintf("command timeout (exceeded %v)", timeout)
			exitCode = -1
		} else if ctx.Err() == context.Canceled {
			status = "failed"
			errMsg = "command cancelled"
			exitCode = -1
		} else if err != nil {
			status = "failed"
			if code, ok := exitCodeOf(err); ok {
				exitCode = code
				errMsg = fmt.Sprintf("exit code %d", exitCode)
			} else {
				errMsg = err.Error()
				exitCode = -1
			}
		} else {
			status = "completed"
			exitCode = 0
		}

		// Output was already published incrementally above; pass empty output so
		// the final update sets only status/exitCode/errMsg (no double-write). The
		// spill accounting is recorded here, on the registry goroutine, so a
		// concurrent getOutput never races the write.
		updateShellStatus(shellID, status, "", exitCode, errMsg,
			fwd.spillPath(), fwd.spillBytes(), fwd.spilled())

		// Schedule cleanup after 1 hour without parking a goroutine for the
		// whole window. time.AfterFunc dispatches via the runtime's timer
		// wheel — at idle there's no per-shell goroutine sitting on a Sleep.
		time.AfterFunc(1*time.Hour, func() {
			removeBackgroundShell(shellID)
		})
	}()

	return map[string]any{
		"task_id": shellID,
		"command": command,
		"status":  "running",
	}, nil
}

// execute runs a shell command or Python code
//
// Two execution modes:
//
//  1. Shell command: params["command"] = "ls -la"
//     Runs via: sh -c "command"
//
//  2. Python code: params["code"] = "print('hello')"
//     Runs via: python3 - (code passed to stdin)
//     This avoids shell escaping issues entirely.
//
// WARNING: Both modes execute arbitrary code and are security risks.
func (ops *ShellOperations) execute(ctx context.Context, params map[string]any) (any, error) {
	p, err := decodeParams[shellParams](params)
	if err != nil {
		return nil, err
	}
	if wantsNoDeadline(p.Timeout) {
		return nil, errNoDeadlineForeground
	}

	// Check if this is Python code execution (code param) or shell command
	if p.Code != nil {
		// Python code execution - pass via stdin to python3
		return ops.executePythonCode(ctx, *p.Code, p)
	}

	if p.Command == nil {
		return nil, fmt.Errorf("missing 'command' or 'code' parameter")
	}
	command := *p.Command

	// Normalize newlines to && — LLMs sometimes use \n to separate commands
	// in JSON, which works with sh -c but displays poorly and loses fail-fast semantics.
	command = normalizeCommandNewlines(command)

	if err := bestEffortShellSanityCheck(command); err != nil {
		return nil, fmt.Errorf("invalid command: %w", err)
	}

	// Get timeout from params (defaults to defaultExecTimeoutMs, capped at maxExecTimeoutMs)
	timeout := timeoutFrom(p.Timeout, defaultExecTimeoutMs)

	// Get working directory from params (default: session's project path)
	workingDir := ops.scope.Root()
	if cwd := p.Cwd; cwd != "" {
		resolved, err := validateCwd(ops.scope.Root(), cwd)
		if err != nil {
			return nil, err
		}
		workingDir = resolved
	}

	// Bound the command by both the caller's context and the timeout. Deriving
	// from ctx (not context.Background) means a cancelled request actually kills
	// the foreground command instead of leaving it running detached.
	execCtx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// Execute command in a POSIX shell (sh on Unix, WSL sh on Windows).
	cmd := newShellCmd(execCtx, command)
	// Set process group so we can kill all child processes on timeout (Unix only)
	setProcGroup(cmd)
	cmd.Dir = workingDir
	ops.applyProjectEnv(cmd)

	convID := p.ConvID
	spillID := fmt.Sprintf("exec-%d", time.Now().UnixNano())
	output := newCappedBuffer(outputHeadLimit, outputTailLimit).
		withSpill(ops.scope.Root(), newSpillFile(spillDirFor(ops.scope.ProjectRoot(), convID), spillID))
	cmd.Stdout = output
	cmd.Stderr = output // Merge stderr into stdout - interleaved naturally

	// Start the command
	if err := startContained(cmd); err != nil {
		return nil, fmt.Errorf("command start failed: %w", err)
	}

	// Wait for command with timeout / caller cancellation.
	//
	// The buffer belongs to this goroutine alone, and is closed here rather than
	// in either branch below: output has no lock, os/exec's copier writes to it
	// until the last holder of the pipe has gone, and the cancel branch is
	// allowed to stop waiting for that. Closing it from there would be a write
	// racing a write.
	done := make(chan error, 1)
	go func() {
		err := cmd.Wait()
		releaseContainment(cmd)
		output.closeSpill()
		done <- err
	}()

	select {
	case <-execCtx.Done():
		// Timeout or caller cancellation - kill the process group (all children).
		killGroup(cmd)
		// Bound the wait for the command to go, as the background and streaming
		// paths do. cmd.Stdout/Stderr are a non-*os.File, so os/exec's output
		// copier — and with it cmd.Wait() and done — stays blocked until every
		// holder of the internal pipe's write end exits. Anything that survived
		// the kill therefore holds this branch open indefinitely, long past the
		// deadline, wedging the handler goroutine that a user pressing Escape is
		// waiting on. So cap it and answer; cmd.Wait() keeps its own goroutine
		// and done is buffered, so nothing leaks.
		select {
		case <-done:
		case <-time.After(ops.reapGraceOrDefault()):
		}
		if execCtx.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("command execution timeout (exceeded %v)", timeout)
		}
		return nil, execCtx.Err()
	case err := <-done:
		exitCode := 0
		if err != nil {
			code, ok := exitCodeOf(err)
			if !ok {
				return nil, fmt.Errorf("command execution failed: %w", err)
			}
			exitCode = code
		}
		result := map[string]any{
			"command":  command,
			"stdout":   output.String(), // Combined stdout+stderr
			"stderr":   "",              // Empty - merged into stdout
			"exitCode": exitCode,
			"success":  exitCode == 0,
		}
		if output.spilled() {
			result["outputFile"] = output.spillPath()
			result["outputBytes"] = output.spillBytes()
			result["truncated"] = true
		}
		return result, nil
	}
}

// executePythonCode executes Python code via stdin.
//
// Why stdin instead of the -c flag: the code is passed as pure string data,
// never parsed by a shell, so it sidesteps all shell escaping issues (quotes,
// backslashes, newlines) and shell argument-length limits.
func (ops *ShellOperations) executePythonCode(ctx context.Context, code string, p shellParams) (any, error) {
	// Get timeout from params (defaults to defaultExecTimeoutMs, capped at maxExecTimeoutMs)
	timeout := timeoutFrom(p.Timeout, defaultExecTimeoutMs)

	// Create context with timeout, derived from the caller's context so a
	// cancelled request stops the python process too.
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// Execute python with code passed via stdin
	// Using "-" tells python to read from stdin. On Unix this is python3; on
	// Windows it is routed through WSL (see newPythonCmd).
	cmd := newPythonCmd(ctx)
	cmd.Dir = ops.scope.Root()
	ops.applyProjectEnv(cmd)
	cmd.Stdin = strings.NewReader(code)

	convID := p.ConvID
	spillID := fmt.Sprintf("pyexec-%d", time.Now().UnixNano())
	output := newCappedBuffer(outputHeadLimit, outputTailLimit).
		withSpill(ops.scope.Root(), newSpillFile(spillDirFor(ops.scope.ProjectRoot(), convID), spillID))
	cmd.Stdout = output
	cmd.Stderr = output // Merge stderr into stdout - interleaved naturally

	err := cmd.Run()
	output.closeSpill()
	exitCode := 0

	if err != nil {
		if ctx.Err() == context.DeadlineExceeded {
			return nil, fmt.Errorf("python execution timeout (exceeded %v)", timeout)
		}
		code, ok := exitCodeOf(err)
		if !ok {
			return nil, fmt.Errorf("python execution failed: %w", err)
		}
		exitCode = code
	}

	result := map[string]any{
		"stdout":   output.String(), // Combined stdout+stderr
		"stderr":   "",              // Empty - merged into stdout
		"exitCode": exitCode,
		"success":  exitCode == 0,
	}
	if output.spilled() {
		result["outputFile"] = output.spillPath()
		result["outputBytes"] = output.spillBytes()
		result["truncated"] = true
	}
	return result, nil
}

// validateCwd resolves a user-supplied shell cwd and rejects anything outside
// workingDir. Empty cwd means "use workingDir". The prefix check appends a
// separator so siblings like "<workingDir>-evil" cannot pass.
//
// workingDir is the scope's ROOT, which is the project for an ordinary request
// and the workspace for one bound to a workspace. It is deliberately not
// widened by the allowed roots the scope carries for reads: a conversation
// working in a worktree may read the tree it branched from, but running a
// command in it is how you edit the wrong branch by accident.
func validateCwd(workingDir, cwd string) (string, error) {
	if cwd == "" {
		return workingDir, nil
	}
	absPath, err := filepath.Abs(cwd)
	if err != nil {
		return "", fmt.Errorf("invalid cwd path: %w", err)
	}
	rootDir, err := filepath.Abs(workingDir)
	if err != nil {
		return "", fmt.Errorf("invalid working directory: %w", err)
	}
	rootWithSep := rootDir + string(filepath.Separator)
	if absPath != rootDir && !strings.HasPrefix(absPath+string(filepath.Separator), rootWithSep) {
		return "", fmt.Errorf("cwd must be within the working directory: %s", rootDir)
	}
	return absPath, nil
}
