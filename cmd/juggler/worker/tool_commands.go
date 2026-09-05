//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

package worker

import (
	"encoding/json"
	"fmt"
	"time"

	ycrdt "github.com/skyterra/y-crdt"
)

// maxToolCommandAttempts bounds how many times driveToolActions re-dispatches a
// tool-command that stays stuck at the same delivery state ("" or approved). Past
// this the worker escalates the tool to a terminal error so a parked turn unblocks
// instead of hanging forever, rather than re-driving indefinitely. At the default
// redriveInterval (~5s) this is ~30s of silence before escalation.
//
// The cap only applies to an engine that is ANSWERING FOR THIS TOOL. Exhausting
// it against an engine that has traced nothing for the tool means the commands
// never reached a handler, which is not the tool's fault and would repeat for
// every later tool; that case is held instead, up to engineUnprovenHold (see
// engineUnproven).
const maxToolCommandAttempts = 6

// defaultRedriveInterval is how long driveToolActions waits before re-dispatching
// a tool-command still stuck at the state it was last sent at. Doc-state
// progression (the engine claimed/evaluated the tool) suppresses re-drive
// immediately; this interval only bounds recovery of a silently-dropped command.
// Exposed as the redriveInterval worker field, which tests shrink.
const defaultRedriveInterval = 5 * time.Second

// engineUnprovenHold bounds how long a tool is held while the engine has
// answered nothing for it. Long enough for the server to notice the engine has
// gone silent, evict it, and for a reconnect or an engine-window reload to bring
// one back; short enough that the turn is released while the user is still
// watching, with a message naming the engine rather than the tool.
//
// The margin is deliberate and load-bearing: server-side recovery costs
// engineLivenessWindow (30s of heartbeat silence before eviction) plus
// engineReconnectGrace (20s for the engine to come back before it is reloaded),
// and this hold has to outlast the pair or the tool is failed while its engine
// is still being fetched back. Raising either of those without raising this
// re-breaks the sleep/wake case. They live in server/engine_liveness.go, which
// this package must not import — the coupling is by comment, so check it here.
const engineUnprovenHold = 60 * time.Second

// engineUnreachableHold bounds how long a tool is held while the engine is
// answering for it only to say it cannot reach it — it has no loaded copy of the
// conversation, or the copy it has does not hold the tool yet
// (engineUnreachableReasons). That is a decline, but a recoverable one: the
// engine is loading, and the same command re-driven afterwards succeeds.
//
// It is longer than engineUnprovenHold because it waits on a different, slower
// recovery. A mute engine waits on the server's eviction ladder (~50s); a
// loading engine waits on its own conversation load, whose ceiling is
// WORKER_READY_TIMEOUT_MS in web/js/services/worker-manager.js — 60s. A hold
// merely equal to that ties with the thing it is waiting for and fails the tool
// as the load lands, so this leaves a redriveInterval's headroom above it for
// the next command to actually run. Raising that JS timeout without raising this
// puts the race back.
const engineUnreachableHold = 90 * time.Second

// driveToolActions commands the engine — the single tool executor — to advance
// every non-terminal tool-action in the conversation. It is the worker side of
// the command-driven engine: the worker already observes every doc update via
// handleItemsChange, so rather than relying on the engine's reactive Yjs
// observer to notice a tool-action and react (the racy path that left tools
// "stuck"), the worker explicitly tells the engine what to do. The worker is the
// SOLE driver of the tool lifecycle; the engine has no tool observer.
//
// Called from tryReconcile on every reconcile tick. It scans root + nested
// threads and, per non-terminal tool-action, dispatches the command matching its
// state: "" → evaluate-tool, approved → execute-tool. pending (awaiting the user)
// and running (already claimed) need no command. Terminal tools are skipped.
//
// Dedup + recovery are one level-based rule: re-dispatch a tool's command only
// when the doc state still demands one AND it wasn't already dispatched at that
// state within redriveInterval (tools.shouldRedrive). Doc-state progression is the
// "engine acted" signal — the engine handlers are independently idempotent
// (handleNewToolAction's ifState CAS and claimRunning's compare-and-set), so a
// redundant command is a harmless no-op — so the age test alone both suppresses
// per-tick spam and recovers a silently-dropped command once it goes stale. A tool
// stuck at the same delivery state past maxToolCommandAttempts is escalated to a
// terminal error so the parked turn unblocks. Worker-managed tools (create_thread)
// are commanded too but the engine no-ops them (its handlers early-return on the
// workerManaged manifest), so they remain worker-executed.
func (w *ConversationWorker) driveToolActions() {
	w.driveToolActionsExcept(nil)
}

