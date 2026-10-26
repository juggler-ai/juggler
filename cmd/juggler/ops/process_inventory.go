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
	invObserve
	invUnobserve
)

type inventoryOp struct {
	kind        inventoryOpKind
	entry       *processEntry
	id          string
	projectRoot string
	observer    *processObserver
	resp        chan inventoryResp
}

type inventoryResp struct {
	list      []ProcessInfo
	entry     *processEntry
	observers []*processObserver // who to tell about a track or untrack
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
	snapshot := func() []*processObserver { return append([]*processObserver(nil), observers...) }
	for op := range inventoryOps {
		switch op.kind {
		case invTrack:
			entries[op.entry.info.ID] = op.entry
			op.resp <- inventoryResp{observers: snapshot()}

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
	announceProcessesChanged(askInventory(inventoryOp{kind: invTrack, entry: entry}).observers, projectRoot)

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
