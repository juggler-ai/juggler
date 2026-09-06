//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"fmt"
	"os"
	"sync"
	"sync/atomic"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/server"
)

// appFlags holds the CLI flags parsed by main.
type appFlags struct {
	verbose        bool // -v/--verbose: console log level → Debug
	dev            bool // --dev: enable the web inspector / right-click menu (no source checkout needed)
	assetsFromDisk bool // --assets-from-disk: serve web/ from disk, no cache, reload templates per request (implies dev)
	killExisting   bool // --kill-existing: on lock collision, kill the holder instead of prompting
	window         bool
	project        string              // explicit --project value (raw, may be relative)
	projectSet     bool                // true if --project was passed
	hasTerminal    bool                // true if launched with a controlling TTY
	port           int                 // --port overrides config port (0 = OS-assigned)
	portSet        bool                // true if --port was passed (allows --port 0 = OS-assigned)
	testMode       bool                // --test enables test API routes and prints JUGGLER_ADDR
	testIframes    int                 // --test-iframes N: open viewer at /test-pool?n=N (tiled iframe lanes)
	public         bool                // --public: open LAN access on startup
	publicSet      bool                // true if --public was passed (an explicit value overrides the direct-terminal LAN default)
	startupWAN     []server.TunnelMode // WAN tunnel modes whose startup flag was passed, in registration order (flags are registered per tunnel-mode spec)
	sessionChild   bool                // --session-child: supervised child of a machine server (`juggler serve`); refuses lock contention instead of prompting
	exitWithParent bool                // --exit-with-parent: self-terminate if the parent process dies (set by juggler-app for servers it owns)
	logFile        string              // --log-file: explicit log file path, overriding the centrally-derived one (set by juggler-app per spawned server)
	logFileSet     bool                // true if --log-file was passed
	oneShot        *oneShotOptions     // `juggler run`: the prompt to run unattended, and how to report it (nil for every other launch)
}

// App owns the startup phases, the resources they allocate, and the LIFO
// teardown stack that releases them. Each phase method on *App is responsible
// for registering its own cleanup before returning, so Run's deferred
// runCleanups handles every shutdown path uniformly.
type App struct {
	flags       appFlags
	config      Config // distribution extension points (see Run)
	projectPath string
	cfg         *core.Config
	lock        *core.InstanceLock
	session     *core.SessionManager
	server      *server.Server

	// connectivity holds launch-time LAN/WAN preferences, read once from the
	// global settings at boot (see initServer). Populated only on a GUI launch;
	// the zero value (no LAN, no WAN) is what a terminal or test launch uses, so
	// the saved toggles never affect those launches.
	connectivity core.ConnectivitySettings

	serverErrChan chan error
	cleanups      []func()

	// exitCode is the status the process leaves with. Written by `juggler run`
	// from its own goroutine and read on the shutdown path, so it is atomic
	// rather than a plain field. Zero for every other launch.
	exitCode atomic.Int32

	// exitProcess terminates the process, for the launches that must choose their
	// own status rather than inherit the native quit's. Nil outside tests, which
	// substitute it to observe the status instead of being killed by it.
	exitProcess func(int)

	// cleanupOnce gates the teardown stack so it runs exactly once no matter
	// which shutdown path gets there first.
	cleanupOnce sync.Once
}

// Run executes startup phases in order, then blocks in waitForExit until a
// shutdown trigger fires. All allocated resources are released by the deferred
// cleanup walk, regardless of how Run exits.
func (a *App) Run() error {
	defer a.runCleanups()

	phases := a.startupPhases()
	for _, p := range phases {
		if err := p.fn(); err != nil {
			return fmt.Errorf("%s: %w", p.name, err)
		}
	}

	a.waitForExit()
	return nil
}

