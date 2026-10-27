//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package browser_test

import (
	"encoding/json"
	"flag"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"
	"time"

	"juggler/internal/machineload"
	"juggler/tests/helpers"
)

// harnessHTTPTimeout bounds every harness→server HTTP request; see
// helpers.HarnessHTTPTimeout for why it must.
const harnessHTTPTimeout = helpers.HarnessHTTPTimeout

// listDiscoveryTimeout bounds the wait for the harness to enumerate its tests
// and POST them back to /api/test/names after the __list__ trigger. Unlike a
// per-test run — where the harness iframes are already loaded and connected —
// discovery is the FIRST thing the suite does, so it races a cold engine boot:
// the pool hands out a lane the instant the subprocess prints JUGGLER_ADDR=
// (HTTP listener up), which is well before the WebView2/WebKit host has loaded
// the test-pool page, brought up every iframe, and connected their sockets. On
// a loaded CI runner under `-race` that warm-up is slow (Windows especially),
// and a budget shorter than the boot budget makes discovery time out before the
// harness is ever ready — failing the whole suite. Match the 60s subprocess-boot
// and per-test budgets so discovery gets the same slack as everything else.
const listDiscoveryTimeout = 60 * time.Second

// TestBrowser runs all browser-side tests in parallel. Each JS test becomes a
// subtest addressable via -run, e.g. go test -run 'TestBrowser/integration:glob-go-files'.
//
// Each test acquires a lane on a Wails subprocess+fixture from the pool poolFor
// names — the unit pool for a `unit:` suite, testServerPool for the rest — and
// shares that subprocess's session only with the lanes of its own pool.
//
// Reading the timings: `--- PASS: TestBrowser (2s)` is NOT what this test
// costs. Go stops a parent's clock before it waits on its parallel subtests, so
// that figure covers only discovery and the initial fixture reset — every
// subtest is parallel, and their time shows up only as the package total.
// Profile against `ok juggler/tests/integration/browser <total>`.
func TestBrowser(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping browser tests in short mode")
	}

	// Use any pool lane to fetch the test list (read-only, no fixture writes needed).
	srv := testServerPool.acquire()
	names, exclusive, err := listBrowserTests(srv)
	testServerPool.release(srv)
	if err != nil {
		t.Fatalf("cannot list browser tests: %v", err)
	}
	if len(names) == 0 {
		t.Fatal("browser returned empty test list")
	}

	// Wipe each pool slot's fixture (preserving .juggler/ session state) so
	// `-count=N` iterations don't see leftover test files from the prior
	// iteration ("Created file" vs "Updated file" mismatches, etc.). The
	// iframe-pool integration runner skips its per-test wipe because it
	// would clobber sibling tests' in-flight files; this once-per-iteration
	// reset is the safe equivalent that runs while no tests are in flight.
	resetAllFixtures(t)

	// After every subtest (including the parallel phase) completes: any
	// conversation still in the server's ownership ledger was created by a
	// test and never deleted. Leaks march the shared session toward the
	// MAX_CONVERSATIONS cap — the pressure behind the historical cross-lane
	// bulldoze flakes — so they fail the run loudly, named by creator lane.
	t.Cleanup(func() { reportLeakedConversations(t) })

	exclusiveSet := make(map[string]bool, len(exclusive))
	for _, p := range exclusive {
		exclusiveSet[p] = true
	}

	// selected counts the subtests -run let through. A subtest's function is
	// entered synchronously by t.Run — a parallel one runs up to t.Parallel()
	// before t.Run returns — so the count is complete once both loops below have
	// registered everything. A filter that selects none would otherwise leave
	// TestBrowser passing with nothing run: the usual cause is a name given
	// without its `unit:`/`integration:` prefix.
	selected := 0
	defer func() {
		if selected == 0 && !t.Failed() {
			t.Fatalf("-run %q selected none of the %d browser tests; a browser test is "+
				"TestBrowser/unit:<name> or TestBrowser/integration:<name>",
				flag.Lookup("test.run").Value.String(), len(names))
		}
	}()

	// Every test runs in parallel, fanned across the pools. Most take one lane.
	// An exclusive test takes every lane of one subprocess (acquireServer) and
	// so has that window to itself while the other windows carry on. Two kinds
	// are exclusive, both because they contend on something the lanes of a
	// subprocess share and cannot namespace per test:
	//
	//   - Fixture-root polluters write a fixed-name file (e.g. CLAUDE.md) that
	//     production auto-detection scans on every createConversation. A fixed
	//     filename can't hide behind a per-test prefix, so a sibling lane's
	//     createConversation would pick it up. Each subprocess has a fixture of
	//     its own, so only its own lanes can.
	//   - Focus-sensitive tests assert on document.activeElement. The lanes of a
	//     subprocess are iframes in ONE window, and a window has exactly one
	//     focused frame: any sibling calling element.focus() takes frame focus
	//     away, which blurs the asserting lane's element to <body>. That is a
	//     property of the pool topology, not of the code under test, so these
	//     tests are only meaningful with no sibling in their window.
	//
	// The same goes for state an origin keeps (localStorage, a stubbed fetch
	// seen by the server's settings): each subprocess is its own origin.
	// The fixture is reset before an exclusive test, so a previous polluter's
	// file can't linger, and after it, so its own can't reach the ordinary
	// tests that run there next. Subtest names stay flat (TestBrowser/<name>),
	// preserving `-run` filters.
	exclusiveIn := map[*lanePool]int{}
	for _, name := range names {
		name := name
		exclusive := exclusiveSet[name]
		t.Run(name, func(t *testing.T) {
			selected++ // before t.Parallel(), while t.Run is still waiting on it
			if exclusive {
				exclusiveIn[poolFor(name)]++
			}
			t.Parallel()

			pool := poolFor(name)
			if !exclusive {
				srv := pool.acquire()
				defer pool.release(srv)
				runOneBrowserTest(t, srv)
				return
			}
			srv := pool.acquireServer()
			defer pool.releaseServer(srv)
			resetFixture(t, srv)
			defer resetFixture(t, srv)
			runOneBrowserTest(t, srv)
		})
	}

	// Every subtest -run selected has been counted (each is entered up to its
	// t.Parallel before t.Run returns) and none has started (they wait for this
	// function to return), so each pool learns how many exclusive tests it will
	// see before the first arrives — and frees its solo windows after the last.
	for _, pool := range allPools() {
		pool.expectExclusive(exclusiveIn[pool])
	}
}

