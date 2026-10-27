//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package browser_test

import (
	"bufio"
	"flag"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"juggler/internal/srcroot"
	"juggler/tests/helpers"
)

// testServerEntry is one isolated Wails subprocess+fixture pair in the pool.
type testServerEntry struct {
	addr    string
	fixture string
	cmd     *exec.Cmd
	proc    *poolProc
}

// poolProc is the liveness record for one pool subprocess. Entries travel
// through testServerPool by value, so this hangs off them as a pointer: every
// lane holding a token of the same subprocess shares one record.
//
// It exists because a subprocess that dies mid-run is otherwise invisible. All
// N lanes live in ONE subprocess, so its death fails every remaining test with
// an anonymous "connection refused" — the same message whether the server
// force-exited on the main-thread watchdog, quit gracefully, or was OOM-killed.
// Nothing else in the harness can tell those apart: the exit status is the only
// evidence, and it is destroyed unless someone waits for it.
type poolProc struct {
	pid        int
	stderrPath string // empty when stderr was discarded
	started    time.Time
	exited     chan struct{} // closed once waitErr/exitedAt are set
	waitErr    error         // result of the single cmd.Wait()
	exitedAt   time.Time
	reported   sync.Once // the full post-mortem is printed once per subprocess
}

// dead reports whether the subprocess has exited, without blocking.
func (p *poolProc) dead() bool {
	if p == nil {
		return false
	}
	select {
	case <-p.exited:
		return true
	default:
		return false
	}
}

// watch performs the one and only cmd.Wait() for this subprocess and records
// its outcome. It runs after scannerDone closes: Wait closes the stdout pipe,
// and the os/exec contract forbids doing that while a reader is still working
// through it (the addr scanner reads until EOF, which the process exit itself
// delivers).
func (p *poolProc) watch(cmd *exec.Cmd, scannerDone <-chan struct{}) {
	<-scannerDone
	err := cmd.Wait()
	p.waitErr = err
	p.exitedAt = time.Now()
	close(p.exited)
}

// status renders the exit as a human phrase: "exit status 1", "signal: killed",
// or "exited cleanly (status 0)".
func (p *poolProc) status() string {
	if p.waitErr == nil {
		return "exited cleanly (status 0)"
	}
	return p.waitErr.Error()
}

// testServerPool holds the lanes every browser test that is not a `unit:` suite
// runs on (see lanePool for how a lane, or a whole subprocess, is taken).
var testServerPool *lanePool

// unitServerPool is the same for the `unit:` suites, on subprocesses of their
// own (see poolConfig.unitWindows). Nil when the unit suites share
// testServerPool; poolFor is the one place that decides.
var unitServerPool *lanePool

// poolFor is the pool a browser test runs on: a `unit:` suite on the unit pool
// when there is one, everything else on testServerPool.
func poolFor(name string) *lanePool {
	if unitServerPool != nil && strings.HasPrefix(name, "unit:") {
		return unitServerPool
	}
	return testServerPool
}

// allPools is every pool in use, for the passes that must reach every server.
func allPools() []*lanePool {
	if unitServerPool != nil {
		return []*lanePool{testServerPool, unitServerPool}
	}
	return []*lanePool{testServerPool}
}

// testLogDir is a throwaway directory the pool points every subprocess's logs
// at (via JUGGLER_LOG_DIR), so a test run never writes browser-test-*.log into
// the user's real application-log directory. Created in TestMain, removed on
// pool shutdown. Empty when unset (e.g. the -short path).
var testLogDir string

// testConfigDir is a throwaway per-user config root inherited by every pool
// subprocess. It isolates cache-backed convenience state such as recent models,
// plus credentials and settings, from the developer's real Juggler profile.
var testConfigDir string

// seededTestSettings is the settings.json every pool subprocess starts from: a
// user who has already declined the first-run walkthrough, so an app shell a
// test hosts never opens it over the page under test. The shell takes the same
// path a real user's does; nothing in the app checks for a test.
const seededTestSettings = `{"ui":{"onboardingDismissed":true}}` + "\n"

