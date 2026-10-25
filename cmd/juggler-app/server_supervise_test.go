//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"os/exec"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/apipaths"
)

// fakeServerEnv makes this test binary act as a juggler server when the app
// spawns it: it binds the --port it is given the way the real server does (the
// next free one when that is taken), takes the --project's instance lock as the
// real server does, reports JUGGLER_ADDR, answers every request with its pid,
// and exits on an interrupt, on a POST to the shutdown route, or when its parent
// goes.
const fakeServerEnv = "JUGGLER_APP_TEST_FAKE_SERVER"

// fakeServerDeafEnv makes the fake ignore an interrupt, the way a server on
// Windows never receives one, so the only polite way to stop it is the
// shutdown route.
const fakeServerDeafEnv = "JUGGLER_APP_TEST_FAKE_SERVER_DEAF"

// fakeServerExitDelayEnv is how long, as a Go duration, the fake takes to exit
// once asked to over HTTP — a server finishing an exchange in flight.
const fakeServerExitDelayEnv = "JUGGLER_APP_TEST_FAKE_SERVER_EXIT_DELAY"

func TestMain(m *testing.M) {
	if os.Getenv(fakeServerEnv) == "1" {
		runFakeServer(os.Args[1:])
		return
	}
	os.Exit(m.Run())
}

// fakeServerFailEnv makes the fake fail to start the way the real server does:
// it prints its reason after core.StartupFailurePrefix on stderr, reports no
// address, and exits non-zero.
const fakeServerFailEnv = "JUGGLER_APP_TEST_FAKE_SERVER_FAIL"

func runFakeServer(args []string) {
	if reason := os.Getenv(fakeServerFailEnv); reason != "" {
		fmt.Fprintf(os.Stderr, "\n%s%s\n", core.StartupFailurePrefix, reason)
		os.Exit(1)
	}
	port := 0
	project := ""
	for i, arg := range args {
		if i+1 >= len(args) {
			break
		}
		switch arg {
		case "--port":
			port, _ = strconv.Atoi(args[i+1])
		case "--project":
			project = args[i+1]
		}
	}
	var ln net.Listener
	var err error
	for p := port; p <= port+10; p++ {
		if ln, err = net.Listen("tcp", net.JoinHostPort("127.0.0.1", strconv.Itoa(p))); err == nil || port == 0 {
			break
		}
	}
	if err != nil {
		fmt.Fprintln(os.Stderr, "fake server:", err)
		os.Exit(2)
	}
	if project != "" {
		addr := ln.Addr().(*net.TCPAddr)
		lock := core.NewInstanceLock(project)
		if res, err := lock.TryAcquire(addr.Port, addr.IP.String()); err != nil || !res.Acquired {
			fmt.Fprintln(os.Stderr, "fake server: project lock:", err)
			os.Exit(2)
		}
	}
	fmt.Printf("JUGGLER_ADDR=%s\n", ln.Addr())

	parent := os.Getppid()
	go func() {
		for range time.Tick(100 * time.Millisecond) {
			if os.Getppid() != parent {
				os.Exit(0)
			}
		}
	}()
	if os.Getenv(fakeServerDeafEnv) == "1" {
		signal.Ignore(os.Interrupt)
	} else {
		go func() {
			sig := make(chan os.Signal, 1)
			signal.Notify(sig, os.Interrupt, syscall.SIGTERM)
			<-sig
			os.Exit(0)
		}()
	}
	exitDelay, _ := time.ParseDuration(os.Getenv(fakeServerExitDelayEnv))
	_ = http.Serve(ln, http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodPost && r.URL.Path == apipaths.Shutdown {
			w.WriteHeader(http.StatusAccepted)
			go func() {
				time.Sleep(exitDelay)
				os.Exit(0)
			}()
			return
		}
		_, _ = io.WriteString(w, strconv.Itoa(os.Getpid()))
	}))
}

// useFakeServer points spawnServer at the fake, and the logs it opens at a
// throwaway directory.
func useFakeServer(t *testing.T) {
	t.Helper()
	exe, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("JUGGLER_SERVER_BIN", exe)
	t.Setenv(fakeServerEnv, "1")
	t.Setenv("JUGGLER_LOG_DIR", t.TempDir())
}

