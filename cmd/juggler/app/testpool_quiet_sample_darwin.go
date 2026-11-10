//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build darwin && !production

package app

import (
	"os/exec"
	"path/filepath"
	"strconv"
	"time"

	"juggler/internal/jlog"

	"github.com/wailsapp/wails/v3/pkg/application"
)

// quietEnginePIDsWait bounds the main-thread hop that names the engine's
// processes. A main thread that cannot answer in this long is itself the
// finding, and is logged as one rather than waited on.
const quietEnginePIDsWait = 10 * time.Second

// sampleQuietEngine samples the engine window's web, network and GPU processes
// (in that order) into the log dir when the server's supervisor finds the
// engine quiet for half its liveness window — with its socket still open, so
// the stacks show the realm as it stalled rather than after eviction. The
// engine's own console is unreadable, and its worker cannot report while it is
// the thing that stopped.
func sampleQuietEngine(engineWin *application.WebviewWindow) {
	logPath := jlog.FilePath()
	if logPath == "" {
		return
	}
	pidsCh := make(chan []int, 1)
	go func() {
		pidsCh <- application.InvokeSyncWithResult(func() []int { return webProcessPIDs(engineWin) })
	}()
	var pids []int
	select {
	case pids = <-pidsCh:
	case <-time.After(quietEnginePIDsWait):
		jlog.Error("[engine] quiet-engine sample: the main thread didn't name the engine's processes within %v", quietEnginePIDsWait)
		return
	}
	stamp := time.Now().Format("20060102-150405")
	for _, pid := range pids {
		path := filepath.Join(filepath.Dir(logPath), "engine-quiet-"+stamp+"-"+strconv.Itoa(pid)+".sample.log")
		cmd := exec.Command(samplePath, strconv.Itoa(pid),
			strconv.Itoa(int(stallSampleDuration/time.Second)), strconv.Itoa(stallSampleIntervalMS), "-file", path)
		if out, err := cmd.CombinedOutput(); err != nil {
			jlog.Error("[engine] quiet-engine sample of pid %d failed: %v: %s", pid, err, out)
			continue
		}
		jlog.Info("[engine] quiet-engine sample of pid %d: %s", pid, path)
	}
}
