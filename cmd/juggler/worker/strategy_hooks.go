//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"time"
)

// Strategy lifecycle hooks (onActivate / onWorkerIdle) are JS plugin code that
// mutates the conversation — session-wide flow. The architecture rule is that
// such flow runs in the ONE hidden engine, driven by the worker; viewers are
// pure UI. The worker is the single decider of WHEN a hook fires and dispatches
// it to the engine (targeted, never broadcast), so a hook runs exactly once
// with no per-viewer ownership election. This replaces the old
// strategyOwnerIframeId trick, where one elected viewer ran the hooks — fragile
// (a conversation reopened in a fresh page never re-claimed ownership, so its
// hooks silently stopped) and a textbook viewer-side-flow regression.

// defaultStrategyID is the baseline strategy whose onActivate is a no-op (the
// `default` plugin). The worker seeds a new conversation's activatedStrategyId
// to it so a plain default conversation never pays a no-op activation
// round-trip to the engine, while switching to / creating in a real strategy
// (plan, research) still fires onActivate.
const defaultStrategyID = "default"

// StrategyHookTimeout bounds how long the worker blocks waiting for the engine
// to run onActivate and for the injected guidance to sync back into the doc.
// On timeout the worker proceeds WITHOUT marking the strategy activated, so the
// next turn retries — self-healing once a warm engine is available, rather than
// permanently losing the guidance.
var StrategyHookTimeout = 10 * time.Second

// ensureEngineReady brings the on-demand engine up and waits for it to connect.
// Returns true when no gate is installed (tests / test-pool: the engine is an
// always-on iframe).
func (w *ConversationWorker) ensureEngineReady() bool {
	if w.engineReadyFunc == nil {
		return true
	}
	return w.engineReadyFunc()
}

// dispatchStrategyHook sends a run-strategy-hook request to the engine only. A
// non-empty requestID asks the engine to report the items it injected.
// strategyID is the worker's authoritative active strategy: the engine runs the
// hook on THAT strategy, never on its own (possibly sync-stale) copy. threadID
// (empty for root) names the thread that strategy belongs to, so a sub-thread's
// strategy is never installed over the root's.
func (w *ConversationWorker) dispatchStrategyHook(requestID, hook, strategyID, threadID, previousStrategyID string) {
	data, err := json.Marshal(RunStrategyHookRequest{
		Type:               "run-strategy-hook",
		RequestID:          requestID,
		Hook:               hook,
		StrategyID:         strategyID,
		ThreadItemID:       threadID,
		PreviousStrategyID: previousStrategyID,
	})
	if err != nil {
		w.log.Error("[worker] marshal run-strategy-hook (%s): %v", hook, err)
		return
	}
	w.tape.Record("strategy-hook-dispatch", map[string]any{"hook": hook, "req": requestID})
	w.callbacks.sendToEngine(data)
}

// maybeActivateStrategy fires the strategy onActivate hook exactly once per real
// strategy switch, at the start of the first turn under the new strategy.
//
// Strategy is PER-THREAD: the effective strategy is resolved by walking the
// thread chain (thread Y.Map currentStrategyId → parent → conversation metadata
// default), and the activation marker (activatedStrategyId) is stored per-thread
// too — root on doc metadata, a sub-thread on its own Y.Map. So a sub-thread
// that overrides (or inherits) a non-default strategy activates it for its OWN
// items exactly once, while a default thread (marker seeded to the default
// baseline at creation/init) never pays a no-op activation round-trip.
//
// currentStrategyId is written by the switching viewer and synced in; the worker
// owns activatedStrategyId, the durable record of which strategy has had its
// activation hook run for that thread. Persisting it in the doc means activation
// survives a viewer reload and a worker re-exec and fires once per genuine switch.
//
// onActivate's guidance is a durable doc item that must be present before
// buildMessages assembles the turn, so the worker blocks until the engine has
// run the hook AND the injected items have synced back into the worker's doc.
func (r *run) maybeActivateStrategy() {
	threadID := r.t.thread.itemID
	current := r.doc.ResolveEffectiveStrategyID(threadID)
	// Normalize the activation marker the same way the resolver normalizes the
	// effective strategy: an unset marker means "still on the default baseline".
	// So a default thread (root or sub-thread) whose marker was never written
	// never fires a no-op onActivate round-trip, while a thread that overrides
	// (or inherits) a non-default strategy activates it for its own items once.
	activated := r.doc.GetActivatedStrategyID(threadID)
	if activated == "" {
		activated = defaultStrategyID
	}
	if current == activated {
		return
	}
	// The engine is the only place the hook may run, and the LLM-call gate runs
	// too late for this. Bring it up now; if it can't come up the turn's own
	// gate will surface the error — leave activatedStrategyId unset so a later
	// turn retries.
	if !r.ensureEngineReady() {
		return
	}
	requestID := generateRequestID()
	reply, unregister := r.engine.strategyHookReply.register(requestID)
	defer unregister()
	r.dispatchStrategyHook(requestID, "onActivate", current, threadID, activated)
	guidance, ok := r.waitForStrategyHook(requestID, reply, StrategyHookTimeout)
	if !ok {
		return // engine didn't answer in time — retry on a later turn
	}
	// The WORKER writes the guidance (the engine only captured it), appending
	// after the just-promoted user message. Single writer ⇒ deterministic order.
	for _, g := range guidance {
		if g.Content == "" {
			continue
		}
		r.appendTargetMessage(ConversationItem{
			Type:      ItemTypeSystemReminder,
			ItemID:    generateItemID(),
			Content:   g.Content,
			Source:    g.Source,
			Timestamp: time.Now().Format(time.RFC3339),
		})
	}
	r.batcher.Flush()
	r.doc.SetActivatedStrategyID(threadID, current)
}