// resetAllFixtures resets every pool subprocess's fixture, wiping any files
// left over from a prior `-count` iteration. It holds every subprocess whole
// while it does, so no test is in flight to have its files clobbered; they go
// back on the way out even when a reset fails, or the next test would wait
// forever.
func resetAllFixtures(t *testing.T) {
	t.Helper()
	for _, pool := range allPools() {
		held := pool.acquireAll()
		func() {
			defer pool.releaseAll(held)
			for _, s := range held {
				resetFixture(t, s)
			}
		}()
	}
}

// resetFixture POSTs /api/test/reset-fixture to one subprocess, wiping its
// fixture apart from .juggler/ session state. The caller must hold every lane
// of that subprocess.
func resetFixture(t *testing.T, s testServerEntry) {
	t.Helper()
	url := fmt.Sprintf("/api/test/reset-fixture?fixture=unit-test-fixture&dir=%s",
		neturlEscape(s.fixture))
	client := &http.Client{Timeout: harnessHTTPTimeout}
	resp, err := client.Post("http://"+s.addr+url, "application/json", nil)
	if err != nil {
		t.Fatalf("reset-fixture failed for %s: %v", s.addr, err)
	}
	resp.Body.Close()
	if resp.StatusCode >= 300 {
		t.Fatalf("reset-fixture %s returned %d", s.addr, resp.StatusCode)
	}
}

