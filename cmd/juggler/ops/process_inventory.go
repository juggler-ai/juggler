//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package ops

import (
	"errors"
	"sort"
	"sync"
	"time"

	"juggler/internal/jlog"
)

// The process inventory is the session's task manager: every process the shell
// tool has running right now, background or foreground, with the conversation,
// thread and tool call that started it, and a way to stop each one.
//
// It indexes rather than owns. A background task's state and kill path stay in
// the shell registry and a foreground command's in the call running it; an entry
// here is a label plus the stop function its spawner handed over, added once the
// process has started and removed when it has exited. So the table holds only
// what is running — it is not a history, and a process that never started is
// never in it.
//
// It is keyed by project, as the registry is: a workspace's processes are listed
// under the project the workspace was made from (PathScope.ProjectRoot), because
// the session the user is looking at is the project's, whichever tree a
// conversation happens to work in.
//
// A tool call is shown running before its process exists — the client marks it
// running, then asks for the start — so a stop can be asked for by the tool call
// (StopOwnedProcess) before there is anything listed to stop. Such a stop is held
// against the call's owner and carried out the moment a process with that owner
// is listed, rather than answered "nothing running" and lost.
//
// A tool call runs one foreground command at a time, so listing one supersedes
// any earlier foreground or python process the same call still has running: the
// earlier one is stopped. The engine that executes tool calls holds its
// in-flight set only in memory, and a reloaded engine re-runs the calls the old
// one left running (resetRunningToolsForReattach) while their commands, which
// outlive the engine, carry on. Nothing would read the earlier run's output, and
// two copies of a command must never run side by side. Background tasks are
// exempt: they outlive their call by design.

// Process kinds, as listed.
const (
	ProcessBackground = "background" // startBackground: bash run_in_background, Monitor, extensions
	ProcessForeground = "foreground" // a shell command the caller is waiting on
	ProcessPython     = "python"     // python code run through the execute op
)

// ProcessOwner says what started a process: the conversation, the thread within
// it, and the tool call. Tool-call ids are only unique within one provider
// conversation — `call_1` recurs in every sub-thread — so the thread is what
// makes the pair findable again.
type ProcessOwner struct {
	ConvID    string
	ThreadID  string
	ToolUseID string
}

// ProcessInfo is one listed process.
type ProcessInfo struct {
	ID        string `json:"id"`
	Kind      string `json:"kind"`
	Command   string `json:"command"`
	ConvID    string `json:"convId,omitempty"`
	ThreadID  string `json:"threadId,omitempty"`
	ToolUseID string `json:"toolUseId,omitempty"`
	StartedAt int64  `json:"startedAt"` // Unix milliseconds
}

type processEntry struct {
	info        ProcessInfo
	projectRoot string
	stop        func()
}

func (e *processEntry) owner() ProcessOwner {
	return ProcessOwner{ConvID: e.info.ConvID, ThreadID: e.info.ThreadID, ToolUseID: e.info.ToolUseID}
}

// runsInForeground reports whether the entry's caller is waiting on it, so that
// the call can have only one at a time.
func (e *processEntry) runsInForeground() bool {
	return e.info.Kind == ProcessForeground || e.info.Kind == ProcessPython
}

// ownedBy reports whether the tool call owner under projectRoot started the
// entry. An owner without a tool call owns nothing.
func (e *processEntry) ownedBy(owner ProcessOwner, projectRoot string) bool {
	return owner.ToolUseID != "" && e.owner() == owner && sameProject(e.projectRoot, projectRoot)
}

// heldStop is a stop asked for by a tool call whose process is not listed yet.
type heldStop struct {
	owner       ProcessOwner
	projectRoot string
}

// maxHeldStops bounds the held stops. One whose process never starts — the
// command was refused, or had already ended when the stop was asked for — is
// never claimed, so the oldest give way to newer ones.
const maxHeldStops = 64

// processObserver is one OnProcessesChanged subscription. It is compared by
// pointer, so removing one never removes another registered with the same func.
type processObserver struct{ fn func(projectRoot string) }

// inventoryOpKind names the requests the inventory actor acts on — a closed set,
// as the shell registry's is, because every accessor waits for a reply.
type inventoryOpKind int

