//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"sync"
	"time"
)

// attach counts a local client until its idempotent detach lets it go.
// A foreground terminal and a held POST /api/server/attach are local clients.
func (s *Server) attach() (detach func()) {
	s.attached.Add(1)
	var once sync.Once
	return func() {
		once.Do(func() {
			s.attached.Add(-1)
			s.shutdownIfUnheld()
		})
	}
}

// heldUp counts only local client processes, including the starter until that
// process attaches or dies. Network exposure, viewers and turns hold nothing.
func (s *Server) heldUp() bool {
	// Read the startup hold first: its transfer increments attached before
	// releasing starterGone, so a check sees at least one side of the hold.
	return (s.starter > 0 && !s.starterGone.Load()) || s.attached.Load() > 0
}

func (s *Server) shutdownIfUnheld() {
	if s.implicit && !s.heldUp() {
		s.requestShutdown()
	}
}

// check follows attachments and the starter's liveness on each server tick.
func (s *Server) check() {
	s.checkAttachments()
	s.expireUnavailable(time.Now())
	if s.starter > 0 && !s.starterGone.Load() && !processAlive(s.starter) {
		s.starterGone.Store(true)
	}
	s.shutdownIfUnheld()
}
