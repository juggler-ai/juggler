//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"testing"
	"time"
)

// hookRec captures a run-strategy-hook the worker dispatched to the engine.
type hookRec struct {
	hook       string
	strategyID string
	threadID   string
	prev       string
	reqID      string
}

// newStrategyHookHarness wires a worker with an in-test "engine" client that
// records every run-strategy-hook it receives on hookCh. onActivate requests
// (those carrying a requestId) are answered via replyFn, which the caller
// supplies to control what the engine reports back (and whether it injects an
// item first). Mirrors engine_push_test.go's setup.
func newStrategyHookHarness(t *testing.T, strategyID string, replyFn func(w *ConversationWorker, rec hookRec)) (*ConversationWorker, chan hookRec) {
	t.Helper()
	w := NewConversationWorker("conv-hooks", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	initPayload, _ := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: "conv-hooks"},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	w.currentRun().handleInit(initPayload)
	// In production the switching/creating viewer writes currentStrategyId into
	// the doc metadata and it syncs into the worker; handleInit does not seed it.
	w.doc.SetMetadata("currentStrategyId", strategyID)

	hookCh := make(chan hookRec, 16)
	w.SetCallback("engine", func(b []byte) {
		var m struct {
			Type               string `json:"type"`
			Hook               string `json:"hook"`
			StrategyID         string `json:"strategyId"`
			ThreadItemID       string `json:"threadItemId"`
			PreviousStrategyID string `json:"previousStrategyId"`
			RequestID          string `json:"requestId"`
		}
		if json.Unmarshal(b, &m) != nil || m.Type != "run-strategy-hook" {
			return
		}
		rec := hookRec{hook: m.Hook, strategyID: m.StrategyID, threadID: m.ThreadItemID, prev: m.PreviousStrategyID, reqID: m.RequestID}
		hookCh <- rec
		if rec.reqID != "" && replyFn != nil {
			replyFn(w, rec)
		}
	})
	w.SetEngineClientID("engine")

	// Feed context/tools so the turn can build (a fresh conv has no context
	// items, so only the tools response is strictly required, but supplying
	// both is harmless and matches the other worker tests).
	go func() {
		ctxResp, _ := json.Marshal(map[string]any{
			"type": "render-context-items-response", "systemPrompt": "sys", "contexts": []any{},
		})
		toolsResp, _ := json.Marshal(map[string]any{"type": "tools-result", "tools": []any{}})
		for {
			if !w.engine.contextReply.inject(w.done, ctxResp) {
				return
			}
			if !w.engine.toolsReply.inject(w.done, toolsResp) {
				return
			}
		}
	}()

	// One plain text turn → the loop ends and the worker goes idle.
	w.setMockResponses([]MockResponse{{
		Blocks:     []LLMResponseBlock{{Type: "text", Content: "done"}},
		StopReason: "end_turn",
	}})
	return w, hookCh
}

// drainHooks collects up to n hook records within the deadline.
func drainHooks(t *testing.T, ch chan hookRec, n int) []hookRec {
	t.Helper()
	var got []hookRec
	deadline := time.After(5 * time.Second)
	for len(got) < n {
		select {
		case rec := <-ch:
			got = append(got, rec)
		case <-deadline:
			return got
		}
	}
	return got
}

