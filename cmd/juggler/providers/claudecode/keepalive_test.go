//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

// Layer-B integration tests: drive Client.StreamMessage end-to-end against
// a scenario-driven fake `claude` binary (the test binary itself, re-exec'd
// via the helper-process pattern). These cover the keep-alive invariants
// — single subprocess across turns, --resume on turn 2+, prefix
// divergence triggers a cold-start, user-cancel kills the subprocess —
// via trace and process-state assertions.

package claudecode

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"testing"
	"time"

	"juggler/cmd/juggler/providers/provider"
)

const (
	envFakeClaude  = "JUGGLER_FAKE_CLAUDE"
	envFakeTrace   = "JUGGLER_FAKE_CLAUDE_TRACE"
	envFakeSession = "JUGGLER_FAKE_CLAUDE_SESSION"
	envFakeMode    = "JUGGLER_FAKE_CLAUDE_MODE"

	fakeModeText       = "text"        // emit one assistant text turn, then result, exit (or wait stdin)
	fakeModeToolUse    = "tool_use"    // emit assistant tool_use, then hold open until torn down
	fakeModeNoResult   = "no_result"   // emit nothing past init; hold stdin open (used to test cancel)
	fakeModeFailFirst  = "fail_first"  // emit error result on the first turn (for error-recovery shape)
	fakeModeFailSecond = "fail_second" // complete one turn, then fail after consuming the next request
	fakeModeUntilClose = "until_close" // text turn per stdin line, persistent
	fakeModeAutonomous = "autonomous"  // like until_close, but emits one UNSOLICITED turn after the first reply
	fakeModeUsage      = "usage"       // emit a workspace-trust warning on stderr and /usage JSON on stdout

	// Retry-path modes. These exit WITHOUT a terminal stop reason (no
	// end_turn / result), which is the shape that drives the
	// "exited unexpectedly without completing the turn" transient error.
	fakeModeFlakeFirst     = "flake_first"      // 1st spawn exits with no result; later spawns emit a normal text turn
	fakeModeAlwaysExit     = "always_exit"      // every spawn exits with no result (retry never succeeds)
	fakeModeStreamThenExit = "stream_then_exit" // streams a complete text block, then exits with no end_turn

	// fakeModeRetryLadder models a CLI wedged in a permanent in-band backoff:
	// the upstream keeps answering 529, so the CLI emits system/api_retry
	// notices indefinitely and never produces content or a terminal stop
	// reason. The notices prove the process is ALIVE without it making any
	// PROGRESS — the shape that must still fail the turn in bounded time.
	fakeModeRetryLadder = "retry_ladder"

	// fakeRetryNoticeInterval is the gap between fakeModeRetryLadder notices.
	// Well under any idle window a test shrinks to, so the notices always
	// arrive in time to re-arm it.
	fakeRetryNoticeInterval = 25 * time.Millisecond

	// fakeModeWedgeOnResume models a CLI-side session that has become wedged:
	// any --resume of the ORIGINAL captured uuid produces no output (a
	// backed-up stdin queue / corrupt transcript), but a cold start — a bare
	// fresh spawn or a synthetic --resume under a NEW uuid — works normally.
	// Drives the consecutive-stall circuit breaker that must abandon the
	// wedged uuid and cold-start instead of locking up forever.
	fakeModeWedgeOnResume = "wedge_on_resume"

	// fakeModeLadderOnResume is fakeModeWedgeOnResume's overload twin: a
	// --resume of the original uuid streams api_retry notices forever (the CLI
	// is healthy and talking to us; the UPSTREAM is overloaded), while a cold
	// start works. Distinguishes "this session is wedged, escape it" from
	// "this provider is down, say so" — the two must not be treated alike.
	fakeModeLadderOnResume = "ladder_on_resume"

	// fakeModeRejectOnResume models a CLI session file holding a transcript the
	// API refuses: a --resume of the original uuid takes the turn and reports
	// the CLI's in-band 400 for a malformed tool_use/tool_result sequence, while
	// a cold start (bare, or a synthetic --resume under a NEW uuid) works.
	fakeModeRejectOnResume = "reject_on_resume"

	// fakeModeRejectAlways reports that same 400 on every spawn — the request
	// itself is malformed, so rebuilding the session cannot help.
	fakeModeRejectAlways = "reject_always"

	// fakeRejectedTranscriptText is the CLI's own wording for that 400.
	fakeRejectedTranscriptText = "API Error: 400 due to tool use concurrency issues. Run /rewind to recover the conversation."

	// fakeModeScript is the fully scriptable, tape-recording mode used by the
	// permutation harness. Unlike the fixed modes above, its per-turn tool
	// behaviour is described by a JSON script and it logs the full tools/call ↔
	// control_response pairing so a test can assert tool-delivery fidelity
	// across permutations (parallel calls, arg-drift, orphan parks, multi-turn
	// warm reuse). Implemented in permutation_harness_test.go.
	fakeModeScript = "script"
)

