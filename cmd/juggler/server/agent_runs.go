//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package server

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"sync"
	"time"

	"juggler/cmd/juggler/core"
	"juggler/internal/jlog"
)

// Ephemeral headless agent runs: a prompt run to its end by a strategy, a tool
// set and a model, in a conversation no tab ever shows, whose transcript is
// thrown away once its answer has been read.
//
// The roles are split the way one-shot splits them, and for the same reason
// (one_shot.go): only the engine can seed a conversation, so the engine carries
// the run out. What this file owns is everything around it:
//
//   - Who asked. A run is started by a socket frame (agent-run-start), so its
//     progress and its result go back to that connection alone, as a shell's
//     output does — a viewer, or the engine itself when an engine plugin asked.
//   - The clock. A run has a deadline here; the engine is told it too, but only
//     so it can stop watching a turn nobody is waiting for.
//   - The conversation's whole life after its create. The engine makes it
//     through POST /api/conversations with `ephemeral` and the run's id, and the
//     create binds it to the run (bindAgentRun). From then on this file tears it
//     down — worker, provider resources, folder, and the engine's loaded copy —
//     on every way a run can end: its result, a cancel, its deadline, its
//     requester disconnecting, the engine going. A create for a run that has
//     already ended is torn down on the spot.
//
// The folder itself is core's ephemeral kind (CreateEphemeralConversation): it
// is never in the order, the names or the cap, and the next load sweeps any
// left by a crash. So the guarantee holds however the process ends.

// Statuses an agent run ends with.
const (
	AgentRunCompleted = "completed"
	// AgentRunParked: the turn stopped on a tool that wants a human. Unattended
	// there is nobody to ask, so the run ends rather than waiting forever.
	AgentRunParked    = "parked"
	AgentRunFailed    = "failed"
	AgentRunCancelled = "cancelled"
	AgentRunTimedOut  = "timeout"
)

// agentRunErrorBusy is the errorKind of a run refused because maxAgentRuns are
// already going: a caller can say "busy, try again" rather than show a failure.
const agentRunErrorBusy = "busy"

// maxAgentRuns is how many agent runs may be going at once in a session. Each
// is a conversation, a worker and a model call in flight; the cap keeps a
// caller in a loop from turning that into a hundred.
const maxAgentRuns = 4

// Deadlines for a run. One that names none gets the default; none may ask for
// more than the maximum.
const (
	defaultAgentRunTimeout = 10 * time.Minute
	maxAgentRunTimeout     = 60 * time.Minute
)

// AgentRunStart is the agent-run-start frame: what a caller asks to run.
type AgentRunStart struct {
	Type       frameType `json:"type"`
	RunID      string    `json:"runId"`
	Prompt     string    `json:"prompt"`
	StrategyID string    `json:"strategyId"`
	// Model is "cheap", "default", or {provider, model, thinking?}; omitted
	// means "default".
	Model       json.RawMessage `json:"model,omitempty"`
	WorkspaceID string          `json:"workspaceId,omitempty"`
	// MaxTurns caps the model responses the run may take; 0 is no cap.
	MaxTurns  int   `json:"maxTurns,omitempty"`
	TimeoutMs int64 `json:"timeoutMs,omitempty"`
	// Name labels the run's conversation, for logs.
	Name string `json:"name,omitempty"`
}

// AgentRunCancel is the agent-run-cancel frame.
type AgentRunCancel struct {
	Type  frameType `json:"type"`
	RunID string    `json:"runId"`
}

// agentRunModelConfig is the resolved model the engine sets on the run's
// conversation.
type agentRunModelConfig struct {
	Provider string `json:"provider"`
	Model    string `json:"model"`
	Thinking string `json:"thinking,omitempty"`
}

// runAgentFrame asks the engine to carry out a run.
type runAgentFrame struct {
	Type        frameType           `json:"type"`
	RunID       string              `json:"runId"`
	Prompt      string              `json:"prompt"`
	StrategyID  string              `json:"strategyId"`
	ModelConfig agentRunModelConfig `json:"modelConfig"`
	WorkspaceID string              `json:"workspaceId"`
	MaxTurns    int                 `json:"maxTurns"`
	TimeoutMs   int64               `json:"timeoutMs"`
	Name        string              `json:"name"`
}

