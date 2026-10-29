//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"context"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"

	"juggler/internal/jlog"
)

// killEscalationGrace is how long the registry's kill op waits after the polite
// SIGTERM before taking the task's process group.
const killEscalationGrace = 2 * time.Second

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

	// reaped is closed by the spawner goroutine the moment cmd.Wait returns —
	// the moment the process's pid stops naming it (see stoppingTask). Nothing
	// closes it for a command that never started.
	reaped chan struct{}

	// ProjectRoot is the project this shell was spawned under — the directory it
	// runs in. The registry is process-global, spanning every tree this process
	// works in, so without this a task started in one stays readable and
	// killable from another. Every lookup that acts on a caller-supplied id compares it against
	// the caller's current scope root, which is the boundary the id itself is not.
	ProjectRoot string

	// Mutable fields (owned by registry goroutine only)
	status   string
	output   strings.Builder
	exitCode int
	errMsg   string
	cmd      *exec.Cmd

	// Spill accounting for the full-output file, written after
	// registerBackgroundShell via the terminal updateStatus op — so, like the
	// other mutable fields, they are owned by the registry goroutine and must NOT
	// be written directly from the spawner goroutine.
	outputFile      string
	outputBytes     int64
	outputTruncated bool

	// readOffset is how many bytes of output the TaskOutput tool has already
	// been handed. Advanced by the "getDelta" op so a polling reader receives
	// each byte exactly once (BashOutput semantics). The Monitor delivery pump
	// reads full snapshots via getState and keeps its own diff cursor, so it is
	// unaffected by this field.
	readOffset int
}

// snapshot returns a copy of the mutable state. Only call from the registry goroutine.
func (shell *BackgroundShell) snapshot() TaskOutputState {
	return TaskOutputState{
		Status:          shell.status,
		Output:          shell.output.String(),
		ExitCode:        shell.exitCode,
		Error:           shell.errMsg,
		OutputFile:      shell.outputFile,
		OutputBytes:     shell.outputBytes,
		OutputTruncated: shell.outputTruncated,
	}
}

// registryOpKind names the requests the registry goroutine acts on. It is a
// type rather than a string so the set is closed: a kind the actor does not
// handle cannot be spelled at a call site, and every accessor below waits for a
// reply, so one that reached the actor unhandled would wait for the life of the
// process.
type registryOpKind int

const (
	regRegister registryOpKind = iota
	regGet
	regRemove
	regList
	regGetState
	regGetDelta
	regUpdateCmd
	regAppendOutput
	regUpdateStatus
	regKill
	regKillMatching
	regSetObserver
	regPersistenceState
)

// registryOp is a request sent to the global registry goroutine
type registryOp struct {
	kind        registryOpKind
	id          string
	shell       *BackgroundShell
	convID      string
	projectRoot string
	// within widens regKillMatching from the tasks rooted at projectRoot to every
	// task rooted anywhere under it.
	within   bool
	observer BackgroundTaskObserver
	// updateCmd/updateStatus fields
	cmd      *exec.Cmd
	status   string
	output   string
	exitCode int
	errMsg   string
	// terminal updateStatus spill accounting
	outputFile      string
	outputBytes     int64
	outputTruncated bool
	// response
	resp chan registryResp
}

// registryResp is the response from the global registry goroutine
type registryResp struct {
	shell    *BackgroundShell
	shells   []map[string]any
	snapshot TaskOutputState
	observer BackgroundTaskObserver
	current  bool
	stopped  int
	// stopping are tasks that have been signalled and still need their process
	// group taken if they ignore it. Handed out so the escalation runs off the
	// registry goroutine.
	stopping []stoppingTask
}

var (
	registryOps   = make(chan registryOp, 16)
	registryStart sync.Once
)

// registryCh is the registry actor's mailbox, and starts the actor on first
// use: a process that never runs a background shell never has the goroutine.
// Every send goes through here rather than to registryOps, because every
// accessor waits for a reply and the mailbox is buffered — a send into a
// mailbox nobody had started would land, and its caller would wait forever.
// StopBackgroundTasks is called from shutdown, where that wait would block the
// release of everything sequenced behind it.
func registryCh() chan<- registryOp {
	registryStart.Do(func() { go runShellRegistry() })
	return registryOps
}