// TestMain is the helper-process trampoline. When a test binary for this
// package is spawned by Client.spawnCLIPipes (with JUGGLER_FAKE_CLAUDE=1 in
// env), runFakeClaude takes over and never returns to the test runner.
// Otherwise we settle which binary the fake is spawned as (prepareFakeCLI) and
// pass through to m.Run() as normal.
func TestMain(m *testing.M) {
	if os.Getenv(envFakeClaude) == "1" {
		runFakeClaude()
		return
	}
	// Before any test touches the package: importing it must start nothing.
	// Every binary that links the provider — whether or not it ever runs
	// Claude Code — would otherwise carry the model-info actor, and read its
	// on-disk cache, from init.
	buf := make([]byte, 1<<20)
	if stacks := buf[:runtime.Stack(buf, true)]; bytes.Contains(stacks, []byte("claudecode.runModelInfoActor")) {
		fmt.Fprintln(os.Stderr, "FAIL: importing claudecode started the model-info actor; it must start on first use")
		os.Exit(1)
	}
	cleanupFakeCLI := prepareFakeCLI()
	code := m.Run()
	cleanupFakeCLI()
	os.Exit(code)
}

type traceRecord struct {
	Pid       int      `json:"pid"`
	Argv      []string `json:"argv"`
	ResumeID  string   `json:"resumeId,omitempty"`
	OneShot   bool     `json:"oneShot"` // -p <full json> (fresh) vs --input-format stream-json (persistent)
	Mode      string   `json:"mode"`
	Cwd       string   `json:"cwd,omitempty"` // the spawned process's working directory (cmd.Dir)
	StartedAt int64    `json:"startedAtUnixNano"`
}