// seedTestSettings writes seededTestSettings into configDir unless a settings
// file is already there (a fixture restarted within one run keeps its own).
func seedTestSettings(configDir string) error {
	path := filepath.Join(configDir, "settings.json")
	if _, err := os.Stat(path); err == nil {
		return nil
	}
	if err := os.MkdirAll(configDir, 0o700); err != nil {
		return fmt.Errorf("seed test settings: %w", err)
	}
	if err := os.WriteFile(path, []byte(seededTestSettings), 0o600); err != nil {
		return fmt.Errorf("seed test settings: %w", err)
	}
	return nil
}

// testSkillsDir is an empty throwaway directory the pool points every
// subprocess's user-scoped skill discovery at (via JUGGLER_SKILLS_USER_DIR), so
// a server — which inherits the developer's real $HOME — never discovers their
// personal ~/.juggler or ~/.agents skills. A discovered skill auto-instantiates
// a Skills context item into every conversation, which would perturb thread
// item-count assertions and make tests pass or fail by the host's installed
// skills. Created in TestMain, removed on pool shutdown.
var testSkillsDir string

// poolConfig controls the test-pool topology.
//
//   - JUGGLER_TEST_WINDOWS=N: number of Wails-window subprocesses for every
//     test that is not a `unit:` suite (default 2; the unit suites have their
//     own, below). Each subprocess is fully isolated — its own SessionManager, engine,
//     WebSocket server, and its own WebKit content process. Cranking this up
//     gives perfect isolation but burns more memory and WebKit helper startup
//     time.
//
//   - JUGGLER_TEST_IFRAMES=N: number of test-runner iframes per subprocess
//     (default 3). Each iframe is its own JS realm with its own WebSocket
//     connection, but they share the subprocess's SessionManager, engine,
//     server actors — and its content process, so also one heap and one main
//     thread. Iframes stress-test the server-side concurrency that
//     windows-only topologies hide.
//
// Lanes for ordinary tests = (WINDOWS + UNIT_WINDOWS) × IFRAMES, beside the
// solo windows the exclusive suites run in (below). The defaults give 12 over
// four windows, two each way, plus one solo window per pool.
//
// On macOS the bound is not the host's CPU but its efficiency cores. WebKit
// runs the web process of a page nobody can see at background QoS (priority 4
// in `ps`), and on Apple silicon that QoS is scheduled on the efficiency cores
// alone: every pool window's lanes and its engine — two web processes per
// subprocess — share the two efficiency cores of a 10-core Mac while its eight
// performance cores idle. Measured 2026-10-23: whole runs with the CPUs 65–75%
// idle, a load average of 15–25 (threads queued for those two cores), and
// lanes' timers slipping by up to a second. So more windows means more web
// processes queued on the same two cores. On the browser package alone six
// ordinary windows (3+3×2) were the fastest shape measured (144–199s against
// 184s for 2+2×3), and seven (3+4×2) broke down (255s, timer hops of 1.8s, a
// lane that never answered). But under `make test-all`, which compiles and
// lints beside it, 3+3×2 with three solo windows failed every run on timer
// hops, while 2+2×3 with one solo window per pool ran the package clean in
// 186s. The defaults are that. Neither switching off WebKit's page-visibility
// process suppression nor forcing its throttle state lifted the background QoS
// (both SPIs exist on macOS 27; the processes stayed at priority 4), and
// un-backgrounding them from outside (`taskpolicy -B`) was undone within the
// second — the role follows the never-shown window.
//
// The knee was believed to be the host's CPU ("10 cores here"); whole-run CPU
// sampling killed that, and with it the reading of the 1-minute load average
// as CPU contention on this machine.
//
// How the lanes are SHAPED matters as much as how many there are, and 3×3 beats
// 1×9 on the same slot count: 46s and clean against 141–214s and 5–34 arbitrary
// failures. Lanes sharing a subprocess share its content process, so their
// heaps are one heap. Test pages accumulate what their tests do not release,
// and nine lanes' worth in one heap reaches ~2 GB partway through a run, at
// which point collection pauses land on all nine lanes at once: tests fail on
// their own timeouts, picked by luck rather than by fault, and the pool looks
// like it is failing at random. Three lanes' worth stays under that. Spreading
// them also thins the shared session each lane loads, which is a second-order
// win: a lane hydrates a doc per conversation in ITS subprocess, so a third of
// the siblings is a third of the documents.
//
// Three lanes per subprocess still puts several tabs on one server, which is
// what the iframe topology is for.
//
//   - JUGGLER_TEST_UNIT_WINDOWS=N: subprocesses that run only the `unit:` suites
//     (default 2), each with JUGGLER_TEST_IFRAMES lanes and its own project and
//     settings.json, on a pool of their own (unitServerPool). 0 puts the unit
//     suites back on the shared pool.
//
// The unit suites are separated because what they share with integration tests
// is not namespaced per test: a lane's project is the fixture its subprocess was
// given, and its settings.json is that subprocess's config dir. An integration
// test fills the project with conversations and files and writes settings as a
// user would; a unit suite asserting on a count in the project, or on a settings
// broadcast, then reads a sibling's work (`unit:project-folder`,
// `unit:updates-settings` — both closed in scratch/flaky-tests.md). Unit lanes
// still share among themselves, and all lanes in one window still share focus;
// an exclusive suite holding a subprocess to itself remains the answer to that.
// A unit lane's realm also runs nothing but unit suites, so one that leaves
// document-wide state behind meets more of them before the lane recycles; the
// unit runner fails a suite that leaves `<html>`/`<body>` changed
// (restoreDocumentState in web/js-tests/utilities/integration-test-executor.js).
//
//   - JUGGLER_TEST_SOLO_WINDOWS=N / JUGGLER_TEST_UNIT_SOLO_WINDOWS=N:
//     single-lane subprocesses kept for the exclusive suites of the shared pool
//     and of the unit pool (default 1 each). An exclusive suite needs a window
//     with no sibling lane in it; a one-lane window is that already, so the
//     exclusive suites run beside everything else at the cost of the solo
//     windows alone, where taking an ordinary window would drain it first and
//     then hold its other lanes idle. One each carries the measured exclusive
//     work, ~115s of unit suites and ~30s of the rest (2026-10-23), well inside
//     the run, and each further window is two more web processes on the
//     efficiency cores (above). 0 makes a pool's exclusive suites take one of
//     its ordinary windows whole (lanePool.acquireServer).
type poolConfig struct {
	windows         int
	iframes         int
	unitWindows     int
	soloWindows     int
	unitSoloWindows int
}