// cancelAgentRunFrame tells the engine to stop a run.
type cancelAgentRunFrame struct {
	Type  frameType `json:"type"`
	RunID string    `json:"runId"`
}

// agentRunProgressFrame is one tool call a run made, as a line a person can
// read. The engine sends it, and the server passes it on to the requester.
type agentRunProgressFrame struct {
	Type      frameType `json:"type"`
	RunID     string    `json:"runId"`
	ToolUseID string    `json:"toolUseId"`
	ToolName  string    `json:"toolName"`
	Summary   string    `json:"summary"`
}

// agentRunResultFrame is how a run ended. The engine sends it, and the server
// passes it on — or sends its own, when the run ended here.
//
// Field names avoid the pair (`error`, `message`), which the client's router
// reads as a streaming error (see OneShotResult).
type agentRunResultFrame struct {
	Type   frameType `json:"type"`
	RunID  string    `json:"runId"`
	Status string    `json:"status"`
	// Text is the run's last assistant message: its answer.
	Text string `json:"text"`
	// Turns is how many model responses the run took.
	Turns      int    `json:"turns"`
	ParkedTool string `json:"parkedTool,omitempty"`
	ErrorText  string `json:"errorText,omitempty"`
	ErrorKind  string `json:"errorKind,omitempty"`
	// ConversationID names the conversation the run worked in. It is gone by
	// the time the result arrives.
	ConversationID string `json:"conversationId,omitempty"`
}

// agentRun is one run in flight.
type agentRun struct {
	id        string
	requester Sender
	clientID  string
	convID    string
	timer     *time.Timer
}

// agentRunHub is the session's runs in flight, by run id. Its map belongs to
// one goroutine, reached through cmds and started on first use. Each command is
// a lookup and a few field writes; the sends and teardowns that follow run on
// the caller's goroutine, after the command has returned.
type agentRunHub struct {
	once sync.Once
	cmds chan func()
	runs map[string]*agentRun
}

// agentRunHub is the server's agent-run hub, started if it was not.
func (s *Server) agentRunHub() *agentRunHub {
	h := &s.agentRuns
	h.once.Do(func() {
		h.cmds = make(chan func())
		h.runs = map[string]*agentRun{}
		go func() {
			for fn := range h.cmds {
				fn()
			}
		}()
	})
	return h
}

// do runs fn on the hub's goroutine, against its map, and waits for it.
func (h *agentRunHub) do(fn func(runs map[string]*agentRun)) {
	ran := make(chan struct{})
	h.cmds <- func() { fn(h.runs); close(ran) }
	<-ran
}

// lookupAgentRun is the run in flight under runID, or nil.
func (s *Server) lookupAgentRun(runID string) *agentRun {
	var run *agentRun
	s.agentRunHub().do(func(runs map[string]*agentRun) { run = runs[runID] })
	return run
}