// driveToolActionsExcept advances tools only in threads not owned by a live run.
// The actor is the sole caller while turns run concurrently, which keeps the
// conversation-owned command tracker and strategy baselines single-goroutine.
func (w *ConversationWorker) driveToolActionsExcept(liveThreads map[string]bool) {
	// Re-evaluate tools parked awaiting approval if the active strategy changed
	// since the last tick. This is a pure worker-side doc write (independent of
	// the engine), so run it before the engine-attached guard — a switch made
	// while the engine is momentarily detached must not be lost.
	w.reevaluatePendingToolsOnStrategyChangeExcept(liveThreads)

	if !w.callbacks.engineAttached() {
		return
	}

	type toolCmd struct {
		id, state, action string
	}
	var cmds []toolCmd

	ycrdtMu.Lock()
	walkAllItems(w.doc.getItems(), "", func(m *ycrdt.YMap, threadID string) bool {
		if liveThreads[threadID] {
			return false
		}
		if t, _ := m.Get("type").(string); t != ItemTypeToolAction {
			return false
		}
		id, _ := m.Get("toolUseId").(string)
		if id == "" {
			return false
		}
		state, _ := m.Get("state").(string)
		var action string
		switch state {
		case StateUnevaluated:
			action = "evaluate-tool"
		case StateApproved:
			action = "execute-tool"
		default:
			// pending (awaiting user), running (already claimed), or terminal
			// (completed/cancelled): nothing for the worker to command. The user's
			// approval is expressed as the viewer's state=approved write, which
			// this walk picks up on the next tick via the StateApproved branch.
			return false
		}
		cmds = append(cmds, toolCmd{id: id, state: state, action: action})
		return false
	})
	ycrdtMu.Unlock()

	// Filter to the commands due for dispatch: either the doc demands a fresh
	// command (never dispatched, or the demanded state changed) or the last
	// dispatch at this state has aged past redriveInterval. recordDispatch stamps
	// the dispatch and returns the attempt count; past maxToolCommandAttempts the
	// tool is escalated to a terminal error instead of re-driven forever.
	now := time.Now()
	var toDispatch, escalate []toolCmd
	for _, c := range cmds {
		if !w.tools.shouldRedrive(c.id, c.state, now, w.redriveInterval) {
			continue // already dispatched at this state and not yet stale
		}
		if n := w.tools.recordDispatch(c.id, c.state, now); n > maxToolCommandAttempts {
			// Attempts are exhausted, but they only bound how long we wait on an
			// engine that is ANSWERING. An engine that has said nothing at all since
			// this phase began was never reached, so failing the tool would blame it
			// for a command it never received — and would go on doing so for every
			// later tool. Keep re-driving instead until the hold ceiling, giving the
			// engine's own recovery (eviction → reconnect → reload) time to land.
			if w.engineUnproven(c.id, now) {
				w.noteHeldToolCommand(c.id, n)
				toDispatch = append(toDispatch, c)
				continue
			}
			escalate = append(escalate, c)
			continue
		}
		toDispatch = append(toDispatch, c)
	}

	if len(toDispatch) > 0 {
		// The engine acts solely on these commands and must already hold the
		// tool-action each refers to. Push the full doc through the SAME ordered
		// engine mailbox the commands use, so the engine applies the tool-action
		// before handling the command (engine doc-syncs are batched behind a
		// setTimeout, so a bare command could arrive before the sync that created
		// the tool and resolve to nothing). This ordering discipline — commands ride
		// the doc-sync mailbox; the engine flushes pending syncs before acting — is
		// the load-bearing invariant of the command-driven engine.
		w.pushStateToEngine()
		for _, c := range toDispatch {
			w.dispatchToolCommand(c.action, c.id)
		}
	}

	for _, c := range escalate {
		w.escalateStaleToolCommand(c.id, c.state)
	}
}