// TestWorkerDrivesStrategyHooks pins the core contract that replaces the
// strategyOwnerIframeId election: the WORKER (not an elected viewer) dispatches
// the strategy lifecycle hooks to the engine. onActivate fires once at
// turn-start carrying the previous strategy id; onWorkerIdle fires when the root
// conversation goes idle. A successful onActivate (the engine answers) records
// the activation durably in activatedStrategyId so it never fires twice.
func TestWorkerDrivesStrategyHooks(t *testing.T) {
	// Engine answers onActivate with one captured guidance item → the worker
	// writes it itself (single writer) and records the activation.
	w, hookCh := newStrategyHookHarness(t, "read-only", func(w *ConversationWorker, rec hookRec) {
		resp, _ := json.Marshal(StrategyHookResponse{
			Type: "strategy-hook-response", RequestID: rec.reqID,
			Guidance: []GuidanceItem{{Content: "READ-ONLY MODE: explore first.", Source: "read-only"}},
		})
		w.engine.strategyHookReply.inject(w.done, resp)
	})

	w.driveStrategyLoop(t, "build a feature", false)

	hooks := drainHooks(t, hookCh, 2)
	if len(hooks) != 2 {
		t.Fatalf("expected 2 dispatched hooks (onActivate, onWorkerIdle), got %d: %+v", len(hooks), hooks)
	}
	if hooks[0].hook != "onActivate" {
		t.Errorf("first hook should be onActivate (at turn-start), got %q", hooks[0].hook)
	}
	if hooks[0].prev != defaultStrategyID {
		t.Errorf("first activation's previousStrategyId should be the seeded baseline %q (switched from default), got %q", defaultStrategyID, hooks[0].prev)
	}
	if hooks[0].reqID == "" {
		t.Error("onActivate must carry a requestId so the worker can block on injected guidance")
	}
	if hooks[1].hook != "onWorkerIdle" {
		t.Errorf("second hook should be onWorkerIdle (at idle), got %q", hooks[1].hook)
	}
	if hooks[1].reqID != "" {
		t.Errorf("onWorkerIdle is fire-and-forget and must carry no requestId, got %q", hooks[1].reqID)
	}

	if got, _ := w.doc.GetMetadata("activatedStrategyId").(string); got != "read-only" {
		t.Errorf("activatedStrategyId should be recorded as %q after a successful activation, got %q", "read-only", got)
	}

	// The worker (single writer) must have written the captured guidance into
	// its own doc — after the user message, never racing it.
	items := w.doc.GetItems()
	var reminderIdx, userIdx = -1, -1
	for i, it := range items {
		if it.Type == ItemTypeSystemReminder && it.Content == "READ-ONLY MODE: explore first." {
			reminderIdx = i
		}
		if it.Type == ItemTypeUser {
			userIdx = i
		}
	}
	if reminderIdx < 0 {
		t.Fatal("worker must write the captured onActivate guidance into the doc")
	}
	if userIdx < 0 || reminderIdx < userIdx {
		t.Errorf("guidance (idx %d) must be written after the user message (idx %d)", reminderIdx, userIdx)
	}
}

// TestWorkerActivatesSubThreadStrategy is the Issue-2 proof: strategy is
// per-thread on the WORKER path. Root is plain default; a sub-thread carries its
// OWN `currentStrategyId` override (read-only). When the worker drives a turn for
// that sub-thread, maybeActivateStrategy must resolve the SUB-THREAD's effective
// strategy (read-only, not the root default) and fire onActivate under it,
// recording the activation on the sub-thread's own marker.
//
// Before the fix maybeActivateStrategy bailed for any sub-thread (treating
// strategy as a flat conversation-level concern) and read flat metadata, so the
// override was silently ignored and no onActivate fired.
func TestWorkerActivatesSubThreadStrategy(t *testing.T) {
	// Root strategy left at default ("" → normalized to "default").
	w, hookCh := newStrategyHookHarness(t, "", func(w *ConversationWorker, rec hookRec) {
		resp, _ := json.Marshal(StrategyHookResponse{
			Type: "strategy-hook-response", RequestID: rec.reqID,
			Guidance: []GuidanceItem{{Content: "READ-ONLY MODE: explore first.", Source: "read-only"}},
		})
		w.engine.strategyHookReply.inject(w.done, resp)
	})

	// A sub-thread with its OWN read-only override on its Y.Map.
	threadID := insertThreadReturningID(t, w, "sub")
	w.doc.SetThreadField(threadID, "currentStrategyId", "read-only")

	// Drive activation as the worker would at the start of the sub-thread's turn
	// (handleSendMessage sets both the itemID and the thread's items array).
	w.turn.thread.itemID = threadID
	w.turn.thread.itemsArray = w.doc.GetThreadItemsArray(threadID)
	w.currentRun().maybeActivateStrategy()

	hooks := drainHooks(t, hookCh, 1)
	if len(hooks) == 0 || hooks[0].hook != "onActivate" {
		t.Fatalf("worker must fire onActivate for the sub-thread, got %+v", hooks)
	}
	if hooks[0].strategyID != "read-only" {
		t.Fatalf("onActivate must carry the sub-thread's effective strategy %q, got %q (flat root strategy leaked through)", "read-only", hooks[0].strategyID)
	}
	// The request must name the thread it belongs to. Without it the engine has
	// nothing to scope the hook by and installs the sub-thread's strategy on the
	// root thread, where it then refuses the user's own tool approvals.
	if hooks[0].threadID != threadID {
		t.Fatalf("onActivate must carry the sub-thread's threadItemId %q, got %q", threadID, hooks[0].threadID)
	}
	if got := w.doc.GetActivatedStrategyID(threadID); got != "read-only" {
		t.Fatalf("sub-thread's own activatedStrategyId must be recorded %q, got %q", "read-only", got)
	}
	// Root must remain unactivated for read-only — the override is the sub-thread's.
	if got := w.doc.GetActivatedStrategyID(""); got == "read-only" {
		t.Errorf("root must NOT be activated read-only by a sub-thread override (got %q)", got)
	}

	// The captured guidance must be injected into the SUB-THREAD's items, not root.
	subItems := w.doc.GetItemsFromArray(w.doc.GetThreadItemsArray(threadID))
	found := false
	for _, it := range subItems {
		if it.Type == ItemTypeSystemReminder && it.Content == "READ-ONLY MODE: explore first." {
			found = true
		}
	}
	if !found {
		t.Errorf("read-only onActivate guidance must be injected into the sub-thread's own items")
	}
}

