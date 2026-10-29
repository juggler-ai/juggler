//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"juggler/internal/detach"
	"juggler/internal/userpaths"
	"juggler/internal/userpaths/userpathstest"
	"juggler/web"
)

// helperServeEnv marks a run of this test binary as a stand-in for `juggler
// serve` (see TestHelperMachineServer).
const helperServeEnv = "JUGGLER_MACHINESERVER_HELPER_SERVE"

// helperStarterPIDEnv passes the local starter pid into the stand-in command.
const helperStarterPIDEnv = "JUGGLER_MACHINESERVER_HELPER_STARTER_PID"

// TestHelperMachineServer is not a test: it is the machine server that
// helperStarter starts, this test binary run again with helperServeEnv set. It
// is the real `serve --implicit` (RunCommand), with session children that are
// stand-ins (TestHelperSessionChild).
func TestHelperMachineServer(t *testing.T) {
	if os.Getenv(helperServeEnv) != "1" {
		t.Skip("run only as the stand-in machine server")
	}
	newChildCommand = func(string, string, []string) *exec.Cmd {
		cmd := exec.Command(os.Args[0], "-test.run=^TestHelperSessionChild$") //nolint:gosec // this test binary
		cmd.Env = append(os.Environ(), helperChildEnv+"=1")
		return cmd
	}
	os.Exit(RunCommand([]string{"--implicit", "--port", "0", "--started-by", os.Getenv(helperStarterPIDEnv)}, web.Files, nil))
}

// helperStarter is a Starter that runs TestHelperMachineServer detached, as
// DetachedStarter runs `juggler serve --implicit`, and counts the servers it
// starts. Every one still running when the test ends is shut down through the
// control API and waited for.
func helperStarter(t *testing.T) (start Starter, count func() int) {
	t.Helper()
	t.Setenv("JUGGLER_LOG_DIR", t.TempDir())
	var n atomic.Int32
	exits := make(chan (<-chan struct{}), 16)
	t.Cleanup(func() {
		if info := NewMachineLock(userpaths.ConfigDir()).readInfo(); info != nil && info.Addr != "" {
			c := &Client{addr: info.Addr, token: info.Token, http: &http.Client{Timeout: 5 * time.Second}}
			_ = c.do(http.MethodPost, "/shutdown", nil, nil)
		}
		for range n.Load() {
			select {
			case <-<-exits:
			case <-time.After(30 * time.Second):
				t.Error("a stand-in machine server did not exit after a shutdown request")
			}
		}
	})
	start = func() (int, <-chan struct{}, error) {
		cmd := detach.Command(os.Args[0], "-test.run=^TestHelperMachineServer$")
		cmd.Env = append(os.Environ(), helperServeEnv+"=1", helperStarterPIDEnv+"="+strconv.Itoa(os.Getpid()))
		cmd, err := detach.Start(cmd)
		if err != nil {
			return 0, nil, err
		}
		exited := make(chan struct{})
		go func() {
			_ = cmd.Wait()
			close(exited)
		}()
		n.Add(1)
		exits <- exited
		return cmd.Process.Pid, exited, nil
	}
	return start, func() int { return int(n.Load()) }
}

// TestConnectWaitsOutTheWindowBeforeTheAddressIsRecorded: a server holds the
// lock from before it listens, so server.json names no address for a moment.
// A client arriving then waits for the address and the server answering,
// rather than reading the window as no server at all.
func TestConnectWaitsOutTheWindowBeforeTheAddressIsRecorded(t *testing.T) {
	userpathstest.Isolate(t)
	lock := NewMachineLock(userpaths.ConfigDir())
	if acquired, _, err := lock.TryAcquire(ServerInfo{Version: "v9.9.9", Token: testToken}); err != nil || !acquired {
		t.Fatalf("acquire: %v %v", acquired, err)
	}
	defer func() { _ = lock.Release() }()

	waiting := make(chan struct{}, 1)
	orig := connectWaiting
	connectWaiting = func() {
		select {
		case waiting <- struct{}{}:
		default:
		}
	}
	t.Cleanup(func() { connectWaiting = orig })

	type result struct {
		c   *Client
		err error
	}
	got := make(chan result, 1)
	go func() {
		c, err := Connect(ConnectOptions{})
		got <- result{c, err}
	}()
	select {
	case <-waiting:
	case r := <-got:
		t.Fatalf("Connect during the window before the address: %+v, %v; want it to wait", r.c, r.err)
	}

	s := &Server{reg: newRegistry(), token: testToken, startedAt: time.Now()}
	front := httptest.NewServer(s.routes())
	defer front.Close()
	s.addr = front.Listener.Addr().String()
	if err := lock.UpdateAddr(s.addr); err != nil {
		t.Fatal(err)
	}
	r := <-got
	if r.err != nil || r.c.Addr() != s.addr {
		t.Fatalf("Connect once the address was recorded: %+v, %v; want %s", r.c, r.err, s.addr)
	}
}

// deadPID returns the process ID of a process that has exited.
func deadPID(t *testing.T) int {
	t.Helper()
	cmd := exec.Command(os.Args[0], "-test.run=^$") //nolint:gosec // this test binary
	if err := cmd.Run(); err != nil {
		t.Fatalf("run a process to outlive: %v", err)
	}
	return cmd.Process.Pid
}

