//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/providers/claudecode"
	"juggler/cmd/juggler/providers/provider"
	"juggler/cmd/juggler/server"
	jugglertest "juggler/cmd/juggler/testing"
	"juggler/internal/httpx"
	"juggler/internal/jlog"
	"juggler/internal/logpaths"
)

// loadConfig determines the project path (from --project, cwd, or none) and
// loads .juggler/config.json from it. If no project is selected (window-mode
// launch with no --project), the app starts in no-project mode using a
// default in-memory config; the user picks a project later via the UI.
// Runs before logging is initialised, so failures go to stderr directly.
func (a *App) loadConfig() error {
	projectPath, err := a.resolveStartupProject()
	if err != nil {
		fatal("%v", err)
		return err
	}
	a.projectPath = projectPath

	if projectPath == "" {
		fmt.Fprintln(a.startupOut(), "📋 Starting in no-project mode (open a project from the UI)")
		a.cfg = core.DefaultConfig()
		return nil
	}

	fmt.Fprintln(a.startupOut(), "📋 Loading configuration...")
	cfg, err := core.LoadConfig(projectPath)
	if err != nil {
		fatal("Failed to load config: %v", err)
		return err
	}
	a.cfg = cfg
	return nil
}

// resolveStartupProject returns the absolute project path to open at startup,
// or "" for no-project mode. Rules:
//   - --project <path> always wins; resolved to absolute and validated.
//   - else if launched with a controlling terminal: use cwd, UNLESS cwd is a
//     "silly" well-known location (home, Desktop, Documents, a system folder,
//     the filesystem root, …) with no existing .juggler/. Adopting such a cwd
//     would scatter a stray .juggler/ where the user doesn't expect one, so we
//     fall back to no-project mode and let them pick a folder in the UI.
//   - else (window/app launch with no flag): no-project mode.
func (a *App) resolveStartupProject() (string, error) {
	if a.flags.projectSet {
		raw := a.flags.project
		if raw == "" {
			return "", fmt.Errorf("--project requires a path")
		}
		abs, err := filepath.Abs(raw)
		if err != nil {
			return "", fmt.Errorf("--project: %w", err)
		}
		info, err := os.Stat(abs)
		if err != nil {
			return "", fmt.Errorf("--project %s: %w", abs, err)
		}
		if !info.IsDir() {
			return "", fmt.Errorf("--project %s: not a directory", abs)
		}
		return abs, nil
	}
	if a.flags.hasTerminal {
		wd, err := os.Getwd()
		if err != nil {
			return "", fmt.Errorf("failed to get current directory: %w", err)
		}
		// If a .juggler/ already exists here the user has deliberately used
		// juggler in this folder before, so honour it regardless of location.
		// Otherwise refuse to seed one in a well-known/system location.
		if !hasJugglerDir(wd) {
			home, _ := os.UserHomeDir()
			if core.IsUnsuitableProjectRoot(wd, home) {
				fmt.Fprintf(a.startupOut(), "ℹ️  %s looks like a system/home location; not creating a session here.\n", wd)
				return "", nil
			}
		}
		return wd, nil
	}
	return "", nil
}