func loadPoolConfig() poolConfig {
	cfg := poolConfig{windows: 2, iframes: 3, unitWindows: 2, soloWindows: 1, unitSoloWindows: 1}
	for _, v := range []struct {
		env string
		dst *int
	}{{"JUGGLER_TEST_SOLO_WINDOWS", &cfg.soloWindows}, {"JUGGLER_TEST_UNIT_SOLO_WINDOWS", &cfg.unitSoloWindows}} {
		if s := os.Getenv(v.env); s != "" {
			if n, err := strconv.Atoi(s); err == nil && n >= 0 {
				*v.dst = n
			}
		}
	}
	if v := os.Getenv("JUGGLER_TEST_WINDOWS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.windows = n
		}
	}
	if v := os.Getenv("JUGGLER_TEST_IFRAMES"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 {
			cfg.iframes = n
		}
	}
	if v := os.Getenv("JUGGLER_TEST_UNIT_WINDOWS"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n >= 0 {
			cfg.unitWindows = n
		}
	}
	return cfg
}

// unboundedParallel is the -test.parallel raiseParallelToPool sets: more than
// any run has browser subtests, so it never binds.
const unboundedParallel = 4096

// raiseParallelToPool lifts -test.parallel, when it was not given explicitly,
// out of the way of the lane pools. A parallel browser subtest counts against
// -parallel from the moment it is released, including while it waits on its
// pool, so any finite cap near the lane count holds lanes idle: with the
// default (GOMAXPROCS, below the lane count on most machines) subtests queued
// on a full unit pool take every place while the shared pool's lanes stand
// empty, and an exclusive subtest waiting for a whole subprocess holds its
// place for as long as the drain takes — enough of them, and only the windows
// they hold are running. The pools are the real limit (lanePool), and waiting
// on one costs a parked goroutine, so -parallel is set beyond reach.
func raiseParallelToPool() {
	explicit := false
	flag.Visit(func(f *flag.Flag) {
		if f.Name == "test.parallel" {
			explicit = true
		}
	})
	if !explicit {
		_ = flag.Set("test.parallel", strconv.Itoa(unboundedParallel))
	}
}

