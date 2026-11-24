//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"

	"juggler/cmd/juggler/machineserver"
	"juggler/internal/binwatch"
	"juggler/tests/helpers"
)

// relaunchStatus is what this test reads of GET /api/server/status.
type relaunchStatus struct {
	PID            int    `json:"pid"`
	InstalledBuild string `json:"installedBuild"`
	LAN            bool   `json:"lan"`
}

func (ms *machineServer) relaunchStatus() relaunchStatus {
	ms.t.Helper()
	resp, err := ms.do(http.MethodGet, "/api/server/status", nil)
	if err != nil {
		ms.t.Fatalf("status: %v", err)
	}
	defer resp.Body.Close()
	var st relaunchStatus
	body, _ := io.ReadAll(resp.Body)
	if err := json.Unmarshal(body, &st); err != nil {
		ms.t.Fatalf("status %s: %v", body, err)
	}
	return st
}

// installAnotherBuild puts another build at path, as a rebuild does: a copy of
// the binary there with one character of its build ID changed, written beside
// it and renamed over it while it runs. On macOS the copy is signed again, as
// the linker signs a build, since a changed byte voids the signature.
func installAnotherBuild(t *testing.T, path string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	at, _, err := binwatch.IDSpan(bytes.NewReader(data))
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	if data[at] == 'A' {
		data[at] = 'B'
	} else {
		data[at] = 'A'
	}
	next := path + ".new"
	if err := os.WriteFile(next, data, 0o755); err != nil {
		t.Fatal(err)
	}
	if runtime.GOOS == "darwin" {
		if out, err := exec.Command("codesign", "--force", "--sign", "-", next).CombinedOutput(); err != nil {
			t.Fatalf("codesign %s: %v: %s", next, err, out)
		}
	}
	// Windows lets a running binary be renamed, but not replaced by a rename
	// (MoveFileEx), so it goes aside first, as the updater and `make` put it.
	if runtime.GOOS == "windows" {
		if err := os.Rename(path, path+".old"); err != nil {
			t.Fatalf("move the running server's binary aside: %v", err)
		}
	}
	if err := os.Rename(next, path); err != nil {
		t.Fatalf("install over the running server: %v", err)
	}
}

// heldForTheUser is iso with its server kept from relaunching into a build
// installed under it by itself, so the test sees what a server does until it
// has.
func heldForTheUser(iso isolatedRun) isolatedRun {
	iso.env = helpers.EnvWithOverride(iso.env, machineserver.NoAutoRelaunchEnv, "1")
	return iso
}

// isolatedRunOfACopy is an isolatedRun whose binary is a copy of the suite's,
// in the run's own directory, so the test may install another build over it.
// It returns the run and the copy's path.
func isolatedRunOfACopy(t *testing.T) (isolatedRun, string) {
	t.Helper()
	iso := newIsolatedRun(t)
	name := filepath.Base(iso.binary)
	if runtime.GOOS == "windows" && !strings.HasSuffix(name, ".exe") {
		name += ".exe"
	}
	bin := filepath.Join(iso.base, "bin", name)
	if err := os.MkdirAll(filepath.Dir(bin), 0o755); err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(iso.binary)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(bin, data, 0o755); err != nil {
		t.Fatal(err)
	}
	iso.binary = bin
	return iso, bin
}

// TestMachineServerRefusesSessionsFromAnotherBuild: a server whose binary has
// been replaced by another build runs no session from it. The child it spawns
// is that other build, which sees it is not the server's and exits before its
// handshake, and the open fails at once — no restarts — as a session needing
// the server relaunched.
func TestMachineServerRefusesSessionsFromAnotherBuild(t *testing.T) {
	iso, bin := isolatedRunOfACopy(t)
	ms, stop := startMachineServerIn(t, heldForTheUser(iso))
	defer stop()

	installAnotherBuild(t, bin)

	resp, err := ms.do(http.MethodPost, "/api/server/sessions", map[string]string{"project": newProjectDir(t)})
	if err != nil {
		t.Fatalf("POST /api/server/sessions: %v", err)
	}
	body, _ := io.ReadAll(resp.Body)
	resp.Body.Close()
	var sess struct {
		ID             string `json:"id"`
		PID            int    `json:"pid"`
		Addr           string `json:"addr"`
		State          string `json:"state"`
		Error          string `json:"error"`
		Restarts       int    `json:"restarts"`
		RelaunchNeeded bool   `json:"relaunchNeeded"`
	}
	if err := json.Unmarshal(body, &sess); err != nil {
		t.Fatalf("decode session %s: %v", body, err)
	}
	if sess.PID != 0 {
		ms.children[sess.PID] = sess.Addr
	}
	if resp.StatusCode != http.StatusBadGateway || sess.State != "error" || !sess.RelaunchNeeded || sess.Restarts != 0 {
		t.Fatalf("opening a session from another build answered %d %s; want 502, state error, relaunchNeeded, no restarts", resp.StatusCode, body)
	}
}