// reevaluatePendingToolsOnStrategyChange resets a thread's tool-actions parked
// in StatePending (awaiting user approval) back to StateUnevaluated when that
// thread's effective strategy has changed since the last reconcile tick, so
// driveToolActions re-dispatches evaluate-tool and the engine's handleNewToolAction
// re-decides approval under the NEW strategy's getApprovalPolicy().
//
// Without this, a tool that parked for approval under the old strategy keeps
// waiting for a click even after the user switches to YOLO mid-loop: the engine
// makes its approval decision exactly once, at evaluate time, and nothing
// revisits an already-parked tool. The engine-side policy fix only covers tools
// evaluated AFTER the switch; this covers the ones already pending.
//
// Strategy is per-thread, so the switch is detected per-thread: each thread
// (root + every sub-thread) is compared against its own last-reconciled effective
// strategy, and only the threads whose strategy actually changed have their
// pending tools reset. The reset mirrors handleRetryToolApproval — a full return
// to "" clearing the cached approval form — and drops each tool's dedup entry so
// the drive below re-commands it.
//
// The first observation (worker init / load) only records the baseline; it never
// resets, so freshly-loaded pending tools aren't disturbed on startup. A newly
// appeared thread likewise only records its baseline (its tools are fresh). An
// empty effective strategy is normalized to "default" by the resolver, so a
// default→yolo switch is detected even though the doc went from "" to "yolo".
func (w *ConversationWorker) reevaluatePendingToolsOnStrategyChangeExcept(liveThreads map[string]bool) {
	// Snapshot the current effective strategy for every inactive thread. A live
	// thread keeps its old baseline until its owner retires, so a strategy change
	// made mid-run is still observed on the first safe pass.
	current := make(map[string]string, len(w.lastReconciledStrategyIDs)+1)
	for threadID, strategyID := range w.lastReconciledStrategyIDs {
		current[threadID] = strategyID
	}
	if !liveThreads[""] {
		current[""] = w.doc.ResolveEffectiveStrategyID("")
	}
	var threadIDs []string
	ycrdtMu.Lock()
	walkThreads(w.doc.getItems(), func(m *ycrdt.YMap, _ *ycrdt.YArray, _ string) bool {
		if id, _ := m.Get("itemId").(string); id != "" {
			threadIDs = append(threadIDs, id)
		}
		return false
	})
	ycrdtMu.Unlock()
	for _, id := range threadIDs {
		if !liveThreads[id] {
			current[id] = w.doc.ResolveEffectiveStrategyID(id)
		}
	}

	if !w.strategyBaselineSet {
		// First observation: record every thread's baseline without resetting.
		w.lastReconciledStrategyIDs = current
		w.strategyBaselineSet = true
		return
	}

	// Determine which threads changed strategy since the last tick.
	changed := make(map[string]bool)
	for threadID, cur := range current {
		prev, existed := w.lastReconciledStrategyIDs[threadID]
		if !existed {
			// Newly appeared thread — record baseline, don't reset (tools fresh).
			continue
		}
		if cur != prev {
			changed[threadID] = true
		}
	}
	w.lastReconciledStrategyIDs = current
	if len(changed) == 0 {
		return
	}

	// Collect pending tool-actions belonging to a changed thread.
	var ids []string
	ycrdtMu.Lock()
	walkAllItems(w.doc.getItems(), "", func(m *ycrdt.YMap, threadID string) bool {
		if !changed[threadID] {
			return false
		}
		if t, _ := m.Get("type").(string); t != ItemTypeToolAction {
			return false
		}
		if state, _ := m.Get("state").(string); state != StatePending {
			return false
		}
		if id, _ := m.Get("toolUseId").(string); id != "" {
			ids = append(ids, id)
		}
		return false
	})
	ycrdtMu.Unlock()

	for _, id := range ids {
		// UpdateToolActionFieldsRecursive acquires ycrdtMu internally, so this
		// must run with the lock released. Full reset to "" so the engine rebuilds
		// a fresh approval decision (and form, if still needed) from the tool's
		// immutable toolInput under the new policy.
		w.doc.UpdateToolActionFieldsRecursive(id, map[string]any{
			"state":            StateUnevaluated,
			"approvalResponse": nil,
			"approvalOptions":  nil,
			"displayData":      nil,
		})
		w.tools.clear(id)
	}
	if len(ids) > 0 {
		w.tape.Record("strategy-switch-reevaluate", map[string]any{
			"threads": len(changed), "count": len(ids),
		})
	}
}