// reportLeakedConversations queries every pool server's test-mode ownership
// ledger and fails the run if any conversation created by a test still
// exists. Runs from TestBrowser's cleanup, after all subtests (and their
// lanes' own cleanup deletes) have finished, so anything still owned is a
// genuine leak — the entry's lane id plus the per-lane delete attribution in
// the server log identify the leaking test.
func reportLeakedConversations(t *testing.T) {
	t.Helper()
	for _, pool := range allPools() {
		for _, s := range pool.entries() {
			client := &http.Client{Timeout: harnessHTTPTimeout}
			resp, err := client.Get("http://" + s.addr + "/api/test/conversation-owners")
			if err != nil {
				t.Errorf("conversation-owners check failed for %s: %v", s.addr, err)
			} else {
				// A non-200 means the ownership endpoint is unwired — which
				// also means the cross-lane delete guard is unwired. Fail
				// loudly rather than letting the leak check pass vacuously
				// (that exact silent unwiring has happened: the sessionAPI
				// field was zeroed by a wholesale struct reassignment).
				if resp.StatusCode != http.StatusOK {
					t.Errorf("conversation-owners returned %d on %s — the ownership "+
						"guard/leak check is not wired; see RegisterTestRoutes", resp.StatusCode, s.addr)
				}
				var body struct {
					Owners map[string]struct {
						Lane   string `json:"lane"`
						Reason string `json:"reason"`
					} `json:"owners"`
				}
				if err := json.NewDecoder(resp.Body).Decode(&body); err == nil && len(body.Owners) > 0 {
					lines := make([]string, 0, len(body.Owners))
					for id, o := range body.Owners {
						reason := o.Reason
						if reason == "" {
							reason = "unknown test"
						}
						lines = append(lines, fmt.Sprintf("%s (created by %s, lane %s)", id, reason, o.Lane))
					}
					sort.Strings(lines)
					t.Errorf("LEAKED CONVERSATIONS on %s (created by a test, never deleted): %s — "+
						"these accumulate in the shared session toward the MAX_CONVERSATIONS cap; "+
						"the creating test must delete what it creates", s.addr, strings.Join(lines, "; "))
				}
				resp.Body.Close()
			}
		}
	}
}

// neturlEscape is a tiny inline url.QueryEscape stand-in to avoid pulling
// net/url just for one call site.
func neturlEscape(s string) string {
	const hex = "0123456789ABCDEF"
	var b []byte
	for i := 0; i < len(s); i++ {
		c := s[i]
		if (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_' || c == '.' || c == '~' || c == '/' {
			b = append(b, c)
		} else {
			b = append(b, '%', hex[c>>4], hex[c&15])
		}
	}
	return string(b)
}

// listBrowserTests triggers list mode on the Wails subprocess and waits for the
// names to be POSTed back to /api/test/names. It returns every test name plus
// the subset that must run with no sibling in flight on their server (see the
// exclusive tests in TestBrowser).
func listBrowserTests(srv testServerEntry) (names, exclusive []string, err error) {
	if err := postToServer(srv, "/api/test/run", map[string]any{
		"name": "__list__",
	}); err != nil {
		return nil, nil, fmt.Errorf("POST __list__: %w%s", err, prefixedPoolDeath(srv))
	}

	var payload struct {
		Names     []string `json:"names"`
		Exclusive []string `json:"exclusive"`
	}
	if err := pollServer(srv, "/api/test/names", listDiscoveryTimeout, &payload); err != nil {
		return nil, nil, fmt.Errorf("waiting for test names: %w%s", err, prefixedPoolDeath(srv))
	}
	return payload.Names, payload.Exclusive, nil
}

// The lane in the browser is the authority on when a test has failed: it fails
// one that has made no progress for its window (`perTestTimeoutMs`, 25s), then
// spends up to 5s building the failure block, which it posts with tapes and a
// trace attached. The harness's wait exists for the case where no result is
// posted at all: the lane itself died, or the server stopped answering.
//
// So the harness waits while the lane keeps saying its test is moving
// (POST /api/test/progress, reportTestProgress in
// web/js-tests/utilities/progress-report.js), and gives up only after
// resultSilenceWindow with neither a result nor a report. A fixed wall-clock
// wait failed every long test on a slow core while it was still running, as a
// bare "timeout polling /api/test/result" naming nothing.
const (
	// resultSilenceWindow sits clear of the lane's own worst case for a test
	// that has stopped (its 25s window, the diagnostics build, the result
	// POST's retries), so a stopped test is reported by the lane, not here.
	resultSilenceWindow = 120 * time.Second
	// resultCeiling is the backstop for a lane that reports progress forever.
	// Under the package's 15m -timeout (Makefile), so it reports first.
	resultCeiling = 12 * time.Minute
)

