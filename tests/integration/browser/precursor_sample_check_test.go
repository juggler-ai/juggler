//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package browser_test

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
	"testing"
	"time"
)

// TestStalledLaneSamplesThePoolOnce: the first lane of a pool server to fail
// "made no progress" has the server (and the WebKit processes it names)
// sampled there and then, kept where CI prints it. The main-thread watchdog's
// sample comes minutes later, if at all, and shows only the wedge the stall
// led to. A stand-in process plays the server. A failure that is not a stall
// must not spend the one sample, and a second stall must not take another: on
// a saturated machine every sample costs the lanes still running.
func TestStalledLaneSamplesThePoolOnce(t *testing.T) {
	if runtime.GOOS != "darwin" {
		t.Skip("only macOS has /usr/bin/sample")
	}
	stand := exec.Command("/bin/sleep", "60")
	if err := stand.Start(); err != nil {
		t.Fatalf("start the stand-in server: %v", err)
	}
	t.Cleanup(func() {
		_ = stand.Process.Kill()
		_ = stand.Wait()
	})
	dir := t.TempDir()
	p := &poolProc{
		pid:        stand.Process.Pid,
		stderrPath: filepath.Join(dir, "juggler-stderr-fake.log"),
		started:    time.Now(),
		exited:     make(chan struct{}),
	}
	srv := testServerEntry{addr: "127.0.0.1:1", proc: p}

	if got := samplePrecursor(srv, []string{"expected 3 rows, got 2"}); got != "" {
		t.Fatalf("sampled the pool for a failure that is not a stall:\n%s", got)
	}
	stall := []string{"[integration:x] Test made no progress for 25s (window 25s) — machine at give-up: load 1.0/CPU"}
	report := samplePrecursor(srv, stall)
	kept := filepath.Join(dir, fmt.Sprintf("juggler-precursor-sample-%d.log", p.pid))
	data, err := os.ReadFile(kept)
	if err != nil {
		t.Fatalf("the stalled pool's sample was not kept beside the stderr logs: %v\n%s", err, report)
	}
	if !strings.Contains(string(data), "sleep") {
		t.Fatalf("the kept sample is not of the pool server:\n%s", data)
	}
	if !strings.Contains(report, kept) {
		t.Errorf("the report doesn't say where the sample is kept (%s):\n%s", kept, report)
	}
	if again := samplePrecursor(srv, stall); again != "" {
		t.Errorf("sampled the same pool server a second time:\n%s", again)
	}
}