// TestMain spins up the test-pool topology controlled by poolConfig and
// tears everything down after m.Run() returns.
func TestMain(m *testing.M) {
	flag.Parse()

	if testing.Short() {
		os.Exit(m.Run())
	}

	jugglerRoot, err := srcroot.Find(".")
	if err != nil {
		fmt.Fprintf(os.Stderr, "cannot find project root: %v\n", err)
		os.Exit(1)
	}

	binary := helpers.ServerBinary(jugglerRoot)
	srcFixture := filepath.Join(jugglerRoot, "tests", "benchmarks", "fixtures", "unit-test-fixture")

	log.SetOutput(io.Discard)

	cfg := loadPoolConfig()
	raiseParallelToPool()

	// Redirect every subprocess's logs into a throwaway dir so the run never
	// litters the user's real ~/Library/Logs/Juggler with browser-test-*.log.
	// Removed in poolHandle.shutdown alongside the fixtures.
	if dir, err := os.MkdirTemp("", "juggler-test-logs-*"); err == nil {
		testLogDir = dir
	} else {
		fmt.Fprintf(os.Stderr, "cannot create test log dir: %v\n", err)
		os.Exit(1)
	}

	// Isolate all per-user application state. Browser tests exercise real HTTP
	// endpoints, including recent-model writes, so inheriting the developer's
	// profile would let synthetic fixtures escape the test process.
	if dir, err := os.MkdirTemp("", "juggler-test-config-*"); err == nil {
		testConfigDir = dir
	} else {
		fmt.Fprintf(os.Stderr, "cannot create test config dir: %v\n", err)
		os.Exit(1)
	}

	// Isolate user-scoped skill discovery to an empty dir so the developer's
	// real ~/.juggler and ~/.agents skills never leak into a test conversation
	// (see testSkillsDir).
	if dir, err := os.MkdirTemp("", "juggler-test-skills-*"); err == nil {
		testSkillsDir = dir
	} else {
		fmt.Fprintf(os.Stderr, "cannot create test skills dir: %v\n", err)
		os.Exit(1)
	}

	testServerPool = newLanePool()
	startedPool := &poolHandle{}

	// Trap SIGINT/SIGTERM so a Ctrl-C or test-killing signal still reaps the
	// pool. The other escape hatch — Go's `panic: test timed out` from the
	// testing alarm — runs in a goroutine and crashes the process without
	// running deferreds; the subprocess-side parent-watchdog catches that.
	sigCh := make(chan os.Signal, 1)
	signal.Notify(sigCh, syscall.SIGINT, syscall.SIGTERM)
	go func() {
		<-sigCh
		startedPool.shutdown()
		os.Exit(130)
	}()

	if cfg.unitWindows > 0 {
		unitServerPool = newLanePool()
	}

	// Start the subprocesses; each ordinary one hosts cfg.iframes iframe lanes,
	// each solo one a single lane. One fixture dir per subprocess, passed to it
	// as --project: all iframes inside a subprocess share its
	// SessionManager+engine+WS, so they share that fixture too, and every lane
	// of the subprocess carries it. Tests collaborate on the shared root by
	// prefixing their filenames; a suite that cannot is declared exclusive and
	// given a subprocess to itself (see listExclusiveTests in
	// web/js-tests/utilities/integration-test-executor.js).
	soloPool, unitSoloPool := testServerPool, unitServerPool
	if unitSoloPool == nil {
		unitSoloPool = testServerPool // the unit suites, exclusive ones too, share the pool
	}
	pools := []struct {
		windows int
		iframes int
		pool    *lanePool
		solo    bool
	}{
		{cfg.windows, cfg.iframes, testServerPool, false},
		{cfg.unitWindows, cfg.iframes, unitServerPool, false},
		{cfg.soloWindows, 1, soloPool, true},
		{cfg.unitSoloWindows, 1, unitSoloPool, true},
	}
	for _, p := range pools {
		for w := 0; w < p.windows; w++ {
			fixtureDir, err := os.MkdirTemp("", "browser-test-*")
			if err != nil {
				fmt.Fprintf(os.Stderr, "cannot create fixture dir: %v\n", err)
				startedPool.shutdown()
				os.Exit(1)
			}

			if err := helpers.CopyDir(srcFixture, fixtureDir); err != nil {
				fmt.Fprintf(os.Stderr, "cannot copy fixture: %v\n", err)
				os.RemoveAll(fixtureDir)
				startedPool.shutdown()
				os.Exit(1)
			}

			entry, err := startJugglerSubprocess(binary, fixtureDir, p.iframes)
			if err != nil {
				fmt.Fprintf(os.Stderr, "cannot start juggler subprocess: %v\n", err)
				os.RemoveAll(fixtureDir)
				startedPool.shutdown()
				os.Exit(1)
			}

			startedPool.add(entry)
			// One lane per iframe: the pool lets no more tests into a
			// subprocess than it has iframes to run them.
			if p.solo {
				p.pool.addSolo(entry)
			} else {
				p.pool.add(entry, p.iframes)
			}
		}
	}

	awaitEngines(startedPool.entries)
	// After boot, so the mode prices the tests rather than the engines' start.
	startedPool.stopSlowCore = startSlowCore(startedPool.entries)

	code := m.Run()

	startedPool.shutdown()
	os.Exit(code)
}

