//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"time"
)

// Timeout bounds shared by the shell/python execution paths, in milliseconds.
const (
	defaultExecTimeoutMs = 30000   // default per-command timeout; mirrors DEFAULT_EXEC_TIMEOUT_MS in web/js/services/ops-api.js
	maxExecTimeoutMs     = 1200000 // hard cap on any requested timeout
)

// timeoutFromParams reads an optional "timeout" (milliseconds) from params,
// falling back to defaultMs when absent, and caps the result at maxExecTimeoutMs.
func timeoutFromParams(params map[string]any, defaultMs int) time.Duration {
	timeoutMs := defaultMs
	if t, ok := params["timeout"].(float64); ok {
		timeoutMs = int(t)
	}
	return capTimeout(timeoutMs)
}

// capTimeout caps a millisecond timeout at maxExecTimeoutMs and converts it to
// a Duration.
func capTimeout(timeoutMs int) time.Duration {
	if timeoutMs > maxExecTimeoutMs {
		timeoutMs = maxExecTimeoutMs
	}
	return time.Duration(timeoutMs) * time.Millisecond
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

// shellStateSnapshot is a snapshot of a shell's mutable state
type shellStateSnapshot struct {
	Status   string
	Output   string
	ExitCode int
	Error    string
}

// BackgroundShell represents a background shell process.
// Mutable state (status, output, exitCode, errMsg, cmd) is owned by the
// registry goroutine — never accessed directly from other goroutines.
type BackgroundShell struct {
	// Immutable fields (safe to read from any goroutine)
	ID        string
	ConvID    string // Conversation that owns this shell
	ToolUseID string // Tool use ID for frontend correlation
	Command   string
	StartTime time.Time
	cancel    context.CancelFunc

	// Mutable fields (owned by registry goroutine only)
	status   string
	output   strings.Builder
	exitCode int
	errMsg   string
	cmd      *exec.Cmd

	// readOffset is how many bytes of output the TaskOutput tool has already
	// been handed. Advanced by the "getDelta" op so a polling reader receives
	// each byte exactly once (BashOutput semantics). The Monitor delivery pump
	// reads full snapshots via getState and keeps its own diff cursor, so it is
	// unaffected by this field.
	readOffset int
}

// snapshot returns a copy of the mutable state. Only call from the registry goroutine.
func (shell *BackgroundShell) snapshot() shellStateSnapshot {
	return shellStateSnapshot{
		Status:   shell.status,
		Output:   shell.output.String(),
		ExitCode: shell.exitCode,
		Error:    shell.errMsg,
	}
}

// registryOp is a request sent to the global registry goroutine
type registryOp struct {
	kind   string // "register", "get", "remove", "list", "cleanup", "getState", "getDelta", "updateCmd", "appendOutput", "updateStatus", "kill"
	id     string
	shell  *BackgroundShell
	convID string
	// updateCmd/updateStatus fields
	cmd      *exec.Cmd
	status   string
	output   string
	exitCode int
	errMsg   string
	// response
	resp chan registryResp
}

// registryResp is the response from the global registry goroutine
type registryResp struct {
	shell    *BackgroundShell
	shells   []map[string]any
	snapshot shellStateSnapshot
}

var registryCh = make(chan registryOp, 16)

// runShellRegistry owns the background-shell map and processes all ops
// serialized through registryCh. Started by RegisterAll().
func runShellRegistry() {
	shells := make(map[string]*BackgroundShell)
	for op := range registryCh {
		switch op.kind {
		case "register":
			shells[op.shell.ID] = op.shell

		case "get":
			op.resp <- registryResp{shell: shells[op.id]}

		case "remove":
			delete(shells, op.id)

		case "list":
			var result []map[string]any
			for _, shell := range shells {
				if op.convID != "" && shell.ConvID != op.convID {
					continue
				}
				result = append(result, map[string]any{
					"task_id":     shell.ID,
					"tool_use_id": shell.ToolUseID,
					"command":     shell.Command,
					"status":      shell.status,
					"output":      shell.output.String(),
					"exit_code":   shell.exitCode,
					"error":       shell.errMsg,
				})
			}
			op.resp <- registryResp{shells: result}

		case "cleanup":
			for shellID, shell := range shells {
				if shell.cancel != nil {
					shell.cancel()
				}
				delete(shells, shellID)
			}

		case "getState":
			shell := shells[op.id]
			if shell == nil {
				op.resp <- registryResp{}
			} else {
				op.resp <- registryResp{snapshot: shell.snapshot()}
			}

		case "getDelta":
			// Read-and-advance: return only the output produced since the last
			// getDelta and move the cursor to the current end. This is what the
			// TaskOutput tool uses so a polling reader receives each byte exactly
			// once (BashOutput semantics). getState is untouched, so the Monitor
			// delivery pump — which keeps its own diff cursor — is unaffected.
			shell := shells[op.id]
			if shell == nil {
				op.resp <- registryResp{}
			} else {
				full := shell.output.String()
				snap := shell.snapshot()
				if shell.readOffset <= len(full) {
					snap.Output = full[shell.readOffset:]
				} else {
					snap.Output = ""
				}
				shell.readOffset = len(full)
				op.resp <- registryResp{snapshot: snap}
			}

		case "updateCmd":
			if shell := shells[op.id]; shell != nil {
				shell.cmd = op.cmd
			}

		case "appendOutput":
			if shell := shells[op.id]; shell != nil {
				shell.output.WriteString(op.output)
			}

		case "updateStatus":
			if shell := shells[op.id]; shell != nil {
				shell.status = op.status
				shell.output.WriteString(op.output)
				shell.exitCode = op.exitCode
				shell.errMsg = op.errMsg
			}

		case "kill":
			shell := shells[op.id]
			if shell == nil || shell.status != "running" {
				status := ""
				if shell != nil {
					status = shell.status
				}
				op.resp <- registryResp{snapshot: shellStateSnapshot{Status: status}}
				continue
			}

			// Cancel the context
			if shell.cancel != nil {
				shell.cancel()
			}

			// Signal the process to stop, then schedule a force-kill of the
			// process group if it doesn't exit promptly. We must NOT call
			// cmd.Wait() here: the startBackground goroutine is the sole owner of
			// Wait (and reaps the process there). Reaping it here too would be a
			// concurrent Wait on the same *exec.Cmd — a data race. The AfterFunc
			// escalation is non-blocking, so the registry goroutine stays
			// responsive to other ops. (Mirrors executeStreaming's cancel path.)
			if shell.cmd != nil && shell.cmd.Process != nil {
				cmd := shell.cmd
				_ = cmd.Process.Signal(syscall.SIGTERM)
				time.AfterFunc(2*time.Second, func() {
					killProcessGroup(cmd)
				})
			}

			shell.status = "failed"
			shell.errMsg = "Killed by user"
			shell.exitCode = -1

			op.resp <- registryResp{snapshot: shell.snapshot()}
		}
	}
}

// getBackgroundShell retrieves a background shell by ID
func getBackgroundShell(id string) *BackgroundShell {
	resp := make(chan registryResp, 1)
	registryCh <- registryOp{kind: "get", id: id, resp: resp}
	return (<-resp).shell
}

// registerBackgroundShell adds a shell to the registry
func registerBackgroundShell(shell *BackgroundShell) {
	registryCh <- registryOp{kind: "register", shell: shell}
}

// removeBackgroundShell removes a shell from the registry
func removeBackgroundShell(id string) {
	registryCh <- registryOp{kind: "remove", id: id}
}

// getShellState gets a state snapshot via the registry goroutine
func getShellState(id string) shellStateSnapshot {
	resp := make(chan registryResp, 1)
	registryCh <- registryOp{kind: "getState", id: id, resp: resp}
	return (<-resp).snapshot
}

// getShellDelta returns the shell's output produced since the previous
// getShellDelta call (advancing the read cursor) alongside its current status.
// Snapshot.Output carries the delta, not the full accumulated output.
func getShellDelta(id string) shellStateSnapshot {
	resp := make(chan registryResp, 1)
	registryCh <- registryOp{kind: "getDelta", id: id, resp: resp}
	return (<-resp).snapshot
}

// updateShellCmd updates the cmd field via the registry goroutine
func updateShellCmd(id string, cmd *exec.Cmd) {
	registryCh <- registryOp{kind: "updateCmd", id: id, cmd: cmd}
}

// appendShellOutput appends an output delta via the registry goroutine without
// touching status. Used by startBackground to publish a running command's output
// incrementally, so readers (ops.TaskState) see it before the process exits.
func appendShellOutput(id, delta string) {
	registryCh <- registryOp{kind: "appendOutput", id: id, output: delta}
}

// updateShellStatus updates status fields via the registry goroutine. Pass an
// empty output to set only status/exitCode/errMsg without appending — used when
// output has already been published incrementally (see startBackground).
func updateShellStatus(id string, status, output string, exitCode int, errMsg string) {
	registryCh <- registryOp{kind: "updateStatus", id: id, status: status, output: output, exitCode: exitCode, errMsg: errMsg}
}

// killShell sends a kill request via the registry goroutine and waits for completion
func killShell(id string) shellStateSnapshot {
	resp := make(chan registryResp, 1)
	registryCh <- registryOp{kind: "kill", id: id, resp: resp}
	return (<-resp).snapshot
}

// ShellOperations handles shell command execution.
//
// Trust model: every command reaching this layer must already have been
// approved by the user via the UI approval flow. There is no server-side
// whitelist. The bestEffortShellSanityCheck below is a foot-gun filter,
// not a security boundary.
type ShellOperations struct {
	scope PathScope

	// Watchdog tuning for the streaming "why is this silent?" feedback. Zero
	// means "use the default"; tests override these (and probeFn) directly to
	// stay deterministic and fast without hardcoding multi-second waits.
	probeDeadline     time.Duration    // how long the fs-access probe may block before we call it "awaiting-permission"
	heartbeatInterval time.Duration    // how long a command may be silent before a neutral "still running" status
	probeFn           func(dir string) // filesystem-access probe; default os.Stat(dir)

	// Cancel/timeout teardown tuning for ExecuteStreaming. Zero means "use the
	// default"; tests override these to exercise the escaped-grandchild path
	// without waiting multiple real seconds.
	killGrace time.Duration // after SIGTERM, wait this long before SIGKILL of the process group
	reapGrace time.Duration // then wait at most this long for the process to exit before force-closing the pipe
}

// NewShellOperations creates a new shell operations handler
func NewShellOperations(scope PathScope) *ShellOperations {
	return &ShellOperations{
		scope: scope,
	}
}

// Default watchdog timings. The probe deadline MUST stay below the heartbeat
// interval: a pending permission prompt is detected first (probe blocks past
// its deadline) so the specific "awaiting-permission" status pre-empts the
// neutral heartbeat. Generic silence (slow build, network, sleep) lets the
// probe return fast, so only the heartbeat fires.
const (
	defaultProbeDeadline     = 1500 * time.Millisecond
	defaultHeartbeatInterval = 4 * time.Second
)

const (
	// streamKillGrace is how long the ExecuteStreaming cancel/timeout path waits
	// after SIGTERM before force-killing the process group.
	streamKillGrace = 5 * time.Second
	// streamReapGrace bounds how long that path then waits for the process to
	// actually exit (cmd.Wait, via cmdDone) before giving up and force-closing the
	// output pipe. It is longer than streamKillGrace so a process reaped by the
	// SIGKILL above is normally collected cleanly and its output tail preserved;
	// the cap only bites when a grandchild has escaped the process group and
	// wedged the pipe, which would otherwise block the return indefinitely — long
	// past the command's deadline.
	streamReapGrace = 7 * time.Second
)

func (ops *ShellOperations) probeDeadlineOrDefault() time.Duration {
	if ops.probeDeadline > 0 {
		return ops.probeDeadline
	}
	return defaultProbeDeadline
}

func (ops *ShellOperations) heartbeatIntervalOrDefault() time.Duration {
	if ops.heartbeatInterval > 0 {
		return ops.heartbeatInterval
	}
	return defaultHeartbeatInterval
}

func (ops *ShellOperations) killGraceOrDefault() time.Duration {
	if ops.killGrace > 0 {
		return ops.killGrace
	}
	return streamKillGrace
}

func (ops *ShellOperations) reapGraceOrDefault() time.Duration {
	if ops.reapGrace > 0 {
		return ops.reapGrace
	}
	return streamReapGrace
}

func (ops *ShellOperations) probeFnOrDefault() func(dir string) {
	if ops.probeFn != nil {
		return ops.probeFn
	}
	// A real TCC consent dialog makes this stat block while pending; a decided
	// (granted or denied) state returns fast.
	return func(dir string) { _, _ = os.Stat(dir) }
}

// Execute executes a shell operation
func (ops *ShellOperations) Execute(ctx context.Context, operation string, params map[string]any) (any, error) {
	switch operation {
	case "execute":
		return ops.execute(ctx, params)
	case "startBackground":
		return ops.startBackground(params)
	case "getOutput":
		return ops.getOutput(params)
	case "getOutputDelta":
		return ops.getOutputDelta(params)
	case "kill":
		return ops.kill(params)
	case "listBackgroundShells":
		return ops.listBackgroundShells(params)
	default:
		return nil, fmt.Errorf("unknown operation: %s", operation)
	}
}

// getOutput retrieves output from a background shell
func (ops *ShellOperations) getOutput(params map[string]any) (any, error) {
	taskID, ok := params["task_id"].(string)
	if !ok || taskID == "" {
		return nil, fmt.Errorf("missing task_id parameter")
	}

	shell := getBackgroundShell(taskID)
	if shell == nil {
		return map[string]any{
			"task_id": taskID,
			"status":  "not_found",
			"error":   "Task not found",
		}, nil
	}

	state := getShellState(taskID)

	result := map[string]any{
		"task_id": taskID,
		"status":  state.Status,
		"output":  state.Output,
	}

	if state.Status == "completed" || state.Status == "failed" {
		result["exitCode"] = state.ExitCode
		if state.Error != "" {
			result["error"] = state.Error
		}
	}

	return result, nil
}

// getOutputDelta is the read-and-advance variant of getOutput used by the
// TaskOutput tool: each call returns only the output produced since the previous
// getOutputDelta call for this task (BashOutput semantics), so a model that polls
// a running task never re-ingests output it has already seen. The cumulative
// getOutput path is untouched — the Monitor live-output panel, which keeps its
// own diff cursor over the full buffer, keeps calling that.
func (ops *ShellOperations) getOutputDelta(params map[string]any) (any, error) {
	taskID, ok := params["task_id"].(string)
	if !ok || taskID == "" {
		return nil, fmt.Errorf("missing task_id parameter")
	}

	shell := getBackgroundShell(taskID)
	if shell == nil {
		return map[string]any{
			"task_id": taskID,
			"status":  "not_found",
			"error":   "Task not found",
		}, nil
	}

	state := getShellDelta(taskID)

	result := map[string]any{
		"task_id":     taskID,
		"status":      state.Status,
		"output":      state.Output,
		"outputIsNew": true, // output is the delta since the previous read, not the full log
	}

	if state.Status == "completed" || state.Status == "failed" {
		result["exitCode"] = state.ExitCode
		if state.Error != "" {
			result["error"] = state.Error
		}
	}

	return result, nil
}

// kill terminates a background shell
func (ops *ShellOperations) kill(params map[string]any) (any, error) {
	shellID, ok := params["shell_id"].(string)
	if !ok || shellID == "" {
		return nil, fmt.Errorf("missing shell_id parameter")
	}

	shell := getBackgroundShell(shellID)
	if shell == nil {
		return map[string]any{
			"shell_id": shellID,
			"killed":   false,
			"error":    "Shell not found",
		}, nil
	}

	result := killShell(shellID)

	if result.Status != "failed" {
		return map[string]any{
			"shell_id": shellID,
			"killed":   false,
			"error":    "Shell is not running",
		}, nil
	}

	return map[string]any{
		"shell_id": shellID,
		"killed":   true,
	}, nil
}

// listBackgroundShells returns all background shells for a conversation
func (ops *ShellOperations) listBackgroundShells(params map[string]any) (any, error) {
	convID, _ := params["conv_id"].(string)

	resp := make(chan registryResp, 1)
	registryCh <- registryOp{
		kind:   "list",
		convID: convID,
		resp:   resp,
	}
	result := <-resp

	return map[string]any{"shells": result.shells}, nil
}

// startBackground starts a command in the background and returns immediately
func (ops *ShellOperations) startBackground(params map[string]any) (any, error) {
	command, ok := params["command"].(string)
	if !ok || command == "" {
		return nil, fmt.Errorf("missing command parameter")
	}

	// Normalize newlines to && — LLMs sometimes use \n to separate commands
	command = normalizeCommandNewlines(command)

	if err := bestEffortShellSanityCheck(command); err != nil {
		return nil, fmt.Errorf("invalid command: %w", err)
	}

	// Get timeout from params (default: 10 minutes for background tasks)
	timeout := timeoutFromParams(params, maxExecTimeoutMs)

	// Extract conversation/tool-use tracking params (optional)
	convID, _ := params["conv_id"].(string)
	toolUseID, _ := params["tool_use_id"].(string)

	// Generate unique shell ID
	shellID := fmt.Sprintf("bg-%d", time.Now().UnixNano())

	// Create context with timeout and cancellation
	ctx, cancel := context.WithTimeout(context.Background(), timeout)

	// Create background shell entry (mutable state initialized here,
	// owned by registry goroutine once registered)
	shell := &BackgroundShell{
		ID:        shellID,
		ConvID:    convID,
		ToolUseID: toolUseID,
		Command:   command,
		StartTime: time.Now(),
		cancel:    cancel,
		status:    "running",
	}

	// Register the shell (registry goroutine now owns mutable state)
	registerBackgroundShell(shell)

	// Start command execution in goroutine
	go func() {
		defer cancel()

		// Build command
		cmd := newShellCmd(ctx, command)
		setProcGroup(cmd)
		cmd.Dir = ops.scope.BaseDir()

		updateShellCmd(shellID, cmd)

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

		if startErr := cmd.Start(); startErr != nil {
			pipeWriter.Close()
			pipeReader.Close()
			updateShellStatus(shellID, "failed", "", -1, fmt.Sprintf("command start failed: %v", startErr))
			time.AfterFunc(1*time.Hour, func() { removeBackgroundShell(shellID) })
			return
		}

		cmdDone := make(chan error, 1)
		go func() {
			cmdDone <- cmd.Wait()
			pipeWriter.Close()
		}()

		// Head/tail-capped, UTF-8-safe forwarder: publishes output to the
		// registry live up to outputHeadLimit bytes, then retains only the last
		// outputTailLimit bytes; the dropped middle is flushed once at stream end
		// (see suffix() below) so the final registry output matches the capped
		// head+tail the non-streaming cappedBuffer produces.
		fwd := newCappedForwarder(outputHeadLimit, outputTailLimit, func(s string) {
			appendShellOutput(shellID, s)
		})

		readerDone := make(chan struct{})
		go func() {
			defer close(readerDone)
			fwd.drain(pipeReader, nil)
		}()

		// Wait for the process to exit, then for the reader to drain fully before
		// reading the cap accounting (happens-before its final writes).
		err := <-cmdDone
		<-readerDone
		pipeReader.Close()

		// Flush the retained tail (and the dropped-middle marker) so the final
		// registry output is the capped head+tail, matching the old behaviour.
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
		// the final update sets only status/exitCode/errMsg (no double-write).
		updateShellStatus(shellID, status, "", exitCode, errMsg)

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
	// Check if this is Python code execution (code param) or shell command
	if code, ok := params["code"].(string); ok {
		// Python code execution - pass via stdin to python3
		return ops.executePythonCode(ctx, code, params)
	}

	command, ok := params["command"].(string)
	if !ok {
		return nil, fmt.Errorf("missing 'command' or 'code' parameter")
	}

	// Normalize newlines to && — LLMs sometimes use \n to separate commands
	// in JSON, which works with sh -c but displays poorly and loses fail-fast semantics.
	command = normalizeCommandNewlines(command)

	if err := bestEffortShellSanityCheck(command); err != nil {
		return nil, fmt.Errorf("invalid command: %w", err)
	}

	// Get timeout from params (defaults to defaultExecTimeoutMs, capped at maxExecTimeoutMs)
	timeout := timeoutFromParams(params, defaultExecTimeoutMs)

	// Working directory (default: the conversation's worktree of the project).
	// A given cwd is validated against the REAL project root, then redirected
	// into the conversation's worktree of whichever repo it lands in.
	workingDir := ops.scope.BaseDir()
	if cwd, ok := params["cwd"].(string); ok && cwd != "" {
		resolved, err := validateCwd(ops.scope.Root(), cwd)
		if err != nil {
			return nil, err
		}
		workingDir = ops.scope.Remap(resolved)
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

	output := newCappedBuffer(outputHeadLimit, outputTailLimit)
	cmd.Stdout = output
	cmd.Stderr = output // Merge stderr into stdout - interleaved naturally

	// Start the command
	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("command start failed: %w", err)
	}

	// Wait for command with timeout / caller cancellation
	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()

	select {
	case <-execCtx.Done():
		// Timeout or caller cancellation - kill the process group (all children).
		killProcessGroup(cmd)
		<-done // Wait for the goroutine to finish
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
		return map[string]any{
			"command":  command,
			"stdout":   output.String(), // Combined stdout+stderr
			"stderr":   "",              // Empty - merged into stdout
			"exitCode": exitCode,
			"success":  exitCode == 0,
		}, nil
	}
}

// executePythonCode executes Python code via stdin.
//
// Why stdin instead of the -c flag: the code is passed as pure string data,
// never parsed by a shell, so it sidesteps all shell escaping issues (quotes,
// backslashes, newlines) and shell argument-length limits.
func (ops *ShellOperations) executePythonCode(ctx context.Context, code string, params map[string]any) (any, error) {
	// Get timeout from params (defaults to defaultExecTimeoutMs, capped at maxExecTimeoutMs)
	timeout := timeoutFromParams(params, defaultExecTimeoutMs)

	// Create context with timeout, derived from the caller's context so a
	// cancelled request stops the python process too.
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// Execute python with code passed via stdin
	// Using "-" tells python to read from stdin. On Unix this is python3; on
	// Windows it is routed through WSL (see newPythonCmd).
	cmd := newPythonCmd(ctx)
	cmd.Dir = ops.scope.BaseDir()
	cmd.Stdin = strings.NewReader(code)

	output := newCappedBuffer(outputHeadLimit, outputTailLimit)
	cmd.Stdout = output
	cmd.Stderr = output // Merge stderr into stdout - interleaved naturally

	err := cmd.Run()
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

	return map[string]any{
		"stdout":   output.String(), // Combined stdout+stderr
		"stderr":   "",              // Empty - merged into stdout
		"exitCode": exitCode,
		"success":  exitCode == 0,
	}, nil
}

// ShellStreamChunk represents a chunk of streaming output.
//
// A normal chunk carries Data (with Done=false) or is the terminal completion
// chunk (Done=true, optional ExitCode/Error). A *status* chunk is neither: it
// carries Status (e.g. "awaiting-permission" or "running") with empty Data and
// Done=false, so the UI can surface why a silent command is still running
// without it being mistaken for output or completion. Status is empty on every
// data/completion chunk.
type ShellStreamChunk struct {
	ShellID  string `json:"shellId"`
	Data     string `json:"data"`
	Done     bool   `json:"done"`
	ExitCode int    `json:"exitCode,omitempty"`
	Error    string `json:"error,omitempty"`
	Status   string `json:"status,omitempty"` // "awaiting-permission" | "running"; empty for data/done chunks
	Hint     string `json:"hint,omitempty"`   // human-readable explanation for the status
}

// ExecuteStreaming runs a shell command with real-time output streaming.
// Output is sent via the output channel as chunks arrive.
// The function returns when the command completes or context is cancelled.
// On cancellation, sends SIGTERM to gracefully stop the process.
func (ops *ShellOperations) ExecuteStreaming(
	ctx context.Context,
	shellID string,
	command string,
	cwd string,
	timeoutMs int,
	output chan<- ShellStreamChunk,
) {
	defer close(output)

	if err := bestEffortShellSanityCheck(command); err != nil {
		output <- ShellStreamChunk{
			ShellID: shellID,
			Done:    true,
			Error:   fmt.Sprintf("invalid command: %v", err),
		}
		return
	}

	// Default and cap timeout
	if timeoutMs <= 0 {
		timeoutMs = defaultExecTimeoutMs
	}
	timeout := capTimeout(timeoutMs)

	// Working directory, validated to stay within the real project root, then
	// redirected into the conversation's worktree of the repo it lands in.
	workingDir, err := validateCwd(ops.scope.Root(), cwd)
	if err != nil {
		output <- ShellStreamChunk{
			ShellID: shellID,
			Done:    true,
			Error:   err.Error(),
		}
		return
	}
	workingDir = ops.scope.Remap(workingDir)

	// Create timeout context
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()

	// Build command
	cmd := newShellCmd(ctx, command)
	setProcGroup(cmd)
	cmd.Dir = workingDir

	// Create pipe for merged stdout/stderr
	pipeReader, pipeWriter := io.Pipe()
	cmd.Stdout = pipeWriter
	cmd.Stderr = pipeWriter

	// Start command
	if err := cmd.Start(); err != nil {
		output <- ShellStreamChunk{
			ShellID: shellID,
			Done:    true,
			Error:   fmt.Sprintf("command start failed: %v", err),
		}
		return
	}

	// Channel to signal command completion
	cmdDone := make(chan error, 1)
	go func() {
		cmdDone <- cmd.Wait()
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
	})

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
			// Give process time to clean up, then force kill the group.
			time.AfterFunc(ops.killGraceOrDefault(), func() {
				killProcessGroup(cmd)
			})
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

		errMsg := "command cancelled"
		if ctx.Err() == context.DeadlineExceeded {
			errMsg = fmt.Sprintf("command timeout (exceeded %v)", timeout)
		}
		output <- ShellStreamChunk{
			ShellID: shellID,
			Data:    fwd.suffix(),
			Done:    true,
			Error:   errMsg,
		}
		return

	case err := <-cmdDone:
		stopWatchdog()
		readerWG.Wait() // Wait for reader to exit before closing pipeReader
		pipeReader.Close()
		exitCode := 0
		if err != nil {
			if code, ok := exitCodeOf(err); ok {
				exitCode = code
			}
		}
		output <- ShellStreamChunk{
			ShellID:  shellID,
			Data:     fwd.suffix(),
			Done:     true,
			ExitCode: exitCode,
		}
	}
}

