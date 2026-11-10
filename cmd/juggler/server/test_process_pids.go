//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !production

package server

import (
	"os"
	"path/filepath"
	"runtime/pprof"
	"sync/atomic"
	"time"

	"juggler/internal/jlog"
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
	// lanesHold reports whether a browser test queued on this server is not
	// yet finished with it (see testLanesHold). Installed by
	// RegisterTestRoutes; nil elsewhere.
	lanesHold atomic.Pointer[func() bool]
	// engineQuiet runs when an attached engine has been silent for half its
	// liveness window (see SetTestEngineQuiet). Installed by the test-pool
	// host; nil elsewhere.
	engineQuiet atomic.Pointer[func()]
	// engineQuietNoted is set while one quiet spell has been noted, so a spell
	// is sampled once; cleared when the engine is heard from again.
	engineQuietNoted atomic.Bool
}

// SetTestEngineQuiet installs what a test pool does when an attached engine
// has gone quiet for half its liveness window — while its socket is still open
// and before eviction changes anything: on macOS, sample the engine's WebKit
// processes, whose stacks are the only record of what a realm that stopped
// turning was doing. It runs on its own goroutine, so it may block.
func (s *Server) SetTestEngineQuiet(fn func()) {
	if fn == nil {
		s.testPool.engineQuiet.Store(nil)
		return
	}
	s.testPool.engineQuiet.Store(&fn)
}

// noteTestEngineQuiet is called on every supervision tick of a live engine,
// with whether it has been quiet for half its window. The first tick of a
// quiet spell dumps this server's goroutines beside its log — which says
// whether the engine went quiet or this server stopped reading it — then runs
// the hook SetTestEngineQuiet installed, if any.
func (s *Server) noteTestEngineQuiet(quiet bool) {
	if !quiet {
		s.testPool.engineQuietNoted.Store(false)
		return
	}
	if s.testPool.engineQuietNoted.Swap(true) {
		return
	}
	jlog.Info("[engine] quiet for %v", s.engineSilence().Round(time.Second))
	if logPath := jlog.FilePath(); logPath != "" {
		path := filepath.Join(filepath.Dir(logPath), "engine-quiet-"+time.Now().Format("20060102-150405")+"-goroutines.log")
		if f, err := os.Create(path); err == nil {
			_ = pprof.Lookup("goroutine").WriteTo(f, 2)
			_ = f.Close()
			jlog.Info("[engine] quiet-engine goroutine dump: %s", path)
		}
	}
	if fn := s.testPool.engineQuiet.Load(); fn != nil {
		go (*fn)()
	}
}

// testLanesHold reports whether a browser test queued on this server has yet
// to have its result read, which holds the session against retirement: the
// lane's window may still be loading, and nothing but the test's own progress
// says how long that takes.
func (s *Server) testLanesHold() bool {
	if fn := s.testPool.lanesHold.Load(); fn != nil {
		return (*fn)()
	}
	return false
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
// before the pool went quiet for the whole of quiet.
type LaneWait func(n int, quiet time.Duration) bool

// WaitForTestLanes reports whether n distinct lanes of this server's test pool
// have asked for work before the pool went quiet — no page served, no lane
// polling — for the whole of quiet. The app layer's pool window waits on it to
// tell a first load that hung from one that is running, however slowly. A
// server with no test routes has no lanes to wait for and reports true.
func (s *Server) WaitForTestLanes(n int, quiet time.Duration) bool {
	if fn := s.testPool.laneWait.Load(); fn != nil {
		return (*fn)(n, quiet)
	}
	return true
}