// runFakeClaude implements a minimal claude CLI replacement just rich
// enough to drive Client through complete turns. It is invoked via
// TestMain when JUGGLER_FAKE_CLAUDE=1. The behavior is parameterized by
// JUGGLER_FAKE_CLAUDE_MODE; per-spawn metadata is logged to the file at
// JUGGLER_FAKE_CLAUDE_TRACE so tests can introspect spawns after the fact.
func runFakeClaude() {
	mode := os.Getenv(envFakeMode)
	if mode == "" {
		mode = fakeModeText
	}
	sessionID := os.Getenv(envFakeSession)
	if sessionID == "" {
		sessionID = "fake-session"
	}

	argv := os.Args
	resumeID := extractFlag(argv, "--resume")
	// One-shot is `-p <JSON>` with no --input-format stream-json.
	oneShot := containsFlag(argv, "-p") && !containsFlagValue(argv, "--input-format", "stream-json")

	if path := os.Getenv(envFakeTrace); path != "" {
		cwd, _ := os.Getwd()
		writeTrace(path, traceRecord{
			Pid:       os.Getpid(),
			Argv:      argv,
			ResumeID:  resumeID,
			OneShot:   oneShot,
			Mode:      mode,
			Cwd:       cwd,
			StartedAt: time.Now().UnixNano(),
		})
	}

	out := bufio.NewWriter(os.Stdout)
	defer out.Flush()

	emitInit := func() {
		emit(out, map[string]any{
			"type":       "system",
			"subtype":    "init",
			"session_id": sessionID,
		})
	}

	// Read stdin until the turn's user message arrives, the way a real CLI
	// does. A fake that dies without doing this dies while juggler is still
	// writing to its stdin, which is a different failure (a broken pipe at
	// boot) decided by process scheduling rather than by the mode under test —
	// so any mode that means "die after init" waits here first.
	awaitUserTurn := func() {
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			if fakeStdinIsUserTurn(scanner.Bytes()) {
				return
			}
		}
	}

	switch mode {
	case fakeModeUsage:
		fmt.Fprintln(os.Stderr, "Ignoring project permissions: this workspace has not been trusted.")
		awaitUserTurn()
		if err := json.NewEncoder(out).Encode(map[string]any{
			"type":    "result",
			"subtype": "success",
			"result":  "Current session: 42% used · resets Jun 14 at 5:50pm (Europe/London)",
		}); err != nil {
			os.Exit(1)
		}
		return
	case fakeModeNoResult:
		emitInit()
		// Stay alive and silent. Block on a real stdin read (a syscall, so
		// the Go runtime's deadlock detector stays quiet — unlike select{},
		// which would panic the lone-goroutine fake and exit before the
		// read-side idle timeout can fire) and discard everything. Returns
		// when the test tears the CLI down and stdin EOFs.
		_, _ = io.Copy(io.Discard, os.Stdin)
		return
	case fakeModeToolUse:
		emitInit()
		emitToolUse(out, "t1", "mcp__juggler__bash", map[string]any{"cmd": "ls"})
		// CLI is paused at tool_use; in production it would POST to MCP.
		// The fake doesn't speak MCP — just hold the process alive so
		// the test can observe the parked state and then tear us down.
		// Parked on a real stdin read, as fakeModeNoResult is: select{}
		// leaves every goroutine blocked on a channel, which is the state
		// Go's deadlock detector ends a process for, so whether the fake
		// outlived its park was up to the runtime. Returns on the stdin EOF
		// that teardown opens with.
		out.Flush()
		_, _ = io.Copy(io.Discard, os.Stdin)
		return
	case fakeModeFailFirst:
		emitInit()
		emit(out, map[string]any{
			"type":    "result",
			"subtype": "error",
			"result":  "synthetic failure",
		})
		return
	case fakeModeFailSecond:
		emitInit()
		turn := 0
		scanner := bufio.NewScanner(os.Stdin)
		for scanner.Scan() {
			if !fakeStdinIsUserTurn(scanner.Bytes()) {
				continue
			}
			turn++
			if turn == 1 {
				emitTextTurn(out, "turn 1", 2000)
				continue
			}
			emit(out, map[string]any{"type": "result", "subtype": "error", "result": "invalid request"})
			return
		}
	case fakeModeText, fakeModeUntilClose:
		// Real claude CLI behavior:
		//   -p <JSON>             one-shot: emit one turn for the inline JSON, exit
		//   --input-format stream-json --resume <uuid> ... -p
		//                          persistent: idle at startup, emit a turn ONLY
		//                          on each stdin line received, exit on EOF
		emitInit()
		if oneShot {
			emitTextTurn(out, "turn 1", 0)
			return
		}
		// Persistent: emit one turn per user-message stdin line. cacheRead
		// grows so tests can distinguish turn 2 from turn 3 by cache numbers.
		turn := 0
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			if !fakeStdinIsUserTurn(scanner.Bytes()) {
				continue
			}
			turn++
			emitTextTurn(out, fmt.Sprintf("turn %d", turn), 1000*(turn+1)) // turn 1 → 2000, turn 2 → 3000, ...
		}
	case fakeModeAutonomous:
		// Persistent: one solicited turn per stdin line, AND — right after
		// the first line's reply — one extra UNSOLICITED turn with no stdin
		// prompt, simulating a scheduled wake / monitor firing while juggler
		// thinks the conversation is idle. This is the autonomous-turn the
		// always-on reader must surface even though no Submit is in flight.
		emitInit()
		turn := 0
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			if !fakeStdinIsUserTurn(scanner.Bytes()) {
				continue
			}
			turn++
			emitTextTurn(out, fmt.Sprintf("solicited %d", turn), 1000*(turn+1))
			if turn == 1 {
				emitTextTurn(out, "autonomous wake", 2500)
			}
		}
	case fakeModeFlakeFirst:
		// First spawn takes the turn and then dies with no terminal result (a
		// crash / quota-kill). The retry re-spawns; the second spawn
		// behaves like a normal one-shot text turn so the turn succeeds.
		emitInit()
		awaitUserTurn()
		if fakeSpawnCount() <= 1 {
			return
		}
		emitTextTurn(out, "recovered turn", 0)
		return
	case fakeModeAlwaysExit:
		// Every spawn takes the turn and dies with no terminal result, so the
		// bounded retry exhausts and the turn surfaces the error.
		emitInit()
		awaitUserTurn()
		return
	case fakeModeStreamThenExit:
		// Take the turn, stream a complete text block (so a callback chunk is
		// emitted), then exit WITHOUT a message_delta/end_turn. The turn-level
		// retry must NOT re-attempt — replaying would duplicate the text
		// already streamed to the UI.
		emitInit()
		awaitUserTurn()
		emit(out, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]any{"type": "text"}},
		})
		emit(out, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]any{"type": "text_delta", "text": "half an answer"}},
		})
		emit(out, map[string]any{
			"type":  "stream_event",
			"event": map[string]any{"type": "content_block_stop", "index": 0},
		})
		return
	case fakeModeRetryLadder:
		// One retry notice per interval and nothing else, ever. Bounded only
		// so a failing test can't leave the helper process spinning; every
		// caller kills us long before the count runs out.
		emitInit()
		for attempt := 1; attempt <= 4000; attempt++ {
			emit(out, map[string]any{
				"type": "system", "subtype": "api_retry",
				"attempt": attempt, "max_retries": 10,
				"retry_delay_ms": 1000, "error_status": 529,
				"error": "Overloaded",
			})
			time.Sleep(fakeRetryNoticeInterval)
		}
		return
	case fakeModeLadderOnResume:
		ladderWedged := sessionID
		sid := resumeID
		if sid == "" {
			sid = sessionID
		}
		emit(out, map[string]any{"type": "system", "subtype": "init", "session_id": sid})
		if resumeID == ladderWedged {
			// Warm resume: alive and announcing retries, forever.
			for attempt := 1; attempt <= 4000; attempt++ {
				emit(out, map[string]any{
					"type": "system", "subtype": "api_retry",
					"attempt": attempt, "max_retries": 10,
					"retry_delay_ms": 1000, "error_status": 529,
					"error": "Overloaded",
				})
				time.Sleep(fakeRetryNoticeInterval)
			}
			return
		}
		turn := 0
		ladderScanner := bufio.NewScanner(os.Stdin)
		ladderScanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for ladderScanner.Scan() {
			if !fakeStdinIsUserTurn(ladderScanner.Bytes()) {
				continue
			}
			turn++
			emitTextTurn(out, fmt.Sprintf("turn %d", turn), 1000*(turn+1))
		}
	case fakeModeWedgeOnResume:
		// The wedged session id is the one this fake mints at init
		// (envFakeSession). A --resume of THAT id is the warm-resume path and
		// must stall; any other resume id is a synthetic cold-start and works.
		// Mirror the real CLI by reporting the resumed id as the session id, so
		// a cold start captures the fresh (non-wedged) uuid and future turns
		// resume it cleanly.
		wedged := sessionID
		sid := resumeID
		if sid == "" {
			sid = sessionID
		}
		emit(out, map[string]any{"type": "system", "subtype": "init", "session_id": sid})
		if resumeID == wedged {
			// Warm resume of the wedged session: emit nothing and hold stdin
			// open so the read side hits its idle timeout (the stall).
			_, _ = io.Copy(io.Discard, os.Stdin)
			return
		}
		// Fresh / synthetic-resume cold start: behave like a normal persistent
		// session (one text turn per user-message stdin line).
		turn := 0
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			if !fakeStdinIsUserTurn(scanner.Bytes()) {
				continue
			}
			turn++
			emitTextTurn(out, fmt.Sprintf("turn %d", turn), 1000*(turn+1))
		}
	case fakeModeRejectOnResume, fakeModeRejectAlways:
		// The rejected session id is the one this fake mints at init
		// (envFakeSession); the CLI reports a resumed id as its session id.
		sid := resumeID
		if sid == "" {
			sid = sessionID
		}
		emit(out, map[string]any{"type": "system", "subtype": "init", "session_id": sid})
		if mode == fakeModeRejectAlways || resumeID == sessionID {
			awaitUserTurn()
			emit(out, map[string]any{
				"type": "result", "subtype": "success",
				"is_error": true, "api_error_status": 400,
				"result": fakeRejectedTranscriptText,
			})
			return
		}
		turn := 0
		scanner := bufio.NewScanner(os.Stdin)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			if !fakeStdinIsUserTurn(scanner.Bytes()) {
				continue
			}
			turn++
			emitTextTurn(out, fmt.Sprintf("turn %d", turn), 1000*(turn+1))
		}
	case fakeModeScript:
		// Scriptable, tape-recording mode: behavior is driven by a JSON script
		// (JUGGLER_FAKE_CLAUDE_SCRIPT) and every tools/call emitted + every
		// control_response received is logged to a pairing tape so a test can
		// assert no tool result was crossed, dropped, or duplicated. Defined in
		// permutation_harness_test.go. The CLI reports the resumed id as its
		// session id (real-CLI behaviour) so a warm --resume keeps the same uuid.
		sid := resumeID
		if sid == "" {
			sid = sessionID
		}
		runScriptedFake(out, sid)
	default:
		emitInit()
		emitTextTurn(out, "default fake", 0)
	}
}

