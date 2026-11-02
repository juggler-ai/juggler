//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package bundlelaunch

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/unix"
)

// The helper bundle's identity, and the variables that steer a run of this
// test binary as the helper (TestHelperBundleProcess).
const (
	helperBundleID  = "studio.juggler.bundlelaunch-test"
	helperReportEnv = "JUGGLER_BUNDLELAUNCH_REPORT"
	helperHoldEnv   = "JUGGLER_BUNDLELAUNCH_HOLD"
	helperMarkerEnv = "JUGGLER_BUNDLELAUNCH_MARKER"
)

// checkInGiveUp is how long LaunchServices waits for a launched app to check
// in before it answers a launch that waits for that.
const checkInGiveUp = 30 * time.Second

// helperReport is what the helper finds about itself.
type helperReport struct {
	PID            int      `json:"pid"`
	PPID           int      `json:"ppid"`
	XPCServiceName string   `json:"xpcServiceName"`
	Args           []string `json:"args"`
	Marker         string   `json:"marker"`
}

// TestHelperBundleProcess is not a test: it is the executable of the bundle
// TestStartIsALaunchOfItsOwn starts, this test binary run again. It reports
// on itself, then holds until the hold FIFO is closed by the test.
func TestHelperBundleProcess(t *testing.T) {
	report := os.Getenv(helperReportEnv)
	if report == "" {
		t.Skip("run only as the bundle's executable")
	}
	b, _ := json.Marshal(helperReport{
		PID:            os.Getpid(),
		PPID:           os.Getppid(),
		XPCServiceName: os.Getenv("XPC_SERVICE_NAME"),
		Args:           os.Args[1:],
		Marker:         os.Getenv(helperMarkerEnv),
	})
	if err := os.WriteFile(report+".tmp", b, 0o600); err != nil {
		os.Exit(2)
	}
	if err := os.Rename(report+".tmp", report); err != nil {
		os.Exit(2)
	}
	hold, err := os.Open(os.Getenv(helperHoldEnv))
	if err != nil {
		os.Exit(2)
	}
	_, _ = io.Copy(io.Discard, hold)
	os.Exit(0)
}

// helperBundle makes a background-only app bundle in dir whose executable is
// this test binary, and returns its path.
func helperBundle(t *testing.T, dir string) string {
	t.Helper()
	bundle := filepath.Join(dir, "BundleLaunchTest.app")
	macos := filepath.Join(bundle, "Contents", "MacOS")
	if err := os.MkdirAll(macos, 0o755); err != nil {
		t.Fatal(err)
	}
	self, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	bin, err := os.ReadFile(self) //nolint:gosec // this test binary
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(macos, "BundleLaunchTest"), bin, 0o755); err != nil { //nolint:gosec // an executable
		t.Fatal(err)
	}
	plist := `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
	<key>CFBundleExecutable</key><string>BundleLaunchTest</string>
	<key>CFBundleIdentifier</key><string>` + helperBundleID + `</string>
	<key>CFBundleName</key><string>BundleLaunchTest</string>
	<key>CFBundlePackageType</key><string>APPL</string>
	<key>LSBackgroundOnly</key><true/>
</dict></plist>
`
	if err := os.WriteFile(filepath.Join(bundle, "Contents", "Info.plist"), []byte(plist), 0o600); err != nil {
		t.Fatal(err)
	}
	return bundle
}

