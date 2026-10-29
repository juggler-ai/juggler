//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"io/fs"
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/cmd/juggler/tunnel"
	"juggler/internal/jlog"
	"juggler/internal/portbind"
	"juggler/internal/userpaths"
)

// DefaultPort is where the machine server listens unless told otherwise.
const DefaultPort = 3939

// listenAll listens on every interface at port, or the first free port after
// it, so the server's address stays one a person can remember; the LAN gate,
// not the bind, decides who gets in. Port 0 is any port the OS assigns.
//
// A port something else holds on loopback alone is taken: on some systems
// (macOS) a bind on every interface succeeds beside it, and every client on
// this machine, which dials loopback (dialAddr), would reach that other thing.
// So loopback is tried first, and let go just before the real bind.
//
// The real bind probes idle connections (portbind.KeepAlive): this is the
// listener a remote viewer's host connects to — over the LAN, or a tunnel's
// forwarder — so it is where a host that vanished without closing (a suspended
// laptop, a phone leaving wifi) leaves a half-open connection to be reaped.
func listenAll(port int) (net.Listener, error) {
	if port == 0 {
		return portbind.Listen(":0") // every interface by design; the LAN gate decides who gets in
	}
	return portbind.FirstFree("", port, func(addr string) (net.Listener, error) {
		_, p, _ := net.SplitHostPort(addr)
		probe, err := net.Listen("tcp", net.JoinHostPort("127.0.0.1", p))
		if err != nil {
			return nil, err
		}
		_ = probe.Close()
		return portbind.Listen(addr)
	})
}

// dialAddr is where a client on this machine reaches ln: loopback, at its port.
func dialAddr(ln net.Listener) string {
	_, port, _ := net.SplitHostPort(ln.Addr().String())
	return net.JoinHostPort("127.0.0.1", port)
}

// serveListening is called with the server once Serve is serving, before its
// lifetime checks start. A seam for the stand-in server in tests.
var serveListening = func(*Server) {}

// RunCommand runs `juggler serve` to completion and returns the process exit
// code, serving the sessions page from assets and answering a tunnel's WebRTC
// offers with peer. One machine server per machine,
// enforced by the flock under ~/.juggler/; a second invocation reports the
// running one and exits. startupNotes are what the caller did before there was
// a log to say so in (a failed login-shell PATH probe); each is logged once
// there is.
func RunCommand(args []string, assets fs.FS, peer Peer, startupNotes ...string) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	port := fs.Int("port", DefaultPort, "Port for the machine server, or the first free one after it (0 = OS-assigned; the bound address is recorded in ~/.juggler/server.json)")
	verbose := fs.Bool("verbose", false, "Verbose logging (debug level)")
	fs.BoolVar(verbose, "v", false, "Verbose logging (debug level) (shorthand)")
	implicit := fs.Bool("implicit", false, "Mark this server as started on demand by a client (bare juggler, the desktop app) rather than by hand; recorded in ~/.juggler/server.json")
	startedBy := fs.Int("started-by", 0, "PID of the local client holding startup until it attaches or exits")
	testChildren := fs.Bool("test", false, "Test harness only: spawn session children as test servers driven through this server's proxy")
	dev := fs.Bool("dev", false, "Enable dev mode in every session: the web inspector and full right-click menu")
	lan := fs.Bool("lan", false, "Start with LAN access on: other devices on this network can use the server, with no password. Off unless this or Settings → Connectivity says to start it; this machine can switch it at any time (juggler server lan, the sessions page, or Settings → Connectivity)")
	openTunnel := fs.String("tunnel", "", "Start with a tunnel open in `mode`: anyone with its link can use the server, with no password. Over any tunnel Settings → Connectivity names; none unless one of them does. This machine can open or close one at any time (juggler server tunnel, the sessions page, or Settings → Connectivity)")
	assetsFromDisk := fs.Bool("assets-from-disk", false, "Developer flag: every session serves web assets from the on-disk web/ tree (requires a source checkout); implies --dev")
	var allowHosts []string
	fs.Func("allow-host", "Also accept requests for `name`: the name a reverse proxy on this machine (tailscale serve, caddy) serves Juggler under. Its callers count as remote. Repeatable; only name a host whose DNS you control", func(v string) error {
		allowHosts = append(allowHosts, v)
		return nil
	})
	// Exported to the environment, which every session child inherits.
	fs.Func("updates-managed-by", "For packagers: the package manager (`name`, e.g. Nix) that installs Juggler's updates. Juggler then never updates itself, and points its update notices there. Same as setting "+core.UpdatesManagedByEnv, core.SetUpdatesManagedBy)
	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *openTunnel != "" {
		if _, err := startableMode(tunnel.Mode(*openTunnel)); err != nil {
			fmt.Fprintf(os.Stderr, "serve: %v\n", err)
			return 2
		}
	}

	defer InitLogging(*verbose)()
	for _, note := range startupNotes {
		jlog.Info("%s", note)
	}

	err := Serve(ServeOptions{Port: *port, Implicit: *implicit, StartedBy: *startedBy, TestChildren: *testChildren,
		Dev: *dev, AssetsFromDisk: *assetsFromDisk, AllowHosts: allowHosts, LAN: *lan, Tunnel: tunnel.Mode(*openTunnel), Assets: assets, Peer: peer})
	var held *LockHeldError
	switch {
	case err == nil:
		return 0
	case errors.As(err, &held):
		if held.Existing != nil {
			fmt.Fprintf(os.Stderr, "A machine server is already running: pid %d at %s (version %s).\n",
				held.Existing.PID, held.Existing.Addr, held.Existing.Version)
		} else {
			fmt.Fprintln(os.Stderr, "A machine server is already running (holder unknown).")
		}
		return 1
	case errors.As(err, new(badAllowHostError)):
		fmt.Fprintf(os.Stderr, "serve: %v\n", err)
		return 2
	default:
		jlog.Error("serve: %v", err)
		return 1
	}
}

