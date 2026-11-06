//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"sync/atomic"
	"time"

	"juggler/cmd/juggler/server"
	"juggler/internal/enginehost"
	"juggler/internal/jlog"
	"juggler/internal/webviewenv"

	"github.com/wailsapp/wails/v3/pkg/application"
	"github.com/wailsapp/wails/v3/pkg/events"
)

// engineConnectTimeout bounds how long the engine-readiness gate waits for the
// hidden engine WebView to load /engine and connect its WebSocket. Generous: a
// cold engine connects in ~1–2s at startup; this is the ceiling a turn waits
// before failing with engine-not-available (only ever relevant during the
// startup window or a watchdog re-exec, since the engine otherwise stays up).
const engineConnectTimeout = 30 * time.Second

// engineStartupTimeout is how long a reloaded engine may go without connecting
// or getting any further towards it before the server gives up on it and exits
// (startEngineHost). Giving up is for an engine that cannot come up at all, and
// all a longer span costs that one is the extra wait. A variable so tests can
// shrink it.
var engineStartupTimeout = 2 * time.Minute

// engineReloadAfter is how long a starting engine may go without connecting or
// getting any further before it is reloaded, once, in case its first load has
// wedged. The node host cannot reload in place, so for it this is where the
// server gives up (nodeHost.Recover). A variable so tests can shrink it.
var engineReloadAfter = engineConnectTimeout

// engineServer is what startEngineHost needs of the server.
type engineServer interface {
	GetAddr() string
	WaitForEngineConnected(timeout time.Duration) bool
	EngineBootProgressAt() time.Time
	SetEngineReadyGate(gate server.EngineReadyGate)
	SetEngineRecovery(fn server.EngineRecovery)
}

// engineURL is the engine page served at addr.
func engineURL(addr string) string { return "http://" + addr + "/engine" }

// reloadEngineWindow replaces the engine window's realm with a fresh one by
// navigating it to the engine page again. It does not use win.Reload(), because
// on Linux Wails implements that as a load of "wails://" instead of the current
// page. That would take the engine off /engine for good, and no engine would
// ever reconnect. A navigation to the page's own URL reloads it on every
// platform, and the navigation is driven from outside the page, so it works
// even when the page's own script has wedged. SetURL marshals itself to the
// main thread.
func reloadEngineWindow(win *application.WebviewWindow, addr string) {
	win.SetURL(engineURL(addr))
}

// newEngineWindow builds (but does not run) the hidden engine WebviewWindow. The
// engine page boots the worker-backed runtime (web/js/engine-worker-main.js):
// the engine's WebSocket and tool execution run in a module worker, off the
// WebView's main thread, so WebKit's hidden/accessory main-thread throttling
// can't stall them.
//
// KeepRunningWhenHidden is Disabled (WKInactiveSchedulingPolicyThrottle): the
// hidden page main thread is allowed to throttle, so WebKit never pins an
// always-on CVDisplayLink — the display link is the exact path WebKit deadlocks
// on across a display reconfiguration (monitor hot-plug, display sleep, scaling
// switch). The engine's real work lives in the module worker, which keeps
// processing at full rate regardless of the main thread's throttle state, so
// the engine can safely stay alive for the whole process lifetime.
//
// Windows takes the opposite setting for the opposite reason. WebView2 has no
// display-link hazard; what it has is efficiency mode, which a window created
// hidden falls into as soon as Wails hides its controller — and it throttles
// the whole page's timers toward 0Hz, module workers included, so the engine
// stops executing tools. KeepRunningWhenHidden keeps the controller visible to
// WebView2 (the window itself is never shown), at the cost of an invisible
// input surface where the window sits.
//
// WebviewGpuPolicyNever forces software rendering for this WebView on Linux
// (WebKitGTK). The engine page is off-screen and paints nothing — its work runs
// in a module worker — so it has no use for GPU acceleration. Left at the
// zero-value default (WebviewGpuPolicyAlways), WebKitGTK insists on the
// hardware path and, on a broken or absent GL stack (VM software GL, no DRI,
// headless), fails to bring the WebView up at all — the engine WebSocket never
// connects, engineConnectTimeout elapses, and tool execution never starts.
// Scoped to this window only: the visible viewer window is a separate window in
// the juggler-app process and keeps its own (accelerated) GPU policy.
func newEngineWindow(app *application.App, addr string) *application.WebviewWindow {
	return app.Window.NewWithOptions(application.WebviewWindowOptions{
		Name:   "juggler-engine",
		Title:  "Juggler Engine",
		URL:    engineURL(addr),
		Width:  200,
		Height: 150,
		Hidden: true,
		Mac: application.MacWindow{
			WebviewPreferences: application.MacWebviewPreferences{
				KeepRunningWhenHidden: application.Disabled,
			},
		},
		Windows: application.WindowsWindow{
			KeepRunningWhenHidden: true,
		},
		Linux: application.LinuxWindow{
			WebviewGpuPolicy: application.WebviewGpuPolicyNever,
		},
	})
}