// servingPID is the pid of the server answering at url, or 0 when nothing does.
func servingPID(url string) int {
	client := http.Client{Timeout: time.Second}
	resp, err := client.Get(url)
	if err != nil {
		return 0
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	pid, _ := strconv.Atoi(strings.TrimSpace(string(body)))
	return pid
}

// stopOwnedServers stops whatever the registry holds when the test ends, so no
// fake outlives it.
func stopOwnedServers(t *testing.T, a *appState) {
	t.Cleanup(a.stopAllServers)
}

// A window shows a server at one address for its whole life, and the page in it
// reconnects only ever to that address. So a server that dies under its window —
// the engine failing to come up on a crowded login, a crash — has to be started
// again where the window is looking. Nothing else will bring that window back.
func TestAServerThatDiesUnderItsWindowIsStartedAgainWhereTheWindowLooks(t *testing.T) {
	useFakeServer(t)
	a := newTestAppState(t)
	stopOwnedServers(t, a)

	addr, proc, err := spawnServer(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	url := "http://" + addr
	registerWindowOn(a, "w1", url)
	a.adoptServer(url, proc)

	first := servingPID(url)
	if first == 0 {
		t.Fatalf("the spawned server is not answering at %s", url)
	}
	if err := proc.cmd.Process.Kill(); err != nil {
		t.Fatal(err)
	}

	deadline := time.Now().Add(15 * time.Second)
	for {
		if pid := servingPID(url); pid != 0 && pid != first {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("nothing took over %s after its server (pid %d) died under a window", url, first)
		}
		time.Sleep(50 * time.Millisecond)
	}
}

// supervised runs the supervisor for proc at url and reports when it returns.
func supervised(a *appState, url string, proc *serverProc) chan struct{} {
	a.reg(func(st *regState) { st.servers[url] = proc })
	done := make(chan struct{})
	go func() {
		a.superviseServer(url, proc)
		close(done)
	}()
	return done
}

// awaitReturn fails the test unless done closes promptly.
func awaitReturn(t *testing.T, done chan struct{}, what string) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		t.Fatalf("the supervisor never returned: %s", what)
	}
}

// A server the app stopped itself — its last window closed, the app quit — went
// because it was asked to, and starting it again would bring back a server
// nothing is looking at.
func TestAServerTheAppStoppedIsNotStartedAgain(t *testing.T) {
	useFakeServer(t)
	a := newTestAppState(t)
	a.spawnServerOn = func(string, string) (string, *serverProc, error) {
		t.Error("a server the app stopped was started again")
		return "", nil, errors.New("not wanted")
	}

	addr, proc, err := spawnServer(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	url := "http://" + addr
	registerWindowOn(a, "w1", url)
	done := supervised(a, url, proc)

	proc.stop()
	awaitReturn(t, done, "after the app stopped its server")
}

// deadServer is a server that has already exited, having just started.
func deadServer(addr string) *serverProc {
	p := &serverProc{cmd: &exec.Cmd{}, addr: addr, started: time.Now(), exited: make(chan struct{})}
	close(p.exited)
	return p
}

// A server that dies every time, straight after starting, is not something a
// restart is going to mend. It is started again a bounded number of times, then
// left down and forgotten, rather than spun forever.
func TestAServerThatKeepsDyingOnStartIsGivenUpOn(t *testing.T) {
	a := newTestAppState(t)
	const addr = "127.0.0.1:3939"
	url := "http://" + addr
	registerWindowOn(a, "w1", url)
	restarts := 0
	a.spawnServerOn = func(_, port string) (string, *serverProc, error) {
		if port != "3939" {
			t.Errorf("restarted on port %q, not the one its window looks at", port)
		}
		restarts++
		return addr, deadServer(addr), nil
	}

	awaitReturn(t, supervised(a, url, deadServer(addr)), "for a server that keeps dying")

	if restarts != serverQuickDeaths {
		t.Errorf("restarted %d times, want %d", restarts, serverQuickDeaths)
	}
	var owned bool
	a.reg(func(st *regState) { _, owned = st.servers[url] })
	if owned {
		t.Error("a server given up on is still recorded as one the app owns")
	}
}