// InitLogging brings up the machine server's log: the console at Info (Debug
// when verbose) and serve.log. It returns the logger's Close.
func InitLogging(verbose bool) (closeLog func()) {
	level := jlog.LevelInfo
	if verbose {
		level = jlog.LevelDebug
	}
	jlog.Init(jlog.Options{
		ConsoleLevel: level,
		Colors:       true,
		Component:    "serve",
		MaxSizeMB:    10,
		MaxBackups:   5,
		LogFilePath:  serveLogPath(),
	})
	return jlog.Close
}

// ServeOptions is one run of the machine server (Serve).
type ServeOptions struct {
	// Port to listen on, or the first free one after it; 0 for one the OS
	// assigns.
	Port int
	// Implicit marks a server a client started on demand: it exits without clients.
	Implicit bool
	// StartedBy holds startup while this pid lives, until it attaches.
	StartedBy int
	// TestChildren spawns every child as a test server (see Server.testChildren).
	TestChildren bool
	// Dev and AssetsFromDisk are passed to every child (--dev,
	// --assets-from-disk).
	Dev, AssetsFromDisk bool
	// AllowHosts are extra Host names to accept, beside the saved ones.
	AllowHosts []string
	// LAN starts the server with LAN access on (serve --lan), whatever the
	// saved setting (launchExposure).
	LAN bool
	// Tunnel opens a tunnel in this mode once serving (serve --tunnel), over
	// the saved one (launchExposure).
	Tunnel tunnel.Mode
	// Assets is the web tree the sessions page is served from.
	Assets fs.FS
	// Peer answers a tunnel's WebRTC offers; nil answers none.
	Peer Peer
	// Signals delivers requests to stop. Nil listens for SIGINT and SIGTERM.
	Signals <-chan os.Signal
	// Foreground, when set, is the terminal this server serves in the
	// foreground of (RunTerminal).
	Foreground *Foreground
}

// Foreground is a machine server running in a terminal's foreground: bare
// juggler, run with no server running. It counts itself an attached client for
// its whole run, so it never exits idle under its own terminal; it opens the
// session for Project once serving; and when it is stopped it says which
// other sessions stop with it.
type Foreground struct {
	// Project is the folder to open a session for; "" opens none, leaving the
	// sessions page to choose one.
	Project string
	// Out is where it tells the person at the terminal what it is doing.
	Out io.Writer
	// Ready, when set, is told the URL to open once the session is running:
	// the session's, or with no Project the sessions page's.
	Ready func(url string)
}