// nonEmptyOr returns s, or fallback when s is empty.
func nonEmptyOr(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

// hasJugglerDir reports whether dir already contains a .juggler/ directory —
// the marker that juggler has been used in this folder before.
func hasJugglerDir(dir string) bool {
	info, err := os.Stat(filepath.Join(dir, ".juggler"))
	return err == nil && info.IsDir()
}

// initLogging brings up jlog according to config + --verbose, and registers
// jlog.Close as the last cleanup to run. The log file path is resolved centrally
// from the project by internal/logpaths (one process → one well-known file in
// the platform log dir), so a no-project/host launch — exactly the case that bricks
// silently on a fresh Windows double-click with no terminal to catch stderr —
// still leaves a diagnostic trail in host.log. An explicit --log-file overrides
// the derived path (used by the desktop app when it spawns servers).
func (a *App) initLogging() error {
	opts := jlog.Options{
		ConsoleLevel: jlog.LevelInfo,
		Colors:       true,
		Component:    "server",
		MaxSizeMB:    10,
		MaxBackups:   5,
	}
	if a.flags.verbose || (a.cfg != nil && a.cfg.IsVerboseEnabled()) {
		opts.ConsoleLevel = jlog.LevelDebug
	}
	if a.cfg != nil {
		opts.MaxSizeMB = a.cfg.Logging.MaxSizeMB
		opts.MaxBackups = a.cfg.Logging.MaxBackups
	}

	disabled := a.cfg != nil && a.cfg.Logging.Disabled
	switch {
	case disabled:
		// On-disk logging explicitly turned off: console only.
	case a.flags.logFileSet:
		opts.LogFilePath = a.flags.logFile
	default:
		opts.LogFilePath = logpaths.ServerLogPath(a.projectPath)
	}

	opts.HeaderExtra = map[string]string{
		"project": nonEmptyOr(a.projectPath, "(none)"),
		"gen":     nonEmptyOr(os.Getenv("JUGGLER_RELAUNCH_GEN"), "0"),
	}

	// With a file sink and no controlling terminal — an app- or icon-spawned
	// server — nothing watches stderr interactively, and a parent (the desktop
	// app) captures that stderr to a per-project crash file. Silencing the
	// console keeps every jlog line out of that crash file, leaving it to catch
	// only genuine panics / pre-init output. A direct terminal launch keeps its
	// console.
	if opts.LogFilePath != "" && !a.flags.hasTerminal {
		opts.DiscardConsole = true
	}

	jlog.Init(opts)
	a.pushCleanup(func() {
		jlog.Info("👋 Goodbye!")
		jlog.Close()
	})

	// Best-effort housekeeping: remove logs for projects (or old test runs)
	// that haven't been touched in a while, so the shared log directory doesn't
	// grow without bound. The active log keeps a current mtime and survives;
	// size rotation already bounds each live file, this bounds the dead ones.
	maxAge := logpaths.DefaultLogRetention
	if a.cfg != nil && a.cfg.Logging.MaxAgeDays != 0 {
		maxAge = time.Duration(a.cfg.Logging.MaxAgeDays) * 24 * time.Hour
	}
	if n := logpaths.SweepOldLogs(logpaths.LogDir(), maxAge, time.Now()); n > 0 {
		jlog.Debug("🧹 Removed %d stale log file(s) from %s", n, logpaths.LogDir())
	}
	return nil
}

// logProviders prints the discovered LLM providers (registered via blank
// imports in main.go).
func (a *App) logProviders() error {
	providers := provider.ListAvailableProviders()
	if len(providers) > 0 {
		jlog.Info("🔌 Available LLM providers: %s", strings.Join(providers, ", "))
	} else {
		jlog.Info("⚠️  No LLM providers available")
	}
	return nil
}

// initNetwork applies the saved proxy policy to the shared HTTP layer. Unlike
// the connectivity prefs (GUI-launch only), proxy settings apply on every launch
// — terminal included — and must be set before any provider client, model-list
// probe, or update check runs, hence this early phase. Test mode never reads a
// developer's real settings.json; there httpx keeps its env-based default (and
// loopback traffic bypasses the proxy regardless). A load failure is non-fatal:
// LoadGlobalSettings still returns normalised defaults (system) to apply.
func (a *App) initNetwork() error {
	if a.flags.testMode {
		return nil
	}
	gs, err := core.LoadGlobalSettings()
	if err != nil {
		jlog.Debug("Network: settings load failed, applying default proxy policy: %v", err)
	}
	httpx.SetConfig(httpx.Config{Mode: gs.Network.Proxy.Mode, URL: gs.Network.Proxy.URL})
	return nil
}

// initSession constructs the session store and manager. The manager spawns
// its own actor goroutine internally; Shutdown/cleanup of session state is
// handled by the server when it shuts down. In no-project mode, we still
// create a SessionManager (with empty projectPath) so the server has
// something to wire up; switching to a real project rebuilds it.
func (a *App) initSession() error {
	jlog.Info("💾 Creating session manager...")
	mgr, err := core.NewSessionManagerForPath(a.projectPath)
	if err != nil {
		jlog.Error("Failed to create session manager: %v", err)
		return err
	}
	a.session = mgr
	jlog.Info("✅ Session manager initialized")
	return nil
}

// initServer creates the HTTP server and binds its listening port. Shutdown
// (with a 10s timeout) is registered as a cleanup.
func (a *App) initServer() error {
	jlog.Info("🌐 Starting HTTP server...")

	port := a.cfg.Server.Port
	if a.flags.portSet {
		port = a.flags.port
	}

	// Assets-from-disk may also be enabled via config.json (not just the flag,
	// which is guarded earlier in Run). Reject it here too if no source checkout
	// is present, so the failure is the same clear message rather than a cryptic
	// template-load error deep inside server.New.
	assetsFromDisk := a.assetsFromDiskEnabled()
	if assetsFromDisk && !assetsFromDiskAvailable() {
		jlog.Error("%s", assetsFromDiskUnavailableMsg)
		return fmt.Errorf("assets-from-disk requested but no source checkout found")
	}

	srv, err := server.New(server.Config{
		SessionManager: a.session,
		Host:           a.cfg.Server.Host,
		Port:           port,
		DevMode:        a.devModeEnabled(),
		AssetsFromDisk: assetsFromDisk,
		ProjectPath:    a.projectPath,
		BootLock:       a.lock,
		ExtraRoutes:    a.config.ExtraRoutes,
		ExitWithParent: a.flags.exitWithParent,
	})
	if err != nil {
		jlog.Error("Failed to create server: %v", err)
		return err
	}
	a.server = srv
	// claudecode learns each model's true context window only from the CLI's
	// first result event; rebroadcast the provider list when it does so the UI's
	// context gauge fills in (it stays blank until then rather than guessing).
	claudecode.SetModelInfoChangedHook(srv.RefreshProviders)
	a.pushCleanup(func() {
		ctx, cancel := context.WithTimeout(context.Background(), serverShutdownTimeout)
		defer cancel()
		if err := srv.Shutdown(ctx); err != nil {
			jlog.Error("Shutdown error: %v", err)
		}
	})
	if err := srv.BindPort(); err != nil {
		jlog.Error("Failed to bind port: %v", err)
		return err
	}

	// Start MCP discovery at the first point the project is known, so servers are
	// connecting while the engine boots. Deferred to the engine's first request
	// instead, the turn that asks for the tool list is the one that starts
	// discovery, and it ships without a single MCP tool.
	srv.StartMCP()

	// Record the address we actually bound to so discovery clients (the test
	// harness via stdout, a desktop app that spawned us as a subprocess, a peer
	// reading instance.json) all see the real port — findAvailablePort may have
	// moved past a busy one. The stdout line is the spawn-time channel; the lock
	// file is the discover-an-already-running-instance channel.
	fmt.Fprintf(a.startupOut(), "JUGGLER_ADDR=%s\n", srv.GetAddr())
	if a.lock != nil {
		if host, portStr, err := net.SplitHostPort(srv.GetAddr()); err == nil {
			if port, err := strconv.Atoi(portStr); err == nil {
				if err := a.lock.UpdateAddr(host, port); err != nil {
					jlog.Error("Failed to update instance lock address: %v", err)
				}
			}
		}
	}

	// Read launch-time connectivity prefs once (read-only at boot). Only a
	// GUI/desktop-app launch honours them; a terminal launch uses CLI flags and
	// test mode must never read a developer's real settings.json — isGUILaunch is
	// false in both cases, so we skip the read and leave the zero value (no
	// LAN/WAN on launch).
	if a.isGUILaunch() {
		if gs, err := core.LoadGlobalSettings(); err != nil {
			jlog.Debug("Connectivity: settings load failed, ignoring launch prefs: %v", err)
		} else {
			a.connectivity = gs.Connectivity
		}
	}

	if a.resolveLANDefault() {
		srv.SetPublicMode(true)
	}

	if a.flags.testMode {
		jugglerRoot, err := server.FindProjectRoot(a.projectPath)
		if err != nil {
			jlog.Error("Failed to find project root for test routes: %v", err)
			return err
		}
		srv.RegisterTestRoutes(jugglertest.NewTestService(jugglerRoot, a.session))
	}

	return nil
}

// initEngineWatcher launches a goroutine that waits for the engine WebSocket
// client (loaded in the dedicated hidden engine WebviewWindow) to connect,
// then fires the interactive banner and starts file watchers. Non-blocking:
// the wait happens in the background while the Wails event loop is starting
// up.
func (a *App) initEngineWatcher() error {
	go func() {
		if !a.server.WaitForEngineConnected(engineConnectTimeout) {
			// The engine WebView failed to come up. No external browser can stand
			// in for it (the engine WS role is loopback-only), so the server is
			// permanently unable to run tools — startEngine is concurrently tearing
			// the process down for exactly this reason. Just stop here; don't start
			// watchers or the banner on a server that's on its way out.
			jlog.Error("Engine did not connect within %v — server is shutting down", engineConnectTimeout)
			return
		}
		// The interactive banner offers keys nobody is there to press.
		if a.flags.oneShot == nil {
			a.printInteractiveBanner()
		}
		a.server.StartBackgroundServices()
	}()
	return nil
}

// serve spawns the HTTP server's Serve goroutine. Errors are routed to
// serverErrChan so the wait loop can react to them.
func (a *App) serve() error {
	a.serverErrChan = make(chan error, 1)
	go func() { a.serverErrChan <- a.server.Serve() }()
	return nil
}

// printInteractiveBanner shows the session info box with TTY-aware hints,
// then any active LAN/tunnel status. WAN toggle hints come from the
// tunnel-mode registry — a build with no registered modes lists none.
func (a *App) printInteractiveBanner() {
	lines := []string{""}
	if !a.flags.window {
		lines = append(lines, "Type 'w' + Enter  -  Open a native window")
	}
	lines = append(lines,
		"Type 'b' + Enter  -  Open this URL in your default browser",
		"Type 'p' + Enter  -  Enable/disable LAN access",
	)
	for _, spec := range server.TunnelModes() {
		if spec.ToggleKey != "" && spec.ToggleHelp != "" {
			lines = append(lines, fmt.Sprintf("Type '%s' + Enter  -  %s", spec.ToggleKey, spec.ToggleHelp))
		}
	}
	lines = append(lines, "", "Ctrl+C  - Quit")
	a.server.PrintSessionInfo(lines...)
	if a.server.IsPublicMode() {
		a.server.PrintLANStatus(true)
	}
}