// dispatchToolCommand marshals and sends one ToolCommand to the engine only. The
// conversationId is stamped by the outbound envelope (FormatWorkerMessage).
func (w *ConversationWorker) dispatchToolCommand(action, toolUseID string) {
	w.dispatchToolCommandEpoch(action, toolUseID, 0)
}

// dispatchToolCommandEpoch is dispatchToolCommand carrying an execution
// generation, so a cancel-tool command aborts only the incarnation it was
// issued against (see ToolCommand.RunningEpoch). Epoch 0 is omitted from the
// wire and means "unscoped" — the value passed by every non-cancel command.
func (w *ConversationWorker) dispatchToolCommandEpoch(action, toolUseID string, runningEpoch int64) {
	data, err := json.Marshal(ToolCommand{Type: action, ToolUseID: toolUseID, RunningEpoch: runningEpoch})
	if err != nil {
		w.log.Error("[worker] marshal tool-command %s: %v", action, err)
		return
	}
	w.tape.Record("tool-command", map[string]any{"action": action, "id": toolUseID, "runningEpoch": runningEpoch})
	w.callbacks.sendToEngine(data)
}

// clearToolCommandBookkeeping drops all command bookkeeping for a toolUseId at a
// full-reset site (user-triggered retry, escalation-to-failed). Leaving a stale
// entry would make driveToolActions treat a fresh incarnation as already-dispatched
// and suppress its first command until the age test elapsed.
func (w *ConversationWorker) clearToolCommandBookkeeping(id string) {
	w.tools.clear(id)
}

// engineUnproven reports whether a tool's command should keep being re-driven
// past the attempts cap rather than failing the tool: the engine has not
// answered for THIS tool since the dispatch before last, and the hold ceiling
// has not yet elapsed.
//
// The hold exists to lose a race on purpose. An engine whose realm is suspended
// (a laptop that slept, a wedged WebView) keeps its WebSocket open — WebKit runs
// the socket in the network process, below the realm — so the worker goes on
// dispatching into an engine that cannot run a handler, and engineAttached stays
// true throughout. Recovery is the server's: engineLivenessWindow of heartbeat
// silence to evict it, then engineReconnectGrace for a reconnect or a window
// reload. engineUnprovenHold is sized to outlast that whole sequence, so the
// engine gets put back before the tool is failed. Escalating on the attempts cap
// alone takes ~30s and beats it every time.
//
// An engine that answers only to say it cannot reach the tool is held on the
// same principle for the same reason, but against its own longer clock: it is
// demonstrably running handlers, so none of the server's eviction ladder will
// fire, and what it is waiting on is its own conversation load. See
// engineUnreachableHold.
//
// Each ceiling is what keeps doc.go's rule intact — degrade to a recoverable
// error, never an infinite wait. They only change WHO is blamed and how long we
// wait first, not whether the turn is eventually released.
func (w *ConversationWorker) engineUnproven(id string, now time.Time) bool {
	phaseStart := w.tools.phaseStartedAt(id)
	if phaseStart.IsZero() {
		return false
	}
	if unreachable, _ := w.tools.unreachableSincePrevDispatch(id); unreachable {
		return now.Sub(phaseStart) < engineUnreachableHold
	}
	if w.tools.answeredSincePrevDispatch(id) {
		return false // the engine is answering for this tool; it really is stuck
	}
	return now.Sub(phaseStart) < engineUnprovenHold
}