// engineBootBudget bounds how long awaitEngines waits for a pool subprocess's
// engine. Generous because boot is when the machine is busiest: `test-all`
// compiles and lints on every core while the pool's engines come up.
const engineBootBudget = 2 * time.Minute

// awaitEngines waits until every pool subprocess's engine has connected, all
// of them at once, before any lane is handed out.
//
// A lane waits for the engine itself at the start of each test, but on the
// test's own 30s budget (waitForEngineConnected, integration-test-executor.js).
// That suits a reconnect mid-run and not a cold boot: printing JUGGLER_ADDR=
// only means the listener is up, and the window, its engine and their sockets
// follow — with every core busy compiling, past 30s, so the first test on each
// lane failed for a boot it had no part in. An engine that never connects is
// named here and the run goes on, so its lanes fail with their own blocks.
func awaitEngines(entries []testServerEntry) {
	type outcome struct {
		addr string
		err  error
	}
	done := make(chan outcome, len(entries))
	for _, e := range entries {
		go func() {
			deadline := time.Now().Add(engineBootBudget)
			for time.Now().Before(deadline) && !e.proc.dead() {
				var status struct {
					Connected bool `json:"connected"`
				}
				err := helpers.PollJSON(e.addr, "/api/engine/status", 5*time.Second, &status, e.proc.dead)
				if err == nil && status.Connected {
					done <- outcome{addr: e.addr}
					return
				}
				time.Sleep(200 * time.Millisecond)
			}
			done <- outcome{addr: e.addr, err: fmt.Errorf("engine not connected after %s", engineBootBudget)}
		}()
	}
	for range entries {
		if o := <-done; o.err != nil {
			fmt.Fprintf(os.Stderr, "pool subprocess %s: %v — its lanes will fail on their own deadline\n", o.addr, o.err)
		}
	}
}

