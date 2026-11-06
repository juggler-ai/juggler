//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package app

import (
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"juggler/cmd/juggler/server"
)

// fakeEngineServer is a server whose engine connects when the test says so,
// and which reports boot progress at every ask while progressing is set.
type fakeEngineServer struct {
	connected   chan struct{}
	once        sync.Once
	progressing atomic.Bool
}

func (f *fakeEngineServer) EngineBootProgressAt() time.Time {
	if f.progressing.Load() {
		return time.Now()
	}
	return time.Time{}
}

func newFakeEngineServer() *fakeEngineServer {
	return &fakeEngineServer{connected: make(chan struct{})}
}

func (f *fakeEngineServer) connect() { f.once.Do(func() { close(f.connected) }) }

func (f *fakeEngineServer) GetAddr() string { return "127.0.0.1:0" }

func (f *fakeEngineServer) WaitForEngineConnected(timeout time.Duration) bool {
	select {
	case <-f.connected:
		return true
	case <-time.After(timeout):
		return false
	}
}

func (f *fakeEngineServer) SetEngineReadyGate(server.EngineReadyGate) {}

func (f *fakeEngineServer) SetEngineRecovery(server.EngineRecovery) {}

// fakeEngineHost counts reloads, and runs onRecover on each.
type fakeEngineHost struct {
	recovered atomic.Int32
	onRecover func()
}

func (h *fakeEngineHost) Start(string) error { return nil }
func (h *fakeEngineHost) Describe() string   { return "fake" }
func (h *fakeEngineHost) Stop()              {}
func (h *fakeEngineHost) Recover() {
	h.recovered.Add(1)
	if h.onRecover != nil {
		h.onRecover()
	}
}

// shortEngineStartup scales the startup windows down to test size.
func shortEngineStartup(t *testing.T) {
	t.Helper()
	reload, budget := engineReloadAfter, engineStartupTimeout
	engineReloadAfter, engineStartupTimeout = 50*time.Millisecond, 1500*time.Millisecond
	t.Cleanup(func() { engineReloadAfter, engineStartupTimeout = reload, budget })
}

// startWatched starts host on srv and returns a channel that closes if the
// server is told to quit.
func startWatched(host engineHost, srv engineServer) chan struct{} {
	quit := make(chan struct{})
	var once sync.Once
	startEngineHost(host, srv, func() { once.Do(func() { close(quit) }) })
	return quit
}

// expectNoQuit fails if quit closes before the whole startup budget is over.
func expectNoQuit(t *testing.T, quit chan struct{}, what string) {
	t.Helper()
	select {
	case <-quit:
		t.Fatalf("the server gave up on %s", what)
	case <-time.After(engineStartupTimeout + 300*time.Millisecond):
	}
}

// An engine is slow to come up when the machine is — a login with every app
// reopening at once is the case that brought a server down. One that connects
// late but within the startup budget is a working engine, not a failed one.
func TestAnEngineThatConnectsLateIsNotGivenUpOn(t *testing.T) {
	shortEngineStartup(t)
	srv := newFakeEngineServer()
	quit := startWatched(&fakeEngineHost{}, srv)
	time.AfterFunc(3*engineReloadAfter, srv.connect)

	expectNoQuit(t, quit, "an engine that connected late")
}

// A first load that wedges is rescued by loading the engine again, which is what
// an engine that has not connected in the usual time gets, before anything is
// given up on.
func TestAnEngineThatHasNotConnectedIsReloadedBeforeItIsGivenUpOn(t *testing.T) {
	shortEngineStartup(t)
	srv := newFakeEngineServer()
	host := &fakeEngineHost{onRecover: srv.connect}
	quit := startWatched(host, srv)

	expectNoQuit(t, quit, "an engine whose reload connected")
	if n := host.recovered.Load(); n != 1 {
		t.Errorf("reloaded %d times, want once", n)
	}
}

// How long an engine takes to boot is how fast the machine is: on a starved
// core a healthy engine can still be fetching its modules when any span of
// wall time runs out. One that keeps getting further is neither reloaded,
// which would restart the boot it is part-way through, nor given up on — until
// it stops getting anywhere.
func TestAnEngineStillMakingProgressIsNotGivenUpOn(t *testing.T) {
	shortEngineStartup(t)
	srv := newFakeEngineServer()
	srv.progressing.Store(true)
	host := &fakeEngineHost{}
	quit := startWatched(host, srv)

	select {
	case <-quit:
		t.Fatal("the server gave up on an engine that was still making progress")
	case <-time.After(2 * engineStartupTimeout):
	}
	if n := host.recovered.Load(); n != 0 {
		t.Errorf("an engine still making progress was reloaded %d times, want none", n)
	}

	srv.progressing.Store(false)
	select {
	case <-quit:
	case <-time.After(engineReloadAfter + engineStartupTimeout + 10*time.Second):
		t.Fatal("the server never gave up on an engine that stopped making progress")
	}
	if n := host.recovered.Load(); n != 1 {
		t.Errorf("reloaded %d times before giving up, want once", n)
	}
}

// The server's background services wait for the engine, and only the host's
// startup decides that an engine is not coming. Its clock starts when the native
// app does, later than the server's phases, so an engine it accepts can connect
// after any budget counted from the phases — and must still get its services.
func TestBackgroundServicesStartForAnEngineTheHostStillAccepts(t *testing.T) {
	shortEngineStartup(t)
	srv := newFakeEngineServer()
	started := make(chan struct{})
	go startOnceEngineConnects(srv, func() { close(started) })
	time.AfterFunc(engineStartupTimeout+300*time.Millisecond, srv.connect)

	select {
	case <-started:
	case <-time.After(engineStartupTimeout + 10*time.Second):
		t.Fatal("an engine that connected after the startup budget, counted from before the host started, never got its background services")
	}
}

// An engine that never connects still takes the server down — a headless
// server with no engine can do nothing — but only once the startup budget is
// spent, and after the reload has been tried.
func TestAnEngineThatNeverConnectsIsGivenUpOnAtTheEndOfTheBudget(t *testing.T) {
	shortEngineStartup(t)
	host := &fakeEngineHost{}
	start := time.Now()
	quit := startWatched(host, newFakeEngineServer())

	select {
	case <-quit:
	case <-time.After(engineStartupTimeout + 10*time.Second):
		t.Fatal("the server never gave up on an engine that never connected")
	}
	if took := time.Since(start); took < engineStartupTimeout {
		t.Errorf("gave up after %v, before the %v budget was spent", took, engineStartupTimeout)
	}
	if n := host.recovered.Load(); n != 1 {
		t.Errorf("reloaded %d times before giving up, want once", n)
	}
}
