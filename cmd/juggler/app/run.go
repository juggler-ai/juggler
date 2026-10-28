//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Package app is the importable entrypoint for the juggler server binary.
// The public cmd/juggler main is a thin shim over Run(Config{}); a wrapping
// distribution builds its own main that passes a Config carrying its extension
// points (asset overlay, extra routes) and performs its own registrations
// (ops.Register, registry.RegisterProvider) before calling Run. Everything
// else about startup — flags, phases, teardown — is identical between the two.
package app

import (
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/gorilla/mux"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/extconfig"
	"juggler/cmd/juggler/machineserver"
	"juggler/cmd/juggler/mcp"
	"juggler/cmd/juggler/ops"
	"juggler/cmd/juggler/providers/acp"
	"juggler/cmd/juggler/providers/builtin"
	"juggler/cmd/juggler/providers/customprovider"
	"juggler/cmd/juggler/providers/streamidle"
	"juggler/internal/enginehost"
	"juggler/internal/ingress"
	"juggler/internal/srcroot"
	"juggler/internal/webviewenv"
	"juggler/web"
)

// Config carries the optional extension points a wrapping distribution injects
// into the server. The zero value is the stock public binary. Pro-style
// add-ons register through these seams and through the public registries —
// they never edit files in this repository (see the additive-only contract in
// LICENSING.md).
type Config struct {
	// AssetOverlay, if set, is layered over the embedded web assets via
	// web.SetOverlay: lookups prefer the overlay, directory listings merge.
	// Extra extensions placed under extensions/<name>/ in the overlay are
	// discovered exactly like the built-in ones.
	AssetOverlay fs.FS
	// ExtraRoutes, if set, registers additional HTTP routes on the server's
	// router after the built-in ones (see server.Config.ExtraRoutes).
	ExtraRoutes func(r *mux.Router)
}