// engineHost abstracts the runtime that hosts the agent engine. Whichever host
// is selected, the contract is identical: Start must lead to the engine
// connecting its WebSocket back to the server, after which readiness flows
// through that socket + /api/client/report — a path that is already
// host-agnostic. Selection is made by internal/enginehost.Choose (see
// selectEngineHost).
type engineHost interface {
	// Start launches the host so the engine connects to addr. It returns once
	// the host has been launched — NOT once the engine has connected, which is
	// gated separately via WaitForEngineConnected. A non-nil error means the
	// host could not be launched at all.
	Start(addr string) error
	// Describe returns a short label for the boot log line ("webview",
	// "node v22.3.0").
	Describe() string
	// Recover brings the engine back after its realm has stopped and closing the
	// socket did not bring it home. Called from the server's engine supervisor,
	// off the main thread, and only after the reconnect grace has lapsed — so it
	// may be expensive, but it must not block for long.
	Recover()
	// Stop takes the engine down as the server exits, so nothing of ours is
	// still dialling the address once the process is gone.
	Stop()
}

// webviewHost runs the engine inside the hidden WebKit/WebView2 webview — the
// original and default host. The window's throttling/GPU/sandbox semantics are
// the hard-won part and live unchanged in newEngineWindow.
//
// The window handle is kept, not discarded, because it is the only lever that
// can revive a realm that has stopped: the page must be reloaded to get a fresh
// worker. It is read from the supervisor goroutine, hence the atomic. addr is
// written before win is stored and read only after win is loaded, so the atomic
// covers it too.
type webviewHost struct {
	app  *application.App
	addr string
	win  atomic.Pointer[application.WebviewWindow]
}

// Describe implements engineHost.
func (h *webviewHost) Describe() string { return "webview" }

// Start builds and runs the hidden engine WebView. win.Run() must be called on
// the main (Wails) thread inside the ApplicationStarted callback.
func (h *webviewHost) Start(addr string) error {
	win := newEngineWindow(h.app, addr)

	// A renderer crash is the one engine death WebKit tells us about. It reloads
	// the page itself, so this changes no behaviour — it just stops the crash
	// being invisible, since the engine's console goes nowhere and the reloaded
	// page looks identical to one that never died. Registering a mac event is
	// inert on other platforms, where no such signal exists.
	win.OnWindowEvent(events.Mac.WebViewWebContentProcessDidTerminate, func(*application.WindowEvent) {
		jlog.Error("[engine] the engine's renderer process died; WebKit is reloading the page")
	})

	h.addr = addr
	h.win.Store(win)
	win.Run()
	return nil
}

// Recover reloads the engine page, which is what replaces a stopped realm: the
// reload re-runs engine-worker-main.js, spawning a fresh module worker that
// opens a new WebSocket. See reloadEngineWindow for how it reloads.
func (h *webviewHost) Recover() {
	win := h.win.Load()
	if win == nil {
		jlog.Error("[engine] cannot reload the engine WebView: no window handle")
		return
	}
	jlog.Info("[engine] reloading the engine WebView")
	reloadEngineWindow(win, h.addr)
}

// Stop is nothing to do for this host: the engine is a window in this process
// and goes when the process does, so there is no separate life to end.
func (h *webviewHost) Stop() {}

