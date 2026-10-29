//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package integration_test

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/enginehost"
	"juggler/internal/srcroot"
	"juggler/tests/helpers"
)

// Model id the stand-in gateway advertises. Obviously not a real model, so a
// run that somehow reached a real provider fails loudly rather than quietly
// costing money.
const oneShotModelID = "fake-model"

// What the scripted gateway makes the agent do, and what it says afterwards.
const (
	oneShotFileName = "hello.txt"
	oneShotContent  = "potato\n"
	oneShotSentinel = "POTATO-PLANTED"
)

// TestOneShotRunWritesAFileUnattended is the `juggler run` conformance test: one
// prompt, one process, nobody watching, and a real tool executed on the way
// through. It runs the shipped binary against a stand-in OpenAI-compatible
// gateway, so it needs no network and no API key, and the model's two answers
// are fixed — the run either carries them out or it does not.
//
// The load-bearing assertion is the last one, on the turn's transaction blob. A
// conversation seeded outside the JS model gets an EMPTY system prompt and the
// default strategy, and then runs perfectly: the process exits 0, the JSON says
// completed, and the only symptom is a model that was never told what it is or
// what it can do. Every cheaper check here — exit code, status, the file on
// disk — passes just as happily in that state, which is what makes it worth
// spending a whole end-to-end run to read what actually went on the wire. The
// Yjs document cannot answer this: its SYSTEM_1 item is a placeholder that is
// legitimately empty, because the prompt is rendered engine-side at turn time.
// The blob under <conversationDir>/txns/ is the only record of the real thing.
//
// It skips loudly when node is missing or too old — the run is driven by the
// engine, and a node-less leg would otherwise drop this coverage in silence.
func TestOneShotRunWritesAFileUnattended(t *testing.T) {
	binary := oneShotBinary(t)

	proj := t.TempDir()
	wantPath := filepath.Join(proj, oneShotFileName)

	gateway := startFakeGateway(t, wantPath)
	cfgDir := writeOneShotConfig(t, gateway.URL+"/v1")

	stdout, stderr, code := runOneShot(t, binary, proj, cfgDir, 3*time.Minute,
		"Create "+oneShotFileName+" in the project containing the word potato.")
	report := func(format string, args ...any) string {
		return fmt.Sprintf(format, args...) + "\n" + tailLog(stderr)
	}

	if code != 0 {
		t.Fatal(report("`juggler run` exited %d, want 0.\nstdout:\n%s", code, stdout))
	}
	assertNothingOutlivedTheRun(t, proj, cfgDir)

	outcome := decodeOnlyJSONObject(t, stdout, stderr)
	if outcome.Status != "completed" {
		t.Fatal(report("status = %q (error %q, parked tool %q), want completed",
			outcome.Status, outcome.ErrorText, outcome.ParkedTool))
	}
	if outcome.Turns < 1 {
		t.Fatal(report("turns = %d, want at least 1 — the prompt never reached the model", outcome.Turns))
	}
	if !strings.Contains(outcome.FinalText, oneShotSentinel) {
		t.Error(report("final text %q does not carry the sentinel %q — the run did not reach the scripted answer",
			outcome.FinalText, oneShotSentinel))
	}

	// The tool really ran, unattended and unapproved: the file is on disk with
	// the content the model asked for.
	written, err := os.ReadFile(wantPath)
	if err != nil {
		t.Fatal(report("the write tool left no file at %s: %v", wantPath, err))
	}
	if string(written) != oneShotContent {
		t.Error(report("%s contains %q, want %q", oneShotFileName, string(written), oneShotContent))
	}

	convDir := outcome.ConversationDir
	if convDir == "" {
		t.Fatal(report("the outcome named no conversation directory"))
	}
	if !filepath.IsAbs(convDir) {
		convDir = filepath.Join(proj, convDir)
	}
	if _, err := os.Stat(convDir); err != nil {
		t.Fatal(report("conversation directory %s: %v", convDir, err))
	}

	prompt, tools := bestTransactionBlob(t, convDir, stderr)
	if prompt <= 500 {
		t.Error(report("the turn's system prompt was %d characters, want a real one (>500). "+
			"A conversation seeded outside the JS model runs exactly like this and answers nothing it was asked",
			prompt))
	}
	if tools == 0 {
		t.Error(report("the turn carried no tools, so the model was offered nothing to do"))
	}
	t.Logf("transaction blob: system prompt %d chars, %d tools", prompt, tools)
}