// pollResultWhileProgressing waits for name's result on srv for as long as its
// lane keeps reporting progress, up to resultCeiling.
func pollResultWhileProgressing(srv testServerEntry, name string, out any) error {
	started := time.Now()
	for {
		err := pollServer(srv, "/api/test/result?name="+name, resultSilenceWindow, out)
		if err == nil || srv.proc.dead() {
			return err
		}
		a, aerr := fetchAudit(srv.addr, name)
		if aerr != nil {
			return err
		}
		recent := a.ProgressAgeMs >= 0 && time.Duration(a.ProgressAgeMs)*time.Millisecond < resultSilenceWindow
		if !recent {
			return fmt.Errorf("%w — no result, and the lane last reported progress %s", err, progressAgo(a.ProgressAgeMs))
		}
		if time.Since(started) >= resultCeiling {
			return fmt.Errorf("%w — the lane was still reporting progress (%d reports, the last %s ago) after %v, the ceiling for one test",
				err, a.Progress, agoString(a.ProgressAgeMs), resultCeiling)
		}
	}
}

// progressAgo renders a progress report's age for a failure line.
func progressAgo(ms int64) string {
	if ms < 0 {
		return "never"
	}
	return agoString(ms) + " ago"
}

// runOneBrowserTest triggers one named test via the HTTP API and polls for its result.
func runOneBrowserTest(t *testing.T, srv testServerEntry) {
	name := t.Name()[len("TestBrowser/"):]

	// Outer watchdog: dumps goroutines if the inner polling deadline somehow
	// doesn't fire (e.g. the goroutine running this test is itself stuck).
	helpers.PerTestTimeout(t, resultCeiling+resultSilenceWindow)

	// All iframes in a subprocess share the SessionManager's working dir
	// (srv.fixture) — the server-side path validator joins relative tool-
	// input paths against THAT, so a per-test scratch sub-dir wouldn't
	// actually isolate file IO. Tests collaborate on the shared fixture by
	// using unique filename prefixes (see comments at the top of every
	// *-tests.js file).
	if err := postToServer(srv, "/api/test/run", map[string]any{
		"name":        name,
		"projectPath": srv.fixture,
	}); err != nil {
		t.Fatalf("POST test run: %v%s", err, prefixedPoolDeath(srv))
	}

	var result struct {
		Passed        bool     `json:"passed"`
		Details       string   `json:"details"`
		Errors        []string `json:"errors"`
		BudgetWarning string   `json:"budgetWarning"`
	}
	if err := pollResultWhileProgressing(srv, name, &result); err != nil {
		// A dead server makes the queue audit unanswerable, so the audit's own
		// "unavailable (connection refused)" would be the only clue. Report the
		// death instead: it says what the audit cannot.
		if death := poolDeath(srv); death != "" {
			t.Fatalf("waiting for test result: %v\n%s", err, death)
		}
		// The machine reading is ours to take here: no result came back, so the
		// lane never assembled a failure block to carry one of its own.
		t.Fatalf("waiting for test result: %v\n%s%s\n%s", err,
			queueAudit(srv.addr, name), projectSize(srv.addr), machineload.Line())
	}

	if !result.Passed {
		if len(result.Errors) > 0 {
			for _, e := range result.Errors {
				t.Error(e)
			}
		} else {
			t.Error(result.Details)
		}
		return
	}
	recordSuiteBudget(t, result.BudgetWarning)
}

// suiteBudgetLogEnv names a file each passing unit suite that crossed its split
// line appends one line to — the lane's warning, then the machine's reading.
// A passing subtest prints nothing without -v, so this file is the only place
// such a suite is heard of; the parent's `check` and `test-all` set it and
// report what was written.
const suiteBudgetLogEnv = "JUGGLER_SUITE_BUDGET_LOG"

