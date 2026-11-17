//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"testing"
	"time"

	"juggler/cmd/juggler/core"

	"github.com/gorilla/websocket"
)

// Agent runs are driven here over real sockets: a viewer asks for runs, and
// the test answers as the engine would, creating each run's ephemeral
// conversation the way POST /api/conversations does.

// agentRunBudget bounds each wait for a step that should follow at once. It is
// patience before failing, never a duration under test.
const agentRunBudget = 30 * time.Second

// agentRunCount is how many runs are in flight.
func (s *Server) agentRunCount() int {
	n := 0
	s.agentRunHub().do(func(runs map[string]*agentRun) { n = len(runs) })
	return n
}

type agentRunRig struct {
	s   *Server
	ts  *httptest.Server
	mgr *core.SessionManager
}

func newAgentRunRig(t *testing.T) *agentRunRig {
	t.Helper()
	s, ts := newEngineSocketServer(t)
	s.setEngineLivenessWindow(time.Hour)
	// The viewer here carries no token; the token is a separate concern.
	s.test.authDisabled = true
	mgr, err := core.NewSessionManagerForPath(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(mgr.Shutdown)
	s.projectState.Store(&projectState{projectPath: mgr.GetProjectPath(), sessionManager: mgr, viewers: newViewerGroup()})
	s.agentRunModelResolver = func(context.Context, json.RawMessage) (core.ModelRef, error) {
		return core.ModelRef{Provider: "test-provider", Model: "test-model"}, nil
	}
	return &agentRunRig{s: s, ts: ts, mgr: mgr}
}

func (r *agentRunRig) engine(t *testing.T) *websocket.Conn {
	t.Helper()
	conn := dialEngine(t, r.ts)
	if !waitUntil(agentRunBudget, r.s.IsEngineConnected) {
		t.Fatal("the engine never registered")
	}
	return conn
}

// readFrame reads conn until a frame of type want arrives, decoding it into v.
func readFrame(t *testing.T, conn *websocket.Conn, want frameType, v any) {
	t.Helper()
	_ = conn.SetReadDeadline(time.Now().Add(agentRunBudget))
	for {
		_, data, err := conn.ReadMessage()
		if err != nil {
			t.Fatalf("waiting for %s: %v", want, err)
		}
		var head struct {
			Type frameType `json:"type"`
		}
		if json.Unmarshal(data, &head) == nil && head.Type == want {
			if err := json.Unmarshal(data, v); err != nil {
				t.Fatalf("decode %s: %v", want, err)
			}
			return
		}
	}
}

func startRun(t *testing.T, viewer *websocket.Conn, runID string, extra map[string]any) {
	t.Helper()
	frame := map[string]any{"type": frameAgentRunStart, "runId": runID, "prompt": "write it", "strategyId": "subagent-commit-message", "model": "cheap"}
	for k, v := range extra {
		frame[k] = v
	}
	if err := viewer.WriteJSON(frame); err != nil {
		t.Fatal(err)
	}
}

// bind makes the run's ephemeral conversation as the create route does, and
// returns its folder.
func (r *agentRunRig) bind(t *testing.T, runID string) (string, string) {
	t.Helper()
	id, dir, err := r.mgr.CreateEphemeralConversation("Agent run", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := r.s.bindAgentRun(runID, id); err != nil {
		t.Fatalf("bind %s: %v", runID, err)
	}
	return id, dir
}

func assertGone(t *testing.T, r *agentRunRig, convID, dir string) {
	t.Helper()
	if !waitUntil(agentRunBudget, func() bool { _, ok := r.mgr.ConvDir(convID); return !ok }) {
		t.Errorf("conversation %s still resolves after its run ended", convID)
	}
	if _, err := os.Stat(dir); !os.IsNotExist(err) {
		t.Errorf("the run's folder %s survived it (stat err %v)", dir, err)
	}
}

// Two runs in flight at once each get their own progress and their own
// result, whatever order the engine answers in, and each run's conversation is
// torn down when its result arrives.
func TestAgentRunsAreKeyedByRunID(t *testing.T) {
	r := newAgentRunRig(t)
	engine := r.engine(t)
	viewer := dialViewer(t, r.ts)

	startRun(t, viewer, "run_a", map[string]any{"maxTurns": 7, "workspaceId": "ws1", "timeoutMs": 60_000})
	var fa runAgentFrame
	readFrame(t, engine, frameRunAgent, &fa)
	startRun(t, viewer, "run_b", nil)
	var fb runAgentFrame
	readFrame(t, engine, frameRunAgent, &fb)
	if fa.RunID != "run_a" || fa.MaxTurns != 7 || fa.WorkspaceID != "ws1" || fa.ModelConfig.Provider != "test-provider" || fa.StrategyID != "subagent-commit-message" {
		t.Fatalf("the engine was asked %+v, want run_a as requested with its model resolved", fa)
	}
	if fb.RunID != "run_b" {
		t.Fatalf("second run arrived as %q", fb.RunID)
	}
	convA, dirA := r.bind(t, "run_a")
	convB, dirB := r.bind(t, "run_b")

	_ = engine.WriteJSON(map[string]any{"type": frameAgentRunProgress, "runId": "run_b", "toolUseId": "t1", "toolName": "read", "summary": "Read queue.go"})
	_ = engine.WriteJSON(map[string]any{"type": frameAgentRunResult, "runId": "run_b", "status": AgentRunCompleted, "text": "B", "turns": 2})
	_ = engine.WriteJSON(map[string]any{"type": frameAgentRunResult, "runId": "run_a", "status": AgentRunCompleted, "text": "A", "turns": 1})

	var p agentRunProgressFrame
	readFrame(t, viewer, frameAgentRunProgress, &p)
	if p.RunID != "run_b" || p.Summary != "Read queue.go" || p.ToolName != "read" {
		t.Errorf("progress %+v, want run_b's", p)
	}
	got := map[string]agentRunResultFrame{}
	for range 2 {
		var res agentRunResultFrame
		readFrame(t, viewer, frameAgentRunResult, &res)
		got[res.RunID] = res
	}
	if got["run_a"].Text != "A" || got["run_b"].Text != "B" || got["run_b"].Turns != 2 || got["run_a"].ConversationID != convA {
		t.Errorf("results %+v, want each run's own", got)
	}
	assertGone(t, r, convA, dirA)
	assertGone(t, r, convB, dirB)
}

// A cancel from the requester ends the run at once as cancelled, tells the
// engine to stop, and tears the conversation down; the engine's late answer
// goes nowhere.
func TestAgentRunCancelTearsDown(t *testing.T) {
	r := newAgentRunRig(t)
	engine := r.engine(t)
	viewer := dialViewer(t, r.ts)

	startRun(t, viewer, "run_c", nil)
	var f runAgentFrame
	readFrame(t, engine, frameRunAgent, &f)
	conv, dir := r.bind(t, "run_c")

	_ = viewer.WriteJSON(map[string]any{"type": frameAgentRunCancel, "runId": "run_c"})
	var res agentRunResultFrame
	readFrame(t, viewer, frameAgentRunResult, &res)
	if res.RunID != "run_c" || res.Status != AgentRunCancelled {
		t.Errorf("result %+v, want run_c cancelled", res)
	}
	var c cancelAgentRunFrame
	readFrame(t, engine, frameCancelAgentRun, &c)
	if c.RunID != "run_c" {
		t.Errorf("engine told to cancel %q", c.RunID)
	}
	var del conversationsChangedFrame
	readFrame(t, engine, frameConversationsChanged, &del)
	if del.Op != "deleted" || del.ID != conv {
		t.Errorf("engine told %+v, want the run's conversation deleted", del)
	}
	assertGone(t, r, conv, dir)
	if r.s.agentRunCount() != 0 {
		t.Errorf("%d runs still registered after a cancel", r.s.agentRunCount())
	}
}

// Past the cap a run is refused at once, saying why, and a finished run makes
// room again.
func TestAgentRunCapIsEnforced(t *testing.T) {
	r := newAgentRunRig(t)
	engine := r.engine(t)
	viewer := dialViewer(t, r.ts)

	for i := range maxAgentRuns {
		startRun(t, viewer, "run_"+string(rune('0'+i)), nil)
		var f runAgentFrame
		readFrame(t, engine, frameRunAgent, &f)
	}
	startRun(t, viewer, "run_over", nil)
	var res agentRunResultFrame
	readFrame(t, viewer, frameAgentRunResult, &res)
	if res.RunID != "run_over" || res.Status != AgentRunFailed || res.ErrorKind != agentRunErrorBusy || res.ErrorText == "" {
		t.Fatalf("over-cap result %+v, want a busy refusal", res)
	}

	_ = engine.WriteJSON(map[string]any{"type": frameAgentRunResult, "runId": "run_0", "status": AgentRunCompleted})
	readFrame(t, viewer, frameAgentRunResult, &res)
	startRun(t, viewer, "run_room", nil)
	var f runAgentFrame
	readFrame(t, engine, frameRunAgent, &f)
	if f.RunID != "run_room" {
		t.Errorf("after a run finished, the engine was asked %q", f.RunID)
	}
}

// A requester that disconnects takes its runs with it: the engine is told to
// stop and the conversation is torn down.
func TestAgentRunEndsWithItsRequester(t *testing.T) {
	r := newAgentRunRig(t)
	engine := r.engine(t)
	viewer := dialViewer(t, r.ts)

	startRun(t, viewer, "run_d", nil)
	var f runAgentFrame
	readFrame(t, engine, frameRunAgent, &f)
	conv, dir := r.bind(t, "run_d")
	_ = viewer.Close()

	var c cancelAgentRunFrame
	readFrame(t, engine, frameCancelAgentRun, &c)
	if c.RunID != "run_d" {
		t.Errorf("engine told to cancel %q", c.RunID)
	}
	assertGone(t, r, conv, dir)
}

// The server owns the clock: a run that outlives its timeout ends as timeout,
// and is torn down like any other.
func TestAgentRunTimesOut(t *testing.T) {
	r := newAgentRunRig(t)
	engine := r.engine(t)
	viewer := dialViewer(t, r.ts)

	startRun(t, viewer, "run_t", map[string]any{"timeoutMs": 200})
	var f runAgentFrame
	readFrame(t, engine, frameRunAgent, &f)
	conv, dir := r.bind(t, "run_t")
	var res agentRunResultFrame
	readFrame(t, viewer, frameAgentRunResult, &res)
	if res.Status != AgentRunTimedOut {
		t.Errorf("result %+v, want timeout", res)
	}
	assertGone(t, r, conv, dir)
}

// An engine that goes takes every run with it, reported as failed.
func TestAgentRunFailsWhenTheEngineGoes(t *testing.T) {
	r := newAgentRunRig(t)
	engine := r.engine(t)
	viewer := dialViewer(t, r.ts)

	startRun(t, viewer, "run_e", nil)
	var f runAgentFrame
	readFrame(t, engine, frameRunAgent, &f)
	conv, dir := r.bind(t, "run_e")
	_ = engine.Close()

	var res agentRunResultFrame
	readFrame(t, viewer, frameAgentRunResult, &res)
	if res.RunID != "run_e" || res.Status != AgentRunFailed || res.ErrorText == "" {
		t.Errorf("result %+v, want a failure that says why", res)
	}
	assertGone(t, r, conv, dir)
}

// A conversation created for a run that has already ended is refused and
// removed, so a create racing a cancel leaves nothing behind.
func TestAgentRunBindAfterTheRunEndedTearsDown(t *testing.T) {
	r := newAgentRunRig(t)
	id, dir, err := r.mgr.CreateEphemeralConversation("Agent run", "")
	if err != nil {
		t.Fatal(err)
	}
	if err := r.s.bindAgentRun("run_gone", id); err == nil {
		t.Fatal("bound a conversation to a run that is not running")
	}
	assertGone(t, r, id, dir)
}

// Starting a run with nothing to run is refused at once.
func TestAgentRunRefusesAnEmptyPrompt(t *testing.T) {
	r := newAgentRunRig(t)
	r.engine(t)
	viewer := dialViewer(t, r.ts)
	_ = viewer.WriteJSON(map[string]any{"type": frameAgentRunStart, "runId": "run_empty", "prompt": "  "})
	var res agentRunResultFrame
	readFrame(t, viewer, frameAgentRunResult, &res)
	if res.RunID != "run_empty" || res.Status != AgentRunFailed {
		t.Errorf("result %+v, want a refusal", res)
	}
}