// fakeExtractRequestID pulls response.request_id out of a control_response line
// so the dup-tool fake can tell which parked call the provider just answered.
func fakeExtractRequestID(line []byte) string {
	var root struct {
		Response struct {
			RequestID string `json:"request_id"`
		} `json:"response"`
	}
	if json.Unmarshal(line, &root) != nil {
		return ""
	}
	return root.Response.RequestID
}

// fakeExtractToolResultText loosely decodes the tool-result text the worker
// feeds back inside a control_response. The provider's sendControlSuccess nests
// it as response.response.mcp_response.result.content[0].text; we navigate that
// path defensively so a shape variance at any layer just yields "" rather than
// panicking the lone-goroutine fake.
func fakeExtractToolResultText(line []byte) string {
	var root map[string]any
	if json.Unmarshal(line, &root) != nil {
		return ""
	}
	dig := func(v any, key string) any {
		m, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		return m[key]
	}
	cur := dig(root, "response")   // ControlResponseBody
	cur = dig(cur, "response")     // {mcp_response: ...}
	cur = dig(cur, "mcp_response") // JSONRPC envelope
	cur = dig(cur, "result")       // MCPToolsCallResult
	content, ok := dig(cur, "content").([]any)
	if !ok || len(content) == 0 {
		return ""
	}
	first, ok := content[0].(map[string]any)
	if !ok {
		return ""
	}
	text, _ := first["text"].(string)
	return text
}

// fakeSpawnCount returns how many times the fake CLI has been launched in the
// current test, counting the in-progress spawn. runFakeClaude appends one
// trace record per launch BEFORE dispatching on mode, so the trace line count
// (including this spawn's own record) is the spawn ordinal: 1 on the first
// launch, 2 on the retry, and so on. Used by per-spawn-varying modes to act
// differently on the first attempt than on the retry.
func fakeSpawnCount() int {
	path := os.Getenv(envFakeTrace)
	if path == "" {
		return 1
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return 1
	}
	n := 0
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if line != "" {
			n++
		}
	}
	if n == 0 {
		return 1
	}
	return n
}

// fakeStdinIsUserTurn reports whether a stdin line the fake received is a
// user-message envelope (type:"user") that should drive a turn. The CLI also
// receives control-protocol frames on stdin (the initialize handshake,
// control_responses carrying tool results); the real CLI never turns those
// into assistant replies, so the fake must skip them — otherwise it
// spuriously emits a turn per control frame, which the always-on reader then
// surfaces or mis-attributes.
func fakeStdinIsUserTurn(line []byte) bool {
	var env struct {
		Type string `json:"type"`
	}
	if err := json.Unmarshal(line, &env); err != nil {
		return false
	}
	return env.Type == "user"
}

func emit(w *bufio.Writer, v map[string]any) {
	b, _ := json.Marshal(v)
	_, _ = w.Write(b)
	_ = w.WriteByte('\n')
	_ = w.Flush()
}