// startAgentRun registers a run and hands it to the engine. Every refusal is a
// result frame to the requester, so a caller always reads one shape.
func (s *Server) startAgentRun(req AgentRunStart, requester Sender, clientID string) {
	refuse := func(kind, why string) {
		requester.Send(agentRunResultFrame{Type: frameAgentRunResult, RunID: req.RunID, Status: AgentRunFailed, ErrorKind: kind, ErrorText: why})
	}
	if strings.TrimSpace(req.RunID) == "" {
		jlog.Error("[agent-run] start with no run id from %s", clientID)
		return
	}
	if strings.TrimSpace(req.Prompt) == "" {
		refuse("", "there is no prompt to run")
		return
	}
	if !s.IsEngineConnected() {
		refuse("", "no engine is connected, so there is nothing to run the prompt")
		return
	}
	timeout := defaultAgentRunTimeout
	if req.TimeoutMs > 0 {
		timeout = min(time.Duration(req.TimeoutMs)*time.Millisecond, maxAgentRunTimeout)
	}

	refusal, busy := "", false
	s.agentRunHub().do(func(runs map[string]*agentRun) {
		if _, dup := runs[req.RunID]; dup {
			refusal = "a run with this id is already going"
			return
		}
		if len(runs) >= maxAgentRuns {
			refusal, busy = fmt.Sprintf("%d agent runs are already going; wait for one to finish", maxAgentRuns), true
			return
		}
		run := &agentRun{id: req.RunID, requester: requester, clientID: clientID}
		run.timer = time.AfterFunc(timeout, func() {
			s.finishAgentRun(req.RunID, agentRunResultFrame{Status: AgentRunTimedOut, ErrorText: fmt.Sprintf("the run did not finish within %s", timeout)}, true)
		})
		runs[req.RunID] = run
	})
	if refusal != "" {
		kind := ""
		if busy {
			kind = agentRunErrorBusy
		}
		refuse(kind, refusal)
		return
	}

	// Resolving the model can wait on provider state, so it is kept off the
	// socket's read loop.
	go func() {
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		model, err := s.resolveAgentRunModel(ctx, req.Model)
		if err != nil {
			s.finishAgentRun(req.RunID, agentRunResultFrame{Status: AgentRunFailed, ErrorText: err.Error()}, false)
			return
		}
		if s.lookupAgentRun(req.RunID) == nil {
			return
		}
		sent := engineRecipient{s}.Send(runAgentFrame{
			Type:        frameRunAgent,
			RunID:       req.RunID,
			Prompt:      req.Prompt,
			StrategyID:  req.StrategyID,
			ModelConfig: agentRunModelConfig{Provider: model.Provider, Model: model.Model, Thinking: model.Thinking},
			WorkspaceID: req.WorkspaceID,
			MaxTurns:    max(req.MaxTurns, 0),
			TimeoutMs:   timeout.Milliseconds(),
			Name:        req.Name,
		})
		if !sent {
			s.finishAgentRun(req.RunID, agentRunResultFrame{Status: AgentRunFailed, ErrorText: "the engine's connection closed before the run could be sent"}, false)
			return
		}
		jlog.Info("[agent-run] %s dispatched (strategy %s, model %s/%s)", req.RunID, req.StrategyID, model.Provider, model.Model)
	}()
}

// errAgentRunGone is a bind for a run that is no longer in flight.
var errAgentRunGone = errors.New("the agent run this conversation was made for has ended")

// bindAgentRun records convID as runID's conversation, so it is torn down when
// the run ends. A conversation made for a run that has already ended — a create
// racing a cancel — is torn down here instead, and the bind refused.
func (s *Server) bindAgentRun(runID, convID string) error {
	bound, ok := false, false
	s.agentRunHub().do(func(runs map[string]*agentRun) {
		run, found := runs[runID]
		ok = found
		if found && run.convID == "" {
			run.convID = convID
			bound = true
		}
	})
	if bound {
		return nil
	}
	s.teardownEphemeralConversation(convID)
	if ok {
		return fmt.Errorf("agent run %s already has a conversation", runID)
	}
	return errAgentRunGone
}

// forwardAgentRunProgress passes one progress line from the engine to the
// run's requester.
func (s *Server) forwardAgentRunProgress(p agentRunProgressFrame) {
	run := s.lookupAgentRun(p.RunID)
	if run == nil {
		return
	}
	p.Type = frameAgentRunProgress
	run.requester.Send(p)
}

// cancelAgentRun ends a run its requester gave up on. Only the connection that
// started a run may cancel it.
func (s *Server) cancelAgentRun(runID, clientID string) {
	run := s.lookupAgentRun(runID)
	if run == nil || run.clientID != clientID {
		return
	}
	s.finishAgentRun(runID, agentRunResultFrame{Status: AgentRunCancelled}, true)
}