// runShellRegistry owns the background-shell map and processes all ops
// serialized through registryCh. It runs for the rest of the process once
// started.
func runShellRegistry() {
	shells := make(map[string]*BackgroundShell)
	latestByOwner := make(map[string]string)
	var observer BackgroundTaskObserver
	for op := range registryOps {
		switch op.kind {
		case regRegister:
			shells[op.shell.ID] = op.shell
			if op.shell.ConvID != "" && op.shell.ToolUseID != "" {
				latestByOwner[op.shell.ConvID+"\x00"+op.shell.ToolUseID] = op.shell.ID
			}

		case regSetObserver:
			observer = op.observer

		case regPersistenceState:
			shell := shells[op.id]
			current := shell != nil
			if current && shell.ConvID != "" && shell.ToolUseID != "" {
				current = latestByOwner[shell.ConvID+"\x00"+shell.ToolUseID] == shell.ID
			}
			op.resp <- registryResp{shell: shell, snapshot: func() TaskOutputState {
				if shell == nil {
					return TaskOutputState{}
				}
				return shell.snapshot()
			}(), observer: observer, current: current}

		case regGet:
			op.resp <- registryResp{shell: shells[op.id]}

		case regRemove:
			if shell := shells[op.id]; shell != nil && shell.ConvID != "" && shell.ToolUseID != "" {
				owner := shell.ConvID + "\x00" + shell.ToolUseID
				if latestByOwner[owner] == shell.ID {
					delete(latestByOwner, owner)
				}
			}
			delete(shells, op.id)

		case regList:
			// Scoped to one conversation within one project by the caller, which
			// both callers enforce before sending. Output is deliberately absent:
			// a listing says what is running, and a caller that wants a task's
			// output asks for that task by id through getOutput, where the same
			// ownership check applies and the request is explicit.
			var result []map[string]any
			for _, shell := range shells {
				if shell.ConvID != op.convID || !sameProject(shell.ProjectRoot, op.projectRoot) {
					continue
				}
				result = append(result, map[string]any{
					"task_id":     shell.ID,
					"tool_use_id": shell.ToolUseID,
					"command":     shell.Command,
					"status":      shell.status,
					"exit_code":   shell.exitCode,
					"error":       shell.errMsg,
				})
			}
			op.resp <- registryResp{shells: result}

		case regKillMatching:
			// Stop every running task under a project — or rooted anywhere below a
			// directory, when `within` is set — or under all of them when no root
			// is named. The records stay in the map: a task that was
			// stopped is a task that ended, and its terminal state is what the
			// snapshot observer and any later read should see.
			var stopping []stoppingTask
			stopped := 0
			for _, shell := range shells {
				if shell.status != "running" {
					continue
				}
				switch {
				case op.projectRoot == "":
				case op.within:
					if !rootedWithin(shell.ProjectRoot, op.projectRoot) {
						continue
					}
				case !sameProject(shell.ProjectRoot, op.projectRoot):
					continue
				}
				// A task registered a moment ago may not have reached cmd.Start
				// yet, so there is nothing to signal — but its context is
				// cancelled here and the command is built with CommandContext, so
				// it dies at Start rather than escaping. It counts as stopped:
				// what was stopped is the task, not necessarily a process.
				if task := signalShellStop(shell); task != nil {
					stopping = append(stopping, *task)
				}
				shell.status = "failed"
				shell.errMsg = op.errMsg
				shell.exitCode = -1
				stopped++
			}
			// Escalation is the caller's: it happens off the actor so a slow
			// process group cannot stall every other task's reads behind it.
			op.resp <- registryResp{stopping: stopping, stopped: stopped}

		case regGetState:
			shell := shells[op.id]
			if shell == nil {
				op.resp <- registryResp{}
			} else {
				op.resp <- registryResp{snapshot: shell.snapshot()}
			}

		case regGetDelta:
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

		case regUpdateCmd:
			if shell := shells[op.id]; shell != nil {
				shell.cmd = op.cmd
			}

		case regAppendOutput:
			if shell := shells[op.id]; shell != nil {
				shell.output.WriteString(op.output)
			}

		case regUpdateStatus:
			if shell := shells[op.id]; shell != nil {
				// The first terminal verdict stands. A stop records why the task
				// ended and cancels its context, and that cancellation is what
				// makes the process exit — so the spawner's own terminal update
				// follows moments later saying "command cancelled", which names
				// the mechanism rather than the cause. Whoever stopped it is what
				// the user reads on the tool action, and which of the two writes
				// the machine ran last is not something to decide it.
				if shell.status == "running" {
					shell.status = op.status
					shell.exitCode = op.exitCode
					shell.errMsg = op.errMsg
				}
				// Output and spill accounting stay the spawner's to report
				// either way: a task that was stopped still wrote what it wrote,
				// and the spill file is complete by the time this lands.
				shell.output.WriteString(op.output)
				shell.outputFile = op.outputFile
				shell.outputBytes = op.outputBytes
				shell.outputTruncated = op.outputTruncated
			}

		case regKill:
			shell := shells[op.id]
			if shell == nil || shell.status != "running" {
				status := ""
				if shell != nil {
					status = shell.status
				}
				op.resp <- registryResp{snapshot: TaskOutputState{Status: status}}
				continue
			}

			// Signal the process to stop, then schedule a force-kill of the
			// process group if it doesn't exit promptly. The AfterFunc escalation
			// is non-blocking, so the registry goroutine stays responsive to other
			// ops. (Mirrors executeStreaming's cancel path.)
			if task := signalShellStop(shell); task != nil {
				time.AfterFunc(killEscalationGrace, task.forceKillGroup)
			}

			shell.status = "failed"
			shell.errMsg = "Killed by user"
			shell.exitCode = -1

			op.resp <- registryResp{snapshot: shell.snapshot()}

		default:
			// Unreachable while every kind is one of the constants above, which is
			// what the type buys. Answered rather than dropped so a kind added
			// without a case here surfaces as a logged fault and an empty reply,
			// not as a caller parked on a channel nobody will ever send to.
			jlog.Error("ops: registry received unhandled op kind %d", int(op.kind))
			if op.resp != nil {
				op.resp <- registryResp{}
			}
		}
	}
}