// Run executes the juggler server: CLI dispatch, flag parsing, registrations,
// then the App startup phases, blocking until shutdown. It returns the
// process exit code — the caller owns os.Exit so its own defers run.
func Run(cfg Config) int {
	// Developer CLI: `juggler ext …` is a self-contained tool (scaffold/link/add
	// an extension) that must NOT boot a server. Dispatch it before flag parsing
	// or the banner so it behaves like a plain command-line utility.
	if len(os.Args) > 1 && os.Args[1] == "ext" {
		return runExtCommand(os.Args[2:])
	}

	// `juggler doctor` prints the engine-host probe table (display, node, xvfb,
	// chosen mode) and exits, without booting a server — the first thing to run
	// when the engine won't start on a headless host. Like `ext`, dispatch it
	// before flag parsing and the banner so it behaves as a plain utility.
	if len(os.Args) > 1 && os.Args[1] == "doctor" {
		return runDoctor(os.Args[2:])
	}

	// `juggler serve` runs the machine server: a project-less supervisor that
	// spawns per-project session children and proxies clients to them. It has
	// its own small flag set and must not boot the engine/webview path, so
	// dispatch it before flag parsing like the other subcommands.
	if len(os.Args) > 1 && os.Args[1] == "serve" {
		return machineserver.RunCommand(os.Args[2:])
	}

	// `juggler server status|sessions|stop` and `juggler open <project>` are
	// clients of the machine server: they find it through server.json and
	// drive its control API. Only open starts one when none is running — this
	// binary's `serve --implicit`, detached — and neither boots a server in
	// this process.
	if len(os.Args) > 1 && (os.Args[1] == "server" || os.Args[1] == "open") {
		env := machineserver.CLIEnv{Stdout: os.Stdout, Stderr: os.Stderr, OpenBrowser: openInBrowser}
		if os.Args[1] == "server" {
			return machineserver.RunServerCommand(os.Args[2:], env)
		}
		if exe, err := os.Executable(); err == nil {
			env.Start = machineserver.DetachedStarter(exe)
		}
		return machineserver.RunOpenCommand(os.Args[2:], env)
	}

	// `juggler run "<prompt>"` runs one prompt to completion and exits with a
	// status. Unlike the subcommands above it needs the whole server — the
	// engine is what carries the run out — so it parses its own flags here and
	// then falls through into the ordinary startup with them (see one_shot.go).
	var oneShot *oneShotOptions
	if len(os.Args) > 1 && os.Args[1] == "run" {
		opts, code := parseOneShotFlags(os.Args[2:])
		if opts == nil {
			return code
		}
		oneShot = opts
	}

	// Determine terminal-vs-icon launch first, before anything writes to stdout.
	// On Windows an icon launch detaches the console Windows allocated for us as
	// a side effect (see launchedFromTerminal), so this must run early.
	hasTerminal := launchedFromTerminal()

	// A GUI launch inherits a stripped PATH that omits everything the user's
	// shell adds (Homebrew, version managers, ~/go/bin, ~/.local/bin, rustup,
	// …). Repair PATH before any child process (bash tool, git, the claude CLI)
	// is spawned so they resolve tools the same way a terminal launch would.
	// No-op for a terminal launch and on Windows.
	repairPathForGUILaunch(hasTerminal)

	var flags appFlags
	if oneShot != nil {
		flags = oneShot.appFlags(hasTerminal)
	} else {
		var version bool
		flags, version = parseFlags(hasTerminal)
		if version {
			fmt.Printf("juggler %s (commit: %s, built: %s)\n",
				core.Version, core.Commit, core.BuildDate)
			return 0
		}
		if why := flags.refusal(); why != "" {
			fmt.Fprintln(os.Stderr, why)
			return 2
		}
		// Bare juggler rides the machine server; only a launch marked as more
		// than that serves one project in this process (standaloneLaunch).
		if !flags.standaloneLaunch() {
			return runBare(flags)
		}
	}

	// When Node is unavailable, retain the established WebKit fallback: a
	// headless Linux host can bring up the hidden engine webview under Xvfb. Node
	// hosts skip this relaunch entirely so auto mode is not forced back onto GTK.
	if runtime.GOOS != "linux" || os.Getenv(enginehost.EnvVar) == "webview" || !probeNode().OK {
		if note := webviewenv.MaybeRelaunchUnderXvfb(); note != "" {
			fmt.Fprintln(os.Stderr, note)
		}
	}

	// --assets-from-disk is a developer flag that serves the web/ tree off disk;
	// a stock binary shipped on its own has no such tree. Fail fast and clearly
	// here rather than deep inside server startup with a cryptic template error.
	if flags.assetsFromDisk && !assetsFromDiskAvailable() {
		fmt.Fprintln(os.Stderr, assetsFromDiskUnavailableMsg)
		return 1
	}

	// Install the asset overlay before anything reads web.Files.
	if cfg.AssetOverlay != nil {
		web.SetOverlay(cfg.AssetOverlay)
	}

	ops.RegisterAll()
	mcp.Register()
	acp.RegisterOps()
	customprovider.RegisterOps()
	if err := extconfig.RegisterOps(); err != nil {
		fmt.Fprintf(os.Stderr, "failed to register extension config: %v\n", err)
		return 1
	}
	registerProviders()

	// Self-terminate if our parent dies, so a server spawned by juggler-app (or
	// the test harness) never outlives its owner. The app passes
	// --exit-with-parent; the test harness relies on --test. A machine-server
	// session child watches its parent only on Windows, where a server restart
	// is a new process and the child must notice the old one die; on unix the
	// supervisor owns child lifetime outright (and survives restart by re-exec,
	// keeping its PID).
	app := &App{flags: flags, config: cfg}
	// Every launch takes the ingress secret out of its environment, so no
	// process it spawns inherits it; only a session child has a supervisor to
	// keep it for. Taken here rather than earlier because the Xvfb relaunch
	// above must pass it on.
	if secret := ingress.TakeSecret(); flags.sessionChild {
		app.ingressSecret = secret
	}
	// A run that never reports has not finished, whatever else brought the
	// process down — a Ctrl-C, an engine that never started, a server error. So
	// failure is where a run starts, and only its own report lowers it.
	if oneShot != nil {
		app.exitCode.Store(exitRunFailed)
	}
	if flags.testMode || flags.exitWithParent || (flags.sessionChild && runtime.GOOS == "windows") {
		startParentWatchdog(app.releaseResources)
	}

	// The banner is for a person watching a server start. A run has no such
	// audience, and its stdout is the answer.
	if oneShot == nil {
		printBanner()
	}

	// Neither return below is reached when the launch owns the native app:
	// beginShutdown calls app.Quit(), and [NSApp terminate:] ends the process
	// without unwinding the stack. A one-shot run therefore exits from inside
	// beginShutdown via a.exit(...), and App.exitProcess is the seam tests
	// replace to observe the status. These returns serve the paths that do
	// unwind, so a status set here must also be set on the exit path above.
	if err := app.Run(); err != nil {
		reportStartupFailure(os.Stderr, err)
		return 1
	}
	return int(app.exitCode.Load())
}

// reportStartupFailure explains a launch that never got off the ground.
//
// The status code alone is not an explanation. Nothing between the failing
// phase and here prints the error, and the logging cleanup runs on the way out,
// so without this a startup failure reaches the terminal as a banner, silence,
// and an exit — indistinguishable from a session that ran and ended. A held
// project lock gets its recovery advice too, since that is the failure a person
// can actually do something about.
//
// The line it prints is also how the desktop app learns why a server it spawned
// never came up (core.StartupFailurePrefix), so its shape is a contract.
func reportStartupFailure(w io.Writer, err error) {
	fmt.Fprintf(w, "\n%s%v\n", core.StartupFailurePrefix, err)

	var locked *core.ProjectLockedError
	if errors.As(err, &locked) {
		fmt.Fprintf(w, "\n%s\n", locked.Advice())
	}
}