// noteHeldToolCommand announces, once per delivery phase, that a tool has passed
// the attempts cap and is being kept alive by the unproven/unreachable hold
// rather than escalated.
//
// The holds are 60s and 90s, which outlast every browser test's budget, so
// escalation — and with it the engine-liveness summary that says WHY a tool is
// stuck — never runs inside a test. Without this line the tape of a wedged run
// is indistinguishable from a slow one: the same `tool-command` repeating every
// few seconds and nothing to say whether the engine is absent, alive but silent
// on this tool, or answering to decline it. That distinction is the whole
// content of engineLivenessSummary, and it is worth having before the ceiling
// rather than only after it.
func (w *ConversationWorker) noteHeldToolCommand(id string, attempts int) {
	if !w.tools.noteHeld(id) {
		return
	}
	engine, lastTrace, toolTrace := w.engineLivenessSummary(id)
	unreachable, reason := w.tools.unreachableSincePrevDispatch(id)
	w.tape.Record("tool-command-held", map[string]any{
		"id":          id,
		"attempts":    attempts,
		"engine":      engine,
		"lastTrace":   lastTrace,
		"toolTrace":   toolTrace,
		"unreachable": unreachable,
		"reason":      reason,
	})
	w.log.Info("[worker] tool %s held past %d attempts (engine=%s, last engine trace %s, last trace for this tool %s)",
		id, maxToolCommandAttempts, engine, lastTrace, toolTrace)
}

// engineLivenessSummary describes, for a diagnostic log line, who the worker
// believes the engine is, how long since that engine last spoke about THIS
// conversation, and how long since it last spoke about THIS tool. The three
// together separate the causes a tool the engine never advanced can have, which
// no two of them can:
//
//   - engine=none, or a conversation trace age far exceeding the dispatch
//     window: no engine, or the commands never landed.
//   - a recent conversation trace with toolTrace=never: the engine is alive and
//     working, yet no handler ever answered for this tool — the command is being
//     lost, or a handler is returning without tracing.
//   - a recent trace for the tool itself: the engine received the command and
//     declined, and the evaluate-noact/execute-noact trace names its reason.
func (w *ConversationWorker) engineLivenessSummary(id string) (engine, lastTrace, toolTrace string) {
	engine = w.callbacks.engineClientID()
	if engine == "" {
		engine = "none"
	}
	age := func(t time.Time) string {
		if t.IsZero() {
			return "never"
		}
		return time.Since(t).Round(time.Second).String() + " ago"
	}
	return engine, age(w.lastEngineTraceAt), age(w.tools.lastTracedAt(id))
}