const (
	invTrack inventoryOpKind = iota
	invUntrack
	invList
	invLookup
	invStopOwned
	invObserve
	invUnobserve
)

type inventoryOp struct {
	kind        inventoryOpKind
	entry       *processEntry
	id          string
	owner       ProcessOwner
	projectRoot string
	observer    *processObserver
	resp        chan inventoryResp
}

type inventoryResp struct {
	list      []ProcessInfo
	entry     *processEntry
	owned     []*processEntry    // the processes a stop by owner, or a re-run, ends
	observers []*processObserver // who to tell about a track or untrack
	stopNow   bool               // the tracked process's call asked to stop before it was listed
}

var (
	inventoryOps   = make(chan inventoryOp, 16)
	inventoryStart sync.Once
)

// inventoryCh is the actor's mailbox, starting the actor on first use (see
// registryCh for why every send goes through here).
func inventoryCh() chan<- inventoryOp {
	inventoryStart.Do(func() { go runProcessInventory() })
	return inventoryOps
}

// runProcessInventory owns the table and the observer list. Observers are
// handed back to the caller rather than called here, so a slow one stalls only
// the spawner that made the change, never every other process's bookkeeping.
func runProcessInventory() {
	entries := make(map[string]*processEntry)
	var observers []*processObserver
	var held []heldStop
	snapshot := func() []*processObserver { return append([]*processObserver(nil), observers...) }
	for op := range inventoryOps {
		switch op.kind {
		case invTrack:
			var superseded []*processEntry
			if op.entry.runsInForeground() {
				for _, entry := range entries {
					if entry.runsInForeground() && entry.ownedBy(op.entry.owner(), op.entry.projectRoot) {
						superseded = append(superseded, entry)
					}
				}
			}
			entries[op.entry.info.ID] = op.entry
			stopNow := false
			if op.entry.info.ToolUseID != "" {
				for i, h := range held {
					if h.owner == op.entry.owner() && sameProject(h.projectRoot, op.entry.projectRoot) {
						held = append(held[:i:i], held[i+1:]...)
						stopNow = true
						break
					}
				}
			}
			op.resp <- inventoryResp{observers: snapshot(), stopNow: stopNow, owned: superseded}

		case invUntrack:
			// Only this entry: an id reused by a later process is that process's.
			if entries[op.entry.info.ID] == op.entry {
				delete(entries, op.entry.info.ID)
			}
			op.resp <- inventoryResp{observers: snapshot()}

		case invList:
			list := make([]ProcessInfo, 0, len(entries))
			for _, entry := range entries {
				if sameProject(entry.projectRoot, op.projectRoot) {
					list = append(list, entry.info)
				}
			}
			op.resp <- inventoryResp{list: list}

		case invLookup:
			op.resp <- inventoryResp{entry: entries[op.id]}

		case invStopOwned:
			var found []*processEntry
			for _, entry := range entries {
				if entry.ownedBy(op.owner, op.projectRoot) {
					found = append(found, entry)
				}
			}
			if len(found) == 0 {
				held = append(held, heldStop{owner: op.owner, projectRoot: op.projectRoot})
				if len(held) > maxHeldStops {
					held = append(held[:0:0], held[len(held)-maxHeldStops:]...)
				}
			}
			op.resp <- inventoryResp{owned: found}

		case invObserve:
			observers = append(observers, op.observer)
			op.resp <- inventoryResp{}

		case invUnobserve:
			for i, o := range observers {
				if o == op.observer {
					observers = append(observers[:i:i], observers[i+1:]...)
					break
				}
			}
			op.resp <- inventoryResp{}

		default:
			jlog.Error("ops: process inventory received unhandled op kind %d", int(op.kind))
			op.resp <- inventoryResp{}
		}
	}
}

func askInventory(op inventoryOp) inventoryResp {
	op.resp = make(chan inventoryResp, 1)
	inventoryCh() <- op
	return <-op.resp
}

