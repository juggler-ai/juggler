//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"sync/atomic"
	"time"

	"juggler/cmd/juggler/ops"
)

// processesCoalesce is how long a change to the process inventory waits before
// it is published, so that a burst — a turn starting several commands at once,
// a project switch stopping every task — goes out as one frame.
const processesCoalesce = 150 * time.Millisecond

// watchProcesses publishes the current project's process inventory to its
// viewers whenever a process starts or exits anywhere, coalesced, and returns
// the function that stops watching.
//
// The whole table is sent rather than the change: it is small, and a viewer that
// missed a frame (it connected late, it was asleep) is then corrected by the next
// one without having to ask. A viewer that has seen none asks once, through the
// shell op listProcesses.
func (s *Server) watchProcesses() (stop func()) {
	changed := coalesce(processesCoalesce, s.publishProcesses)
	return ops.OnProcessesChanged(func(string) { changed() })
}

// coalesce returns a trigger that calls publish once, window after the first of
// any burst of triggers. It never blocks, so it is safe to call from a spawner.
func coalesce(window time.Duration, publish func()) (trigger func()) {
	var armed atomic.Bool
	return func() {
		if !armed.CompareAndSwap(false, true) {
			return
		}
		time.AfterFunc(window, func() {
			// Disarmed before publishing, so a change landing during the read
			// arms the next publish rather than being lost behind this one.
			armed.Store(false)
			publish()
		})
	}
}

// publishProcesses sends the current project's process inventory to its viewers.
func (s *Server) publishProcesses() {
	s.viewerSendToAll(processesChangedFrame{
		Type:      frameProcessesChanged,
		Processes: ops.ListProcesses(s.ProjectPath()),
	})
}