// TestOneShotRunReportsATimeoutInItsExitStatus holds `juggler run` to its
// documented exit codes when the run does NOT succeed.
//
// The whole point of the command is to be read by something unattended, and the
// only thing a caller is guaranteed to see is the exit status, and the JSON
// payload must agree with it: a batch runner reading either one must score a
// timed-out instance as timed out, never as a success.
//
// The gateway here accepts the completion and then never answers it, which is
// the shape of the failure this has to survive: a provider that has taken the
// request and gone quiet, leaving the wall clock as the only way out.
func TestOneShotRunReportsATimeoutInItsExitStatus(t *testing.T) {
	binary := oneShotBinary(t)

	proj := t.TempDir()
	gateway, calls := startStalledGateway(t)
	cfgDir := writeOneShotConfig(t, gateway.URL+"/v1")

	stdout, stderr, code := runOneShot(t, binary, proj, cfgDir, 10*time.Second,
		"Say something. Anything at all.")
	report := func(format string, args ...any) string {
		return fmt.Sprintf(format, args...) + "\n" + tailLog(stderr)
	}

	if code != 4 {
		t.Fatal(report("`juggler run` exited %d, want 4 (timed out).\nstdout:\n%s", code, stdout))
	}
	assertNothingOutlivedTheRun(t, proj, cfgDir)

	outcome := decodeOnlyJSONObject(t, stdout, stderr)
	if outcome.Status != "timeout" {
		t.Error(report("status = %q, want timeout", outcome.Status))
	}
	// The payload and the process must agree. They are read by different callers
	// — one parses stdout, one reads $? — and a run that tells them different
	// stories is worse than one that fails outright.
	if outcome.ExitCode != code {
		t.Error(report("the outcome reported exit code %d but the process exited %d", outcome.ExitCode, code))
	}
	if outcome.ErrorText == "" {
		t.Error(report("a timed-out run explained nothing — the caller is owed the deadline it missed"))
	}
	// Deliberately no assertion on conversationDir. A run that times out this
	// early may have been killed before the engine created the conversation at
	// all, and then there is no directory to name — under load this test reached
	// exactly that state. Anything reading a timed-out run's trajectory has to
	// cope with the field being empty.

	// The turn ended with the run: its session was stopped before the run
	// exited, so the provider call it was stalled in is closed, not left
	// running in a process nobody is waiting on.
	if calls.seen.Load() > 0 && !calls.awaitAllEnded(time.Minute) {
		t.Error(report("%d stalled provider call(s) still open after `juggler run` exited", calls.open.Load()))
	}
}

// TestOneShotRunRefusesAProjectOpenElsewhere: a project already open in a
// session elsewhere holds its lock, so the session a run spawns for it cannot
// start. The run fails, and says that in so many words.
func TestOneShotRunRefusesAProjectOpenElsewhere(t *testing.T) {
	binary := oneShotBinary(t)

	proj := t.TempDir()
	lock := core.NewInstanceLock(proj)
	if res, err := lock.TryAcquire(); err != nil || !res.Acquired {
		t.Fatalf("hold the project lock: %+v, %v", res, err)
	}
	t.Cleanup(func() { _ = lock.Release() })
	cfgDir := writeOneShotConfig(t, "http://127.0.0.1:1/v1")

	stdout, stderr, code := runOneShot(t, binary, proj, cfgDir, time.Minute, "Say something.")
	if code != 1 {
		t.Fatalf("`juggler run` exited %d, want 1.\nstdout:\n%s\n%s", code, stdout, tailLog(stderr))
	}
	outcome := decodeOnlyJSONObject(t, stdout, stderr)
	if !strings.Contains(outcome.ErrorText, "open in another Juggler session") {
		t.Errorf("errorText %q does not say the project is open elsewhere", outcome.ErrorText)
	}
}

