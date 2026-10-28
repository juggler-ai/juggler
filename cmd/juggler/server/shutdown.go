//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"strconv"
	"sync/atomic"
	"time"

	"juggler/cmd/juggler/ops"
	"juggler/internal/jlog"
)

// initiateShutdown triggers the server shutdown process
func (s *Server) initiateShutdown() {
	s.StopTunnel()
	s.shutdownOnce.Do(func() {
		close(s.shutdownChan)
	})
}

// ShutdownChan returns a channel that is closed when shutdown is requested
func (s *Server) ShutdownChan() <-chan struct{} {
	return s.shutdownChan
}

// serverLifetimeContext is a context for work that belongs to the server
// rather than to any one connection: it ends when shutdown is requested, or
// when cancel is called.
func (s *Server) serverLifetimeContext() (context.Context, context.CancelFunc) {
	ctx, cancel := context.WithCancel(context.Background())
	go func() {
		select {
		case <-s.ShutdownChan():
			cancel()
		case <-ctx.Done():
		}
	}()
	return ctx, cancel
}

// newHTTPServer builds an http.Server with the shared handler and timeouts.
// Used for both the local listener and the tunnel, so both get
// identical keep-alive, body-limit and header-timeout behaviour.
//
// IdleTimeout caps how long an HTTP/1.1 keepalive connection can sit idle
// before being closed. Without it, every page reload leaves its prior
// connection parked in connReader.Read forever; combined with websockets
// and log/lock files we exhaust per-process fds and the next open()
// (e.g. Wails' Metal shader load) is denied.
func (s *Server) newHTTPServer() *http.Server {
	return &http.Server{
		Handler:           withBodyLimit(s.router, defaultMaxBodyBytes),
		IdleTimeout:       60 * time.Second,
		ReadHeaderTimeout: 10 * time.Second,
		MaxHeaderBytes:    1 << 20, // 1 MiB; default is 1 MiB but pin it explicitly.
	}
}

// Serve starts serving HTTP on the bound port (blocking)
// Must call BindPort() first
func (s *Server) Serve() error {
	if s.listener == nil {
		return fmt.Errorf("no listener bound, call BindPort() first")
	}
	return s.newHTTPServer().Serve(s.listener)
}

// GetAddr returns the bound server address (empty if not yet bound)
func (s *Server) GetAddr() string {
	return s.addr
}

// GetStaticVersion returns the random version string used for cache-busted paths
func (s *Server) GetStaticVersion() string {
	return s.staticVersion
}

// IsEngineConnected returns true if the engine browser is connected AND its JS
// realm has proved itself within the liveness window. Callers all mean "is there
// an engine that can execute a tool", and an open socket does not answer that —
// see engine_liveness.go for why the transport can outlive the realm.
func (s *Server) IsEngineConnected() bool {
	if s.engineClient.Load() == nil {
		return false
	}
	if !s.engineLive() {
		s.reportEngineSilence()
		return false
	}
	return true
}

// ActiveConversationIDs returns conversation IDs that are actively running a
// turn (excludes turns parked solely on a pending tool approval — those are
// interrupting nothing and survive a restart intact).
func (s *Server) ActiveConversationIDs() []string {
	return s.workerManager.ActiveConversationIDs()
}

// SetEngineReadyGate installs the engine-readiness gate called at the start of
// every LLM turn. Production wires this to a wait-for-connected check on the
// always-alive engine (see startEngine); tests/test-pool leave it nil (engine
// always present, gate returns true).
func (s *Server) SetEngineReadyGate(gate EngineReadyGate) {
	if gate == nil {
		s.engineReadyGate.Store(nil)
		return
	}
	s.engineReadyGate.Store(&gate)
}

// ensureEngineReady runs the engine-readiness gate if one is installed, blocking
// until the engine is connected. Returns true when the engine is ready (or no
// gate is set, e.g. in tests).
func (s *Server) ensureEngineReady() bool {
	if g := s.engineReadyGate.Load(); g != nil {
		return (*g)()
	}
	return true
}

// WaitForEngineConnected blocks until an engine client connects or the timeout
// expires. Returns true if the engine connected within the timeout.
func (s *Server) WaitForEngineConnected(timeout time.Duration) bool {
	deadline := time.Now().Add(timeout)
	for time.Now().Before(deadline) {
		if s.IsEngineConnected() {
			return true
		}
		time.Sleep(100 * time.Millisecond)
	}
	return false
}