// recordSuiteBudget reports a passing suite's budget warning (empty for one
// within its line): logged, which -v and the CI legs that run with it show,
// and appended to the suiteBudgetLogEnv file when one is named. Never a
// failure: the time is concurrent wall time, which the reader weighs against
// the load before splitting anything.
func recordSuiteBudget(t *testing.T, warning string) {
	t.Helper()
	if warning == "" {
		return
	}
	line := machineload.Line()
	t.Logf("SUITE OVER ITS SPLIT LINE (passing): %s\n%s", warning, line)
	path := os.Getenv(suiteBudgetLogEnv)
	if path == "" {
		return
	}
	// O_APPEND, one short line per suite: the subtests of a run write it
	// concurrently.
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		t.Logf("could not record the budget warning in %s: %v", path, err)
		return
	}
	defer func() { _ = f.Close() }()
	_, _ = fmt.Fprintf(f, "%s\t%s\n", warning, strings.TrimSpace(line))
}

// postToServer is helpers.PostJSON to a pool subprocess, which stops retrying
// once the subprocess has exited.
func postToServer(srv testServerEntry, path string, body any) error {
	return helpers.PostJSON(srv.addr, path, body, srv.proc.dead)
}

// pollServer is helpers.PollJSON against a pool subprocess, which ends the
// poll once the subprocess has exited.
func pollServer(srv testServerEntry, path string, timeout time.Duration, out any) error {
	return helpers.PollJSON(srv.addr, path, timeout, out, srv.proc.dead)
}

// poolStderrTailLines is how much of a dead subprocess's stderr poolDeath
// quotes. The evidence that matters is always at the very end — the fatal line
// the process wrote on its way out — and the file also holds the Wails startup
// banner and any WebKit chatter from the whole run, which is not worth pasting
// into a test failure.
const poolStderrTailLines = 40

// poolDeath returns "" while the subprocess behind srv is alive, and otherwise
// an evidence block for a test failure message.
//
// Every lane lives in ONE subprocess, so its death fails every remaining test
// with the same anonymous transport error: "connection refused" reads
// identically whether the server force-exited on the macOS main-thread watchdog,
// quit gracefully through its own shutdown path, or was killed by the OS. Those
// want completely different fixes, and the exit status plus the last thing the
// process said are what separate them — neither of which appears anywhere else.
// The subprocess writes its stderr to a file under the platform temp dir that
// no CI job reads (and whose path is not /tmp on macOS or Windows), so quoting
// its tail HERE is the only way that line reaches whoever reads the failure.
//
// The full block is printed once per subprocess; every later test gets a
// one-liner pointing at it, so a hundred cascaded failures stay readable.
func poolDeath(srv testServerEntry) string {
	if !srv.proc.dead() {
		return ""
	}
	p := srv.proc
	first := false
	p.reported.Do(func() { first = true })
	if !first {
		return fmt.Sprintf("POOL SERVER: already dead (pid %d) — see the first failure for the post-mortem.", p.pid)
	}

	var b strings.Builder
	fmt.Fprintf(&b, "POOL SERVER DIED: pid %d %s after %s of the run — every lane lives in this one "+
		"subprocess, so every test from here on fails on a refused connection regardless of what it asserts.\n",
		p.pid, p.status(), p.exitedAt.Sub(p.started).Round(time.Second))
	if p.stderrPath == "" {
		b.WriteString("Its stderr was discarded (JUGGLER_TEST_DISCARD_STDERR=1), so there is nothing to quote.\n")
		return b.String()
	}
	fmt.Fprintf(&b, "Last %d lines of %s:\n", poolStderrTailLines, p.stderrPath)
	data, err := os.ReadFile(p.stderrPath)
	if err != nil {
		fmt.Fprintf(&b, "  (unreadable: %v)\n", err)
		return b.String()
	}
	lines := strings.Split(strings.TrimRight(string(data), "\n"), "\n")
	samplePath := ""
	for _, line := range lines {
		if after, ok := strings.CutPrefix(line, stallSampleStderrPrefix); ok {
			samplePath = strings.TrimSpace(after)
		}
	}
	if len(lines) > poolStderrTailLines {
		lines = lines[len(lines)-poolStderrTailLines:]
	}
	for _, line := range lines {
		fmt.Fprintf(&b, "  | %s\n", line)
	}
	if samplePath != "" {
		b.WriteString(stallSampleReport(samplePath, p))
	}
	return b.String()
}

// stallSampleStderrPrefix opens the line a pool server's main-thread watchdog
// writes to stderr when it force-exits with a native sample of the wedged
// thread (stallSampleNote, cmd/juggler/app).
const stallSampleStderrPrefix = "Main-thread sample: "

