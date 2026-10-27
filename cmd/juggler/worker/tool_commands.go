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
// re-drive interval (~5s) this is ~30s of silence before escalation.
//
// The cap only applies to an engine that is ANSWERING FOR THIS TOOL. Exhausting
// it against an engine that has traced nothing for the tool means the commands
// never reached a handler, which is not the tool's fault and would repeat for
// every later tool; that case is held instead, up to engineUnprovenHold (see
// engineUnproven).
//
// Nor does it count an engine answering that it is still working on the tool
// (engineInFlightReasons): each such answer resets the count, so the cap only
// measures commands that go unanswered or are declined for a real reason. Those
// answers are bounded by engineInFlightCeiling instead.
const maxToolCommandAttempts = 6

// engineInFlightCeiling bounds how long a delivery phase may go on with the
// engine answering, re-drive after re-drive, that it already has the tool in
// hand ('in-flight' / 'already-executing'). Those answers reset the attempts
// count, so without this an engine wedged inside one evaluation or run would
// hold the turn forever, against doc.go's rule.
//
// 30 minutes, because it must outlast the longest legitimate stretch the engine
// can spend inside one tool: a command run under the 20-minute execution cap
// (maxExecTimeoutMs in ops/shell_exec.go, MAX_EXEC_TIMEOUT_MS in the web
// client), or an evaluation awaiting an edit-family prepare() round-trip, on a
// core slow enough to stretch either. Anything still "in flight" past that is
// stuck, not slow. Measured from the phase start (firstDispatchedAt), which the
// in-flight answers do not move.
const engineInFlightCeiling = 30 * time.Minute

