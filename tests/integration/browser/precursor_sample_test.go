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
	"slices"
	"strconv"
	"strings"
	"sync"
)

// The first stall is the moment worth sampling. A macOS pool server's main
// thread has been seen to wedge in WebKit's display refresh minutes after its
// lanes began failing "made no progress": the web side stalls first, and the
// watchdog's sample at the wedge shows only where that led. So the first lane
// of a server to fail that way has the server and the WebKit processes behind
// its pages sampled while the stall is going on.
const (
	// precursorStallMarker is in the failure the lane's stall watch writes
	// (watchForStall, web/js-tests/utilities/stall-watch.js).
	precursorStallMarker = "made no progress for"
	// precursorSampleSeconds and precursorSampleIntervalMS match the
	// watchdog's own sample (stallSampleDuration, cmd/juggler/app).
	precursorSampleSeconds    = 2
	precursorSampleIntervalMS = 10
	// precursorMainThreadLines caps each process's quoted main thread. Several
	// processes are quoted at once and the kept copies have the rest.
	precursorMainThreadLines = 40
)

// samplePrecursor samples srv's server process, and the WebKit processes it
// names (/api/test/process-pids), when errs is a lane's stall failure and
// nothing has sampled that server for one before. Each sample is kept beside
// the stderr logs as juggler-precursor-sample-<server>[-pid<N>].log, which CI's
// dump step prints. It returns the report to log with the failure, or "" when
// it sampled nothing: not a stall, not macOS, stderr discarded, or already
// sampled.
func samplePrecursor(srv testServerEntry, errs []string) string {
	p := srv.proc
	if runtime.GOOS != "darwin" || p == nil || p.stderrPath == "" || p.dead() {
		return ""
	}
	if !slices.ContainsFunc(errs, func(e string) bool { return strings.Contains(e, precursorStallMarker) }) {
		return ""
	}
	report := ""
	p.precursor.Do(func() { report = takePrecursorSamples(srv) })
	return report
}

// takePrecursorSamples samples the server and its WebKit processes at once, so
// every sample covers the same two seconds, and reports each main thread.
func takePrecursorSamples(srv testServerEntry) string {
	p := srv.proc
	dir := filepath.Dir(p.stderrPath)
	type target struct {
		pid  int
		kept string
	}
	targets := []target{{p.pid, filepath.Join(dir, fmt.Sprintf("juggler-precursor-sample-%d.log", p.pid))}}
	for _, pid := range reportedProcessPIDs(srv.addr) {
		targets = append(targets, target{pid, filepath.Join(dir, fmt.Sprintf("juggler-precursor-sample-%d-pid%d.log", p.pid, pid))})
	}
	errs := make([]error, len(targets))
	var wg sync.WaitGroup
	for i, tg := range targets {
		wg.Go(func() {
			out, err := exec.Command("/usr/bin/sample", strconv.Itoa(tg.pid),
				strconv.Itoa(precursorSampleSeconds), strconv.Itoa(precursorSampleIntervalMS),
				"-file", tg.kept).CombinedOutput()
			if err != nil {
				errs[i] = fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
			}
		})
	}
	wg.Wait()

	var b strings.Builder
	fmt.Fprintf(&b, "FIRST STALL ON THIS POOL SERVER (pid %d): sampled it and the %d WebKit processes it names, while the lane is stalled:\n",
		p.pid, len(targets)-1)
	for i, tg := range targets {
		what := "server"
		if i > 0 {
			what = "WebKit process " + strconv.Itoa(tg.pid)
		}
		if errs[i] != nil {
			fmt.Fprintf(&b, "%s: sampling failed: %v\n", what, errs[i])
			continue
		}
		data, err := os.ReadFile(tg.kept)
		if err != nil {
			fmt.Fprintf(&b, "%s: sample unreadable: %v\n", what, err)
			continue
		}
		fmt.Fprintf(&b, "%s (all threads kept at %s):\n", what, tg.kept)
		b.WriteString(mainThreadGraph(string(data), precursorMainThreadLines))
	}
	return b.String()
}