// stallSampleMainThreadLines caps how much of the main thread's call graph
// stallSampleReport quotes. A wedged thread is one stack standing still, so the
// tree is narrow; the cap only guards against a sample that caught it moving.
const stallSampleMainThreadLines = 120

// stallSampleReport quotes the main thread's call graph from the sample a
// wedged pool server took of itself, and keeps the whole sample beside the
// stderr logs. The sample is written into the pool's throwaway log dir, which
// is deleted when the run ends — before CI's dump step, which prints every log
// beside the stderr files and so prints the kept copy in full. The main thread
// alone names where it is stuck; the other threads are what say who holds the
// lock it waits on, which is why the whole file is kept.
func stallSampleReport(samplePath string, p *poolProc) string {
	var b strings.Builder
	data, err := os.ReadFile(samplePath)
	if err != nil {
		fmt.Fprintf(&b, "Main-thread sample %s unreadable: %v\n", samplePath, err)
		return b.String()
	}
	kept := filepath.Join(filepath.Dir(p.stderrPath), fmt.Sprintf("juggler-stall-sample-%d.log", p.pid))
	if err := os.WriteFile(kept, data, 0o644); err != nil {
		fmt.Fprintf(&b, "Main-thread sample (couldn't keep a copy at %s: %v):\n", kept, err)
	} else {
		fmt.Fprintf(&b, "Main-thread sample (all threads kept at %s):\n", kept)
	}
	// /usr/bin/sample's call graph gives each thread a heading line naming it,
	// then its frames, each opening "    +".
	inMain, quoted := false, 0
	for _, line := range strings.Split(string(data), "\n") {
		if !inMain {
			inMain = strings.Contains(line, "com.apple.main-thread")
			if !inMain {
				continue
			}
		} else if !strings.HasPrefix(line, "    +") {
			break
		}
		if quoted == stallSampleMainThreadLines {
			fmt.Fprintf(&b, "  ¦ … (cut at %d lines; the kept copy has the rest)\n", stallSampleMainThreadLines)
			break
		}
		fmt.Fprintf(&b, "  ¦ %s\n", line)
		quoted++
	}
	if quoted == 0 {
		b.WriteString("  (no main-thread call graph in it)\n")
	}
	return b.String()
}

// prefixedPoolDeath is poolDeath for appending to an error line: it opens with a
// newline when there is something to say and is empty when the server is alive,
// so a failure with a living server doesn't grow a trailing blank line.
func prefixedPoolDeath(srv testServerEntry) string {
	death := poolDeath(srv)
	if death == "" {
		return ""
	}
	return "\n" + death
}

// testAudit is the server's account of one test's queue/result transitions.
// An age is negative when that transition never happened.
type testAudit struct {
	Name              string   `json:"name"`
	Queued            int      `json:"queued"`
	Dispatched        int      `json:"dispatched"`
	ResultPosted      int      `json:"resultPosted"`
	ResultServed      int      `json:"resultServed"`
	QueuedAgeMs       int64    `json:"queuedAgeMs"`
	DispatchedAgeMs   int64    `json:"dispatchedAgeMs"`
	ResultPostedAgeMs int64    `json:"resultPostedAgeMs"`
	ResultServedAgeMs int64    `json:"resultServedAgeMs"`
	Progress          int      `json:"progress"`
	ProgressAgeMs     int64    `json:"progressAgeMs"`
	PendingDepth      int      `json:"pendingDepth"`
	PendingNames      []string `json:"pendingNames"`
	BufferedResults   int      `json:"bufferedResults"`
}

// fetchAudit reads the server's audit record for one test.
func fetchAudit(addr, testName string) (testAudit, error) {
	var a testAudit
	client := &http.Client{Timeout: harnessHTTPTimeout}
	resp, err := client.Get("http://" + addr + "/api/test/audit?name=" + neturlEscape(testName))
	if err != nil {
		return a, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return a, fmt.Errorf("endpoint returned %d (unwired?)", resp.StatusCode)
	}
	if err := json.NewDecoder(resp.Body).Decode(&a); err != nil {
		return a, fmt.Errorf("undecodable (%v)", err)
	}
	return a, nil
}