// defaultRedriveInterval is how long driveToolActions waits before re-dispatching
// a tool-command still stuck at the state it was last sent at. Doc-state
// progression (the engine claimed/evaluated the tool) suppresses re-drive
// immediately; this interval only bounds recovery of a silently-dropped command.
// Exposed as the tracker's redriveAfter field, which tests shrink.
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
// as the load lands, so this leaves a re-drive interval's headroom above it for
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
// state within the re-drive interval (tools.shouldRedrive). Doc-state progression is the
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

	// Refuse the unstarted calls a denial left behind, for the same reason and in
	// the same place: another pure doc write, and the case it exists for is
	// precisely an engine too busy to have evaluated them yet.
	w.cascadeBatchDenialsExcept(liveThreads)

	if !w.callbacks.engineAttached() {
		return
	}

	type toolCmd struct {
		id, state string
		action    wireMsgType
	}
	var cmds []toolCmd
	// Every tool-action of each turn, in emission order, for the turn-order
	// rule (tool_ordering.go). Keyed by thread and transaction: a turn's calls
	// share both. A call with no transaction belongs to no turn and is never held.
	turns := map[[2]string][]turnCall{}
	// Calls parked after their execute-tool went out: they are running and wait
	// on the user part-way (a program tool holding one of its calls). The
	// approval that follows is a fresh delivery — the engine hands it to the
	// waiting call — so their bookkeeping goes, as at every reset site;
	// otherwise it would be suppressed as a re-drive and counted towards the
	// attempts cap.
	var holding []string

	withYDoc(func() {
		walkAllItems(w.doc.getItems(), "", func(m *ycrdt.YMap, threadID string) bool {
			if liveThreads[threadID] {
				return false
			}
			if t := yMapString(m, keyType); t != ItemTypeToolAction {
				return false
			}
			id := yMapString(m, keyToolUseID)
			if id == "" {
				return false
			}
			state := yMapString(m, keyState)
			if txnID := yMapString(m, keyTransactionID); txnID != "" {
				category := yMapString(m, keyCategory)
				key := [2]string{threadID, txnID}
				turns[key] = append(turns[key], turnCall{id: id, state: state, category: category, ran: hasRun(m)})
			}
			var action wireMsgType
			switch state {
			case StateUnevaluated:
				action = msgEvaluateTool
			case StateApproved:
				action = msgExecuteTool
			case StatePending:
				if w.tools.commandedAt(id, StateApproved) {
					holding = append(holding, id)
				}
				return false
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
	})

	for _, id := range holding {
		w.tools.clear(id)
	}

	held := map[string]bool{}
	for _, calls := range turns {
		for id := range heldByTurnOrder(calls) {
			held[id] = true
		}
	}

	// Filter to the commands due for dispatch: either the doc demands a fresh
	// command (never dispatched, or the demanded state changed) or the last
	// dispatch at this state has aged past the re-drive interval. recordDispatch stamps
	// the dispatch and returns the attempt count; past maxToolCommandAttempts the
	// tool is escalated to a terminal error instead of re-driven forever.
	now := time.Now()
	var toDispatch, escalate []toolCmd
	for _, c := range cmds {
		if held[c.id] {
			continue // waiting its turn; not a delivery, so not counted
		}
		if !w.tools.shouldRedrive(c.id, c.state, now) {
			continue // already dispatched at this state and not yet stale
		}
		n := w.tools.recordDispatch(c.id, c.state, now)
		if w.engineInFlightTooLong(c.id, now) {
			escalate = append(escalate, c)
			continue
		}
		if n > maxToolCommandAttempts {
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
	current := w.baselines.recordedStrategies()
	if !liveThreads[""] {
		current[""] = w.doc.ResolveEffectiveStrategyID("")
	}
	var threadIDs []string
	withYDoc(func() {
		walkThreads(w.doc.getItems(), func(m *ycrdt.YMap, _ *ycrdt.YArray, _ string) bool {
			if id := yMapString(m, keyItemID); id != "" {
				threadIDs = append(threadIDs, id)
			}
			return false
		})
	})
	for _, id := range threadIDs {
		if !liveThreads[id] {
			current[id] = w.doc.ResolveEffectiveStrategyID(id)
		}
	}

	// The threads whose strategy changed since the last tick. The first
	// observation, and a newly appeared thread, only record a baseline.
	changed := w.baselines.strategySwitches(current)
	if len(changed) == 0 {
		return
	}

	// Reset the pending tool-actions belonging to a changed thread. Full reset
	// to "" so the engine rebuilds a fresh approval decision (and form, if still
	// needed) from the tool's immutable toolInput under the new policy. The
	// pending check and the reset share one hold: an approval given between them
	// would otherwise be wiped.
	ids := w.doc.updateToolActionsWhere(func(m *ycrdt.YMap, threadID string) bool {
		if !changed[threadID] {
			return false
		}
		state := yMapString(m, keyState)
		return state == StatePending
	}, map[string]any{
		"state":            StateUnevaluated,
		"approvalResponse": nil,
		"approvalOptions":  nil,
		"displayData":      nil,
		"hooks":            nil, // re-evaluation re-runs the beforeTool hooks
	})

	for _, id := range ids {
		w.tools.clear(id)
	}
	if len(ids) > 0 {
		w.tape.Record("strategy-switch-reevaluate", map[string]any{
			"threads": len(changed), "count": len(ids),
		})
	}
}

// cascadeBatchDenialsExcept refuses the calls a denial left behind: the members
// of a batch that have not started (parked, unevaluated, or held by turn order)
// when one of their siblings comes back cancelled.
//
// "Denying any call denies the batch" is a UI policy, and the browser applies it
// the moment a person clicks. It can only apply it to the calls it can see,
// though, and a batch is evaluated one call at a time: while the first prompt is
// on screen its siblings may still be at StateUnevaluated, carrying no approval
// form and showing nothing to click. A viewer that denies at that moment settles
// one call; the engine parks the rest a moment later; and the turn rests there
// forever, because the thread reducer rests while any tool-action is
// non-terminal. That leaves a person who refused three commands looking at two
// fresh prompts for the commands they just refused.
//
// So the worker keeps the policy whole. It is the sole writer of cancellation
// results already, it is the only party that sees the batch regardless of which
// viewer clicked (or whether that viewer is still connected), and it writes the
// same result the browser writes so the two halves are indistinguishable in the
// doc.
//
// Edge-triggered, not level-triggered: only a cancellation this worker has not
// already answered starts a cascade. A standing "cancelled sibling ⇒ refuse the
// rest" rule would re-cancel a call that handleRetryToolApproval had just reset
// to StateUnevaluated for a fresh ask, which is a live flow for AskUserQuestion.
//
// A call approved but held back by turn order (tool_ordering.go) is refused too.
// It has not started, and without this it would run once the call ahead of it
// finished, after the person had said stop. The browser cannot do this half: it
// sees neither the hold nor whether execute-tool has gone out, so only the
// worker can tell a held call from one about to be claimed.
//
// Calls already commanded (approved and sent, or running) are left alone: they
// have, or are about to have, a process behind them, and stopping those is
// CancelInFlightToolActions' job, which aborts the execution as well as writing
// the state.
func (w *ConversationWorker) cascadeBatchDenialsExcept(liveThreads map[string]bool) {
	ycrdtMu.Lock()
	defer ycrdtMu.Unlock()

	// Every array that can hold a batch: the root, plus each sub-thread's items.
	type threadArray struct {
		id  string
		arr *ycrdt.YArray
	}
	arrays := []threadArray{{id: "", arr: w.doc.getItems()}}
	walkThreads(w.doc.getItems(), func(m *ycrdt.YMap, nested *ycrdt.YArray, _ string) bool {
		if nested != nil {
			id := yMapString(m, keyItemID)
			arrays = append(arrays, threadArray{id: id, arr: nested})
		}
		return false
	})

	// Rebuilt every tick rather than accumulated, so the set stays the size of
	// the doc's cancelled tools and a call reset back out of cancelled is
	// forgotten — a later denial of the same call cascades again.
	// The cascade runs before this tick's dispatch, and only the worker sends
	// execute-tool, so a held call not yet commanded cannot start under it.
	commanded := func(id string) bool { return w.tools.commandedAt(id, StateApproved) }
	current := make(map[string]bool)
	var cascades []threadArray
	for _, ta := range arrays {
		cancelled, refusable := scanTrailingBatch(ta.arr, commanded)
		fresh := false
		for _, id := range cancelled {
			current[id] = true
			if w.baselines.isFreshDenial(id) {
				fresh = true
			}
		}
		if fresh && len(refusable) > 0 && !liveThreads[ta.id] {
			cascades = append(cascades, ta)
		}
	}

	if !w.baselines.recordDenials(current) {
		// First observation records only. A conversation loaded with a denial
		// already in it had its cascade when the denial happened; re-running it
		// against a doc whose calls may since have been retried would cancel work
		// nobody refused.
		return
	}

	// Written with the same content the browser's resolveApproval writes, so a
	// cascade reads identically whichever half got there first.
	cancelledResult := convertToYcrdt(map[string]any{
		"content":    "Action was cancelled.",
		"isError":    false,
		"cancelled":  true,
		"fullResult": map[string]any{"state": StateCancelled},
	})
	for _, ta := range cascades {
		_, refusable := scanTrailingBatch(ta.arr, commanded)
		var ids []string
		for _, m := range refusable {
			id := yMapString(m, keyToolUseID)
			ids = append(ids, id)
			w.doc.transactTracked(func(_ *ycrdt.Transaction) {
				m.Set(keyState, StateCancelled)
				m.Set(keyResult, cancelledResult)
			})
		}
		w.tape.Record("deny-cascade", map[string]any{"thread": ta.id, "refused": ids})
		w.log.Info("Refusing %d call(s) left unstarted by a denial in thread %q", len(ids), ta.id)
	}
}

// scanTrailingBatch reads the batch a turn is currently resting on — the
// contiguous run of dispatched work at the end of an items array — and reports
// the toolUseIds cancelled within it and the Y.Maps of the calls a denial would
// still have to refuse: parked, not yet evaluated, or approved but held back by
// turn order (tool_ordering.go) and never commanded. commanded reports whether
// execute-tool has gone out for a call; one that has may be claimed by the
// engine at any moment, so it is left to the cancel path.
//
// Trailing, because a batch further back has already been answered and resumed
// past; retroactively cancelling anything in one would rewrite settled history.
// Must be called with ycrdtMu held.
func scanTrailingBatch(arr *ycrdt.YArray, commanded func(id string) bool) (cancelled []string, refusable []*ycrdt.YMap) {
	if arr == nil {
		return nil, nil
	}
	length := int(arr.GetLength())
	start := length
	for start > 0 {
		m, ok := arr.Get(ycrdt.Number(start - 1)).(*ycrdt.YMap)
		if !ok {
			break
		}
		t := yMapString(m, keyType)
		if t != ItemTypeToolAction && t != ItemTypeThread && t != ItemTypeMetaToolResult {
			break
		}
		start--
	}
	// Each turn's calls in emission order, for the turn-order rule, and the
	// approved calls that rule might be holding.
	turns := map[string][]turnCall{}
	approved := map[string]*ycrdt.YMap{}
	for i := start; i < length; i++ {
		m, ok := arr.Get(ycrdt.Number(i)).(*ycrdt.YMap)
		if !ok {
			continue
		}
		if t := yMapString(m, keyType); t != ItemTypeToolAction {
			continue
		}
		id := yMapString(m, keyToolUseID)
		if id == "" {
			continue
		}
		state := yMapString(m, keyState)
		if txnID := yMapString(m, keyTransactionID); txnID != "" {
			category := yMapString(m, keyCategory)
			turns[txnID] = append(turns[txnID], turnCall{id: id, state: state, category: category, ran: hasRun(m)})
		}
		switch state {
		case StateCancelled:
			cancelled = append(cancelled, id)
		case StatePending, StateUnevaluated:
			refusable = append(refusable, m)
		case StateApproved:
			approved[id] = m
		}
	}
	for _, calls := range turns {
		for id := range heldByTurnOrder(calls) {
			if m := approved[id]; m != nil && !commanded(id) {
				refusable = append(refusable, m)
			}
		}
	}
	return cancelled, refusable
}

// dispatchToolCommand marshals and sends one ToolCommand to the engine only. The
// conversationId is stamped by the outbound envelope (FormatWorkerMessage).
func (w *ConversationWorker) dispatchToolCommand(action wireMsgType, toolUseID string) {
	w.dispatchToolCommandEpoch(action, toolUseID, 0)
}

// dispatchToolCommandEpoch is dispatchToolCommand carrying an execution
// generation, so a cancel-tool command aborts only the incarnation it was
// issued against (see ToolCommand.RunningEpoch). Epoch 0 is omitted from the
// wire and means "unscoped" — the value passed by every non-cancel command.
func (w *ConversationWorker) dispatchToolCommandEpoch(action wireMsgType, toolUseID string, runningEpoch int64) {
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

// engineInFlightTooLong reports whether the engine is still answering for this
// tool that it has it in hand, and has gone on doing so past
// engineInFlightCeiling since the phase began. The in-flight answers reset the
// attempts cap, so this is the only thing that ends such a phase.
func (w *ConversationWorker) engineInFlightTooLong(id string, now time.Time) bool {
	inFlight, _ := w.tools.inFlightSincePrevDispatch(id)
	if !inFlight {
		return false
	}
	phaseStart := w.tools.phaseStartedAt(id)
	return !phaseStart.IsZero() && now.Sub(phaseStart) >= engineInFlightCeiling
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
	return engine, age(w.engine.lastTrace()), age(w.tools.lastTracedAt(id))
}

// escalateStaleToolCommand fails a tool whose engine command stayed stuck at the
// same delivery state past maxToolCommandAttempts. It writes a terminal error
// result onto the tool-action — the same recovery shape as a worker-side cancel
// (cancelToolsInArray) — so the reducer feeds an isError tool-result to the
// provider and a parked CLI unblocks (doc.go: "degrade to a recoverable error,
// never an infinite wait").
//
// The walk that selected this id ran earlier and released ycrdtMu, so the engine
// may have claimed or completed the tool since. The write revalidates in the
// hold it writes under: only a tool still at expectState with no result is
// failed; otherwise the engine acted and we just drop the stale bookkeeping. All
// bookkeeping for the id is cleared.
func (w *ConversationWorker) escalateStaleToolCommand(id, expectState string) {
	engine, lastTrace, toolTrace := w.engineLivenessSummary(id)
	// Four very different faults share this exit, and the message must say which
	// — reporting any of the others as a tool failure sends every investigation
	// after the tool:
	//
	//   - the engine answered for this tool and could not carry the command out.
	//     The tool is what is broken.
	//   - the engine answered that it was still working on the tool, and went on
	//     saying so past engineInFlightCeiling. The tool's evaluation or run is
	//     wedged inside the engine; the reason it gave says which.
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
	inFlight, inFlightReason := w.tools.inFlightSincePrevDispatch(id)
	mute := !unreachable && !w.tools.answeredSincePrevDispatch(id)
	verdict := "unhandled"
	switch {
	case inFlight:
		verdict = "in-flight:" + inFlightReason
	case unreachable:
		verdict = "unreachable:" + unreachableReason
	case mute:
		verdict = "mute"
	}
	content := fmt.Sprintf("Couldn't run this tool: the engine acknowledged the request but never carried it out, after %d attempts. Failed so the turn can continue.",
		maxToolCommandAttempts)
	switch {
	case inFlight:
		// Not "never carried it out": the engine said every time that it was
		// carrying it out. Keep its word for which half was stuck.
		content = fmt.Sprintf("Couldn't run this tool: the engine kept reporting it as still in progress for over %s without finishing it. Failed so the turn can continue. (engine reason: %s)",
			engineInFlightCeiling, inFlightReason)
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
	toolName := ""
	failed := w.doc.updateToolActionsWhere(func(m *ycrdt.YMap, _ string) bool {
		if tid := yMapString(m, keyToolUseID); tid != id {
			return false
		}
		toolName = yMapString(m, keyToolName)
		state := yMapString(m, keyState)
		return state == expectState && m.Get(keyResult) == nil
	}, map[string]any{
		"state": StateCompleted,
		"result": map[string]any{
			"content": content,
			"isError": true,
		},
		"runningStartedAt": nil,
	})
	w.clearToolCommandBookkeeping(id)
	if len(failed) == 0 {
		return
	}
	w.log.Error("[worker] tool-command for %s (%s) in %s stayed at state=%q (verdict=%s, attempt cap %d); failing the tool to unblock the turn (engine=%s lastEngineTrace=%s lastToolTrace=%s)",
		id, toolName, w.conversationID, expectState, verdict, maxToolCommandAttempts, engine, lastTrace, toolTrace)
	w.tape.Record("tool-command-attempts-escalate", map[string]any{
		"id": id, "tool": toolName, "state": expectState, "attempts": maxToolCommandAttempts,
		"engine": engine, "lastEngineTrace": lastTrace, "lastToolTrace": toolTrace,
		"verdict": verdict, "mute": mute,
	})
	w.sched.markReconcile()
}
