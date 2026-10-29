//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package machineserver

import (
	"bytes"
	"encoding/json"
	"net"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/userpaths"
	"juggler/internal/userpaths/userpathstest"
)

// cliServer runs a machine server's routes behind httptest and publishes it in
// server.json under an isolated home, as `juggler serve` would, so the CLI
// finds it the way it finds a real one.
func cliServer(t *testing.T) (*Server, string) {
	t.Helper()
	home := userpathstest.Isolate(t)
	s := &Server{reg: newRegistry(), token: testToken, shutdownReq: make(chan struct{}, 1), startedAt: time.Now()}
	front := httptest.NewServer(s.routes())
	s.addr = front.Listener.Addr().String()
	t.Cleanup(front.Close)
	t.Cleanup(s.stopAllChildren)
	publishServerInfo(t, ServerInfo{PID: os.Getpid(), Addr: front.Listener.Addr().String(), Version: "v9.9.9", StartedAt: time.Now(), Token: testToken})
	return s, home
}

// publishServerInfo writes server.json where the CLI looks for it.
func publishServerInfo(t *testing.T, info ServerInfo) {
	t.Helper()
	l := NewMachineLock(userpaths.ConfigDir())
	l.info = info
	if err := os.MkdirAll(userpaths.ConfigDir(), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := l.writeInfo(); err != nil {
		t.Fatal(err)
	}
}

// runCLI runs one CLI command and returns its exit code and output.
func runCLI(t *testing.T, run func(args []string, env CLIEnv) int, args ...string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	var opened []string
	code := run(args, CLIEnv{Stdout: &out, Stderr: &errOut, OpenBrowser: func(u string) error { opened = append(opened, u); return nil }})
	if len(opened) > 0 {
		out.WriteString("\nOPENED " + strings.Join(opened, " "))
	}
	return code, out.String(), errOut.String()
}

// TestCLIWithNoServerSaysHowToStartOne: with no server.json, or one naming a
// server that no longer answers, commands fail with instructions to start one.
func TestCLIWithNoServerSaysHowToStartOne(t *testing.T) {
	userpathstest.Isolate(t)
	for _, args := range [][]string{{"status"}, {"sessions"}, {"stop"}} {
		code, _, errOut := runCLI(t, RunServerCommand, args...)
		if code != 1 || !strings.Contains(errOut, "juggler serve") {
			t.Errorf("server %v with no server.json: exit %d, stderr %q", args, code, errOut)
		}
	}
	if code, _, errOut := runCLI(t, RunOpenCommand, t.TempDir()); code != 1 || !strings.Contains(errOut, "run `juggler` in the project") {
		t.Errorf("open with no server.json: exit %d, stderr %q", code, errOut)
	}

	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	dead := ln.Addr().String()
	_ = ln.Close()
	publishServerInfo(t, ServerInfo{PID: 1, Addr: dead, Token: testToken})
	if code, _, errOut := runCLI(t, RunServerCommand, "status"); code != 1 || !strings.Contains(errOut, "juggler serve") {
		t.Errorf("status against a server that has gone: exit %d, stderr %q", code, errOut)
	}
}

// TestCLIStatusAndSessions: status names the server and its session count;
// sessions lists each session's ID, state and project, or as JSON.
func TestCLIStatusAndSessions(t *testing.T) {
	s, _ := cliServer(t)
	a, _ := s.reg.reserve("/work/alpha")
	s.reg.setRunning(a.ID, &child{addr: "127.0.0.1:1"}, 11)
	b, _ := s.reg.reserve("/work/beta")
	s.reg.setError(b.ID, "it broke")

	code, out, errOut := runCLI(t, RunServerCommand, "status")
	if code != 0 || !strings.Contains(out, core.Version) || !strings.Contains(out, "http://"+s.addr+"/") || !strings.Contains(out, "2 sessions") {
		t.Fatalf("status: exit %d, stdout %q, stderr %q", code, out, errOut)
	}

	code, out, _ = runCLI(t, RunServerCommand, "sessions")
	if code != 0 {
		t.Fatalf("sessions: exit %d", code)
	}
	for _, want := range []string{a.ID, "/work/alpha", "idle", b.ID, "/work/beta", "error", "it broke"} {
		if !strings.Contains(out, want) {
			t.Errorf("sessions output lacks %q:\n%s", want, out)
		}
	}

	code, out, _ = runCLI(t, RunServerCommand, "sessions", "--json")
	var list []Session
	if code != 0 || json.Unmarshal([]byte(out), &list) != nil || len(list) != 2 {
		t.Fatalf("sessions --json: exit %d, output %q", code, out)
	}
}

// TestCLIStop: with no argument it shuts the server down; given a session ID or
// a project path (as typed, relative to where the command runs) it stops just
// that session.
func TestCLIStop(t *testing.T) {
	s, home := cliServer(t)
	proj := filepath.Join(home, "proj")
	if err := os.Mkdir(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	a, _ := s.reg.reserve(proj)
	s.reg.setRunning(a.ID, &child{addr: "127.0.0.1:1"}, 11)
	b, _ := s.reg.reserve("/work/beta")
	s.reg.setRunning(b.ID, &child{addr: "127.0.0.1:2"}, 12)

	t.Chdir(home)
	if code, _, errOut := runCLI(t, RunServerCommand, "stop", "proj"); code != 0 {
		t.Fatalf("stop proj: exit %d, stderr %q", code, errOut)
	}
	if _, ok := s.reg.get(a.ID); ok {
		t.Fatalf("stop by project left session %s", a.ID)
	}
	if code, _, errOut := runCLI(t, RunServerCommand, "stop", b.ID); code != 0 {
		t.Fatalf("stop %s: exit %d, stderr %q", b.ID, code, errOut)
	}
	if _, ok := s.reg.get(b.ID); ok {
		t.Fatalf("stop by ID left session %s", b.ID)
	}
	if code, _, errOut := runCLI(t, RunServerCommand, "stop", "nothing-here"); code != 1 || !strings.Contains(errOut, "nothing-here") {
		t.Fatalf("stop of an unknown session: exit %d, stderr %q", code, errOut)
	}
	if len(s.shutdownReq) != 0 {
		t.Fatal("stopping a session shut the server down")
	}
	if code, _, errOut := runCLI(t, RunServerCommand, "stop"); code != 0 || len(s.shutdownReq) != 1 {
		t.Fatalf("stop: exit %d, shutdown signalled %v, stderr %q", code, len(s.shutdownReq) == 1, errOut)
	}
}

// TestCLIOpen: open starts (or finds) the session for a folder given as typed —
// relative to where the command runs, or under ~ — and prints its URL; with
// --browser it opens it too.
func TestCLIOpen(t *testing.T) {
	useHelperChildren(t)
	s, home := cliServer(t)
	proj := filepath.Join(home, "proj")
	if err := os.Mkdir(proj, 0o755); err != nil {
		t.Fatal(err)
	}
	t.Chdir(home)

	code, out, errOut := runCLI(t, RunOpenCommand, "proj")
	if code != 0 {
		t.Fatalf("open proj: exit %d, stderr %q", code, errOut)
	}
	list := s.reg.snapshot()
	if len(list) != 1 || list[0].Project != proj {
		t.Fatalf("sessions after open = %+v, want one for %s", list, proj)
	}
	info := NewMachineLock(userpaths.ConfigDir()).readInfo()
	want := "http://" + info.Addr + "/s/" + list[0].ID + "/"
	if strings.TrimSpace(out) != want {
		t.Fatalf("open printed %q, want %q", out, want)
	}

	code, out, _ = runCLI(t, RunOpenCommand, "--browser", "~/proj")
	if code != 0 || !strings.Contains(out, "OPENED "+want) || len(s.reg.snapshot()) != 1 {
		t.Fatalf("open --browser ~/proj: exit %d, output %q, sessions %d", code, out, len(s.reg.snapshot()))
	}

	if code, _, errOut := runCLI(t, RunOpenCommand, filepath.Join(home, "missing")); code != 1 || !strings.Contains(errOut, "missing") {
		t.Fatalf("open of a missing folder: exit %d, stderr %q", code, errOut)
	}
	if code, _, _ := runCLI(t, RunOpenCommand); code != 2 {
		t.Fatalf("open with no folder: exit %d, want 2", code)
	}
}

// TestCLIUsage: an unknown or missing verb prints the verbs and exits 2.
func TestCLIUsage(t *testing.T) {
	userpathstest.Isolate(t)
	for _, args := range [][]string{{}, {"frobnicate"}} {
		code, _, errOut := runCLI(t, RunServerCommand, args...)
		if code != 2 || !strings.Contains(errOut, "status") || !strings.Contains(errOut, "sessions") || !strings.Contains(errOut, "stop") {
			t.Errorf("server %v: exit %d, stderr %q", args, code, errOut)
		}
	}
}