// killGroupHook lets a test observe every force-kill escalation without altering
// what production does. It is atomic because escalations are scheduled on
// timers, so one armed by an earlier test can still be in flight when the next
// installs its own hook. Production never sets it.
var killGroupHook atomic.Value // func(*exec.Cmd)

// killGroup force-kills a command's whole process tree.
func killGroup(cmd *exec.Cmd) {
	if hook, _ := killGroupHook.Load().(func(*exec.Cmd)); hook != nil {
		hook(cmd)
		return
	}
	killProcessGroup(cmd)
}

// stoppingTask is a command that has been asked to stop, paired with the channel
// its spawner closes once cmd.Wait has returned.
//
// A force-kill names a whole process TREE by one pid, and a pid means what the
// killer thinks only until the process is reaped: Wait releases the handle that
// reserves the number, and the OS is then free to hand the same number to
// something else — Windows recycles pids within seconds, so `taskkill /T` would
// take down that stranger and its children. Every escalation that runs on a
// timer, seconds after the polite stop, therefore goes through forceKillGroup.
type stoppingTask struct {
	cmd    *exec.Cmd
	reaped <-chan struct{}
}

// forceKillGroup takes the task's process group, unless it has already been
// reaped and its pid is no longer ours to name.
func (task stoppingTask) forceKillGroup() {
	select {
	case <-task.reaped:
	default:
		killGroup(task.cmd)
	}
}

// signalShellStop cancels a running shell's context and asks its process to
// stop, returning the task so the caller can escalate to the process group.
// Only call from the registry goroutine.
//
// It must NOT call cmd.Wait(): the startBackground goroutine is the sole owner
// of Wait (and reaps the process there), so a second Wait on the same *exec.Cmd
// would be a data race. Signalling is safe from here; reaping is not.
func signalShellStop(shell *BackgroundShell) *stoppingTask {
	if shell.cancel != nil {
		shell.cancel()
	}
	if shell.cmd == nil || shell.cmd.Process == nil {
		return nil
	}
	cmd := shell.cmd
	_ = cmd.Process.Signal(syscall.SIGTERM)
	return &stoppingTask{cmd: cmd, reaped: shell.reaped}
}

// getBackgroundShell retrieves a background shell by ID
func getBackgroundShell(id string) *BackgroundShell {
	resp := make(chan registryResp, 1)
	registryCh() <- registryOp{kind: regGet, id: id, resp: resp}
	return (<-resp).shell
}

// registerBackgroundShell adds a shell to the registry
func registerBackgroundShell(shell *BackgroundShell) {
	registryCh() <- registryOp{kind: regRegister, shell: shell}
}

func setBackgroundTaskObserver(observer BackgroundTaskObserver) {
	registryCh() <- registryOp{kind: regSetObserver, observer: observer}
}