// assertNothingOutlivedTheRun checks that `juggler run` left nothing behind:
// the session it spawned has let go of the project (a process that has died
// holds no lock, however it died), and no machine server was started in its
// config directory.
func assertNothingOutlivedTheRun(t *testing.T, proj, cfgDir string) {
	t.Helper()
	if locked, info, err := core.CheckProjectLocked(proj); err != nil || locked {
		t.Errorf("after `juggler run` exited, its project is still locked (%+v, %v): its session outlived it", info, err)
	}
	if _, err := os.Stat(filepath.Join(cfgDir, "server.json")); err == nil {
		t.Error("`juggler run` left a machine server's server.json in its config directory")
	}
}

// oneShotBinary returns the shipped binary to run, skipping the test when the
// engine host it needs is unavailable. The run is driven by the engine, so a
// node-less leg would otherwise drop this coverage in silence.
func oneShotBinary(t *testing.T) string {
	t.Helper()
	if testing.Short() {
		t.Skip("spawns the juggler binary; skipped in -short mode")
	}
	node, err := exec.LookPath("node")
	if err != nil {
		t.Skip("node not found on PATH — skipping the one-shot run test " +
			"(install Node.js 22+ to exercise the headless engine host)")
	}
	out, err := exec.Command(node, "--version").Output()
	if err != nil {
		t.Skipf("node --version failed (%v) — skipping the one-shot run test", err)
	}
	version := strings.TrimSpace(string(out))
	major := 0
	if _, err := fmt.Sscanf(strings.TrimPrefix(version, "v"), "%d", &major); err != nil || major < enginehost.MinNodeMajor {
		t.Skipf("Node %s is too old — skipping the one-shot run test (need Node.js %d+)", version, enginehost.MinNodeMajor)
	}

	root, err := srcroot.Find(".")
	if err != nil {
		t.Fatalf("find project root: %v", err)
	}
	binary := helpers.ServerBinary(root)
	if _, err := os.Stat(binary); err != nil {
		t.Fatalf("server binary not built at %s (run make go-build): %v", binary, err)
	}
	return binary
}

// oneShotOutcome is the `--json` object `juggler run` prints on stdout.
type oneShotOutcome struct {
	Status          string `json:"status"`
	ExitCode        int    `json:"exitCode"`
	ConversationID  string `json:"conversationId"`
	ConversationDir string `json:"conversationDir"`
	Turns           int    `json:"turns"`
	FinalText       string `json:"finalText"`
	ParkedTool      string `json:"parkedTool"`
	ErrorText       string `json:"errorText"`
}

// decodeOnlyJSONObject parses stdout as one JSON object and nothing else. The
// "nothing else" half is the contract being tested: a caller pipes stdout, so
// anything the server says about itself belongs on stderr.
func decodeOnlyJSONObject(t *testing.T, stdout, stderr string) oneShotOutcome {
	t.Helper()
	var outcome oneShotOutcome
	dec := json.NewDecoder(strings.NewReader(stdout))
	if err := dec.Decode(&outcome); err != nil {
		t.Fatalf("stdout is not a JSON object: %v\nstdout:\n%s\n%s", err, stdout, tailLog(stderr))
	}
	if _, err := dec.Token(); err != io.EOF {
		t.Fatalf("stdout carried more than the outcome object (next token err=%v)\nstdout:\n%s", err, stdout)
	}
	return outcome
}

// bestTransactionBlob returns the largest system prompt and tool count recorded
// across the conversation's transaction blobs — one JSON file per LLM
// round-trip, written before anything else in the turn can go wrong.
func bestTransactionBlob(t *testing.T, convDir, stderr string) (promptLen, toolCount int) {
	t.Helper()
	txnDir := filepath.Join(convDir, "txns")
	entries, err := os.ReadDir(txnDir)
	if err != nil {
		t.Fatalf("no transaction blobs in %s: %v\n%s", txnDir, err, tailLog(stderr))
	}
	seen := 0
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(txnDir, entry.Name()))
		if err != nil {
			t.Fatalf("read blob %s: %v", entry.Name(), err)
		}
		var blob struct {
			Input struct {
				SystemPrompt string            `json:"systemPrompt"`
				Tools        []json.RawMessage `json:"tools"`
			} `json:"input"`
		}
		if err := json.Unmarshal(data, &blob); err != nil {
			t.Fatalf("parse blob %s: %v", entry.Name(), err)
		}
		seen++
		if len(blob.Input.SystemPrompt) > promptLen {
			promptLen = len(blob.Input.SystemPrompt)
		}
		if len(blob.Input.Tools) > toolCount {
			toolCount = len(blob.Input.Tools)
		}
	}
	if seen == 0 {
		t.Fatalf("%s holds no transaction blobs — nothing was ever sent to the model\n%s", txnDir, tailLog(stderr))
	}
	return promptLen, toolCount
}

