//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package web

import (
	"context"
	"encoding/json"
	"fmt"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

// runNodeSandboxHarness runs body as an ES module in node, with
// `installNodeSandboxDelegate` and `runInSandbox` imported from the shipped
// files and the delegate already installed — the Node engine host's query_code
// path, minus the engine. body must print one JSON line last; it is decoded
// into out.
func runNodeSandboxHarness(t *testing.T, body string, out any) {
	t.Helper()
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not found on PATH — skipping the Node sandbox host test")
	}
	moduleURL := func(rel string) string {
		p, err := filepath.Abs(rel)
		if err != nil {
			t.Fatalf("resolve %s: %v", rel, err)
		}
		u := url.URL{Scheme: "file", Path: filepath.ToSlash(p)}
		if !strings.HasPrefix(u.Path, "/") {
			u.Path = "/" + u.Path
		}
		b, _ := json.Marshal(u.String())
		return string(b)
	}
	script := fmt.Sprintf(`
import { installNodeSandboxDelegate } from %s;
import { runInSandbox } from %s;
installNodeSandboxDelegate({ origin: 'http://127.0.0.1:1', token: '', projectRoot: '/' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
%s
process.exit(0);
`, moduleURL("js/engine-sandbox-node.mjs"), moduleURL("sdk/lib/sandbox-runner.js"), body)
	harness := filepath.Join(t.TempDir(), "harness.mjs")
	if err := os.WriteFile(harness, []byte(script), 0o600); err != nil {
		t.Fatalf("write harness: %v", err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 60*time.Second)
	defer cancel()
	raw, err := exec.CommandContext(ctx, node, harness).CombinedOutput()
	if err != nil {
		t.Fatalf("harness failed: %v\n%s", err, raw)
	}
	lines := strings.Split(strings.TrimSpace(string(raw)), "\n")
	if err := json.Unmarshal([]byte(lines[len(lines)-1]), out); err != nil {
		t.Fatalf("parse harness output: %v\n%s", err, raw)
	}
}

// TestNodeSandboxAbortTerminatesScript pins that aborting a query_code run on
// the Node engine host stops the script, not merely its caller. Escape aborts
// query_code's signal; a run that only settles the caller leaves the script
// executing until its own timeout — up to ten minutes of capability calls
// nobody is waiting for.
func TestNodeSandboxAbortTerminatesScript(t *testing.T) {
	var got struct {
		TicksBeforeAbort int    `json:"ticksBeforeAbort"`
		Outcome          string `json:"outcome"`
		TicksAfterAbort  int    `json:"ticksAfterAbort"`
		TicksLater       int    `json:"ticksLater"`
	}
	runNodeSandboxHarness(t, `
let ticks = 0;
const controller = new AbortController();
const run = runInSandbox(
  'for (;;) { await tick(); await new Promise((r) => setTimeout(r, 10)); }',
  { capabilities: { tick: () => { ticks++; } }, timeoutMs: 60000, signal: controller.signal }
);
const started = Date.now();
while (ticks < 3 && Date.now() - started < 10000) await sleep(10);
const ticksBeforeAbort = ticks;
controller.abort();
const outcome = await Promise.race([
  run.then(() => 'resolved', (e) => (e && e.name) || String(e)),
  sleep(2000).then(() => 'pending'),
]);
// Let anything still in flight at the abort land, then watch for more.
await sleep(200);
const ticksAfterAbort = ticks;
await sleep(500);
console.log(JSON.stringify({ ticksBeforeAbort, outcome, ticksAfterAbort, ticksLater: ticks }));
`, &got)

	if got.TicksBeforeAbort < 3 {
		t.Fatalf("the script never got going (%d capability calls before the abort)", got.TicksBeforeAbort)
	}
	if got.Outcome != "AbortError" {
		t.Errorf("an aborted run must settle the caller with an AbortError, got %q", got.Outcome)
	}
	if got.TicksLater != got.TicksAfterAbort {
		t.Errorf("the script kept running after the abort: %d capability calls became %d over the next 500ms",
			got.TicksAfterAbort, got.TicksLater)
	}
}

// TestNodeSandboxConsole pins that a script's console output reaches the
// caller on the Node engine host — on success, on a throw, and when the
// script is killed mid-run — and that it is capped where it is produced.
func TestNodeSandboxConsole(t *testing.T) {
	type run struct {
		Lines  []string `json:"lines"`
		Result any      `json:"result"`
		Error  string   `json:"error"`
	}
	var got map[string]run
	runNodeSandboxHarness(t, `
async function capture(code, timeoutMs = 10000) {
  const lines = [];
  try {
    const result = await runInSandbox(code, { timeoutMs, onConsole: (line) => lines.push(line) });
    return { lines, result };
  } catch (e) {
    return { lines, error: e.message };
  }
}
console.log(JSON.stringify({
  ok: await capture('console.log("hi", { a: 1 }, [2]); console.warn("careful"); console.error(new Error("oops")); return 7;'),
  thrown: await capture('console.log("got this far"); throw new Error("boom");'),
  hung: await capture('console.log("before the hang"); for (;;) {}', 1000),
  capped: await capture('for (let i = 0; i < 500; i++) console.log("line " + i); return "done";'),
}));
`, &got)

	if want := []string{`hi {"a":1} [2]`, "[warn] careful", "[error] Error: oops"}; strings.Join(got["ok"].Lines, "\n") != strings.Join(want, "\n") {
		t.Errorf("console output on success: got %q, want %q", got["ok"].Lines, want)
	}
	if got["ok"].Result != float64(7) {
		t.Errorf("the result must still come back beside the output, got %v", got["ok"].Result)
	}
	if got["thrown"].Error != "boom" || len(got["thrown"].Lines) != 1 || got["thrown"].Lines[0] != "got this far" {
		t.Errorf("output before a throw must survive it: got error %q, lines %q", got["thrown"].Error, got["thrown"].Lines)
	}
	if !strings.Contains(got["hung"].Error, "timed out") || len(got["hung"].Lines) != 1 || got["hung"].Lines[0] != "before the hang" {
		t.Errorf("output before a hang must survive the kill: got error %q, lines %q", got["hung"].Error, got["hung"].Lines)
	}
	capped := got["capped"].Lines
	if len(capped) != 201 || capped[0] != "line 0" || capped[199] != "line 199" ||
		capped[200] != "… console output truncated (limit: 200 lines, 20000 characters)" {
		t.Errorf("output must be capped at 200 lines plus a truncation notice, got %d lines ending %q",
			len(capped), capped[max(0, len(capped)-2):])
	}
}