// launchExposure is what a start opens: LAN access if --lan or the saved
// connectivity.lanOnLaunch says so, and the tunnel --tunnel names, else the
// saved connectivity.wanOnLaunch. Every start reads them, however it was
// started — the desktop app's, a terminal's, a service's — except under
// --test, so the harness never picks up a developer's real settings.json. A
// saved mode this build lacks, or that cannot start here, opens nothing; it
// stays saved, for the build or the helper that brings it back.
func launchExposure(opts ServeOptions) (lan bool, mode tunnel.Mode) {
	lan, mode = opts.LAN, opts.Tunnel
	if opts.TestChildren {
		return lan, mode
	}
	gs, err := core.LoadGlobalSettings()
	if err != nil {
		jlog.Error("serve: settings load failed, opening only what the flags say: %v", err)
		return lan, mode
	}
	lan = lan || gs.Connectivity.LANOnLaunch
	if saved := tunnel.Mode(gs.Connectivity.WANOnLaunch); mode == "" && saved != "" {
		if _, err := startableMode(saved); err != nil {
			jlog.Info("serve: not opening the saved tunnel: %v", err)
		} else {
			mode = saved
		}
	}
	return lan, mode
}

// LockHeldError is Serve's answer when another machine server holds the lock.
// Existing is that server's info, when readable.
type LockHeldError struct {
	Existing *ServerInfo
}

func (e *LockHeldError) Error() string { return "a machine server is already running" }

// badAllowHostError is an allowed-host name Serve refused.
type badAllowHostError struct{ err error }

func (e badAllowHostError) Error() string { return e.err.Error() }
func (e badAllowHostError) Unwrap() error { return e.err }

// Serve runs the machine server until it is stopped — by a signal, the
// control API, or (implicit) losing its last local client — and returns nil once it has shut
// down cleanly. Another server holding the lock is a *LockHeldError.
func Serve(opts ServeOptions) error {
	// From here the tunnel registry is read from request handlers.
	tunnel.Seal()
	allowed, err := resolveAllowedHosts(opts.AllowHosts, opts.TestChildren)
	if err != nil {
		return badAllowHostError{err}
	}

	token := mintToken()
	lock := NewMachineLock(userpaths.ConfigDir())
	acquired, existing, err := lock.TryAcquire(ServerInfo{Version: core.Version, Token: token, Implicit: opts.Implicit})
	if err != nil {
		return err
	}
	if !acquired {
		return &LockHeldError{Existing: existing}
	}
	defer func() {
		if err := lock.Release(); err != nil {
			jlog.Error("serve: failed to release machine lock: %v", err)
		}
	}()

	bin, err := childBinPath()
	if err != nil {
		return err
	}

	recents, err := core.NewRecentsStore()
	if err != nil {
		return err
	}

	s := &Server{
		reg:                 newRegistry(),
		recents:             recents,
		assets:              opts.Assets,
		uiLocale:            settingsUILocale,
		lock:                lock,
		childBin:            bin,
		startedAt:           time.Now(),
		shutdownReq:         make(chan struct{}, 1),
		token:               token,
		implicit:            opts.Implicit,
		starter:             opts.StartedBy,
		testChildren:        opts.TestChildren,
		childDev:            opts.Dev,
		childAssetsFromDisk: opts.AssetsFromDisk,
		allowedHosts:        allowed,
		build:               ownBuild(),
		peer:                opts.Peer,
	}

	// Listen for stop requests before anything can take long, so a Ctrl-C
	// while the first session spawns is a stop, not lost.
	sig := opts.Signals
	if sig == nil {
		ch := make(chan os.Signal, 4)
		signal.Notify(ch, os.Interrupt, syscall.SIGTERM)
		defer signal.Stop(ch)
		sig = ch
	}

	ln, err := listenAll(opts.Port)
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	s.addr = dialAddr(ln)
	if err := lock.UpdateAddr(s.addr); err != nil {
		jlog.Error("serve: failed to record server address: %v", err)
	}
	s.httpSrv = &http.Server{Handler: s.routes(), ReadHeaderTimeout: 10 * time.Second}

	fg := opts.Foreground
	if fg == nil {
		// Same startup handshake as a session child, so anything that can read
		// a spawned juggler's address can read the machine server's too.
		fmt.Printf("JUGGLER_ADDR=%s\n", s.addr)
	}
	jlog.Info("🚂 Machine server %s listening on http://%s/ (pid %d)", core.Version, s.addr, os.Getpid())
	if names := allowed.Names(); len(names) > 0 {
		jlog.Info("🔀 Also serving under %s (reverse proxy on this machine; its callers count as remote)", strings.Join(names, ", "))
	}
	lan, openMode := launchExposure(opts)
	s.setLAN(lan)

	errCh := make(chan error, 1)
	go func() { errCh <- s.httpSrv.Serve(ln) }()
	if openMode != "" {
		// Off the startup path: a tunnel can take seconds to come up, and the
		// server serves this machine meanwhile. A failure is logged.
		go func() { _, _ = s.startTunnel(openMode) }()
	}

	// Why a foreground server's open for its terminal failed, if it did.
	fgErr := make(chan error, 1)
	if fg != nil {
		detach := s.attach()
		defer detach()
		opened := make(chan func(), 1)
		defer func() {
			if release := <-opened; release != nil {
				release()
			}
		}()
		go func() {
			release, err := s.openForeground(fg)
			opened <- release
			if err != nil {
				fgErr <- err
				s.requestShutdown()
			}
		}()
	}

	serveListening(s)

	beats := time.NewTicker(attachCheckEvery)
	defer beats.Stop()
	go s.watchAttachments(beats.C)

	var failed error
	select {
	case got := <-sig:
		jlog.Info("serve: received %v — shutting down", got)
		if fg != nil {
			fmt.Fprintln(fg.Out, s.stopNotice(fg.Project))
		}
		go forceQuitOnThirdSignal(sig)
	case <-s.shutdownReq:
		jlog.Info("serve: shutting down")
		select {
		case failed = <-fgErr:
		default:
			if fg != nil {
				fmt.Fprintln(fg.Out, "Stopping the Juggler server: another client asked it to stop.")
			}
		}
	case err := <-errCh:
		s.stopTunnel()
		s.closeIngress()
		s.stopAllChildren()
		return fmt.Errorf("http server failed: %w", err)
	}

	// Shutdown ordering per the supervisor contract: end the lifetime, so an
	// open whose child is in its handshake gives up rather than holding the
	// drain; stop accepting; drain the children and wait for their
	// supervisors; release the machine lock last (the deferred Release above).
	s.endLifetime()
	s.stopTunnel()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := s.httpSrv.Shutdown(ctx); err != nil {
		jlog.Error("serve: http shutdown: %v", err)
	}
	s.closeIngress()
	s.stopAllChildren()
	jlog.Info("serve: all sessions stopped — bye")
	return failed
}