// writeOneShotConfig builds an isolated config directory pointing the
// OpenAI-compatible provider at the stand-in gateway, and pinning it as the
// default model so the run never consults a real provider.
func writeOneShotConfig(t *testing.T, baseURL string) string {
	t.Helper()
	dir := t.TempDir()
	write := func(name string, payload any) {
		data, err := json.Marshal(payload)
		if err != nil {
			t.Fatalf("marshal %s: %v", name, err)
		}
		if err := os.WriteFile(filepath.Join(dir, name), data, 0o600); err != nil {
			t.Fatalf("write %s: %v", name, err)
		}
	}
	write("credentials.json", map[string]string{
		"openai_compatible_base_url": baseURL,
		"openai_compatible_api_key":  "test-key",
	})
	write("default-model.json", map[string]string{
		"provider": "openai-compatible",
		"model":    oneShotModelID,
	})
	return dir
}

// runOneShot spawns `juggler run --json` against the isolated config and returns
// its stdout, stderr and exit code. The context deadline sits above the run's
// own so a wedged binary fails this test rather than the whole suite, and the
// process group is killed either way — the run owns a node child.
func runOneShot(t *testing.T, binary, proj, cfgDir string, timeout time.Duration, prompt string) (stdout, stderr string, code int) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()

	// A run started from a pipe has no terminal, so it discards its console and
	// writes everything diagnostic to this directory instead — the engine's own
	// lines included. Its stderr carries only the two startup banners, which say
	// nothing about how a run went wrong, so a failure that reads its stderr and
	// stops there is reading the one stream guaranteed to be uninformative. Hold
	// the directory so the reporters below can quote the log that matters.
	logDir := t.TempDir()
	cmd := exec.CommandContext(ctx, binary, "run",
		"--project", proj, "--json", "--timeout", timeout.String(), prompt)
	cmd.Env = append(environWithoutJuggler(),
		"JUGGLER_CONFIG_DIR="+cfgDir,
		"JUGGLER_LOG_DIR="+logDir,
		"JUGGLER_ENGINE_HOST=node")
	helpers.SetProcGroupAttr(cmd)

	var outBuf, errBuf bytes.Buffer
	cmd.Stdout = &outBuf
	cmd.Stderr = &errBuf

	if err := cmd.Start(); err != nil {
		t.Fatalf("start %s run: %v", binary, err)
	}
	t.Cleanup(func() {
		if cmd.Process != nil {
			helpers.SignalGroup(cmd, syscall.SIGKILL)
		}
	})

	err := cmd.Wait()
	if ctx.Err() != nil {
		t.Fatalf("`juggler run` did not exit within the test's own deadline\n%s%s",
			tailLog(errBuf.String()), tailRunLog(logDir))
	}
	var exitErr *exec.ExitError
	switch {
	case err == nil:
		code = 0
	case errors.As(err, &exitErr):
		code = exitErr.ExitCode()
	default:
		t.Fatalf("wait for `juggler run`: %v\n%s%s", err,
			tailLog(errBuf.String()), tailRunLog(logDir))
	}
	// A run that reported an outcome the caller did not expect is the case this
	// log exists for, and the directory goes when the test does — so attach it
	// to any failure the caller goes on to report, rather than to none.
	t.Cleanup(func() {
		if t.Failed() {
			t.Logf("`juggler run` exited %d\n%s", code, tailRunLog(logDir))
		}
	})
	return outBuf.String(), errBuf.String(), code
}