// agoString renders a millisecond age as a short duration.
func agoString(ms int64) string {
	if ms < 0 {
		ms = 0
	}
	return fmt.Sprintf("%.1fs", float64(ms)/1000)
}

// queueAudit renders the server's own record of what happened to a timed-out
// test, and names the hop that lost it.
//
// A bare "timeout polling /api/test/result" cannot distinguish a test that no
// consumer ever picked up, one picked up and dropped, and one that ran and
// answered into a reply the harness failed to read — and those want different
// fixes. Only the server saw every transition, and it is the only participant
// that can: both the pending queue and the result buffer are destructive reads,
// so each hop's evidence is consumed by the read that takes it.
func queueAudit(addr, testName string) string {
	a, err := fetchAudit(addr, testName)
	if err != nil {
		return fmt.Sprintf("QUEUE AUDIT: unavailable (%v)", err)
	}

	var b strings.Builder
	fmt.Fprintf(&b, "QUEUE AUDIT for %s: queued=%d dispatched=%d resultPosted=%d resultServed=%d "+
		"progress reports=%d, last %s (pending depth %d, buffered results %d)\n",
		a.Name, a.Queued, a.Dispatched, a.ResultPosted, a.ResultServed,
		a.Progress, progressAgo(a.ProgressAgeMs), a.PendingDepth, a.BufferedResults)

	switch {
	case a.Queued == 0:
		b.WriteString("LOST AT: the run request never reached the server's queue at all.\n")
	case a.Dispatched == 0:
		fmt.Fprintf(&b, "LOST AT: the entry was queued %s ago and no consumer ever took it. The "+
			"pending queue still holds %d entr(y/ies): %s\n",
			agoString(a.QueuedAgeMs), a.PendingDepth, strings.Join(a.PendingNames, ", "))
	case a.ResultPosted == 0:
		fmt.Fprintf(&b, "LOST AT: a consumer took the entry %s ago and never posted a result. The "+
			"dispatch is a destructive read, so a reply that failed to arrive intact destroyed the "+
			"run: the consumer cannot re-queue work it never managed to read.\n",
			agoString(a.DispatchedAgeMs))
	case a.ResultServed > 0:
		fmt.Fprintf(&b, "LOST AT: the browser posted a result %s ago and the server served it %s "+
			"ago — the harness's own read consumed it and then discarded it, so the test ran fine "+
			"and only the answer was lost.\n",
			agoString(a.ResultPostedAgeMs), agoString(a.ResultServedAgeMs))
	default:
		fmt.Fprintf(&b, "LOST AT: a result was posted %s ago and is still buffered unserved — the "+
			"harness was polling a key the result was not filed under.\n", agoString(a.ResultPostedAgeMs))
	}
	return b.String()
}

// projectSize reports how many conversations the lanes' shared project held at
// the moment a test was given up on.
//
// Every lane in the pool works inside one session on disk, and each lane
// rebuilds a Yjs document per conversation in it on every session load, so that
// count is the run's background load. A test lost with the project at a handful
// of conversations and one lost with it near MAX_CONVERSATIONS are different
// failures wanting opposite fixes, and until this line existed nothing recorded
// which had happened. Browser-side failures carry the same number themselves;
// this covers the case where no result comes back at all. Best-effort: the
// probe is a diagnostic and must never replace the failure it annotates.
func projectSize(addr string) string {
	client := &http.Client{Timeout: harnessHTTPTimeout}
	resp, err := client.Get("http://" + addr + "/api/session")
	if err != nil {
		return fmt.Sprintf("PROJECT SIZE: unavailable (%v)", err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return fmt.Sprintf("PROJECT SIZE: endpoint returned %d", resp.StatusCode)
	}
	var sess struct {
		ConversationOrder []string `json:"conversationOrder"`
		BinnedCount       int      `json:"binnedCount"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&sess); err != nil {
		return fmt.Sprintf("PROJECT SIZE: undecodable (%v)", err)
	}
	return fmt.Sprintf("PROJECT SIZE: %d conversation(s), %d binned — [%s]",
		len(sess.ConversationOrder), sess.BinnedCount, strings.Join(sess.ConversationOrder, ", "))
}
