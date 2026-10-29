//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"context"
	"errors"
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
	"juggler/internal/srcroot"
)

// loadConfig determines the project path (from --project or cwd) and loads
// .juggler/config.json from it. A launch that serves in this process serves
// one project, so finding none is fatal: another folder is another session,
// opened from the machine server's sessions page.
// Runs before logging is initialised, so failures go to stderr directly.
func (a *App) loadConfig() error {
	projectPath, err := a.resolveStartupProject()
	if err == nil && projectPath == "" {
		err = errors.New("no project folder: pass --project <folder>, or run juggler from a project folder")
	}
	if err != nil {
		fatal("%v", err)
		return err
	}
	a.projectPath = projectPath

	fmt.Println("📋 Loading configuration...")
	cfg, err := core.LoadConfig(projectPath)
	if err != nil {
		fatal("Failed to load config: %v", err)
		return err
	}
	a.cfg = cfg
	return nil
}

// resolveStartupProject returns the absolute project path to open at startup,
// or "" for none. Rules:
//   - --project <path> always wins; resolved to absolute and validated.
//   - else if launched with a controlling terminal: use cwd, UNLESS cwd is a
//     "silly" well-known location (home, Desktop, Documents, a system folder,
//     the filesystem root, …) with no existing .juggler/. Adopting such a cwd
//     would scatter a stray .juggler/ where the user doesn't expect one, so
//     there is none.
//   - else (no terminal and no flag): none.
//
// The cwd rule is bare juggler's (runBare); a session child and the test
// harness are always given --project.
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
				fmt.Printf("ℹ️  %s looks like a system/home location; not creating a session here.\n", wd)
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
// the platform log dir). An explicit --log-file overrides the derived path (the
// machine server passes one to each session child it spawns).
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

	// With a file sink and no controlling terminal — a session child — nothing
	// watches stderr interactively, and its parent (the machine server) captures
	// that stderr to a per-project crash file. Silencing the
	// console keeps every jlog line out of that crash file, leaving it to catch
	// only genuine panics / pre-init output. A direct terminal launch keeps its
	// console.
	if opts.LogFilePath != "" && !a.flags.hasTerminal {
		opts.DiscardConsole = true
	}

	jlog.Init(opts)
	if pathRepairReport != "" {
		jlog.Info("[path] %s", pathRepairReport)
	}
	a.pushCleanup(func() {
		// Only a session that started can end. This cleanup is registered
		// before the phases that can fail, so on an aborted launch it is the
		// last thing printed — and a sign-off in that position reads as a
		// completed run, burying the reason the run never began.
		if !a.startupFailed {
			jlog.Info("👋 Goodbye!")
		}
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

// initNetwork applies the saved proxy policy to the shared HTTP layer. It must
// be set before any provider client, model-list probe, or update check runs,
// hence this early phase. Test mode never reads a
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
// handled by the server when it shuts down.
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
		IngressSecret:  a.spawner.ingressSecret,
		APIToken:       a.spawner.apiToken,
		Supervisor:     a.spawner.supervisor,
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

	// Tell the spawner (the machine server, `juggler run` or the test harness)
	// the address actually bound — findAvailablePort may have moved past the
	// one asked for — and record it in instance.json beside the lock
	// (InstanceLock.UpdateAddr).
	fmt.Printf("JUGGLER_ADDR=%s\n", srv.GetAddr())
	if a.lock != nil {
		if host, portStr, err := net.SplitHostPort(srv.GetAddr()); err == nil {
			if port, err := strconv.Atoi(portStr); err == nil {
				if err := a.lock.UpdateAddr(host, port); err != nil {
					jlog.Error("Failed to update instance lock address: %v", err)
				}
			}
		}
	}

	if a.flags.testMode {
		jugglerRoot, err := srcroot.Find(a.projectPath)
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
		// Waits as long as startEngineHost does, so this never calls a startup
		// failed that the host is still recovering from.
		if !a.server.WaitForEngineConnected(engineStartupTimeout) {
			// The engine WebView failed to come up. No external browser can stand
			// in for it (the engine WS role is loopback-only), so the server is
			// permanently unable to run tools — startEngine is concurrently tearing
			// the process down for exactly this reason. Just stop here; don't start
			// watchers or the banner on a server that's on its way out.
			jlog.Error("Engine did not connect within %v — server is shutting down", engineStartupTimeout)
			return
		}
		a.server.PrintSessionInfo()
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