func writeTrace(path string, rec traceRecord) {
	b, _ := json.Marshal(&rec)
	f, err := os.OpenFile(path, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		return
	}
	defer f.Close()
	_, _ = f.Write(b)
	_, _ = f.Write([]byte("\n"))
}

func extractFlag(argv []string, name string) string {
	for i, a := range argv {
		if a == name && i+1 < len(argv) {
			return argv[i+1]
		}
	}
	return ""
}

func containsFlag(argv []string, name string) bool {
	for _, a := range argv {
		if a == name {
			return true
		}
	}
	return false
}

func containsFlagValue(argv []string, name, value string) bool {
	for i, a := range argv {
		if a == name && i+1 < len(argv) && argv[i+1] == value {
			return true
		}
	}
	return false
}

// readTrace decodes every JSONL record in path, in order. Empty file => nil.
func readTrace(t *testing.T, path string) []traceRecord {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return nil
		}
		t.Fatalf("read trace: %v", err)
	}
	var out []traceRecord
	for _, line := range strings.Split(strings.TrimSpace(string(data)), "\n") {
		if line == "" {
			continue
		}
		var rec traceRecord
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			t.Fatalf("decode trace line %q: %v", line, err)
		}
		out = append(out, rec)
	}
	return out
}

// installFakeClaude points the package at the test binary acting as fake
// claude. Returns a cleanup that restores the original binary path and
// also returns the path to the per-test trace file (which receives one
// JSONL record per fake-CLI invocation).
func installFakeClaude(t *testing.T, mode, sessionID string) (tracePath string) {
	t.Helper()
	tracePath = filepath.Join(t.TempDir(), "claude.trace.jsonl")
	t.Setenv(envFakeMode, mode)
	t.Setenv(envFakeSession, sessionID)
	t.Setenv(envFakeTrace, tracePath)
	restore := SetBinaryPathForTesting(fakeCLIPath,
		envFakeClaude+"=1",
		envFakeMode+"="+mode,
		envFakeSession+"="+sessionID,
		envFakeTrace+"="+tracePath,
	)
	t.Cleanup(restore)
	return tracePath
}

func mkClient(t *testing.T, model string) *Client {
	t.Helper()
	p, err := NewClient(provider.Config{Model: model, ProjectPath: t.TempDir()})
	if err != nil {
		t.Fatalf("NewClient: %v", err)
	}
	c := p.(*Client)
	// Reap any persistent CLI subprocess before t.TempDir cleanup runs:
	// Windows can't delete a directory a live process holds open, so a
	// held-open fake CLI would fail the working-dir cleanup. closeSession is
	// the production handle-release teardown — it kills+waits the live CLI and
	// is a nil-safe no-op when none was spawned.
	t.Cleanup(c.closeSession)
	return c
}

func nopCallback() provider.StructuredStreamCallback {
	return func(provider.StreamChunk) (*provider.ToolResult, error) { return nil, nil }
}

// TestKeepAlive_MultiTurnReusesSubprocess drives 3 sequential text-only
// turns through StreamMessage and asserts that:
//   - turn 1 spawns one CLI in -p (oneShot) mode
//   - turns 2+ either reuse the persistent CLI or spawn with --resume
//     using the captured session UUID — never cold-starts
func TestKeepAlive_MultiTurnReusesSubprocess(t *testing.T) {
	tracePath := installFakeClaude(t, fakeModeUntilClose, "uuid-keepalive")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv-multi"

	msgs := []provider.Message{userMsg("turn 1 user")}
	ctx := context.Background()

	res1, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys", Messages: msgs,
	}, nopCallback())
	if err != nil {
		t.Fatalf("turn 1 StreamMessage: %v", err)
	}
	if res1.StopReason != "end_turn" {
		t.Fatalf("turn 1 StopReason = %q, want end_turn", res1.StopReason)
	}

	msgs = append(msgs, assistantMsg("turn 1 reply"), userMsg("turn 2 user"))
	res2, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys", Messages: msgs,
	}, nopCallback())
	if err != nil {
		t.Fatalf("turn 2 StreamMessage: %v", err)
	}
	if provider.TokenCount(res2.CachedTokens) == 0 {
		t.Errorf("turn 2 actual CachedTokens = 0; expected the fake's reported cache_read (warm)")
	}

	msgs = append(msgs, assistantMsg("turn 2 reply"), userMsg("turn 3 user"))
	res3, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys", Messages: msgs,
	}, nopCallback())
	if err != nil {
		t.Fatalf("turn 3 StreamMessage: %v", err)
	}
	if provider.TokenCount(res3.CachedTokens) == 0 {
		t.Errorf("turn 3 actual CachedTokens = 0; expected warm")
	}

	trace := readTrace(t, tracePath)
	if len(trace) == 0 {
		t.Fatal("expected at least one fake-CLI spawn in trace, got none")
	}
	// Turn 1 may be -p (one-shot fresh). Turn 2 may either reuse the
	// process from turn 1 or respawn via --resume <uuid>. Either way:
	// EVERY non-first spawn must carry --resume=<the captured uuid>.
	for i, rec := range trace {
		if i == 0 {
			continue
		}
		if rec.ResumeID != "uuid-keepalive" {
			t.Errorf("spawn #%d: ResumeID = %q, want uuid-keepalive (cold-start regression)", i, rec.ResumeID)
		}
	}
	// Must not have spawned more than once per turn (≤3 spawns total).
	if len(trace) > 3 {
		t.Errorf("too many spawns: %d (want ≤ 3, one per turn at most)", len(trace))
	}

	// Tear down so the fake's stdin EOFs and it exits cleanly between tests.
	c.dropSession(convID)
}