// startupPhases returns the phases run by Run() in order.
func (a *App) startupPhases() []struct {
	name string
	fn   func() error
} {
	phases := []struct {
		name string
		fn   func() error
	}{
		{"config", a.loadConfig},
		{"logging", a.initLogging},
		{"instance lock", a.acquireInstance},
		{"network", a.initNetwork},
		{"providers", a.logProviders},
		{"session", a.initSession},
		{"server", a.initServer},
		{"serve", a.serve},
		{"engine watcher", a.initEngineWatcher},
	}
	// `juggler run` adds the phase that drives it. Last, because it needs the
	// server it talks to and the engine host the wait loop is about to start.
	if a.flags.oneShot != nil {
		phases = append(phases, struct {
			name string
			fn   func() error
		}{"one-shot", a.startOneShot})
	}
	return phases
}

// assetsFromDiskEnabled reports whether web assets should be served from the
// on-disk web/ tree (live-reload). Driven by --assets-from-disk or the config
// equivalent; requires a source checkout (see assetsFromDiskAvailable).
func (a *App) assetsFromDiskEnabled() bool {
	return a.flags.assetsFromDisk || a.cfg.IsAssetsFromDiskEnabled()
}

// devModeEnabled reports whether front-end dev mode (web inspector / right-click
// menu) should be on. Enabled by --dev directly, and implied by assets-from-disk
// since serving from disk is inherently a developer workflow.
func (a *App) devModeEnabled() bool {
	return a.flags.dev || a.assetsFromDiskEnabled()
}

// pushCleanup registers a teardown function. Cleanups run in LIFO order.
func (a *App) pushCleanup(fn func()) {
	a.cleanups = append(a.cleanups, fn)
}

// runCleanups releases everything the startup phases allocated, LIFO. Driven
// from two places — beginShutdown on the quit path and Run's defer — so it is
// gated to run exactly once: these cleanups shut the server down and release
// the instance lock, and a second pass would tear down a second time.
func (a *App) runCleanups() {
	a.cleanupOnce.Do(func() {
		for i := len(a.cleanups) - 1; i >= 0; i-- {
			a.cleanups[i]()
		}
	})
}

// releaseResources gives back everything this process holds: any WAN tunnel,
// then the teardown stack (server shutdown, provider subprocesses, the instance
// lock). Every exit path that owns those resources goes through it, and it is
// safe to call more than once — StopTunnel is a no-op with no tunnel up and
// runCleanups is gated.
func (a *App) releaseResources() {
	if a.server != nil {
		a.server.StopTunnel()
	}
	a.runCleanups()
}

// beginShutdown releases our own resources, then hands control to the native
// application's quit.
//
// The ordering is load-bearing: on macOS quitNative is [NSApp terminate:],
// which ends the process without unwinding, so Run's deferred runCleanups is
// never reached. Anything left to that defer is simply never released — the
// server is never shut down, cached conversations are never closed, and every
// provider subprocess (notably the claude CLI, which is in its own process
// group and so does not even receive the terminal's Ctrl-C) is orphaned,
// carrying on with a control channel that no longer has anyone on the other
// end. Teardown must therefore be complete before quitNative is called.
//
// The same property decides where a run reports its status. `juggler run` owns
// the process's exit code, but the only statement that reads it is Run's caller
// — unreachable through a quit that never unwinds, which would report the
// native quit's own success instead and call every failed, parked or timed-out
// run a success. So a run leaves here, where teardown above is complete and the
// status is still ours to set.
func (a *App) beginShutdown(quitNative func()) {
	a.releaseResources()
	if a.flags.oneShot != nil {
		a.exit(int(a.exitCode.Load()))
		return
	}
	quitNative()
}

// exit ends the process. Indirected so the shutdown tests can watch the status
// go by instead of terminating the test binary; a nil exitProcess is os.Exit.
func (a *App) exit(code int) {
	if a.exitProcess != nil {
		a.exitProcess(code)
		return
	}
	os.Exit(code)
}

// fatal prints to stderr. Used only by phases that run before jlog.Init —
// after logging is up, phases use jlog.Error and return error instead.
func fatal(format string, args ...any) {
	fmt.Fprintf(os.Stderr, "❌ "+format+"\n", args...)
}
