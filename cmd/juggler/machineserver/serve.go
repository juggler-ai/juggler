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
	"net"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/jlog"
	"juggler/internal/userpaths"
)

// serveListening is called with the server once Serve is serving, before its
// idle watch starts. A seam for the stand-in server in tests.
var serveListening = func(*Server) {}

// RunCommand runs `juggler serve` to completion and returns the process exit
// code. One machine server per machine, enforced by the flock under
// ~/.juggler/; a second invocation reports the running one and exits.
func RunCommand(args []string) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	port := fs.Int("port", 0, "Port for the machine server (0 = OS-assigned; the bound address is recorded in ~/.juggler/server.json)")
	verbose := fs.Bool("verbose", false, "Verbose logging (debug level)")
	fs.BoolVar(verbose, "v", false, "Verbose logging (debug level) (shorthand)")
	implicit := fs.Bool("implicit", false, "Mark this server as started on demand by a client (bare juggler, the desktop app) rather than by hand; recorded in ~/.juggler/server.json")
	testChildren := fs.Bool("test", false, "Test harness only: spawn session children as test servers driven through this server's proxy")
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

	defer InitLogging(*verbose)()

	err := Serve(ServeOptions{Port: *port, Implicit: *implicit, TestChildren: *testChildren, AllowHosts: allowHosts})
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
	// Port to listen on, 0 for one the OS assigns.
	Port int
	// Implicit marks a server a client started on demand: it exits once idle.
	Implicit bool
	// TestChildren spawns every child as a test server (see Server.testChildren).
	TestChildren bool
	// AllowHosts are extra Host names to accept, beside the saved ones.
	AllowHosts []string
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
// control API, or (implicit) going idle — and returns nil once it has shut
// down cleanly. Another server holding the lock is a *LockHeldError.
func Serve(opts ServeOptions) error {
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
		reg:          newRegistry(),
		recents:      recents,
		uiLocale:     settingsUILocale,
		lock:         lock,
		childBin:     bin,
		startedAt:    time.Now(),
		shutdownReq:  make(chan struct{}, 1),
		token:        token,
		implicit:     opts.Implicit,
		idleTimeout:  serveIdleTimeout,
		testChildren: opts.TestChildren,
		allowedHosts: allowed,
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

	ln, err := net.Listen("tcp", fmt.Sprintf("127.0.0.1:%d", opts.Port))
	if err != nil {
		return fmt.Errorf("listen: %w", err)
	}
	s.addr = ln.Addr().String()
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

	errCh := make(chan error, 1)
	go func() { errCh <- s.httpSrv.Serve(ln) }()

	// Why a foreground server's open for its terminal failed, if it did.
	fgErr := make(chan error, 1)
	if fg != nil {
		detach := s.attach()
		defer detach()
		go func() {
			if err := s.openForeground(fg); err != nil {
				fgErr <- err
				s.requestShutdown()
			}
		}()
	}

	serveListening(s)

	// An implicit server shuts itself down once idle (watchIdle); one started
	// by hand stays until it is stopped.
	if s.implicit {
		tick := time.NewTicker(idleCheckEvery(s.idleTimeout))
		defer tick.Stop()
		go s.watchIdle(tick.C, nil)
	}

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
		s.stopAllChildren()
		return fmt.Errorf("http server failed: %w", err)
	}

	// Shutdown ordering per the supervisor contract: end the lifetime, so an
	// open whose child is in its handshake gives up rather than holding the
	// drain; stop accepting; drain the children and wait for their
	// supervisors; release the machine lock last (the deferred Release above).
	s.endLifetime()
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := s.httpSrv.Shutdown(ctx); err != nil {
		jlog.Error("serve: http shutdown: %v", err)
	}
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
func (s *Server) openForeground(fg *Foreground) error {
	page := "http://" + s.addr + "/"
	fmt.Fprintf(fg.Out, "Started the Juggler server at %s\n", page)
	url := page
	if fg.Project == "" {
		fmt.Fprintln(fg.Out, "Open a project from its page.")
	} else {
		res := s.openSession(s.lifetime(), fg.Project, true)
		if res.refusal != nil {
			return fmt.Errorf("open the session for %s: %s", fg.Project, res.refusal)
		}
		if res.sess.State != SessionRunning {
			return fmt.Errorf("open the session for %s: %s", fg.Project, nonEmpty(res.sess.Error, string(res.sess.State)))
		}
		url = page + "s/" + res.sess.ID + "/"
		fmt.Fprintf(fg.Out, "Session for %s: %s\n", fg.Project, url)
	}
	fmt.Fprintln(fg.Out, "Ctrl-C stops the server and every session on it.")
	if fg.Ready != nil {
		fg.Ready(url)
	}
	return nil
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