// registerProviders registers every built-in provider with the global registry.
// Called once at startup. Tests that want a subset compose their own calls.
func registerProviders() {
	builtin.Register()

	// The user's own named endpoints, read from their definitions file. They
	// register here, alongside the built-ins and ahead of every credential
	// reader, because a provider's key is resolved through the ConfigKeyName its
	// registration carries. Later edits re-register through customprovider.Sync.
	customprovider.RegisterAll()

	// Not a provider: install the resolver for the user-configurable stream
	// idle timeout so every provider's watchdog reads the setting live.
	streamidle.Register()
}

// startParentWatchdog releases resources and self-terminates the process if the
// parent dies — e.g. the juggler-app desktop process that spawned this server
// quit or crashed, or the test harness was SIGKILL'd before it could signal the
// pool. This is what makes a spawned server never outlive its owner. The actual
// wait is platform-specific (waitParentExit): macOS/Linux poll PPID (no
// Pdeathsig wired here); Windows waits on the parent's process handle, since
// Windows never reparents an orphan so PPID polling there would never fire.
//
// release is the teardown this exit path owes: see onParentGone.
func startParentWatchdog(release func()) {
	startPPID := os.Getppid()
	if startPPID <= 1 {
		return
	}
	go func() {
		waitParentExit(startPPID)
		onParentGone(release, quitGraceTimeout, os.Exit)
	}()
}

// onParentGone releases this process's resources, then terminates.
//
// The release is not optional housekeeping: os.Exit runs no deferred cleanup,
// and the server owns provider subprocesses that outlive it by default (the
// claude CLI sits in its own process group, so it does not even receive the
// signals its owner does). Skipping teardown here left one orphan per live
// conversation every time the desktop app quit.
//
// It is bounded, because the watchdog's contract is that a spawned server never
// outlives its owner: a teardown that hangs must not be able to keep us alive.
func onParentGone(release func(), limit time.Duration, exit func(int)) {
	fmt.Fprintln(os.Stderr, "parent gone — self-terminating")
	if release != nil {
		released := make(chan struct{})
		go func() {
			defer close(released)
			release()
		}()
		select {
		case <-released:
		case <-time.After(limit):
			fmt.Fprintf(os.Stderr, "teardown did not finish within %v — exiting anyway\n", limit)
		}
	}
	exit(0)
}