// tailRunLog returns the end of whatever the run wrote under its log directory.
// Every file, because which one carries the answer depends on how it failed: the
// server's own log holds startup, and the engine's stdout is bridged into it.
func tailRunLog(logDir string) string {
	var out strings.Builder
	// Walked rather than listed: the server files its log under a per-project
	// subdirectory of the log dir, so nothing a run writes is at the top level.
	err := filepath.WalkDir(logDir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return nil //nolint:nilerr // an unreadable corner is not worth failing a report over
		}
		body, readErr := os.ReadFile(path)
		if readErr != nil {
			return nil
		}
		rel, relErr := filepath.Rel(logDir, path)
		if relErr != nil {
			rel = path
		}
		out.WriteString("\n--- " + rel + " ---\n")
		out.WriteString(tailLog(string(body)))
		return nil
	})
	if err != nil {
		return "\n--- run log unreadable: " + err.Error() + " ---"
	}
	if out.Len() == 0 {
		return "\n--- the run wrote no log at all ---"
	}
	return out.String()
}

// environWithoutJuggler is the ambient environment with every JUGGLER_ variable
// dropped, so the pool's own settings cannot shadow this run's. A duplicate
// name is resolved by the first entry, not the last, which would otherwise make
// the appended overrides silently inert.
func environWithoutJuggler() []string {
	env := os.Environ()
	kept := env[:0]
	for _, entry := range env {
		if strings.HasPrefix(entry, "JUGGLER_") {
			continue
		}
		kept = append(kept, entry)
	}
	return kept
}