// TestConnectWaitsOnASilentHolderOnlyWhileItLives: Connect's wait on a lock
// holder that does not answer is bounded by that holder's progress, not by a
// clock. A held lock is a live holder — the OS lets a lock go with the process
// that held it — whether or not it has recorded itself in server.json yet. Only
// a lock that cannot be probed falls back on the process server.json names.
// And the server this Connect started is waited for while it lives.
func TestConnectWaitsOnASilentHolderOnlyWhileItLives(t *testing.T) {
	alive, dead := os.Getpid(), deadPID(t)
	ours := make(chan struct{})
	gone := make(chan struct{})
	close(gone)
	for _, c := range []struct {
		name string
		info *ServerInfo
		lock lockState
		ours <-chan struct{}
		want bool
	}{
		{"a holder that has recorded itself", &ServerInfo{PID: alive}, lockHeld, nil, true},
		{"a holder that has not recorded itself yet", nil, lockHeld, nil, true},
		{"a holder that has not yet replaced a dead server's record", &ServerInfo{PID: dead}, lockHeld, nil, true},
		{"the lock is free, whatever server.json says", &ServerInfo{PID: alive}, lockFree, nil, false},
		{"a lock that cannot be probed, recorded holder alive", &ServerInfo{PID: alive}, lockUnknown, nil, true},
		{"a lock that cannot be probed, recorded holder dead", &ServerInfo{PID: dead}, lockUnknown, nil, false},
		{"a lock that cannot be probed, nothing recorded", nil, lockUnknown, nil, false},
		{"the server this call started is on its way up", nil, lockFree, ours, true},
		{"the server this call started has exited", nil, lockFree, gone, false},
	} {
		if got := worthWaiting(c.info, c.lock, c.ours); got != c.want {
			t.Errorf("%s: worthWaiting = %v, want %v", c.name, got, c.want)
		}
	}
}

// TestConnectWithoutStartReportsNoServer: with no server running, and no way
// to start one, Connect says so — including when server.json names a server
// that has gone without releasing it.
func TestConnectWithoutStartReportsNoServer(t *testing.T) {
	userpathstest.Isolate(t)
	if _, err := Connect(ConnectOptions{}); !errors.Is(err, ErrNoServer) {
		t.Fatalf("Connect with no server.json: %v, want ErrNoServer", err)
	}
	publishServerInfo(t, ServerInfo{PID: 1, Addr: "127.0.0.1:1", Token: testToken})
	if _, err := Connect(ConnectOptions{}); !errors.Is(err, ErrNoServer) {
		t.Fatalf("Connect with a stale server.json: %v, want ErrNoServer", err)
	}
}

// TestConnectStartsAnImplicitServer: with no server running, Connect starts
// one detached, marked implicit, and returns once it answers — its address
// read from server.json, since the starter never reads its output.
func TestConnectStartsAnImplicitServer(t *testing.T) {
	userpathstest.Isolate(t)
	start, started := helperStarter(t)
	c, err := Connect(ConnectOptions{Start: start})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	if started() != 1 || !c.Started {
		t.Fatalf("Connect started %d servers (Started=%v), want 1", started(), c.Started)
	}
	info := NewMachineLock(userpaths.ConfigDir()).readInfo()
	if info == nil || info.Addr != c.Addr() || !info.Implicit || !c.Implicit {
		t.Fatalf("server.json %+v, client %+v: want the started server, marked implicit", info, c)
	}

	again, err := Connect(ConnectOptions{Start: start})
	if err != nil || again.Addr() != c.Addr() || again.Started || started() != 1 {
		t.Fatalf("second Connect: %+v, %v, %d started; want the running server reused", again, err, started())
	}
}

// TestConnectRacingStartersShareOneServer: two clients that find no server at
// once both start one. One wins the lock; the other's server exits, and its
// client waits for the winner rather than failing.
func TestConnectRacingStartersShareOneServer(t *testing.T) {
	userpathstest.Isolate(t)
	start, _ := helperStarter(t)
	type result struct {
		c   *Client
		err error
	}
	got := make(chan result, 2)
	for range 2 {
		go func() {
			c, err := Connect(ConnectOptions{Start: start})
			got <- result{c, err}
		}()
	}
	a, b := <-got, <-got
	if a.err != nil || b.err != nil {
		t.Fatalf("racing Connects: %v / %v", a.err, b.err)
	}
	if a.c.Addr() != b.c.Addr() || a.c.token != b.c.token {
		t.Fatalf("racing Connects reached different servers: %s and %s", a.c.Addr(), b.c.Addr())
	}
}

// TestOpenSessionWaitsForRunning: a client's OpenSession returns a session
// that is running, through a server it started.
func TestOpenSessionWaitsForRunning(t *testing.T) {
	home := userpathstest.Isolate(t)
	start, _ := helperStarter(t)
	c, err := Connect(ConnectOptions{Start: start})
	if err != nil {
		t.Fatalf("Connect: %v", err)
	}
	proj := filepath.Join(home, "proj")
	if err := os.Mkdir(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	sess, opened, err := c.OpenSession(proj)
	if err != nil || sess.State != SessionRunning || sess.Project != proj || !opened {
		t.Fatalf("OpenSession: %+v, opened %v, %v; want running for %s, spawned by this open", sess, opened, err, proj)
	}
	if again, opened, err := c.OpenSession(proj); err != nil || again.ID != sess.ID || opened {
		t.Fatalf("second OpenSession: %+v, opened %v, %v; want %s found, not spawned", again, opened, err, sess.ID)
	}
	if !strings.HasSuffix(c.SessionURL(sess.ID), "/s/"+sess.ID+"/") {
		t.Fatalf("SessionURL(%s) = %s", sess.ID, c.SessionURL(sess.ID))
	}
}
