//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package browser_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"slices"
	"strconv"
	"sync"
	"sync/atomic"
	"time"
)

// Slow-core mode: run the pool as if every process it uses were on a core
// FACTOR times slower than this one.
//
//	JUGGLER_TEST_SLOW_CORE=20 make check RUN='…'   (or `make check SLOW=20`)
//
// Code and tests must be correct on any core. A test that passes only when its
// lane is served promptly is a bug in that test, or in the code it covers, and
// such bugs used to surface only when a busy run happened to put the pool on a
// slow core. This puts it there on purpose, so a failure can be had on demand
// and a fix proven by watching that failure go away.
//
// The mechanism is a duty cycle: of every period, each pool process runs for
// period/FACTOR and is stopped for the rest (SIGSTOP/SIGCONT, or suspend and
// resume on Windows). That gives the same factor on any machine. No CPU is
// burned, so the machine stays quiet and nothing outside the pool slows. The
// processes are each pool server, everything descended from it (its tool
// subprocesses, and the web processes WebKitGTK and WebView2 start), and on
// macOS the WebKit XPC processes the server itself names
// (/api/test/process-pids), which are not its descendants.
//
// None of the machine's own readings move under it: load stays well under one
// per CPU while every lane runs twenty times slower. That is the point. A
// slow core is not something a wait may recognise and excuse.
//
// The processes are stopped in step, so no pool process sees another stopped
// while it runs, and a message handed from one to another (page to network
// process to server and back) is picked up in the next slice. That makes each
// hop between processes wait about a period, as a wake-up does on a starved
// core. It is why a lane's socket round trip, not its CPU-bound work, is what
// slows most. If this test binary is killed outright mid-cycle, the stopped
// processes stay stopped. A pool server's process group gets SIGCONT from the
// kernel once it is orphaned, but macOS's XPC web processes do not.
// `pkill -CONT -f com.apple.WebKit` frees them.
const (
	slowCoreEnv       = "JUGGLER_TEST_SLOW_CORE"
	slowCorePeriodEnv = "JUGGLER_TEST_SLOW_CORE_PERIOD_MS"
	// slowCoreDefaultPeriod is long enough that the stop and continue signals
	// are a small part of each slice at 20x, and short enough that a single
	// stop is below the 250ms a timer hop reads as a grid.
	slowCoreDefaultPeriod = 200 * time.Millisecond
	// slowCoreRefresh is how often the set of processes is re-read. A tool
	// subprocess or a reloaded page's new web process waits at most this long
	// before it is slowed too.
	slowCoreRefresh = time.Second
)

// slowCoreConfig reads the mode from the environment: the factor (0 when off)
// and the period it divides.
func slowCoreConfig() (factor int, period time.Duration, err error) {
	v := os.Getenv(slowCoreEnv)
	if v == "" || v == "0" || v == "1" {
		return 0, 0, nil
	}
	factor, err = strconv.Atoi(v)
	if err != nil || factor < 2 {
		return 0, 0, fmt.Errorf("%s=%q: want a whole slowdown factor of 2 or more", slowCoreEnv, v)
	}
	period = slowCoreDefaultPeriod
	if p := os.Getenv(slowCorePeriodEnv); p != "" {
		ms, err := strconv.Atoi(p)
		if err != nil || ms <= 0 {
			return 0, 0, fmt.Errorf("%s=%q: want a period in milliseconds", slowCorePeriodEnv, p)
		}
		period = time.Duration(ms) * time.Millisecond
	}
	if period/time.Duration(factor) < time.Millisecond {
		return 0, 0, fmt.Errorf("%s=%d over a %v period leaves under 1ms to run; lengthen %s", slowCoreEnv, factor, period, slowCorePeriodEnv)
	}
	return factor, period, nil
}

// slowCore duty-cycles the pool's processes until stop is called.
type slowCore struct {
	factor  int
	period  time.Duration
	entries []testServerEntry

	// pids is what the next slice stops; the refresher replaces it whole.
	pids atomic.Pointer[[]int]

	quit chan struct{}
	done chan struct{}
	once sync.Once
}