// TestWorkerDispatchesContextTurnHook proves the worker fires the context-item
// onTurnEnd hook at the same root-idle chokepoint as onWorkerIdle: once per
// completed turn, fire-and-forget (no requestId), carrying the just-incremented
// turn counter. It shares dispatchWorkerIdleHook's exact call site, so it
// inherits that point's gating (root idle only — never a sub-thread drain or a
// compaction fold).
func TestWorkerDispatchesContextTurnHook(t *testing.T) {
	w := NewConversationWorker("conv-ctxhook", "user:test")
	t.Cleanup(func() { w.doc.Destroy() })

	initPayload, _ := json.Marshal(InitMessage{
		Type:         "init",
		Conversation: SerializedConversation{ID: "conv-ctxhook"},
		Config:       WorkerConfig{ProjectPath: t.TempDir()},
	})
	w.currentRun().handleInit(initPayload)

	type ctxHookRec struct {
		hook      string
		turnIndex int
		reqID     string
	}
	ch := make(chan ctxHookRec, 16)
	w.SetCallback("engine", func(b []byte) {
		var m struct {
			Type      string `json:"type"`
			Hook      string `json:"hook"`
			TurnIndex int    `json:"turnIndex"`
			RequestID string `json:"requestId"`
		}
		if json.Unmarshal(b, &m) != nil || m.Type != "run-context-hook" {
			return
		}
		ch <- ctxHookRec{hook: m.Hook, turnIndex: m.TurnIndex, reqID: m.RequestID}
	})
	w.SetEngineClientID("engine")

	// Feed context/tools so the turn can build, mirroring newStrategyHookHarness.
	go func() {
		ctxResp, _ := json.Marshal(map[string]any{
			"type": "render-context-items-response", "systemPrompt": "sys", "contexts": []any{},
		})
		toolsResp, _ := json.Marshal(map[string]any{"type": "tools-result", "tools": []any{}})
		for {
			if !w.engine.contextReply.inject(w.done, ctxResp) {
				return
			}
			if !w.engine.toolsReply.inject(w.done, toolsResp) {
				return
			}
		}
	}()

	w.setMockResponses([]MockResponse{{
		Blocks:     []LLMResponseBlock{{Type: "text", Content: "done"}},
		StopReason: "end_turn",
	}})

	w.driveStrategyLoop(t, "build a feature", false)

	select {
	case rec := <-ch:
		if rec.hook != "onTurnEnd" {
			t.Errorf("context hook should be onTurnEnd, got %q", rec.hook)
		}
		if rec.reqID != "" {
			t.Errorf("onTurnEnd is fire-and-forget and must carry no requestId, got %q", rec.reqID)
		}
		if rec.turnIndex < 1 {
			t.Errorf("onTurnEnd should carry the completed-turn counter (>=1), got %d", rec.turnIndex)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("worker did not dispatch a run-context-hook at root idle")
	}
}

// TestStrategyActivationDefersWhenEngineSilent proves the worker does NOT record
// the activation if the engine never answers (torn down / not loaded), so a
// later turn with a healthy engine retries rather than permanently swallowing
// the activation. The engine here records the dispatch but never replies.
func TestStrategyActivationDefersWhenEngineSilent(t *testing.T) {
	orig := StrategyHookTimeout
	StrategyHookTimeout = 200 * time.Millisecond
	t.Cleanup(func() { StrategyHookTimeout = orig })

	w, hookCh := newStrategyHookHarness(t, "read-only", func(_ *ConversationWorker, _ hookRec) {
		// Deliberately never reply → the worker's wait must time out.
	})

	w.driveStrategyLoop(t, "build a feature", false)

	hooks := drainHooks(t, hookCh, 1)
	if len(hooks) == 0 || hooks[0].hook != "onActivate" {
		t.Fatalf("expected an onActivate dispatch, got %+v", hooks)
	}
	// It must NOT advance to the new strategy (still the seeded baseline), so a
	// later turn with a healthy engine retries the activation.
	if got, _ := w.doc.GetMetadata("activatedStrategyId").(string); got == "read-only" {
		t.Errorf("activatedStrategyId must not advance to %q when the engine never answers (got %q) so the next turn retries", "read-only", got)
	}
}