// teardownStep is one stage of the shutdown sequence, named so that a stage
// which fails to finish can be identified in the log rather than guessed at.
type teardownStep struct {
	name string
	run  func()
}

// runTeardown runs steps in order and then releases the project lock, giving
// the whole sequence no longer than ctx allows.
//
// The deadline exists for the lock's sake. By the time teardown starts the
// listener is already closed, so this process holds the project lock while
// answering nothing — indistinguishable, from outside, from a crashed instance.
// A stage that never finishes therefore strands the lock for as long as the
// process lives, and since flock is only reclaimed by the kernel on exit, the
// project stays unopenable until someone deletes the file by hand.
//
// So on expiry we release regardless and let the caller exit. A stage still
// running at that point is abandoned mid-flight, which risks losing whatever it
// had left to write; holding the lock forever loses the project instead.
func runTeardown(ctx context.Context, steps []teardownStep, release func() error) error {
	// Index of the stage currently running, so a stage that overruns can be
	// named. Written from the teardown goroutine, read from this one.
	var stage atomic.Int32
	stage.Store(-1)

	done := make(chan struct{})
	go func() {
		defer close(done)
		for i, step := range steps {
			stage.Store(int32(i))
			step.run()
		}
		stage.Store(-1)
	}()

	var err error
	select {
	case <-done:
	case <-ctx.Done():
		err = ctx.Err()
		if i := int(stage.Load()); i >= 0 && i < len(steps) {
			jlog.Error("Shutdown ran out of time in the %s stage. Releasing the project lock anyway, so the next launch isn't blocked by it.", steps[i].name)
		} else {
			jlog.Error("Shutdown ran out of time. Releasing the project lock anyway, so the next launch isn't blocked by it.")
		}
	}

	if relErr := release(); relErr != nil {
		jlog.Error("Error releasing instance lock: %v", relErr)
	}
	return err
}

// Shutdown gracefully shuts down the server
func (s *Server) Shutdown(ctx context.Context) error {
	jlog.Info("⏳ Graceful shutdown starting...")

	// 1. Stop accepting new connections
	if s.listener != nil {
		if err := s.listener.Close(); err != nil {
			jlog.Error("Error closing listener: %v", err)
		}
	}

	// Stop being woken: the subscription is process-global, and the worker
	// manager it wakes is about to be shut down.
	if s.stopWake != nil {
		s.stopWake()
	}
	// Likewise the process inventory's: nothing should be published to viewers
	// that are being shut down.
	if s.stopProcessWatch != nil {
		s.stopProcessWatch()
	}

	st := s.projectState.Load()

	steps := []teardownStep{
		// 2. Notify all WebSocket clients that server is shutting down
		{"websocket clients", func() {
			jlog.Info("⏳ Closing WebSocket connections...")
			s.broadcastShutdownNotice()
		}},

		// 3. Stop file watcher (no dependency on session manager or workers)
		{"file watcher", func() {
			if st != nil && st.fileWatcher != nil {
				jlog.Info("⏳ Stopping file watcher...")
				st.fileWatcher.Stop()
			}
		}},

		// 4. Stop workers before session manager — workers call SaveConversationBinary
		// on shutdown, which routes through the session manager actor. If the session
		// manager is stopped first, those saves deadlock waiting for a response.
		{"workers", func() {
			if s.workerManager != nil {
				s.workerManager.Shutdown()
			}
		}},

		// 4a. After workers are quiescent, close every cached Conversation so
		// provider-side resources (CLI subprocesses, sockets, etc.) get
		// released cleanly. Ordered after worker shutdown so no in-flight
		// LLM call races a closing handle.
		{"conversations", func() {
			if s.conversationCache != nil {
				s.conversationCache.Shutdown()
			}
		}},

		// 4b. Stop background tasks. After the workers, so a Monitor's own delivery
		// teardown gets to stop its task first and report it the way that path
		// reports it; whatever is left is a plain run_in_background task, which
		// nothing else stops. Each runs in its own process group, so exiting without
		// this leaves it running under init with no handle anywhere.
		{"background tasks", func() {
			if stopped := ops.StopBackgroundTasks("", "Stopped when Juggler quit", taskStopGrace); stopped > 0 {
				jlog.Info("⏹️  Stopped %d background task(s)", stopped)
			}
		}},

		// 5. Session manager last, so everything above has finished routing its
		// saves through it. The lock is released after this step rather than
		// inside it: until the writing stops, another instance must not be able
		// to open this project.
		{"session manager", func() {
			if st != nil && st.sessionManager != nil {
				jlog.Info("⏳ Shutting down session manager...")
				st.sessionManager.Shutdown()
			}
		}},
	}

	release := func() error {
		if st == nil || st.lock == nil {
			return nil
		}
		return st.lock.Release()
	}

	if err := runTeardown(ctx, steps, release); err != nil {
		return err
	}

	jlog.Info("✅ Graceful shutdown complete")
	return nil
}