func parseFlags(hasTerminal bool) (appFlags, bool) {
	verbose := flag.Bool("verbose", false, "Verbose logging (debug level)")
	flag.BoolVar(verbose, "v", false, "Verbose logging (debug level) (shorthand)")
	dev := flag.Bool("dev", false, "Enable dev mode: the web inspector and full right-click menu (no source checkout required)")
	assetsFromDisk := flag.Bool("assets-from-disk", false, "Developer flag: serve web assets from the on-disk web/ tree (requires a source checkout) instead of the embedded FS, disabling caching and reloading templates per request; implies --dev")
	version := flag.Bool("version", false, "Print version and exit")
	window := flag.Bool("window", false, "Open the desktop app on this server (with --test: its debug lane)")
	project := flag.String("project", "", "Project folder to open (defaults to the current folder when run from a terminal)")
	port := flag.Int("port", 0, "Port for the Juggler server, when this starts it (0 = OS-assigned)")
	testMode := flag.Bool("test", false, "Enable test API routes and print JUGGLER_ADDR to stdout")
	testIframes := flag.Int("test-iframes", 0, "Test-mode only: open the viewer window at /test-pool?n=N (tiled iframes acting as parallel test lanes) instead of the production UI")
	testWindowURL := flag.String("test-window-url", "", "Test-mode only: the URL the test window loads instead of this server's own (set by `juggler serve --test` to the session's proxied URL)")
	var allowHosts []string
	flag.Func("allow-host", "Also accept requests for `name`: the name a reverse proxy on this machine (tailscale serve, caddy) serves Juggler under. Its callers count as remote. Repeatable; only name a host whose DNS you control", func(v string) error {
		allowHosts = append(allowHosts, v)
		return nil
	})
	flag.Func("updates-managed-by", "For packagers: the package manager (`name`, e.g. Nix) that installs Juggler's updates. Juggler then never updates itself, and points its update notices there. Same as setting "+core.UpdatesManagedByEnv, core.SetUpdatesManagedBy)
	// Retired flags stay registered, hidden, so a launch that passes one is
	// told why it no longer applies (refusal) rather than that it is unknown.
	for _, name := range retiredFlagNames() {
		flag.Bool(name, false, "")
	}
	standalone := flag.Bool("standalone", false, "Serve the project in this process rather than on the machine server (tests and developer runs)")
	sessionChild := flag.Bool("session-child", false, "Run as a machine-server session child (spawned by `juggler serve`; not a user-facing mode)")
	exitWithParent := flag.Bool("exit-with-parent", false, "Self-terminate if the parent process dies (set by juggler-app for servers it owns, so they never outlive the app)")
	logFile := flag.String("log-file", "", "Explicit log file path, overriding the centrally-derived per-platform log path (set by juggler-app per spawned server)")
	flag.Usage = usage
	flag.Parse()

	projectSet := false
	portSet := false
	logFileSet := false
	var retired []string
	flag.Visit(func(f *flag.Flag) {
		switch {
		case f.Name == "project":
			projectSet = true
		case f.Name == "port":
			portSet = true
		case f.Name == "log-file":
			logFileSet = true
		case isRetiredFlag(f.Name):
			retired = append(retired, f.Name)
		}
	})
	// The server never opens a window on its own. The visible UI is the separate
	// juggler-app desktop process; this binary is the headless engine + server.
	// This is what stops the server impersonating the app on a Windows
	// double-click. hasTerminal still distinguishes a shell launch from an icon
	// launch for the project default (cwd vs none); see resolveStartupProject.

	return appFlags{
		verbose:        *verbose,
		dev:            *dev,
		assetsFromDisk: *assetsFromDisk,
		window:         *window,
		project:        *project,
		projectSet:     projectSet,
		hasTerminal:    hasTerminal,
		port:           *port,
		portSet:        portSet,
		testMode:       *testMode,
		testIframes:    *testIframes,
		testWindowURL:  *testWindowURL,
		allowHosts:     allowHosts,
		standalone:     *standalone,
		retired:        retired,
		sessionChild:   *sessionChild,
		exitWithParent: *exitWithParent,
		logFile:        *logFile,
		logFileSet:     logFileSet,
	}, *version
}

// hiddenFlags are registered and functional but omitted from --help: developer,
// test-harness, and internal flags an end user has no reason to set. Several are
// load-bearing (the test harness passes --test/--assets-from-disk; juggler-app
// passes --exit-with-parent/--log-file to servers it spawns), so they must keep
// working — they're just undocumented.
var hiddenFlags = map[string]bool{
	"window":           true,
	"standalone":       true,
	"assets-from-disk": true,
	"test":             true,
	"test-iframes":     true,
	"test-window-url":  true,
	"session-child":    true,
	"exit-with-parent": true,
	"log-file":         true,
}

// usage prints a curated --help listing: only the user-facing flags, formatted
// like flag.PrintDefaults. Hidden and retired flags are left out.
func usage() {
	out := flag.CommandLine.Output()
	fmt.Fprintf(out, "Juggler — AI code agent\n\nUsage: %s [options]\n\nOptions:\n", filepath.Base(os.Args[0]))
	flag.VisitAll(func(f *flag.Flag) {
		if hiddenFlags[f.Name] || isRetiredFlag(f.Name) {
			return
		}
		dash := "--"
		if len(f.Name) == 1 {
			dash = "-"
		}
		name, help := flag.UnquoteUsage(f)
		left := "  " + dash + f.Name
		if name != "" {
			left += " " + name
		}
		if f.DefValue != "" && f.DefValue != "false" && f.DefValue != "0" {
			help += fmt.Sprintf(" (default %q)", f.DefValue)
		}
		const col = 26
		if len(left) < col {
			left += strings.Repeat(" ", col-len(left))
		} else {
			left += "\n" + strings.Repeat(" ", col)
		}
		fmt.Fprintln(out, left+help)
	})
}

// assetsFromDiskAvailable reports whether a juggler source checkout (a directory
// tree containing web/) can be located, which --assets-from-disk requires.
func assetsFromDiskAvailable() bool {
	_, err := srcroot.Find("")
	return err == nil
}

// assetsFromDiskUnavailableMsg is shown when --assets-from-disk is requested but
// no source checkout is present — the usual case for a stock standalone binary.
const assetsFromDiskUnavailableMsg = "--assets-from-disk needs to run from a Juggler source checkout " +
	"(a directory tree containing web/), and this binary isn't inside one, so there are no on-disk assets to serve.\n" +
	"  • Remove --assets-from-disk to use the built-in assets.\n" +
	"  • Use --dev to open the web inspector without on-disk assets."

func printBanner() {
	fmt.Printf(`
    ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
    ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄
  ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██

  AI Code Agent • %s

`, core.Version)
}