// dispatchWorkerIdleHook fires onWorkerIdle on the engine when the root
// conversation goes idle. Fire-and-forget: the hook's effects (e.g. plan
// execution spawning sub-threads) re-enter through the normal doc-sync /
// reconcile path, so there is nothing to wait for. The engine is up (it just
// ran the turn) and load-aware on its side for the rare cold-restart case.
func (r *run) dispatchWorkerIdleHook() {
	// onWorkerIdle fires when the ROOT conversation goes idle (r.t.thread already
	// cleared), so this resolves the root strategy; routing through the per-thread
	// resolver keeps every worker strategy read on one path.
	strategyID := r.doc.ResolveEffectiveStrategyID(r.t.thread.itemID)
	r.dispatchStrategyHook("", "onWorkerIdle", strategyID, r.t.thread.itemID, "")
}

// dispatchContextTurnHook fires the context-item onTurnEnd hook on the engine
// when the root conversation goes idle — once per completed turn. Dispatched
// from the same idle chokepoint as dispatchWorkerIdleHook, so it inherits that
// point's gating (it fires only on a genuine root idle, never on a sub-thread
// drain or a compaction fold). Fire-and-forget: the engine fans the hook out
// over every registered context-item type and each hook's effects are external
// side-effects (e.g. writing to a memory server), so there is nothing to wait
// for. Carries the monotonic turn fence as it stands at this idle edge, so a
// hook can distil only the content that is new since its last run. Sampled once
// into a local: this runs on the turn's own goroutine, where a sibling retiring
// on the actor can advance the fence between two reads, and the wire value and
// the tape entry must describe the same dispatch.
func (r *run) dispatchContextTurnHook() {
	turn := r.turnCounter.Load()
	data, err := json.Marshal(RunContextHookRequest{
		Type:      "run-context-hook",
		Hook:      "onTurnEnd",
		TurnIndex: int(turn),
	})
	if err != nil {
		r.log.Error("[worker] marshal run-context-hook: %v", err)
		return
	}
	r.tape.Record("context-hook-dispatch", map[string]any{"hook": "onTurnEnd", "turn": turn})
	r.callbacks.sendToEngine(data)
}

// dispatchCancelStrategyExecution tells the engine to abort any in-flight
// engine-driven strategy execution for this conversation (the plan driver's
// AbortController). Fire-and-forget; targeted at the engine only.
func (w *ConversationWorker) dispatchCancelStrategyExecution() {
	data, err := json.Marshal(map[string]any{
		"type": "cancel-strategy-execution",
	})
	if err != nil {
		return
	}
	w.callbacks.sendToEngine(data)
}

// waitForStrategyHook blocks until the engine answers the onActivate request
// with the guidance it captured, or the timeout elapses. Returns (guidance,
// true) on success, (nil, false) on timeout/cancellation. Mirrors the
// context/tools wait loop: it keeps servicing inbound messages and doc/batcher
// signals while it waits, so the single run goroutine never deadlocks.
func (r *run) waitForStrategyHook(requestID string, reply <-chan json.RawMessage, timeout time.Duration) ([]GuidanceItem, bool) {
	match := func(raw json.RawMessage) ([]GuidanceItem, bool) {
		var resp StrategyHookResponse
		if err := json.Unmarshal(raw, &resp); err != nil {
			return nil, false
		}
		r.tape.Record("strategy-hook-response", map[string]any{"req": requestID, "guidance": len(resp.Guidance)})
		return resp.Guidance, true
	}
	onTimeout := func() {
		r.log.Error("[worker] onActivate hook timed out (req %s) — activation deferred to next turn", requestID)
		r.tape.Record("strategy-hook-timeout", map[string]any{"req": requestID})
	}
	return waitForEngineReply(r, reply, timeout, match, onTimeout)
}