// broadcastShutdownNotice sends a shutdown notification to all connected WebSocket clients
func (s *Server) broadcastShutdownNotice() {
	s.shutdownAllClients()
}

// viewerListenConfig is how the port that serves viewers is bound.
//
// Keep-alive probes are enabled with an explicit period so a peer whose host
// simply vanished — a suspended laptop, a dropped tunnel, a killed VM — gets
// reaped by the kernel instead of lingering as a half-open connection holding
// an fd and a registered WSClient. Nothing above the transport can notice such
// a peer on its own: it never sends, so no read fails, and a write to it only
// fails if there is something to send (see wsWriteTimeout). Probes are the
// only thing that detects a silent idle client that is already gone.
//
// Idle 30s then 9 probes 10s apart declares the connection dead about two
// minutes after the peer disappears, for two packets a minute on a live idle
// connection. The listener binds all interfaces, so these settings also apply
// to loopback peers (the engine, local viewers); that is harmless, since a
// loopback peer cannot go half-open without its process dying, and probes that
// never leave the machine cost nothing.
var viewerListenConfig = net.ListenConfig{
	KeepAliveConfig: net.KeepAliveConfig{
		Enable:   true,
		Idle:     30 * time.Second,
		Interval: 10 * time.Second,
		Count:    9,
	},
}

// listenForViewers binds bindAddr with the viewer keep-alive settings.
func listenForViewers(bindAddr string) (net.Listener, error) {
	return viewerListenConfig.Listen(context.Background(), "tcp", bindAddr)
}

// findAvailablePort tries to bind to the configured port, or finds an available one
func (s *Server) findAvailablePort() (net.Listener, string, error) {
	// Parse the configured address
	host, portStr, err := net.SplitHostPort(s.addr)
	if err != nil {
		return nil, "", fmt.Errorf("invalid address: %w", err)
	}

	port, err := strconv.Atoi(portStr)
	if err != nil {
		return nil, "", fmt.Errorf("invalid port: %w", err)
	}

	// Bind to all interfaces so LAN gate middleware can control access, unless
	// this server is LoopbackOnly, when nothing off the machine may connect at
	// all. The display address (returned as the second value) keeps the
	// configured hostname so the banner shows "localhost" rather than "0.0.0.0".
	bindHost := ""
	if s.loopbackOnly {
		bindHost = "127.0.0.1"
	}
	listener, err := bindFirstFree(bindHost, port, listenForViewers)
	if err != nil {
		return nil, "", err
	}
	_, actualPort, _ := net.SplitHostPort(listener.Addr().String())
	return listener, net.JoinHostPort(host, actualPort), nil
}

// maxPortSearch is how many ports past the configured one bindFirstFree tries.
// The desktop app gives every window its own server, so each open window holds
// one port of this range, and the range is how many windows can be open at
// once. A busy port fails its bind at once, so a long search costs nothing worth
// measuring.
const maxPortSearch = 100

// bindFirstFree listens on bindHost at port, or at the first of the next
// maxPortSearch ports that is free. Only a port that is unavailable moves the
// search on (portUnavailable); any other failure is returned as it is, since
// the next port would fail the same way.
func bindFirstFree(bindHost string, port int, listen func(string) (net.Listener, error)) (net.Listener, error) {
	for i := 0; i <= maxPortSearch; i++ {
		listener, err := listen(net.JoinHostPort(bindHost, strconv.Itoa(port+i)))
		if err == nil {
			if i > 0 {
				jlog.Info("✅ Found available port: %d", port+i)
			}
			return listener, nil
		}
		if !portUnavailable(err) {
			return nil, err
		}
		if i == 0 {
			jlog.Info("⚠️  Port %d is busy, searching for available port...", port)
		}
	}
	return nil, fmt.Errorf("could not find available port after %d attempts", maxPortSearch)
}