// TestMachineServerRelaunchesIntoTheBuildInstalled: a server whose binary is
// replaced by another build while it runs says so in its status, and `juggler
// server relaunch` stops it and brings it back from that binary, run as it
// was — the same process on Unix, which execs, and a server started anew in
// every case — answering where server.json says, as a client finds it, with
// LAN access on as it was when it stopped.
func TestMachineServerRelaunchesIntoTheBuildInstalled(t *testing.T) {
	iso, bin := isolatedRunOfACopy(t)
	ms, stop := startMachineServerIn(t, heldForTheUser(iso))
	defer stop()
	before := ms.relaunchStatus()
	if before.InstalledBuild != "" {
		t.Fatalf("a server whose binary is its own build reports another installed: %q", before.InstalledBuild)
	}

	// Switched on while it runs, which is never saved: the relaunch hands it on.
	if code, out, errOut := ms.cli("server", "lan", "on"); code != 0 {
		t.Fatalf("juggler server lan on: exit %d\nstdout: %s\nstderr: %s", code, out, errOut)
	}
	installAnotherBuild(t, bin)
	// Bounded by the test's own deadline: the server looks every couple of
	// seconds, and reports once two looks agree.
	for ms.relaunchStatus().InstalledBuild == "" {
		time.Sleep(250 * time.Millisecond)
	}

	code, out, errOut := ms.cli("server", "relaunch")
	if code != 0 || !strings.Contains(out, "is back at") {
		t.Fatalf("juggler server relaunch = %d\nstdout: %s\nstderr: %s", code, out, errOut)
	}
	info := ms.readServerInfo()
	// Every start mints its control token afresh, so a new one is a new
	// server, whatever the clock says.
	if info.Token == ms.Token {
		t.Fatal("server.json still names the server that was asked to relaunch")
	}
	ms.Addr, ms.Token = info.Addr, info.Token
	after := ms.relaunchStatus()
	if !after.LAN {
		t.Fatal("LAN access was on as the server relaunched, and is off in the server that replaced it")
	}
	if runtime.GOOS != "windows" && after.PID != before.PID {
		t.Fatalf("relaunched as pid %d; want the same process (%d), exec'd", after.PID, before.PID)
	}
	select {
	case <-ms.exited:
		t.Fatal("the process the test started has exited; on Unix it is the relaunched server, on Windows it waits for it")
	default:
	}
}

// TestMachineServerTakesUpABuildInstalledWhileIdle: a server with no work
// running relaunches into a build installed under it by itself — once it has
// made sure the build starts — and the server that replaces it, built from
// that binary, sees no other build to take up.
func TestMachineServerTakesUpABuildInstalledWhileIdle(t *testing.T) {
	iso, bin := isolatedRunOfACopy(t)
	ms, stop := startMachineServerIn(t, iso)
	defer stop()
	installAnotherBuild(t, bin)
	// Bounded by the test's own deadline: the server looks every couple of
	// seconds, relaunches once two looks agree, and server.json names the
	// next server once it has started — and nothing between the two. The next
	// server writes its token before it listens and its address after
	// (MachineLock.UpdateAddr), so it is waited for with both.
	var info machineserver.ServerInfo
	for {
		b, err := os.ReadFile(filepath.Join(ms.ConfigDir, "server.json"))
		if err == nil && json.Unmarshal(b, &info) == nil && info.Token != "" && info.Token != ms.Token && info.Addr != "" {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	ms.Addr, ms.Token = info.Addr, info.Token
	if after := ms.relaunchStatus(); after.InstalledBuild != "" {
		t.Fatalf("the relaunched server reports another build installed: %q", after.InstalledBuild)
	}
}