// TestKeepAlive_DivergenceColdStarts: edit a previously-sent message, send
// the new (divergent) prefix, and assert the post-divergence spawn does not
// reuse the stale sessionUUID. Path 2 (synthetic-resume) spawns with a
// freshly-minted --resume <uuid> pointing at a synthesised JSONL of the
// edited history; that's still semantically a cold start (new session)
// while preserving the assistant turns the CLI would otherwise drop.
func TestKeepAlive_DivergenceColdStarts(t *testing.T) {
	tracePath := installFakeClaude(t, fakeModeUntilClose, "uuid-divergence")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv-diverge"
	ctx := context.Background()

	msgs := []provider.Message{userMsg("original prefix")}
	if _, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys", Messages: msgs,
	}, nopCallback()); err != nil {
		t.Fatalf("turn 1: %v", err)
	}

	// Edit the original user message in place — divergence.
	edited := []provider.Message{userMsg("DIFFERENT prefix"), assistantMsg("reply"), userMsg("new")}
	if _, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys", Messages: edited,
	}, nopCallback()); err != nil {
		t.Fatalf("turn 2 (post-edit): %v", err)
	}

	trace := readTrace(t, tracePath)
	if len(trace) < 2 {
		t.Fatalf("expected at least 2 fake-CLI spawns (one per turn after divergence), got %d", len(trace))
	}
	last := trace[len(trace)-1]
	if last.ResumeID == "uuid-divergence" {
		t.Errorf("post-divergence spawn reused stale sessionUUID %q; expected either no --resume or a freshly-minted synthetic UUID", last.ResumeID)
	}
	// When the edited prefix has more than one message, Path 2 should
	// have synthesised a resume file with a new UUID. With one message
	// (no history), no synthesis happens and ResumeID stays "".
	if len(edited) > 1 && last.ResumeID == "" {
		t.Errorf("post-divergence spawn with multi-message history should have synthesised a --resume; got bare -p")
	}

	c.dropSession(convID)
}

// TestCancel_KillsLiveSubprocess: turn 1 emits tool_use and parks the
// fake; the test calls Cancel; the subprocess must exit promptly while the
// in-memory session is PRESERVED warm (resume anchor + sidecar kept), so the
// next StreamMessage resumes rather than cold-starts. A cancel is an
// interrupt, not a session invalidation.
func TestCancel_KillsLiveSubprocess(t *testing.T) {
	tracePath := installFakeClaude(t, fakeModeToolUse, "uuid-cancel")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv-cancel"
	ctx := context.Background()

	// Run the StreamMessage in a goroutine — it returns when the CLI
	// emits stop_reason=tool_use, which our fake does immediately. The
	// fake then parks; the live CLI subprocess remains alive until we
	// cancel.
	type streamOutcome struct {
		res *provider.StreamResult
		err error
	}
	done := make(chan streamOutcome, 1)
	go func() {
		res, err := c.streamMessage(ctx, provider.MessageRequest{
			ConversationID: convID, SystemPrompt: "sys",
			Messages: []provider.Message{userMsg("do a tool")},
		}, nopCallback())
		done <- streamOutcome{res, err}
	}()

	// Wait for StreamMessage to reach tool_use pause.
	select {
	case got := <-done:
		if got.err != nil {
			t.Fatalf("StreamMessage returned error: %v", got.err)
		}
		if got.res.StopReason != "tool_use" {
			t.Fatalf("expected StopReason=tool_use, got %q", got.res.StopReason)
		}
	case <-time.After(3 * time.Second):
		t.Fatal("StreamMessage did not return tool_use within 3s")
	}

	// Verify the subprocess is alive (read state directly off the *Client;
	// no global map any more).
	// A CLI that is not live here has already exited, so say how: its own
	// last words, and the status it left once reaped.
	sess := c.activeSession
	if sess == nil {
		t.Fatalf("expected live CLI for %s, got no session", convID)
	}
	if !sess.hasLiveCLI() {
		stderr := sess.drainStderr()
		status := "never spawned"
		if sess.live != nil && sess.live.cmd != nil {
			status = fmt.Sprint(sess.live.cmd.Wait())
		}
		t.Fatalf("expected live CLI for %s; the fake exited (wait: %s), stderr:\n%s", convID, status, stderr)
	}
	pid := sess.live.cmd.Process.Pid

	// Drive cancellation through the Conversation handle — that's the
	// only public lifecycle hook in production.
	conv, err := c.OpenConversation(ctx, convID)
	if err != nil {
		t.Fatalf("OpenConversation: %v", err)
	}
	cancelStart := time.Now()
	conv.Cancel("")
	elapsed := time.Since(cancelStart)
	if elapsed > 2*time.Second {
		t.Errorf("Cancel took %v, want < 2s", elapsed)
	}

	// Process must be dead within 1s — Kill is synchronous via Wait().
	deadline := time.Now().Add(time.Second)
	for time.Now().Before(deadline) {
		if !processAlive(pid) {
			break
		}
		time.Sleep(10 * time.Millisecond)
	}
	if processAlive(pid) {
		t.Errorf("subprocess pid=%d still alive after Cancel", pid)
	}

	// Cancel is warm-preserving: the live CLI is gone but the in-memory session
	// (resume anchor) survives and its pending tools are cleared, so the next
	// turn resumes warm rather than cold-starting.
	if c.activeSession == nil {
		t.Fatal("session must be preserved warm after Cancel, got nil")
	}
	if c.activeSession.hasLiveCLI() {
		t.Error("Cancel must tear down the live CLI")
	}
	if c.activeSession.pendingTools != nil {
		t.Errorf("Cancel must clear pendingTools, got %+v", c.activeSession.pendingTools)
	}

	_ = readTrace(t, tracePath) // sanity-only: ensures trace path was honored
}

