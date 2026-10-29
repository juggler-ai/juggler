//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package server

import (
	"sync/atomic"
	"time"
)

// testPoolHooks is what a test pool installs on its server: the pool window
// (the app layer's window_testpool.go) and RegisterTestRoutes are its only
// writers and readers. A production build has no pool, and its testPoolHooks
// is empty (test_process_pids_production.go).
type testPoolHooks struct {
	// processPIDs lists the processes outside this server's tree that run its
	// pages (see SetTestProcessPIDs). Installed by the test-pool host; nil
	// elsewhere.
	processPIDs atomic.Pointer[ProcessPIDs]
	// laneWait waits for a test pool's lanes to ask for work (see
	// WaitForTestLanes). Installed by RegisterTestRoutes; nil elsewhere.
	laneWait atomic.Pointer[LaneWait]
}

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
		s.testPool.processPIDs.Store(nil)
		return
	}
	s.testPool.processPIDs.Store(&fn)
}

// LaneWait reports whether n distinct lanes of a test pool have asked for work
// within timeout.
type LaneWait func(n int, timeout time.Duration) bool

// WaitForTestLanes reports whether n distinct lanes of this server's test pool
// have asked for work within timeout. The app layer's pool window waits on it
// to tell a first load that hung from one that is running. A server with no
// test routes has no lanes to wait for and reports true.
func (s *Server) WaitForTestLanes(n int, timeout time.Duration) bool {
	if fn := s.testPool.laneWait.Load(); fn != nil {
		return (*fn)(n, timeout)
	}
	return true
}