// startFakeGateway stands up an OpenAI-compatible gateway with a two-step
// script: the turn that is offered tools and has no tool result yet gets a call
// to the `write` tool; the turn carrying that result gets the final answer.
//
// The script is keyed on the request's own shape rather than on a call counter,
// because the server also makes unrelated completion calls (naming the
// conversation, for one) that would otherwise consume a scripted step and leave
// the run answered out of order. Anything the script does not recognise gets a
// harmless one-word completion — a stand-in that returns 4xx teaches the retry
// loop something this test is not about.
func startFakeGateway(t *testing.T, wantPath string) *httptest.Server {
	t.Helper()
	var toolCalls, finals, others atomic.Int64

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"object":"list","data":[{"id":%q,"object":"model","owned_by":"juggler-test"}]}`, oneShotModelID)
			return
		}
		if r.URL.Path != "/v1/chat/completions" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = io.WriteString(w, `{}`)
			return
		}

		body, err := io.ReadAll(r.Body)
		if err != nil {
			t.Errorf("read completions body: %v", err)
			return
		}
		var payload struct {
			Messages []struct {
				Role string `json:"role"`
			} `json:"messages"`
			Tools []json.RawMessage `json:"tools"`
		}
		if err := json.Unmarshal(body, &payload); err != nil {
			t.Errorf("parse completions body: %v", err)
			return
		}
		carriesToolResult := false
		for _, msg := range payload.Messages {
			if msg.Role == "tool" {
				carriesToolResult = true
			}
		}

		switch {
		case carriesToolResult:
			finals.Add(1)
			writeSSE(t, w, textChunk("The file is planted. "+oneShotSentinel), stopChunk("stop"))
		case len(payload.Tools) > 0:
			toolCalls.Add(1)
			writeSSE(t, w, writeToolChunk(t, wantPath), stopChunk("tool_calls"))
		default:
			others.Add(1)
			writeSSE(t, w, textChunk("Potato"), stopChunk("stop"))
		}
	}))
	t.Cleanup(func() {
		srv.Close()
		t.Logf("gateway served %d tool-call turns, %d final turns, %d other completions",
			toolCalls.Load(), finals.Load(), others.Load())
	})
	return srv
}

// startStalledGateway stands up a gateway that advertises the model and then
// accepts every completion without ever answering one. It stands in for a
// provider that has gone quiet mid-request — the failure the run's own deadline
// exists for, and the only one that reaches the timeout exit code without
// depending on how any real provider behaves.
//
// The blocked handlers are released before the server is closed, because Close
// waits for outstanding requests and would otherwise hang the test at teardown.
// A handler also returns when its caller goes, which it can see only once it
// has read the request body to its end, and the gateway counts the
// requests still held open, which is how a test sees that a stalled turn
// really ended rather than being left running somewhere.
func startStalledGateway(t *testing.T) (*httptest.Server, *stalledCalls) {
	t.Helper()
	release := make(chan struct{})
	var releaseOnce sync.Once
	calls := &stalledCalls{changed: make(chan struct{}, 1)}

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/v1/models" {
			w.Header().Set("Content-Type", "application/json")
			fmt.Fprintf(w, `{"object":"list","data":[{"id":%q,"object":"model","owned_by":"juggler-test"}]}`, oneShotModelID)
			return
		}
		calls.note(1)
		defer calls.note(-1)
		// net/http notices a caller going only once the body has been read.
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}))
	t.Cleanup(func() {
		releaseOnce.Do(func() { close(release) })
		srv.Close()
	})
	return srv, calls
}

// stalledCalls counts the requests a stalled gateway is holding open.
type stalledCalls struct {
	open, seen atomic.Int64
	changed    chan struct{}
}

func (c *stalledCalls) note(delta int64) {
	if delta > 0 {
		c.seen.Add(1)
	}
	c.open.Add(delta)
	select {
	case c.changed <- struct{}{}:
	default:
	}
}

// awaitAllEnded waits until the gateway holds no request open, each step
// following a caller going; budget is only patience before failing.
func (c *stalledCalls) awaitAllEnded(budget time.Duration) bool {
	deadline := time.After(budget)
	for c.open.Load() > 0 {
		select {
		case <-c.changed:
		case <-deadline:
			return false
		}
	}
	return true
}

// writeSSE sends chat.completion.chunk objects as a Server-Sent Events stream:
// one `data:` line each, terminated by `data: [DONE]`. This is the shape the
// client asks for — every Chat Completions turn it makes is a streaming one.
func writeSSE(t *testing.T, w http.ResponseWriter, chunks ...map[string]any) {
	t.Helper()
	w.Header().Set("Content-Type", "text/event-stream")
	w.WriteHeader(http.StatusOK)
	for _, chunk := range chunks {
		encoded, err := json.Marshal(chunk)
		if err != nil {
			t.Errorf("marshal chunk: %v", err)
			return
		}
		if _, err := fmt.Fprintf(w, "data: %s\n\n", encoded); err != nil {
			return
		}
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
	}
	_, _ = io.WriteString(w, "data: [DONE]\n\n")
}

// chunk builds one chat.completion.chunk around a single choice delta.
func chunk(delta map[string]any, finishReason any) map[string]any {
	choice := map[string]any{"index": 0, "delta": delta, "finish_reason": finishReason}
	return map[string]any{
		"id":      "chatcmpl-juggler-test",
		"object":  "chat.completion.chunk",
		"created": 0,
		"model":   oneShotModelID,
		"choices": []any{choice},
	}
}

// textChunk carries assistant text.
func textChunk(text string) map[string]any {
	return chunk(map[string]any{"content": text}, nil)
}

// stopChunk closes the stream with a finish reason and the usage block the
// client asks for via stream_options.
func stopChunk(reason string) map[string]any {
	final := chunk(map[string]any{}, reason)
	final["usage"] = map[string]any{"prompt_tokens": 1200, "completion_tokens": 40}
	return final
}

// writeToolChunk expresses the scripted `write` call: the tool the core
// extension offers for creating a file, whose arguments are the JSON object
// {file_path, content} its schema requires.
func writeToolChunk(t *testing.T, path string) map[string]any {
	t.Helper()
	args, err := json.Marshal(map[string]string{"file_path": path, "content": oneShotContent})
	if err != nil {
		t.Fatalf("marshal tool arguments: %v", err)
	}
	call := map[string]any{
		"index": 0,
		"id":    "call_write_1",
		"type":  "function",
		"function": map[string]any{
			"name":      "write",
			"arguments": string(args),
		},
	}
	return chunk(map[string]any{"tool_calls": []any{call}}, nil)
}