// processAlive uses os.FindProcess + signal 0 — the standard Unix idiom
// for "is this pid still around without affecting it." On macOS/Linux a
// dead pid returns ESRCH on signal 0; that's our "not alive" signal.
func processAlive(pid int) bool {
	p, err := os.FindProcess(pid)
	if err != nil {
		return false
	}
	if err := p.Signal(syscall.Signal(0)); err != nil {
		return false
	}
	return true
}

// TestToolUsePark_AdvancesResumeAnchor: when a turn parks on tool_use the CLI
// has durably committed every fed user message to its transcript, so the
// resume anchor (sentCount/sentHash) must advance to cover that prefix — not
// stay stuck at the previous end_turn. Without this, the next resume re-feeds
// the already-committed user turn (duplicate) and a rollback can't be detected
// as divergent, so the model answers a deleted turn.
func TestToolUsePark_AdvancesResumeAnchor(t *testing.T) {
	installFakeClaude(t, fakeModeToolUse, "uuid-park")
	c := mkClient(t, "claude-sonnet-4-6")
	msgs := []provider.Message{userMsg("do a tool")}
	res, err := c.streamMessage(context.Background(), provider.MessageRequest{
		ConversationID: "conv-park", SystemPrompt: "sys", Messages: msgs,
	}, nopCallback())
	if err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	if res.StopReason != "tool_use" {
		t.Fatalf("expected tool_use, got %q", res.StopReason)
	}
	sess := c.activeSession
	if sess == nil {
		t.Fatal("expected parked session preserved")
	}
	if sess.sentCount != len(msgs) {
		t.Errorf("park must advance sentCount to the committed prefix (%d), got %d", len(msgs), sess.sentCount)
	}
	if sess.sentHash != hashRequestPrefix("sys", msgs, len(msgs)) {
		t.Errorf("park must capture sentHash over the committed prefix")
	}
}

// TestCancelParkedTool_ThenContinue_ResumesWarm: cancelling a parked tool and
// then sending a new message must resume WARM (delta of just the new tail),
// never cold-start. This is the regression that motivated deleting resumeDirty:
// a cancel is an interrupt, and the committed prefix is still valid.
func TestCancelParkedTool_ThenContinue_ResumesWarm(t *testing.T) {
	installFakeClaude(t, fakeModeToolUse, "uuid-warm")
	c := mkClient(t, "claude-sonnet-4-6")
	ctx := context.Background()
	if _, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: "conv-warm", SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("do a tool")},
	}, nopCallback()); err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	conv, err := c.OpenConversation(ctx, "conv-warm")
	if err != nil {
		t.Fatalf("OpenConversation: %v", err)
	}
	conv.Cancel("")

	// User abandons the tool and types a new message; the committed prefix
	// ([do a tool]) is unchanged, so this must resume-delta the tail.
	cont := []provider.Message{userMsg("do a tool"), userMsg("never mind, do this instead")}
	dec := classifyRegime(c.activeSession, c.model, "sys", cont, false)
	if dec.Regime != regimeResumeDelta {
		t.Errorf("cancel-then-continue must resume warm (regimeResumeDelta); got regime=%d reason=%q", dec.Regime, dec.Reason)
	}
}

// TestCancelParkedTool_ThenRollback_StartsFresh: cancelling a parked tool and
// then rolling history back past the committed point must start FRESH — never
// resume into the stale transcript and answer the deleted turn.
func TestCancelParkedTool_ThenRollback_StartsFresh(t *testing.T) {
	installFakeClaude(t, fakeModeToolUse, "uuid-rollback")
	c := mkClient(t, "claude-sonnet-4-6")
	ctx := context.Background()
	if _, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: "conv-rollback", SystemPrompt: "sys",
		Messages: []provider.Message{userMsg("do a tool")},
	}, nopCallback()); err != nil {
		t.Fatalf("streamMessage: %v", err)
	}
	conv, err := c.OpenConversation(ctx, "conv-rollback")
	if err != nil {
		t.Fatalf("OpenConversation: %v", err)
	}
	conv.Cancel("")

	// User deletes back past the committed message and starts differently.
	rolledBack := []provider.Message{userMsg("a completely different question"), userMsg("go")}
	dec := classifyRegime(c.activeSession, c.model, "sys", rolledBack, false)
	if dec.Regime != regimeStartFresh {
		t.Errorf("rollback past the committed prefix must start fresh; got regime=%d", dec.Regime)
	}
}

