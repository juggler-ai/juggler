//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build !windows

package integration_test

import (
	"bufio"
	"errors"
	"net/http"
	"os/exec"
	"strconv"
	"strings"
	"syscall"
	"testing"
	"time"

	"juggler/tests/helpers"
)

// TestMachineServerExitsWithItsParent: a `juggler serve --exit-with-parent`
// whose parent dies without a word — a test binary killed by its -timeout
// alarm, a Ctrl-C the server's own process group never receives — stops, and
// takes its session children with it. Without it every such death left a
// machine server serving under a deleted temporary HOME until reboot.
//
// The parent is a shell standing in for the test binary, so the test can kill
// it and survive.
func TestMachineServerExitsWithItsParent(t *testing.T) {
	iso := newIsolatedRun(t)
	sh := exec.Command("/bin/sh", "-c", `"$0" serve --port 0 --exit-with-parent & echo "SERVE_PID=$!"; wait`, iso.binary)
	sh.Env = iso.env
	helpers.SetProcGroupAttr(sh)
	stdout, err := sh.StdoutPipe()
	if err != nil {
		t.Fatalf("stdout pipe: %v", err)
	}
	if err := sh.Start(); err != nil {
		t.Fatalf("start the stand-in parent: %v", err)
	}

	lines := make(chan string, 16)
	go func() {
		defer close(lines)
		sc := bufio.NewScanner(stdout)
		for sc.Scan() {
			lines <- sc.Text()
		}
	}()
	go func() { _ = sh.Wait() }()

	var servePID int
	var addr string
	// Whatever this test concludes, nothing it started outlives it.
	var childPID int
	t.Cleanup(func() {
		helpers.SignalGroup(sh, syscall.SIGKILL)
		for _, pid := range []int{servePID, childPID} {
			if pid > 0 {
				_ = syscall.Kill(pid, syscall.SIGKILL)
			}
		}
	})

	deadline := time.After(machineServerStartTimeout)
	for servePID == 0 || addr == "" {
		select {
		case line, ok := <-lines:
			if !ok {
				t.Fatalf("serve --exit-with-parent ended before printing its address (pid %d, addr %q)", servePID, addr)
			}
			if v, ok := strings.CutPrefix(line, "SERVE_PID="); ok {
				servePID, _ = strconv.Atoi(strings.TrimSpace(v))
			}
			if v, ok := strings.CutPrefix(line, "JUGGLER_ADDR="); ok {
				addr = strings.TrimSpace(v)
			}
		case <-deadline:
			t.Fatalf("serve --exit-with-parent printed no address within %s", machineServerStartTimeout)
		}
	}

	ms := &machineServer{t: t, Addr: addr, Home: iso.home, ConfigDir: configDirUnder(iso.home), Logs: iso.logs, iso: iso,
		children: map[int]string{}}
	ms.Token = ms.readServerInfo().Token
	child := ms.openSession(newProjectDir(t), http.StatusCreated)
	childPID = child.PID

	// The parent dies; the server's process group is its own, so no signal
	// reaches it.
	if err := syscall.Kill(sh.Process.Pid, syscall.SIGKILL); err != nil {
		t.Fatalf("kill the stand-in parent: %v", err)
	}

	gone := time.After(2 * machineServerStopTimeout)
	for alive(servePID) || alive(childPID) {
		select {
		case <-gone:
			t.Fatalf("after its parent died: machine server pid %d alive=%v, its session child pid %d alive=%v",
				servePID, alive(servePID), childPID, alive(childPID))
		case <-time.After(100 * time.Millisecond):
		}
	}
}

// alive reports whether pid names a process that has not exited and been
// reaped.
func alive(pid int) bool {
	err := syscall.Kill(pid, 0)
	return err == nil || errors.Is(err, syscall.EPERM)
}