// normalizeCommandNewlines replaces bare newlines used as command separators
// with " && " for consistent display/logging and fail-fast semantics.
// Empty lines are dropped; commands without newlines pass through unchanged.
func normalizeCommandNewlines(command string) string {
	if !strings.Contains(command, "\n") {
		return command
	}

	lines := strings.Split(command, "\n")
	var nonEmpty []string
	for _, line := range lines {
		trimmed := strings.TrimSpace(line)
		if trimmed != "" {
			nonEmpty = append(nonEmpty, trimmed)
		}
	}
	return strings.Join(nonEmpty, " && ")
}

// bestEffortShellSanityCheck rejects empty / oversized commands and a tiny
// hand-coded list of obviously-destructive patterns. It is NOT a security
// boundary — a determined caller can trivially bypass it (`rm -rf $(pwd)`
// etc.). The real safety net is the UI approval flow that gates every shell
// execution. Treat this as a typo / accidental-foot-gun filter only.
func bestEffortShellSanityCheck(command string) error {
	// Check for empty command
	if strings.TrimSpace(command) == "" {
		return fmt.Errorf("command cannot be empty")
	}

	// Length cap of 10000 supports SWE-bench tests with many test paths.
	const maxCommandLength = 10000
	if len(command) > maxCommandLength {
		return fmt.Errorf("command exceeds maximum length of %d characters", maxCommandLength)
	}

	// Reject a tiny set of obviously-destructive patterns. This is a
	// foot-gun filter, not a security control — bypass is trivial.
	dangerousPatterns := []string{
		"rm -rf /",
		"mkfs",
		"dd if=",
		"> /dev/",
		":(){ :|:& };:", // fork bomb
		"/dev/sda",
		"/dev/hda",
	}

	commandLower := strings.ToLower(command)
	for _, pattern := range dangerousPatterns {
		if strings.Contains(commandLower, strings.ToLower(pattern)) {
			return fmt.Errorf("command contains dangerous pattern: %s", pattern)
		}
	}

	return nil
}

// validateCwd resolves a user-supplied shell cwd and rejects anything outside
// the project workingDir. Empty cwd means "use workingDir". The prefix check
// appends a separator so siblings like "<workingDir>-evil" cannot pass.
func validateCwd(workingDir, cwd string) (string, error) {
	if cwd == "" {
		return workingDir, nil
	}
	absPath, err := filepath.Abs(cwd)
	if err != nil {
		return "", fmt.Errorf("invalid cwd path: %w", err)
	}
	projectDir, err := filepath.Abs(workingDir)
	if err != nil {
		return "", fmt.Errorf("invalid working directory: %w", err)
	}
	projectWithSep := projectDir + string(filepath.Separator)
	if absPath != projectDir && !strings.HasPrefix(absPath+string(filepath.Separator), projectWithSep) {
		return "", fmt.Errorf("cwd must be within project directory")
	}
	return absPath, nil
}