// escalateStaleToolCommand fails a tool whose engine command stayed stuck at the
// same delivery state past maxToolCommandAttempts. It writes a terminal error
// result onto the tool-action — the same recovery shape as a worker-side cancel
// (cancelToolsInArray) — so the reducer feeds an isError tool-result to the
// provider and a parked CLI unblocks (doc.go: "degrade to a recoverable error,
// never an infinite wait").
//
// The walk that selected this id ran earlier and released ycrdtMu, so the engine
// may have claimed or completed the tool since. Revalidate under the lock: only
// fail a tool still at expectState with no result; otherwise the engine acted and
// we just drop the stale bookkeeping. All bookkeeping for the id is cleared.
func (w *ConversationWorker) escalateStaleToolCommand(id, expectState string) {
	stillStuck := false
	toolName := ""
	ycrdtMu.Lock()
	walkAllItems(w.doc.getItems(), "", func(m *ycrdt.YMap, _ string) bool {
		if t, _ := m.Get("type").(string); t != ItemTypeToolAction {
			return false
		}
		if tid, _ := m.Get("toolUseId").(string); tid != id {
			return false
		}
		toolName, _ = m.Get("toolName").(string)
		if state, _ := m.Get("state").(string); state == expectState && m.Get("result") == nil {
			stillStuck = true
		}
		return true // found the tool; stop the walk
	})
	ycrdtMu.Unlock()
	if !stillStuck {
		w.clearToolCommandBookkeeping(id)
		return
	}

	engine, lastTrace, toolTrace := w.engineLivenessSummary(id)
	// Three very different faults share this exit, and the message must say which
	// — reporting any of the others as a tool failure sends every investigation
	// after the tool:
	//
	//   - the engine answered for this tool and could not carry the command out.
	//     The tool is what is broken.
	//   - the engine answered only to say it could not reach the tool, and has
	//     gone on saying so past engineUnreachableHold. Its conversation load is
	//     what is broken; the reason it gave says which part.
	//   - the engine never answered for this tool at all and has now been waited
	//     out. The link is what is broken.
	//
	// The test is per-tool and recent (answeredSincePrevDispatch /
	// unreachableSincePrevDispatch), because the engine being alive proves nothing
	// about this tool: a sibling tool in the same parallel batch traces
	// constantly, and one trace at the head of the phase is what a since-suspended
	// engine leaves behind.
	unreachable, unreachableReason := w.tools.unreachableSincePrevDispatch(id)
	mute := !unreachable && !w.tools.answeredSincePrevDispatch(id)
	verdict := "unhandled"
	switch {
	case unreachable:
		verdict = "unreachable:" + unreachableReason
	case mute:
		verdict = "mute"
	}
	w.log.Error("[worker] tool-command for %s (%s) in %s stayed at state=%q unhandled %d× (verdict=%s); failing the tool to unblock the turn (engine=%s lastEngineTrace=%s lastToolTrace=%s)",
		id, toolName, w.conversationID, expectState, maxToolCommandAttempts, verdict, engine, lastTrace, toolTrace)
	w.tape.Record("tool-command-attempts-escalate", map[string]any{
		"id": id, "tool": toolName, "state": expectState, "attempts": maxToolCommandAttempts,
		"engine": engine, "lastEngineTrace": lastTrace, "lastToolTrace": toolTrace,
		"verdict": verdict, "mute": mute,
	})
	content := fmt.Sprintf("Couldn't run this tool: the engine acknowledged the request but never carried it out, after %d attempts. Failed so the turn can continue.",
		maxToolCommandAttempts)
	switch {
	case unreachable:
		// The engine said exactly why, every time it declined. Lead in plain
		// English and keep its own word for it — that token is what distinguishes a
		// conversation the engine never loaded from one whose copy is missing the
		// tool, and it is the only thing in the message worth searching the log for.
		content = fmt.Sprintf("Couldn't run this tool: the engine couldn't get hold of this conversation to run it, and kept saying so for %s. Nothing ran. (engine reason: %s)",
			engineUnreachableHold, unreachableReason)
	case mute:
		// One line for both silences, because the reader tells them apart from the
		// activity note: "never" is an engine that was never reached, an age is an
		// engine that is alive and simply never answered for this tool.
		content = fmt.Sprintf("Couldn't run this tool: the engine never answered for it within %s. Nothing ran. (last engine activity: %s)",
			engineUnprovenHold, lastTrace)
	}
	w.doc.UpdateToolActionFieldsRecursive(id, map[string]any{
		"state": StateCompleted,
		"result": map[string]any{
			"content": content,
			"isError": true,
		},
		"runningStartedAt": nil,
	})
	w.clearToolCommandBookkeeping(id)
	w.needsReconcile.Store(true)
}