// poolHandle owns the started subprocesses so they can be reaped exactly
// once, whether the run exits cleanly, via signal, or via Go's testing
// alarm panic. add() is called from a single goroutine before m.Run()
// starts; shutdown() is idempotent via sync.Once.
type poolHandle struct {
	entries []testServerEntry
	once    sync.Once
	// stopSlowCore ends slow-core mode (slow_core_test.go) and resumes what it
	// stopped; nil until the mode is started.
	stopSlowCore func()
}

func (p *poolHandle) add(e testServerEntry) {
	p.entries = append(p.entries, e)
}

func (p *poolHandle) shutdown() {
	p.once.Do(func() {
		// First: a stopped process acts on no SIGTERM.
		if p.stopSlowCore != nil {
			p.stopSlowCore()
		}
		cleanupPool(p.entries)
		for _, e := range p.entries {
			os.RemoveAll(e.fixture)
		}
		if testLogDir != "" {
			os.RemoveAll(testLogDir)
		}
		if testConfigDir != "" {
			os.RemoveAll(testConfigDir)
		}
		if testSkillsDir != "" {
			os.RemoveAll(testSkillsDir)
		}
	})
}

// startJugglerSubprocess starts a slot subprocess and returns the entry once
// JUGGLER_ADDR= is printed to stdout. With iframes>0 the subprocess opens its
// viewer window at /test-pool?n=iframes (one Wails window hosting N test
// lanes — a single one for a solo window, which still wants the pool host's
// sized, unthrottled page); with 0 it opens the production app, which
// self-redirects to /headless-test. Set JUGGLER_TEST_SHOW_WINDOW=1 to make the
// window visible.
func startJugglerSubprocess(binary, fixture string, iframes int) (testServerEntry, error) {
	args := []string{"--test", "--assets-from-disk", "--port", "0", "--project", fixture}
	if iframes > 0 {
		args = append(args, "--test-iframes", strconv.Itoa(iframes))
	}
	if os.Getenv("JUGGLER_TEST_SHOW_WINDOW") == "1" {
		args = append(args, "--window")
	}
	cmd := exec.Command(binary, args...)
	// Opt-in coalescing stress: set JUGGLER_TEST_SYNC_THROTTLE_MS to a larger
	// value to widen the outbound-sync window so a fast turn's busy→idle
	// transition always merges into one broadcast — useful for hunting waits
	// that depend on observing a transient state edge instead of a durable
	// fence (Conversation.completedTurns). NOT forced on by default: a global
	// throttle bump also slows every cross-conversation sync, which makes
	// load-sensitive multi-conv tests exceed their budget. The env is inherited
	// by the child (resolveSyncThrottle reads it in cmd/juggler/worker); the
	// default (10ms) is the production value. Run e.g.
	// `JUGGLER_TEST_SYNC_THROTTLE_MS=40 make test` for a targeted stress pass.
	cmd.Env = os.Environ()
	// Always enable the per-worker event tape in the pool. It's a fixed-size
	// ring buffer per conversation worker, so the cost is negligible, and it
	// is the only way a browser-test failure block can include the WORKER
	// TAPE section (the /api/test/dump-tape endpoint returns nothing when
	// tracing is off).
	cmd.Env = helpers.EnvWithOverride(cmd.Env, "JUGGLER_TRACE", "1")
	// Redirect this server's logs into the pool's throwaway dir (see testLogDir)
	// so the run never writes into the user's real application-log directory.
	if testLogDir != "" {
		cmd.Env = helpers.EnvWithOverride(cmd.Env, "JUGGLER_LOG_DIR", testLogDir)
	}
	// Redirect all user-level state, including cache-backed recent models, away
	// from the developer's profile.
	if testConfigDir != "" {
		configDir := filepath.Join(testConfigDir, filepath.Base(fixture))
		if err := seedTestSettings(configDir); err != nil {
			return testServerEntry{}, err
		}
		cmd.Env = helpers.EnvWithOverride(cmd.Env, "JUGGLER_CONFIG_DIR", configDir)
	}
	// Point user-scoped skill discovery at an empty throwaway dir (see
	// testSkillsDir) so the developer's real ~/.juggler / ~/.agents skills never
	// leak in as an auto-instantiated Skills context item and skew item counts.
	if testSkillsDir != "" {
		cmd.Env = helpers.EnvWithOverride(cmd.Env, "JUGGLER_SKILLS_USER_DIR", testSkillsDir)
	}
	// Put the child in its own process group so we can kill the whole group
	// (parent + any grandchildren) on cleanup. Without this, signals to the
	// test process don't reach Wails-spawned WebKit helpers, and they survive
	// as orphans when the test panics on Go's 15-minute alarm.
	helpers.SetProcGroupAttr(cmd)
	stdout, err := cmd.StdoutPipe()
	if err != nil {
		return testServerEntry{}, fmt.Errorf("stdout pipe: %w", err)
	}
	// Pipe stderr to a per-subprocess log under the platform temp dir so we can
	// post-mortem batch hangs after the fact — and so poolDeath can quote its
	// tail into the failing test, which is the only place a reader ever sees it
	// on CI. Set JUGGLER_TEST_DISCARD_STDERR=1 to skip.
	stderrPath := ""
	if os.Getenv("JUGGLER_TEST_DISCARD_STDERR") == "1" {
		cmd.Stderr = io.Discard
	} else {
		logDir := filepath.Join(os.TempDir(), "juggler-test-logs")
		if err := os.MkdirAll(logDir, 0o755); err != nil {
			return testServerEntry{}, fmt.Errorf("create log dir: %w", err)
		}
		stderrPath = filepath.Join(logDir, "juggler-stderr-"+filepath.Base(fixture)+".log")
		stderrFile, err := os.Create(stderrPath)
		if err != nil {
			return testServerEntry{}, fmt.Errorf("stderr file: %w", err)
		}
		cmd.Stderr = stderrFile
	}

	if err := cmd.Start(); err != nil {
		return testServerEntry{}, fmt.Errorf("start: %w", err)
	}

	proc := &poolProc{
		pid:        cmd.Process.Pid,
		stderrPath: stderrPath,
		started:    time.Now(),
		exited:     make(chan struct{}),
	}

	addrCh := make(chan string, 1)
	scannerDone := make(chan struct{})
	go func() {
		defer close(scannerDone)
		scanner := bufio.NewScanner(stdout)
		for scanner.Scan() {
			line := scanner.Text()
			if after, ok := strings.CutPrefix(line, "JUGGLER_ADDR="); ok {
				addrCh <- after
			}
		}
	}()
	// The single owner of cmd.Wait() for this subprocess, for the whole run: a
	// second Wait elsewhere would race it and lose the exit status.
	go proc.watch(cmd, scannerDone)

	select {
	case addr := <-addrCh:
		return testServerEntry{addr: addr, fixture: fixture, cmd: cmd, proc: proc}, nil
	case <-time.After(60 * time.Second):
		helpers.SignalGroup(cmd, syscall.SIGKILL)
		<-proc.exited
		return testServerEntry{}, fmt.Errorf("timeout waiting for JUGGLER_ADDR from %s", binary)
	}
}

// cleanupPool gracefully terminates all subprocess entries in the slice.
// Signals the entire process group (children too — Wails spawns WebKit
// helpers) so nothing survives as an orphan.
func cleanupPool(entries []testServerEntry) {
	for _, e := range entries {
		helpers.SignalGroup(e.cmd, syscall.SIGTERM)
	}
	// Wait on each subprocess's liveness record rather than calling cmd.Wait()
	// here: the watch goroutine started at spawn already owns that call.
	done := make(chan struct{})
	go func() {
		for _, e := range entries {
			if e.proc != nil {
				<-e.proc.exited
			}
		}
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(10 * time.Second):
		for _, e := range entries {
			helpers.SignalGroup(e.cmd, syscall.SIGKILL)
		}
	}
}