// trackProcess lists a started process until the returned untrack is called.
// stop must end the process and must be safe to call more than once and after
// the process has gone. untrack is idempotent.
func trackProcess(id, kind, command, projectRoot string, owner ProcessOwner, stop func()) (untrack func()) {
	entry := &processEntry{
		info: ProcessInfo{
			ID: id, Kind: kind, Command: command,
			ConvID: owner.ConvID, ThreadID: owner.ThreadID, ToolUseID: owner.ToolUseID,
			StartedAt: time.Now().UnixMilli(),
		},
		projectRoot: projectRoot,
		stop:        stop,
	}
	tracked := askInventory(inventoryOp{kind: invTrack, entry: entry})
	announceProcessesChanged(tracked.observers, projectRoot)
	if tracked.stopNow {
		stop()
	}
	for _, earlier := range tracked.owned {
		jlog.Info("ops: %s re-runs tool call %s (conv=%s thread=%s); stopping its earlier run %s",
			id, owner.ToolUseID, owner.ConvID, owner.ThreadID, earlier.info.ID)
		earlier.stop()
	}

	var once sync.Once
	return func() {
		once.Do(func() {
			announceProcessesChanged(askInventory(inventoryOp{kind: invUntrack, entry: entry}).observers, projectRoot)
		})
	}
}

// ListProcesses returns every process running under projectRoot, oldest first.
func ListProcesses(projectRoot string) []ProcessInfo {
	list := askInventory(inventoryOp{kind: invList, projectRoot: projectRoot}).list
	sort.Slice(list, func(i, j int) bool {
		if list[i].StartedAt != list[j].StartedAt {
			return list[i].StartedAt < list[j].StartedAt
		}
		return list[i].ID < list[j].ID
	})
	return list
}

// StopProcess stops the process with this id if it is running under projectRoot,
// and reports whether there was one. The entry leaves the table when the process
// has exited, not here.
func StopProcess(projectRoot, id string) bool {
	entry := askInventory(inventoryOp{kind: invLookup, id: id}).entry
	if entry == nil || !sameProject(entry.projectRoot, projectRoot) {
		return false
	}
	entry.stop()
	return true
}

// StopOwnedProcess stops every process the tool call owner started under
// projectRoot. When none is listed it holds the stop, and the next process listed
// for that owner there is stopped as it is listed: stopped reports a process was
// stopped now, held that the stop waits for one. An owner without a tool call
// names no process and does neither.
func StopOwnedProcess(projectRoot string, owner ProcessOwner) (stopped, held bool) {
	if owner.ToolUseID == "" {
		return false, false
	}
	owned := askInventory(inventoryOp{kind: invStopOwned, owner: owner, projectRoot: projectRoot}).owned
	if len(owned) == 0 {
		return false, true
	}
	for _, entry := range owned {
		entry.stop()
	}
	return true, false
}

// OnProcessesChanged calls fn with the project root whenever a process starts or
// exits there, until the returned remove is called. fn runs on the goroutine
// that made the change — a spawner — so it must return promptly; coalesce and
// read ListProcesses elsewhere.
func OnProcessesChanged(fn func(projectRoot string)) (remove func()) {
	observer := &processObserver{fn: fn}
	askInventory(inventoryOp{kind: invObserve, observer: observer})
	return func() { askInventory(inventoryOp{kind: invUnobserve, observer: observer}) }
}

func announceProcessesChanged(observers []*processObserver, projectRoot string) {
	for _, o := range observers {
		o.fn(projectRoot)
	}
}

// userStop is the stop half of a foreground command's entry: it records that
// the user asked, then cancels the command's context, so the call can say why
// it ended in the same words a killed background task does.
type userStop struct {
	once    sync.Once
	stopped chan struct{}
	cancel  func()
}

func newUserStop(cancel func()) *userStop {
	return &userStop{stopped: make(chan struct{}), cancel: cancel}
}

func (s *userStop) stop() {
	s.once.Do(func() { close(s.stopped) })
	s.cancel()
}

func (s *userStop) requested() bool {
	select {
	case <-s.stopped:
		return true
	default:
		return false
	}
}

// killedByUser is the verdict of a foreground command stopped from the
// inventory — the same text the registry records for a killed background task.
// errKilledByUser is the same verdict as an error, for the calls that return one.
const killedByUser = "Killed by user"

var errKilledByUser = errors.New("killed by user")