// toolDef builds a minimal provider.ToolDefinition for the tool-set tests.
func toolDef(name string) provider.ToolDefinition {
	return provider.ToolDefinition{
		Name:        name,
		Description: name,
		InputSchema: json.RawMessage(`{"type":"object","properties":{}}`),
	}
}

// TestHashToolNames_OrderIndependentAndSetSensitive pins the two properties the
// respawn-on-tool-change gate relies on: reordering the same tools yields the
// SAME fingerprint (so a cosmetic req.Tools shuffle never forces a needless
// recycle), while adding or removing a tool yields a DIFFERENT one (so a real
// MCP discovery change is detected).
func TestHashToolNames_OrderIndependentAndSetSensitive(t *testing.T) {
	a := []provider.ToolDefinition{toolDef("bash"), toolDef("read")}
	reordered := []provider.ToolDefinition{toolDef("read"), toolDef("bash")}
	if hashToolNames(a) != hashToolNames(reordered) {
		t.Error("hashToolNames must be order-independent; a reordering changed the fingerprint")
	}
	grown := []provider.ToolDefinition{toolDef("bash"), toolDef("read"), toolDef("mcp__github__create_issue")}
	if hashToolNames(a) == hashToolNames(grown) {
		t.Error("hashToolNames must change when a tool is added")
	}
	if hashToolNames(nil) == hashToolNames(a) {
		t.Error("hashToolNames of empty set must differ from a non-empty set")
	}
}

// TestKeepAlive_ToolSetChangeRecyclesCLI is the MCP-discovery-race regression.
// The claude CLI answers tools/list exactly once per spawn and freezes that
// snapshot for the process's whole lifetime, so a live CLI keeps advertising its
// spawn-time tool set. When MCP servers finish discovering mid-conversation,
// req.Tools grows — and the model must be able to see AND call the new tools on
// the very next turn, not hit "No such tool available". dispatchTurn detects the
// tool-set change (hashToolNames vs the live CLI's spawn-time signature) and
// recycles the CLI so tools/list re-runs with the current set, while --resume
// keeps the prompt cache warm. A cosmetic reorder of an unchanged set must NOT
// trigger a recycle.
func TestKeepAlive_ToolSetChangeRecyclesCLI(t *testing.T) {
	tracePath := installFakeClaude(t, fakeModeUntilClose, "uuid-toolset")
	c := mkClient(t, "claude-sonnet-4-6")
	convID := "conv-toolset"
	ctx := context.Background()

	base := []provider.ToolDefinition{toolDef("bash"), toolDef("read")}

	// Turn 1: spawn with the base tool set.
	msgs := []provider.Message{userMsg("turn 1")}
	if _, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys", Messages: msgs, Tools: base,
	}, nopCallback()); err != nil {
		t.Fatalf("turn 1: %v", err)
	}
	if !c.activeSession.hasLiveCLI() {
		t.Fatal("turn 1 should leave a live persistent CLI")
	}

	// Turn 2: the SAME tool set, only reordered — must NOT respawn. The live CLI
	// already advertises exactly these tools, so a recycle would waste the cache.
	reordered := []provider.ToolDefinition{toolDef("read"), toolDef("bash")}
	msgs = append(msgs, assistantMsg("r1"), userMsg("turn 2"))
	if _, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys", Messages: msgs, Tools: reordered,
	}, nopCallback()); err != nil {
		t.Fatalf("turn 2: %v", err)
	}
	if got := len(readTrace(t, tracePath)); got != 1 {
		t.Fatalf("turn 2 with an unchanged (reordered) tool set spawned %d CLIs; want 1 (live CLI reused)", got)
	}

	// Turn 3: an MCP server finished discovery — req.Tools now carries a NEW tool.
	// The live CLI's frozen tools/list can't surface it, so dispatchTurn must
	// recycle and respawn via --resume so tools/list re-advertises the full set.
	grown := []provider.ToolDefinition{toolDef("bash"), toolDef("read"), toolDef("mcp__github__create_issue")}
	msgs = append(msgs, assistantMsg("r2"), userMsg("turn 3"))
	if _, err := c.streamMessage(ctx, provider.MessageRequest{
		ConversationID: convID, SystemPrompt: "sys", Messages: msgs, Tools: grown,
	}, nopCallback()); err != nil {
		t.Fatalf("turn 3: %v", err)
	}

	trace := readTrace(t, tracePath)
	if len(trace) != 2 {
		t.Fatalf("tool-set change spawned %d CLIs total; want 2 (turn 1 spawn + turn 3 recycle)", len(trace))
	}
	// The recycle respawn must stay warm: --resume the captured uuid, not a cold start.
	if trace[1].ResumeID != "uuid-toolset" {
		t.Errorf("recycle spawn ResumeID = %q, want uuid-toolset (recycle must stay warm)", trace[1].ResumeID)
	}
	// The recycled CLI now carries the grown tool-set signature, so the next turn
	// with the same set won't recycle again.
	if !c.activeSession.hasLiveCLI() {
		t.Fatal("turn 3 should leave a live persistent CLI")
	}
	if c.activeSession.live.toolSig != hashToolNames(grown) {
		t.Error("recycled CLI's toolSig does not match the grown tool set")
	}

	c.dropSession(convID)
}
