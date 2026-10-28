//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import "time"

// ProcessPIDs lists processes that do this server's work without being in its
// process tree. Installed by the app layer, which owns the web views.
type ProcessPIDs func() []int

// SetTestProcessPIDs installs the lister behind GET /api/test/process-pids.
//
// The browser harness's slow-core mode (JUGGLER_TEST_SLOW_CORE, see
// tests/integration/browser) slows a pool server by duty-cycling every process
// its tests run on. On Linux and Windows those are all descendants of the
// server. On macOS WebKit runs a page's web, network and GPU processes as XPC
// services, children of launchd, so only the server can say which ones are its
// own. Without that the harness would have to guess, and slow whatever else on
// the machine uses WebKit.
func (s *Server) SetTestProcessPIDs(fn ProcessPIDs) {
	if fn == nil {
		s.testProcessPIDs.Store(nil)
		return
	}
	s.testProcessPIDs.Store(&fn)
}

// LaneWait reports whether n distinct lanes of a test pool have asked for work
// within timeout.
type LaneWait func(n int, timeout time.Duration) bool

// WaitForTestLanes reports whether n distinct lanes of this server's test pool
// have asked for work within timeout. The app layer's pool window waits on it
// to tell a first load that hung from one that is running. A server with no
// test routes has no lanes to wait for and reports true.
func (s *Server) WaitForTestLanes(n int, timeout time.Duration) bool {
	if fn := s.testLaneWait.Load(); fn != nil {
		return (*fn)(n, timeout)
	}
	return true
}