// startSlowCore starts slow-core mode over entries when the environment asks
// for it, and returns its off switch, which resumes everything it stopped. It
// is a no-op when the mode is off. An unusable setting stops the run: a run
// asked to be slow that is not is no evidence of anything.
func startSlowCore(entries []testServerEntry) func() {
	factor, period, err := slowCoreConfig()
	if err != nil {
		fmt.Fprintf(os.Stderr, "slow-core: %v\n", err)
		os.Exit(2)
	}
	if factor == 0 {
		return func() {}
	}
	if err := slowCoreSupported(); err != nil {
		fmt.Fprintf(os.Stderr, "slow-core: %v\n", err)
		os.Exit(2)
	}
	sc := &slowCore{factor: factor, period: period, entries: entries, quit: make(chan struct{}), done: make(chan struct{})}
	sc.refresh()
	fmt.Fprintf(os.Stderr, "slow-core: every pool process runs %v of every %v (%dx slower); %d process(es) to start with\n",
		period/time.Duration(factor), period, factor, len(sc.current()))
	go sc.refreshLoop()
	go sc.cycle()
	return sc.stop
}

func (sc *slowCore) current() []int {
	if p := sc.pids.Load(); p != nil {
		return *p
	}
	return nil
}

// refresh re-reads the processes to slow: each live server, its descendants,
// and the ones it names that are not.
func (sc *slowCore) refresh() {
	var roots, named []int
	for _, e := range sc.entries {
		if e.proc == nil || e.proc.dead() {
			continue
		}
		roots = append(roots, e.proc.pid)
		named = append(named, reportedProcessPIDs(e.addr)...)
	}
	pids, err := descendantsOf(roots)
	if err != nil {
		// Keep the last set: one failed listing slows nothing new for a second.
		return
	}
	for _, p := range named {
		if !slices.Contains(pids, p) {
			pids = append(pids, p)
		}
	}
	sc.pids.Store(&pids)
}

func (sc *slowCore) refreshLoop() {
	t := time.NewTicker(slowCoreRefresh)
	defer t.Stop()
	for {
		select {
		case <-sc.quit:
			return
		case <-t.C:
			sc.refresh()
		}
	}
}

// cycle stops and resumes the current set once per period. The resume is
// never skipped: quit is only looked at with everything running.
func (sc *slowCore) cycle() {
	defer close(sc.done)
	run := sc.period / time.Duration(sc.factor)
	stopped := sc.period - run
	for {
		select {
		case <-sc.quit:
			return
		default:
		}
		pids := sc.current()
		pauseProcesses(pids)
		time.Sleep(stopped)
		resumeProcesses(pids)
		time.Sleep(run)
	}
}

func (sc *slowCore) stop() {
	sc.once.Do(func() {
		close(sc.quit)
		<-sc.done
		// The set may have grown since the last slice; resume all of it, so
		// nothing the cycle ever stopped is left that way.
		resumeProcesses(sc.current())
	})
}

// reportedProcessPIDs asks a pool server for the processes running its pages
// that are not in its process tree. A server that cannot answer names none.
func reportedProcessPIDs(addr string) []int {
	client := &http.Client{Timeout: 5 * time.Second}
	resp, err := client.Get("http://" + addr + "/api/test/process-pids")
	if err != nil {
		return nil
	}
	defer resp.Body.Close()
	var body struct {
		PIDs []int `json:"pids"`
	}
	if resp.StatusCode != http.StatusOK || json.NewDecoder(resp.Body).Decode(&body) != nil {
		return nil
	}
	return body.PIDs
}

// descendantsFrom returns roots and every process descended from them, given
// each process's parent. The hop limit guards against cycles that pid reuse
// can leave in a parent table.
func descendantsFrom(roots []int, parent map[int]int) []int {
	isRoot := map[int]bool{}
	for _, r := range roots {
		isRoot[r] = true
	}
	out := slices.Clone(roots)
	for pid := range parent {
		if isRoot[pid] {
			continue
		}
		for p, hops := parent[pid], 0; p > 1 && hops < 32; p, hops = parent[p], hops+1 {
			if isRoot[p] {
				out = append(out, pid)
				break
			}
		}
	}
	return out
}
