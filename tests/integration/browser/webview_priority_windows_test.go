//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package browser_test

import (
	"fmt"
	"slices"
	"strings"
	"testing"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// webviewIdleLimit is how long a WebView2 process may sit at the idle class
// before the check fails: WebView2 sets a renderer's priority when the
// visibility of what it hosts settles, not when the process starts.
const webviewIdleLimit = 3 * time.Second

// TestWebViewProcessesAreNotBackgrounded checks that no WebView2 process a pool
// server owns stays at IDLE_PRIORITY_CLASS.
//
// WebView2 puts a renderer with nothing visible into efficiency mode, the idle
// class. A pool server's windows are never shown, so its pages stay out of it
// only while their controllers report IsVisible=true, which WebView2 does not
// grant a window created hidden until the host asks for it. On a machine whose
// cores are all busy, Windows schedules an idle-class thread only when its
// anti-starvation boost comes round, every few seconds, so a page stalls for
// seconds at a time with nothing failing — a program that takes ten seconds to
// make its first call, a frame whose own one-second timer has not fired after
// six. The priority class is set by visibility, not load, so the check is
// exact on a quiet machine too.
//
// The engine's sandbox frame, where every run_code and query_code program
// runs, is an opaque-origin frame with a renderer of its own, created on the
// first program. So each server runs one query_code turn first: a server whose
// engine has never run a program has no sandbox renderer to check.
func TestWebViewProcessesAreNotBackgrounded(t *testing.T) {
	if testing.Short() {
		t.Skip("skipping browser tests in short mode")
	}

	servers := map[uint32]bool{}
	for _, pool := range allPools() {
		entries := pool.acquireAll()
		defer pool.releaseAll(entries)
		for _, e := range entries {
			if e.proc == nil || e.proc.dead() {
				continue
			}
			bootSandboxFrame(t, e)
			servers[uint32(e.proc.pid)] = true
		}
	}
	if len(servers) == 0 {
		t.Fatal("no live pool server to inspect")
	}

	// Sampled for twice the limit: WebView2 sets a renderer's priority when its
	// visibility settles, not when the process starts. idleSince holds, per
	// process, when the current unbroken run at the idle class began.
	seen := map[uint32]bool{}
	idleSince := map[uint32]time.Time{}
	for deadline := time.Now().Add(2 * webviewIdleLimit); ; {
		procs, err := webviewDescendants(servers)
		if err != nil {
			t.Fatalf("listing WebView2 processes: %v", err)
		}
		now := time.Now()
		var stuck []string
		for _, p := range procs {
			seen[p.pid] = true
			if p.class != windows.IDLE_PRIORITY_CLASS {
				delete(idleSince, p.pid)
				continue
			}
			since, ok := idleSince[p.pid]
			if !ok {
				idleSince[p.pid] = now
				continue
			}
			if now.Sub(since) >= webviewIdleLimit {
				stuck = append(stuck, fmt.Sprintf("pid %d (server %d)", p.pid, p.server))
			}
		}
		if len(stuck) > 0 {
			t.Fatalf("%d WebView2 process(es) stayed at IDLE_PRIORITY_CLASS for %v: %s — WebView2 has put a "+
				"renderer it considers invisible into efficiency mode, and on a busy machine it gets the CPU "+
				"only in bursts seconds apart",
				len(stuck), webviewIdleLimit, strings.Join(stuck, ", "))
		}
		if now.After(deadline) {
			break
		}
		time.Sleep(250 * time.Millisecond)
	}
	if len(seen) == 0 {
		t.Fatal("found no WebView2 process under any pool server, so nothing was checked")
	}
}

// sandboxBootTest is a query_code turn, run on a server to make its engine
// create the sandbox frame. It reads nothing from the fixture, so a fixture
// another test left broken cannot fail it, and it asserts the frame's opaque
// origin, which is what the frame's isolation rests on once it shares the
// engine page's renderer.
const sandboxBootTest = "integration:query-sandbox-isolation"

// bootSandboxFrame runs sandboxBootTest on srv, which the caller holds whole.
//
// The server's WebView2 processes are sampled for the whole run, and what they
// did is logged, and printed with any failure. The lane's own block cannot see
// them: it reads the page from inside, and a renderer that is not being
// scheduled looks there like a test that stopped.
func bootSandboxFrame(t *testing.T, srv testServerEntry) {
	t.Helper()
	watch := watchWebviews(uint32(srv.proc.pid))
	if err := postToServer(srv, "/api/test/run", map[string]any{
		"name":        sandboxBootTest,
		"projectPath": srv.fixture,
	}); err != nil {
		t.Fatalf("POST %s on %s: %v%s\n%s", sandboxBootTest, srv.addr, err, prefixedPoolDeath(srv), watch.report())
	}
	var result struct {
		Passed  bool     `json:"passed"`
		Details string   `json:"details"`
		Errors  []string `json:"errors"`
	}
	err := pollServer(srv, "/api/test/result?name="+sandboxBootTest, 120*time.Second, &result)
	processes := watch.report()
	if err != nil {
		t.Fatalf("waiting for %s on %s: %v%s\n%s", sandboxBootTest, srv.addr, err, poolStall(srv, sandboxBootTest), processes)
	}
	if !result.Passed {
		t.Fatalf("%s failed on %s, so its sandbox frame may not exist: %s %s\n%s",
			sandboxBootTest, srv.addr, result.Details, strings.Join(result.Errors, "; "), processes)
	}
	t.Logf("%s on %s:\n%s", sandboxBootTest, srv.addr, processes)
}

// webviewSampleEvery is how often watchWebviews samples, as the check above.
const webviewSampleEvery = 250 * time.Millisecond

// webviewHistory is what one WebView2 process was seen doing during a watch.
type webviewHistory struct {
	firstSeen, lastSeen time.Time
	firstCPU, lastCPU   time.Duration
	class               uint32        // at the last sample that saw it
	idleSince           time.Time     // start of the current run at the idle class; zero if none
	longestIdle         time.Duration // longest unbroken run at the idle class
}

// webviewWatch samples the WebView2 processes under one pool server until its
// report is taken.
type webviewWatch struct {
	stop chan struct{}
	done chan struct{}

	// Written by the sampler, read by report after done closes.
	start, last time.Time
	samples     int
	procs       map[uint32]*webviewHistory
	err         error
}

// watchWebviews starts sampling the WebView2 processes under server.
func watchWebviews(server uint32) *webviewWatch {
	w := &webviewWatch{
		stop:  make(chan struct{}),
		done:  make(chan struct{}),
		start: time.Now(),
		procs: map[uint32]*webviewHistory{},
	}
	go func() {
		defer close(w.done)
		tick := time.NewTicker(webviewSampleEvery)
		defer tick.Stop()
		for {
			w.sample(server)
			select {
			case <-w.stop:
				w.sample(server)
				return
			case <-tick.C:
			}
		}
	}()
	return w
}

// sample takes one reading of every WebView2 process under server.
func (w *webviewWatch) sample(server uint32) {
	procs, err := webviewDescendants(map[uint32]bool{server: true})
	if err != nil {
		w.err = err
		return
	}
	now := time.Now()
	w.last = now
	w.samples++
	for _, p := range procs {
		h := w.procs[p.pid]
		if h == nil {
			h = &webviewHistory{firstSeen: now, firstCPU: p.cpu}
			w.procs[p.pid] = h
		}
		h.lastSeen, h.lastCPU, h.class = now, p.cpu, p.class
		if p.class != windows.IDLE_PRIORITY_CLASS {
			h.idleSince = time.Time{}
			continue
		}
		if h.idleSince.IsZero() {
			h.idleSince = now
		}
		h.longestIdle = max(h.longestIdle, now.Sub(h.idleSince))
	}
}

// report stops the watch and says, per process, its priority class, how long
// it sat at the idle class, the CPU it was given, and whether it started or
// exited during the watch. A renderer at the idle class that got no CPU was
// starved; one that got CPU throughout was running script; one at a normal
// class that got none was waiting on something outside it.
func (w *webviewWatch) report() string {
	select {
	case <-w.stop:
	default:
		close(w.stop)
	}
	<-w.done
	var b strings.Builder
	fmt.Fprintf(&b, "  WEBVIEW2 PROCESSES over the %v wait (%d samples, every %v; the engine's and the pool's renderers among them):",
		w.last.Sub(w.start).Round(time.Millisecond), w.samples, webviewSampleEvery)
	if w.err != nil {
		fmt.Fprintf(&b, "\n    a listing failed, so a sample is missing: %v", w.err)
	}
	if len(w.procs) == 0 {
		b.WriteString("\n    none seen")
	}
	pids := make([]uint32, 0, len(w.procs))
	for pid := range w.procs {
		pids = append(pids, pid)
	}
	slices.Sort(pids)
	for _, pid := range pids {
		h := w.procs[pid]
		fmt.Fprintf(&b, "\n    pid %d: %s at the last sample, longest run at IDLE %v, CPU %v",
			pid, priorityClassName(h.class), h.longestIdle.Round(time.Millisecond), (h.lastCPU - h.firstCPU).Round(time.Millisecond))
		if h.firstSeen.After(w.start.Add(webviewSampleEvery)) {
			fmt.Fprintf(&b, ", started at +%v", h.firstSeen.Sub(w.start).Round(time.Millisecond))
		}
		if h.lastSeen.Before(w.last) {
			fmt.Fprintf(&b, ", GONE after +%v", h.lastSeen.Sub(w.start).Round(time.Millisecond))
		}
	}
	return b.String()
}

// priorityClassName names a Windows priority class.
func priorityClassName(class uint32) string {
	switch class {
	case windows.IDLE_PRIORITY_CLASS:
		return "IDLE"
	case windows.BELOW_NORMAL_PRIORITY_CLASS:
		return "BELOW_NORMAL"
	case windows.NORMAL_PRIORITY_CLASS:
		return "NORMAL"
	case windows.ABOVE_NORMAL_PRIORITY_CLASS:
		return "ABOVE_NORMAL"
	case windows.HIGH_PRIORITY_CLASS:
		return "HIGH"
	case windows.REALTIME_PRIORITY_CLASS:
		return "REALTIME"
	}
	return fmt.Sprintf("class %#x", class)
}

// webviewProc is one msedgewebview2.exe process under a pool server.
type webviewProc struct {
	pid, server, class uint32
	cpu                time.Duration // kernel and user time used so far
}

// filetimeSpan reads a FILETIME that holds a span, in 100ns units.
func filetimeSpan(ft windows.Filetime) time.Duration {
	return time.Duration(uint64(ft.HighDateTime)<<32|uint64(ft.LowDateTime)) * 100
}

// webviewDescendants lists every msedgewebview2.exe process descended from one
// of servers, with its priority class. A process that exits between the
// snapshot and the query is skipped.
func webviewDescendants(servers map[uint32]bool) ([]webviewProc, error) {
	snap, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return nil, err
	}
	defer func() { _ = windows.CloseHandle(snap) }()

	parent := map[uint32]uint32{}
	name := map[uint32]string{}
	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	for err = windows.Process32First(snap, &entry); err == nil; err = windows.Process32Next(snap, &entry) {
		parent[entry.ProcessID] = entry.ParentProcessID
		name[entry.ProcessID] = windows.UTF16ToString(entry.ExeFile[:])
	}

	// rootOf walks up to a pool server; the hop limit guards against the PID
	// reuse cycles a parent table can contain.
	rootOf := func(pid uint32) (uint32, bool) {
		for hops := 0; hops < 16; hops++ {
			pp, ok := parent[pid]
			if !ok || pp == 0 || pp == pid {
				return 0, false
			}
			if servers[pp] {
				return pp, true
			}
			pid = pp
		}
		return 0, false
	}

	var out []webviewProc
	for pid, exe := range name {
		if !strings.EqualFold(exe, "msedgewebview2.exe") {
			continue
		}
		server, ok := rootOf(pid)
		if !ok {
			continue
		}
		h, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
		if err != nil {
			continue
		}
		class, err := windows.GetPriorityClass(h)
		var created, exited, kernel, user windows.Filetime
		var cpu time.Duration
		if windows.GetProcessTimes(h, &created, &exited, &kernel, &user) == nil {
			cpu = filetimeSpan(kernel) + filetimeSpan(user)
		}
		_ = windows.CloseHandle(h)
		if err != nil {
			continue
		}
		out = append(out, webviewProc{pid: pid, server: server, class: class, cpu: cpu})
	}
	return out, nil
}