// forceQuitOnThirdSignal follows the stop a first signal began: a second says
// the stop is still going, and a third ends the process at once, for a stop
// that has wedged.
func forceQuitOnThirdSignal(sig <-chan os.Signal) {
	n := 1
	for range sig {
		n++
		if n == 2 {
			jlog.Info("Still stopping. Press Ctrl-C again to force quit.")
			continue
		}
		os.Exit(130)
	}
}

// openForeground opens the session for fg.Project and tells the terminal
// where it is. With no Project it points the terminal at the sessions page.
// Its returned viewer hold belongs to Serve, which releases it on exit.
func (s *Server) openForeground(fg *Foreground) (release func(), err error) {
	page := "http://" + s.addr + "/"
	fmt.Fprintf(fg.Out, "Started the Juggler server at %s\n", page)
	url := page
	if fg.Project == "" {
		fmt.Fprintln(fg.Out, "Open a project from its page.")
	} else {
		res := s.openSession(s.lifetime(), fg.Project, true)
		if res.refusal != nil {
			return nil, fmt.Errorf("open the session for %s: %s", fg.Project, res.refusal)
		}
		if res.sess.State != SessionRunning {
			return nil, fmt.Errorf("open the session for %s: %s", fg.Project, nonEmpty(res.sess.Error, string(res.sess.State)))
		}
		var ok bool
		release, ok = s.reg.holdViewer(res.sess.ID)
		if !ok {
			return nil, fmt.Errorf("open the session for %s: session is not running", fg.Project)
		}
		url = page + "s/" + res.sess.ID + "/"
		fmt.Fprintf(fg.Out, "Session for %s: %s\n", fg.Project, url)
	}
	fmt.Fprintln(fg.Out, "Ctrl-C stops the server and every session on it.")
	if fg.Ready != nil {
		fg.Ready(url)
	}
	return release, nil
}

// stopNotice is what a foreground server says as Ctrl-C stops it: which
// sessions, beside the one for its own project, stop with it.
func (s *Server) stopNotice(project string) string {
	var others []string
	for _, sess := range s.reg.snapshot() {
		if sess.Project != project {
			others = append(others, sess.Project)
		}
	}
	switch len(others) {
	case 0:
		return "Stopping the Juggler server."
	case 1:
		return "Stopping the Juggler server and its 1 other session: " + others[0]
	default:
		return fmt.Sprintf("Stopping the Juggler server and its %d other sessions: %s", len(others), strings.Join(others, ", "))
	}
}

// nonEmpty returns s, or fallback when s is empty.
func nonEmpty(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}