// startEngineHost brings up a selected engine host and installs the server's
// engine-readiness gate.
//
// The gate makes a turn (or a worker-driven strategy hook) wait until the engine
// is connected before it can emit tool requests. In steady state the engine is
// already connected and the gate returns immediately; it only ever blocks during
// the startup connect window or while a main-thread-watchdog re-exec is bringing
// a fresh image back up.
//
// The engine host is the entire reason a headless server exists: it is the only
// thing that executes tools, and its engine role is loopback-restricted, so no
// external browser can ever stand in for it (see websocket_loop.go). If it fails
// to come up — a broken GL stack, a WebKit crash, a wedged compositor, a node
// crash — the server can never do useful work, yet without this it would sit
// alive forever (holding its port and instance lock) as an invisible zombie. So
// an engine that has gone engineReloadAfter without connecting or getting any
// further (server.EngineBootProgressAt) is loaded again, and one that then goes
// engineStartupTimeout the same way gets requestQuit to tear the process down:
// a headless server whose host failed must die, not linger. Both spans are
// measured from the engine's last progress rather than from the start, because
// a boot's length is the machine's speed: a wall-time budget gives up on a
// healthy engine on a starved core, and a wall-time reload restarts the boot it
// interrupts.
func startEngineHost(host engineHost, srv engineServer, requestQuit func()) {
	start := time.Now()
	jlog.Info("[engine] START — bringing up %s host", host.Describe())
	if err := host.Start(srv.GetAddr()); err != nil {
		jlog.Error("[engine] %s host failed to start: %v", host.Describe(), err)
		requestQuit()
		return
	}
	reloadAfter, budget := engineReloadAfter, engineStartupTimeout
	go func() {
		var reloaded time.Time
		for {
			// Quiet since the start, the reload, or the engine's last step
			// further, whichever came last.
			quietSince := start
			for _, t := range []time.Time{reloaded, srv.EngineBootProgressAt()} {
				if t.After(quietSince) {
					quietSince = t
				}
			}
			limit := budget
			if reloaded.IsZero() {
				limit = reloadAfter
			}
			quiet := time.Since(quietSince)
			if quiet < limit {
				if srv.WaitForEngineConnected(limit - quiet) {
					jlog.Info("[engine] connected in %v", time.Since(start).Round(time.Millisecond))
					return
				}
				continue
			}
			if !reloaded.IsZero() {
				break
			}
			jlog.Info("[engine] the %s host has made no progress for %v; loading it again (giving up after %v more without any)",
				host.Describe(), reloadAfter, budget)
			host.Recover()
			reloaded = time.Now()
		}
		// The engine host never came up (missing webview runtime, no display, a
		// wedged compositor, a WebKit crash, a node process that died…). This is
		// the catch-all for every host and every cause preflight can't detect up
		// front: print the per-OS remediation, then tear the process down so a
		// headless server whose host failed can't linger as a useless zombie
		// holding its port.
		jlog.Error("[engine] %s", engineUnavailableMessage(
			fmt.Sprintf("the hidden engine %s made no progress towards initialising for %v", host.Describe(), budget)))
		requestQuit()
	}()
	srv.SetEngineReadyGate(func() bool { return srv.WaitForEngineConnected(engineConnectTimeout) })

	// Hand the server the lever for the failure its own supervisor can detect but
	// not repair: an engine whose realm has stopped answering and which did not
	// come back when its socket was closed. Without this, recovery ends at
	// eviction and a dead realm stays dead until the user restarts the app.
	srv.SetEngineRecovery(host.Recover)
}

type selectedEngineHost struct {
	mode   enginehost.Mode
	reason string
	node   enginehost.NodeInfo
}

func engineHostRequiresNativeApp(mode enginehost.Mode) bool {
	return mode != enginehost.ModeNode
}

// selectEngineHost resolves and preflights the engine runtime without creating
// any native application objects. Linux Node mode can therefore be selected
// before GTK is initialized.
func selectEngineHost() (selectedEngineHost, bool) {
	var cached *enginehost.NodeInfo
	probe := func() enginehost.NodeInfo {
		if cached == nil {
			info := probeNode()
			cached = &info
		}
		return *cached
	}

	mode, reason, err := enginehost.Choose(runtime.GOOS, os.Getenv, probe, displayPresent(runtime.GOOS))
	if err != nil {
		jlog.Error("[engine] %s", err)
		return selectedEngineHost{}, false
	}
	selected := selectedEngineHost{mode: mode, reason: reason}
	if mode == enginehost.ModeNode {
		selected.node = probe()
		if !selected.node.OK {
			jlog.Error("[engine] node host unavailable: %s", selected.node.Problem)
			return selectedEngineHost{}, false
		}
	} else {
		if note := webviewenv.PrepareLinuxWebKit(); note != "" {
			jlog.Info("[engine] %s", note)
		}
		if problem := webviewenv.Preflight(); problem != "" {
			jlog.Error("[engine] %s", engineUnavailableMessage(problem))
			return selectedEngineHost{}, false
		}
	}
	jlog.Info("[engine] host: %s (%s)", mode.String(), reason)
	return selected, true
}

// buildEngineHost binds a selected runtime to the resources it needs. app is
// required only by the WebView host; the Node host remains display-free.
func buildEngineHost(selected selectedEngineHost, app *application.App, srv *server.Server, requestQuit func()) engineHost {
	if selected.mode == enginehost.ModeNode {
		return newNodeHost(srv, requestQuit, selected.node)
	}
	return &webviewHost{app: app}
}

// displayPresent reports whether a usable graphical display is available. On
// Linux that requires DISPLAY or WAYLAND_DISPLAY; macOS and Windows always have
// a window server available to a GUI-session process.
func displayPresent(goos string) bool {
	if goos != "linux" {
		return true
	}
	return os.Getenv("DISPLAY") != "" || os.Getenv("WAYLAND_DISPLAY") != ""
}

// probeNode is the production adapter around enginehost.ProbeNode: it resolves
// node on PATH and runs `node --version` with a short timeout so a wedged node
// can never stall startup.
func probeNode() enginehost.NodeInfo {
	return enginehost.ProbeNode(exec.LookPath, func(path string) (string, error) {
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		out, err := exec.CommandContext(ctx, path, "--version").Output()
		return string(out), err
	})
}