// TestStartIsALaunchOfItsOwn starts a bundle and asserts it is a launch of its
// own: not a child of this process, in a launchd job named for the bundle and
// not for this process's job, with the arguments and environment it was
// given, and an exited channel that closes when it exits and not before.
func TestStartIsALaunchOfItsOwn(t *testing.T) {
	dir := t.TempDir()
	bundle := helperBundle(t, dir)
	report := filepath.Join(dir, "report.json")
	hold := filepath.Join(dir, "hold")
	if err := unix.Mkfifo(hold, 0o600); err != nil {
		t.Fatal(err)
	}
	const spaced = "an argument with spaces"
	env := append(os.Environ(),
		helperReportEnv+"="+report,
		helperHoldEnv+"="+hold,
		helperMarkerEnv+"=passed through",
		"XPC_SERVICE_NAME=the.starters.job",
	)
	began := time.Now()
	pid, exited, err := Start(bundle, []string{"-test.run=^TestHelperBundleProcess$", spaced}, env)
	if err != nil {
		t.Fatalf("Start: %v", err)
	}
	// The helper never checks in with LaunchServices as an app, as the
	// server never does. A launch that waits for it to is answered only when
	// LaunchServices gives up on it, 30 seconds on; a launch that does not
	// wait is answered in milliseconds. This is no wait, so it is not bounded
	// by progress: it tells those two apart, with room for a slow machine.
	if took := time.Since(began); took > checkInGiveUp/2 {
		t.Errorf("Start took %v: it waited for the process to check in with LaunchServices, which gives up after %v", took.Round(time.Millisecond), checkInGiveUp)
	}

	// Wait for the report while the helper lives.
	var got helperReport
	for {
		if b, err := os.ReadFile(report); err == nil { //nolint:gosec // the test's own temp file
			if err := json.Unmarshal(b, &got); err != nil {
				t.Fatalf("report: %v", err)
			}
			break
		}
		select {
		case <-exited:
			t.Fatal("the bundle's executable exited without reporting")
		case <-time.After(10 * time.Millisecond):
		}
	}

	if got.PID != pid {
		t.Errorf("Start returned pid %d, but the bundle's executable is pid %d", pid, got.PID)
	}
	if got.PPID == os.Getpid() {
		t.Errorf("the bundle's executable is a child of this process (ppid %d): it was not launched by LaunchServices", got.PPID)
	}
	if want := "application." + helperBundleID + "."; !strings.HasPrefix(got.XPCServiceName, want) {
		t.Errorf("the bundle's executable is in launchd job %q, want one of its own (%s…)", got.XPCServiceName, want)
	}
	if n := len(got.Args); n == 0 || got.Args[n-1] != spaced {
		t.Errorf("args = %q, want the last to be %q", got.Args, spaced)
	}
	if got.Marker != "passed through" {
		t.Errorf("%s = %q, want the environment Start was given", helperMarkerEnv, got.Marker)
	}

	select {
	case <-exited:
		t.Fatal("exited closed while the bundle's executable was still running")
	default:
	}
	w, err := os.OpenFile(hold, os.O_WRONLY, 0)
	if err != nil {
		t.Fatal(err)
	}
	_ = w.Close()
	<-exited
}

// TestStartReportsALaunchThatFails asserts that a bundle LaunchServices cannot
// launch is an error, not a pid.
func TestStartReportsALaunchThatFails(t *testing.T) {
	bundle := filepath.Join(t.TempDir(), "Missing.app")
	if pid, _, err := Start(bundle, nil, os.Environ()); err == nil {
		t.Fatalf("Start of a missing bundle returned pid %d and no error", pid)
	}
}

func TestBundle(t *testing.T) {
	dir := t.TempDir()
	bundle := helperBundle(t, dir)
	exe := filepath.Join(bundle, "Contents", "MacOS", "BundleLaunchTest")
	link := filepath.Join(dir, "link")
	if err := os.Symlink(exe, link); err != nil {
		t.Fatal(err)
	}
	realBundle, _ := filepath.EvalSymlinks(bundle)
	for _, p := range []string{exe, link} {
		if got, ok := Bundle(p); !ok || got != realBundle {
			t.Errorf("Bundle(%s) = %q, %v; want %q, true", p, got, ok, realBundle)
		}
	}

	// An executable in Contents/MacOS that is not the bundle's own.
	other := filepath.Join(bundle, "Contents", "MacOS", "other")
	if err := os.WriteFile(other, []byte("#!/bin/sh\n"), 0o755); err != nil { //nolint:gosec // an executable
		t.Fatal(err)
	}
	// A loose binary.
	loose := filepath.Join(dir, "loose")
	if err := os.WriteFile(loose, []byte("#!/bin/sh\n"), 0o755); err != nil { //nolint:gosec // an executable
		t.Fatal(err)
	}
	for _, p := range []string{other, loose, filepath.Join(dir, "missing")} {
		if got, ok := Bundle(p); ok {
			t.Errorf("Bundle(%s) = %q, true; want no bundle", p, got)
		}
	}
}

func TestWithoutJobEnv(t *testing.T) {
	got := withoutJobEnv([]string{"A=1", "XPC_SERVICE_NAME=x", "XPC_FLAGS=1", "__CFBundleIdentifier=y", "XPC_SERVICE_NAMED=kept", "B=2=3"})
	want := []string{"A=1", "XPC_SERVICE_NAMED=kept", "B=2=3"}
	if strings.Join(got, "\n") != strings.Join(want, "\n") {
		t.Errorf("withoutJobEnv = %q, want %q", got, want)
	}
}