// dropAgentRunsOf ends every run a disconnecting client started. A viewer's
// runs are cancelled in the engine; when the engine is the one going, every
// run fails, since whatever was carrying them out has gone with it.
func (s *Server) dropAgentRunsOf(clientID string, engineGone bool) {
	var ids []string
	s.agentRunHub().do(func(runs map[string]*agentRun) {
		for id, run := range runs {
			if engineGone || run.clientID == clientID {
				ids = append(ids, id)
			}
		}
	})
	for _, id := range ids {
		if engineGone {
			s.finishAgentRun(id, agentRunResultFrame{Status: AgentRunFailed, ErrorText: "the engine disconnected before the run finished"}, false)
		} else {
			s.finishAgentRun(id, agentRunResultFrame{Status: AgentRunCancelled, ErrorText: "the caller disconnected"}, true)
		}
	}
}

// finishAgentRun ends a run exactly once: it leaves the hub, its clock stops,
// the engine is told to stop when the end came from anywhere but the engine,
// its conversation is torn down, and the requester gets res. A second end of
// the same run — the engine's answer to a cancel, say — finds nothing and does
// nothing.
func (s *Server) finishAgentRun(runID string, res agentRunResultFrame, tellEngine bool) {
	var run *agentRun
	s.agentRunHub().do(func(runs map[string]*agentRun) {
		run = runs[runID]
		delete(runs, runID)
	})
	if run == nil {
		return
	}
	run.timer.Stop()
	if tellEngine {
		engineRecipient{s}.Send(cancelAgentRunFrame{Type: frameCancelAgentRun, RunID: runID})
	}
	if run.convID != "" {
		s.teardownEphemeralConversation(run.convID)
	}
	res.Type = frameAgentRunResult
	res.RunID = runID
	if res.ConversationID == "" {
		res.ConversationID = run.convID
	}
	jlog.Info("[agent-run] %s ended %s (conv %s)", runID, res.Status, run.convID)
	run.requester.Send(res)
}

// teardownEphemeralConversation removes every trace of a run's conversation:
// its worker and logs, its provider resources, its folder, and the engine's
// loaded copy. Only the engine is told: no viewer ever knew of it.
func (s *Server) teardownEphemeralConversation(convID string) {
	if convID == "" {
		return
	}
	if s.workerManager != nil {
		s.workerManager.RemoveAndPurgeLogs(convID)
	}
	if cc := s.conversationCache; cc != nil {
		cc.CloseConversation(convID)
	}
	if mgr := s.SessionManager(); mgr != nil {
		if err := mgr.DeleteEphemeralConversation(convID); err != nil {
			jlog.Error("[agent-run] could not remove conversation %s: %v", convID, err)
		}
	}
	engineRecipient{s}.Send(conversationsChangedFrame{Type: frameConversationsChanged, Op: "deleted", ID: convID})
}

// resolveAgentRunModel resolves a run's model: "cheap" and "default" as
// generateText resolves them (resolveLLMCompleteModel), and an explicit model as
// named. Unlike a one-shot completion an agent run is a conversation, which any
// provider can carry, so a CLI provider is not refused here.
func (s *Server) resolveAgentRunModel(ctx context.Context, raw json.RawMessage) (core.ModelRef, error) {
	if s.agentRunModelResolver != nil {
		return s.agentRunModelResolver(ctx, raw)
	}
	trimmed := strings.TrimSpace(string(raw))
	if len(raw) == 0 || trimmed == "null" {
		raw = json.RawMessage(`"default"`)
	}
	var obj struct {
		Provider string `json:"provider"`
		Model    string `json:"model"`
		Thinking string `json:"thinking"`
	}
	if err := json.Unmarshal(raw, &obj); err == nil && obj.Provider != "" && obj.Model != "" {
		model := obj.Model
		if concrete, ok := s.liveModelMatch(obj.Provider, obj.Model); ok {
			model = concrete
		}
		return core.ModelRef{Provider: obj.Provider, Model: model, Thinking: obj.Thinking}, nil
	}
	return s.resolveLLMCompleteModel(ctx, raw)
}
