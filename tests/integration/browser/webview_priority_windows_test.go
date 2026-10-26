//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

//go:build windows

package browser_test

import (
	"fmt"
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
func bootSandboxFrame(t *testing.T, srv testServerEntry) {
	t.Helper()
	if err := postToServer(srv, "/api/test/run", map[string]any{
		"name":        sandboxBootTest,
		"projectPath": srv.fixture,
	}); err != nil {
		t.Fatalf("POST %s on %s: %v%s", sandboxBootTest, srv.addr, err, prefixedPoolDeath(srv))
	}
	var result struct {
		Passed  bool     `json:"passed"`
		Details string   `json:"details"`
		Errors  []string `json:"errors"`
	}
	if err := pollServer(srv, "/api/test/result?name="+sandboxBootTest, 120*time.Second, &result); err != nil {
		t.Fatalf("waiting for %s on %s: %v%s", sandboxBootTest, srv.addr, err, prefixedPoolDeath(srv))
	}
	if !result.Passed {
		t.Fatalf("%s failed on %s, so its sandbox frame may not exist: %s %s",
			sandboxBootTest, srv.addr, result.Details, strings.Join(result.Errors, "; "))
	}
}

// webviewProc is one msedgewebview2.exe process under a pool server.
type webviewProc struct {
	pid, server, class uint32
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
		_ = windows.CloseHandle(h)
		if err != nil {
			continue
		}
		out = append(out, webviewProc{pid: pid, server: server, class: class})
	}
	return out, nil
}