// publishBackgroundTaskSnapshots copies the bounded observable state to the
// server's persistence sink. It never invokes that sink on the registry actor,
// where a slow conversation save would block every background task.
func publishBackgroundTaskSnapshots(shellID string) {
	ticker := time.NewTicker(250 * time.Millisecond)
	defer ticker.Stop()
	last := TaskOutputState{}
	for {
		respCh := make(chan registryResp, 1)
		registryCh() <- registryOp{kind: regPersistenceState, id: shellID, resp: respCh}
		resp := <-respCh
		if !resp.current || resp.shell == nil {
			return
		}
		state := resp.snapshot
		if state != last && resp.observer != nil {
			resp.observer(BackgroundTaskSnapshot{
				TaskID: shellID, ConvID: resp.shell.ConvID, ToolUseID: resp.shell.ToolUseID,
				TaskOutputState: state,
			})
			last = state
		}
		if state.Status != "running" {
			return
		}
		<-ticker.C
	}
}

// removeBackgroundShell removes a shell from the registry
func removeBackgroundShell(id string) {
	registryCh() <- registryOp{kind: regRemove, id: id}
}

// getShellState gets a state snapshot via the registry goroutine
func getShellState(id string) TaskOutputState {
	resp := make(chan registryResp, 1)
	registryCh() <- registryOp{kind: regGetState, id: id, resp: resp}
	return (<-resp).snapshot
}

// getShellDelta returns the shell's output produced since the previous
// getShellDelta call (advancing the read cursor) alongside its current status.
// Snapshot.Output carries the delta, not the full accumulated output.
func getShellDelta(id string) TaskOutputState {
	resp := make(chan registryResp, 1)
	registryCh() <- registryOp{kind: regGetDelta, id: id, resp: resp}
	return (<-resp).snapshot
}

// updateShellCmd updates the cmd field via the registry goroutine
func updateShellCmd(id string, cmd *exec.Cmd) {
	registryCh() <- registryOp{kind: regUpdateCmd, id: id, cmd: cmd}
}

// appendShellOutput appends an output delta via the registry goroutine without
// touching status. Used by startBackground to publish a running command's output
// incrementally, so readers (ops.TaskState) see it before the process exits.
func appendShellOutput(id, delta string) {
	registryCh() <- registryOp{kind: regAppendOutput, id: id, output: delta}
}

// updateShellStatus updates status fields via the registry goroutine. Pass an
// empty output to set only status/exitCode/errMsg without appending — used when
// output has already been published incrementally (see startBackground). The
// trailing outputFile/outputBytes/outputTruncated carry the full-output spill
// accounting, set here (on the registry goroutine) rather than written directly
// from the spawner goroutine so a concurrent getOutput can't race the write.
func updateShellStatus(id string, status, output string, exitCode int, errMsg string, outputFile string, outputBytes int64, outputTruncated bool) {
	registryCh() <- registryOp{
		kind: regUpdateStatus, id: id, status: status, output: output, exitCode: exitCode, errMsg: errMsg,
		outputFile: outputFile, outputBytes: outputBytes, outputTruncated: outputTruncated,
	}
}

// killShell sends a kill request via the registry goroutine and waits for completion
func killShell(id string) TaskOutputState {
	resp := make(chan registryResp, 1)
	registryCh() <- registryOp{kind: regKill, id: id, resp: resp}
	return (<-resp).snapshot
}

// sameProject reports whether two project roots name the same directory. Both
// come from the same stored project path in practice, so this is equality — with
// trailing separators trimmed, because a trailing slash is not a difference and
// reading it as one would make every task in the project unreachable at once.
func sameProject(a, b string) bool {
	trim := func(p string) string {
		if len(p) > 1 {
			return strings.TrimRight(p, `/\`)
		}
		return p
	}
	return trim(a) == trim(b)
}

// rootedWithin reports whether a task's root is dir or somewhere under it. dir
// arrives symlink-resolved (it is what a removal is about to delete), and the
// task's root is resolved here to match: a scope root is stored as given, and on
// macOS the same temp directory is both /var/… and /private/var/….
func rootedWithin(taskRoot, dir string) bool {
	if taskRoot == "" {
		return false
	}
	if real, err := filepath.EvalSymlinks(taskRoot); err == nil {
		taskRoot = real
	}
	rel, err := filepath.Rel(dir, taskRoot)
	if err != nil {
		return false
	}
	return rel == "." || (rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)))
}
