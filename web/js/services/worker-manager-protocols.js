//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Worker-manager sub-protocols: three request/response pairs (context items,
 * tool definitions, approval) plus the approval-adjacent tool-action mutation
 * helpers.
 *
 * Each function takes the WorkerManager instance (`wm`) as its first argument,
 * so the WorkerManager class methods delegate here in one line and its
 * message-handler switch cases dispatch here in one line.
 * @module services/worker-manager-protocols
 */

import { isEngine } from '../../sdk/lib/client-role.js';
import { extractErrorMessage } from '../../sdk/lib/error-utils.js';
import { TOOL_STATES } from '../../sdk/lib/message.js';
import strategyRegistry from '../registries/strategy-registry.js';
import contextItemRegistry from '../registries/context-item-registry.js';
import actionExecutor from './action-executor.js';
import wsService from './websocket.js';
import {
  handleNewToolAction,
  executeToolAction,
  claimRunning,
  reassertRunning,
  saveAutoApprovalPermission,
} from '../model/conversation-tool-actions.js';

// ── context/tools round-trip stamps ──────────────────────────────────────────
//
// The worker gives `render-context-items-request` and `request-tools` 30s
// between them (ContextTimeout) and reports a miss as "Failed to get
// context/tools: context/tools request timed out". Three separate stages can
// spend that budget — the request's trip to the engine, the engine's own work,
// and the reply's trip back — and the worker can distinguish them only if the
// reply says when the engine picked the request up and when it answered. Both
// realms run on one machine and one wall clock, so those stamps subtract
// directly against the worker's own.
//
// The stamp is taken when the request ARRIVES, not when the reply is built:
// the context handler awaits a conversation load and a sync flush before it
// reaches the callback, and that wait is precisely the stage worth measuring.
// It is therefore parked here between the two, keyed by request id.

/**
 * Cap on remembered stamps. Both handlers always answer, so entries are
 * released as fast as they are made; this only bounds the leak from a handler
 * that throws before replying, and never grows into a long run's memory.
 */
const MAX_TRACKED_ROUND_TRIPS = 128;

/**
 * Record the moment a worker request arrived, so the reply can report how long
 * each stage of the round-trip took.
 * @param {any} wm - WorkerManager instance
 * @param {any} data - Worker message payload, carrying `requestId` and `sentAt`
 */
export function beginRoundTrip(wm, data) {
  const requestId = data?.requestId;
  if (!requestId) return;
  if (!wm._roundTripStamps) wm._roundTripStamps = new Map();
  const stamps = wm._roundTripStamps;
  if (stamps.size >= MAX_TRACKED_ROUND_TRIPS) {
    stamps.delete(stamps.keys().next().value);
  }
  stamps.set(requestId, { sentAt: Number(data.sentAt) || 0, receivedAt: Date.now() });
}

/**
 * Close out a round-trip, yielding the timing fields to attach to its reply.
 * A request nobody stamped yields nothing rather than invented stamps — a reply
 * carrying half a measurement is worse than one carrying none.
 * @param {any} wm - WorkerManager instance
 * @param {string} requestId - The request being answered
 * @returns {{sentAt?: number, receivedAt?: number, repliedAt?: number}} Timing fields
 */
function finishRoundTrip(wm, requestId) {
  const started = wm._roundTripStamps?.get(requestId);
  if (!started) return {};
  wm._roundTripStamps.delete(requestId);
  return { sentAt: started.sentAt, receivedAt: started.receivedAt, repliedAt: Date.now() };
}

// ── tool-execution reporter (level-based liveness, engine-only) ──────────────
//
// A single engine-owned timer, armed while any tool-action is executing, that
// periodically reports the executor's full executing set to each conversation's
// worker. The worker uses these reports to finalize a tool stuck at
// running-with-no-result that no engine is actually executing (INV-B).
//
// Reports are emitted ONLY from this timer macrotask — never inline from an
// execution/completion path. Combined with the await-free contiguity between the
// executing-set removal and the terminal doc write (action-executor.js execute()
// finally + ResponseHandler._runActionAndComplete), this is INV-C: any report
// showing a tool absent was necessarily sent after that tool's terminal write,
// which rides the same ordered channel and is therefore already applied by the
// worker before it processes the report.
//
// Cadence ~3s, no reports while idle → zero steady-state traffic. Module-level
// singleton state: the engine is one process, the executor is engine-wide.
const EXEC_REPORT_INTERVAL_MS = 3000;
/** @type {ReturnType<typeof setInterval> | null} */
let _execReportTimer = null;
let _execReportSeq = 0;
/** @type {Set<string>} */
let _execReportPrevConvs = new Set();

/**
 * Arm the reporter timer if it isn't already running. Called right after the
 * engine claims a tool (handleExecuteTool), so the executing set is reported
 * throughout the execution. The timer self-disarms once the executor drains.
 * @param {any} wm - WorkerManager instance
 */
export function noteToolExecutionActivity(wm) {
  if (!isEngine()) return;
  if (_execReportTimer) return;
  _execReportTimer = setInterval(() => sendToolExecutionReports(wm), EXEC_REPORT_INTERVAL_MS);
}

/**
 * One reporter tick: send one tool-execution-report per conversation that has
 * running work, plus one final EMPTY (settle) report per conversation that had
 * work last tick and has none now, then disarm when the registry is fully drained.
 * Exported so tests can drive a deterministic tick without waiting on the timer.
 * @param {any} wm - WorkerManager instance
 */
export function sendToolExecutionReports(wm) {
  if (!isEngine()) return;
  const byConv = actionExecutor.snapshotRunningByConversation();
  const nowConvs = new Set(byConv.keys());
  for (const [conversationId, executing] of byConv) {
    wm.sendToWorker(conversationId, {
      type: 'tool-execution-report',
      conversationId,
      seq: ++_execReportSeq,
      sentAt: Date.now(),
      executing
    });
  }
  // Settle: a conversation that had entries last tick and none now gets one empty
  // report so the worker sees the set drained (and its freshness clock advances)
  // rather than inferring it from silence.
  for (const conversationId of _execReportPrevConvs) {
    if (!nowConvs.has(conversationId)) {
      wm.sendToWorker(conversationId, {
        type: 'tool-execution-report',
        conversationId,
        seq: ++_execReportSeq,
        sentAt: Date.now(),
        executing: []
      });
    }
  }
  _execReportPrevConvs = nowConvs;
  reportOverdueExecutions(wm);
  if (nowConvs.size === 0 && _execReportTimer) {
    clearInterval(_execReportTimer);
    _execReportTimer = null;
  }
}

/**
 * Trace any execution the executor has been running for longer than its
 * watchdog threshold.
 *
 * It rides the reporter's tick because that timer is armed exactly while
 * something is executing and disarms when nothing is — the same condition the
 * watchdog needs — so a wedge costs no extra timer and an idle engine costs
 * nothing at all.
 *
 * The trace is diagnostic and the worker treats it as such: handleEngineTrace
 * logs a `tool-overdue` at Warn (every other engine-trace is Trace) so a wedge
 * that used to be entirely silent is one grep away, and nothing is failed or
 * aborted on the strength of it. See ActionExecutor.overdueRunningActions for
 * why reporting, rather than acting, is the whole of the response.
 * @param {any} wm - WorkerManager instance
 */
function reportOverdueExecutions(wm) {
  for (const o of actionExecutor.overdueRunningActions()) {
    sendEngineTrace(wm, o.conversationId, 'tool-overdue', {
      toolUseId: o.toolUseId,
      actionId: o.actionId,
      runningMs: o.runningMs
    });
  }
}

/**
 * Test hook: reset the module-level reporter state (timer, seq, prev-conversation
 * set) so unit tests start from a clean slate. Not used in production.
 */
export function __resetToolExecutionReporterForTest() {
  if (_execReportTimer) { clearInterval(_execReportTimer); _execReportTimer = null; }
  _execReportSeq = 0;
  _execReportPrevConvs = new Set();
}

// ── render-context-items ─────────────────────────────────────────────

/**
 * Dispatch a render-context-items-request from the worker to the registered
 * callback (set via setOnContextRequest).
 *
 * The request is BROADCAST, so it reaches viewers too, and the engine is the
 * only realm that may answer it: two answers make the turn's system prompt a
 * race between two replicas, and the loser reaches a worker that has already
 * taken the other one (logged there as a round-trip that "answered a request
 * nothing was waiting for"). A viewer therefore returns before it stamps,
 * renders, or loads anything.
 *
 * Like every other engine command handler (handleExecuteTool, handleCancelTool,
 * handleRunStrategyHook), this first ensures the engine has actually LOADED the
 * conversation. Being the sole responder, the engine MUST always reply — an
 * unanswered request wedges the worker's requestContextAndTools for the whole
 * 30s ContextTimeout. Awaiting the load here (a freshly-created conversation or
 * cold engine can have its first context request arrive before auto-load
 * finishes) narrows that race; the callback itself closes it by waiting briefly
 * for still-in-flight item syncs and then responding regardless (see
 * setOnContextRequest in session-worker-callbacks.js).
 * @param {any} wm - WorkerManager instance
 * @param {string} conversationId
 * @param {any} data - Worker message payload
 * @returns {Promise<void>}
 */
export async function handleRenderContextItemsRequest(wm, conversationId, data) {
  if (!isEngine()) return;
  if (!wm._onContextRequest) return;
  beginRoundTrip(wm, data);
  // loadAndFlush applies any batched/deferred syncs before rendering so the
  // callback sees the turn's items (e.g. the just-synced user message / context
  // items). Without this the callback's "requested context-item not in local
  // view" guard bails without responding — and, context being engine-only, that
  // wedges the turn.
  await loadAndFlush(wm, conversationId, 'render-context-items');
  wm._onContextRequest(data, conversationId);
}

/**
 * Send the rendered context items back to the worker.
 * @param {any} wm
 * @param {string} conversationId
 * @param {string} requestId
 * @param {Array<{itemId: string, content: string, tokens: number}>} contexts
 * @param {string} [systemPrompt]
 */
export function sendRenderContextItemsResponse(wm, conversationId, requestId, contexts, systemPrompt = '') {
  wm.sendToWorker(conversationId, {
    type: 'render-context-items-response',
    requestId,
    contexts,
    systemPrompt,
    ...finishRoundTrip(wm, requestId)
  });
}

// ── request-tools ────────────────────────────────────────────────────

/**
 * Dispatch a request-tools message from the worker to the registered
 * callback (set via setOnToolsRequest). Broadcast like the context request and
 * answered by the engine alone, for the same reason: the tool list a turn is
 * offered must come from one realm, not from whichever replica replied first.
 * @param {any} wm
 * @param {string} conversationId
 * @param {any} data
 */
export function handleRequestTools(wm, conversationId, data) {
  if (!isEngine()) return;
  if (wm._onToolsRequest) {
    beginRoundTrip(wm, data);
    wm._onToolsRequest(data, conversationId);
  }
}

/**
 * Send tool definitions back to the worker.
 * @param {any} wm
 * @param {string} conversationId
 * @param {string} requestId
 * @param {Array<object>} tools
 */
export function sendToolsResult(wm, conversationId, requestId, tools) {
  wm.sendToWorker(conversationId, {
    type: 'tools-result',
    requestId,
    tools,
    ...finishRoundTrip(wm, requestId)
  });
}

// ── subthread delegation (worker-driven; engine-only) ────────────────

/**
 * Dispatch a build-subthread-spec request from the worker to the registered
 * engine callback (set via setOnSubthreadSpecRequest). Ensures the engine's
 * copy of the conversation is loaded and its pending syncs applied first, so the
 * callback can resolve the tool's item (mirrors handleRenderContextItemsRequest).
 * @param {any} wm
 * @param {string} conversationId
 * @param {any} data - {requestId, toolUseId, toolName, toolInput}
 * @returns {Promise<void>}
 */
export async function handleBuildSubthreadSpec(wm, conversationId, data) {
  if (!wm._onSubthreadSpecRequest) return;
  await loadAndFlush(wm, conversationId, 'build-subthread-spec');
  wm._onSubthreadSpecRequest(data, conversationId);
}

/**
 * Send a built subthread spec (or null) back to the worker.
 * @param {any} wm
 * @param {string} conversationId
 * @param {string} requestId
 * @param {object|null} spec - SubthreadSpec, or null to run the tool normally
 * @param {string} [error]
 */
export function sendBuildSubthreadSpecResponse(wm, conversationId, requestId, spec, error = '') {
  wm.sendToWorker(conversationId, {
    type: 'build-subthread-spec-response',
    requestId,
    spec: spec || null,
    error: error || ''
  });
}

// ── approval-request + tool-action mutations ─────────────────────────

/**
 * Dispatch an approval-request from the worker to the registered callback
 * (set via setOnApprovalRequest).
 * @param {any} wm
 * @param {string} conversationId
 * @param {any} data
 */
export function handleApprovalRequest(wm, conversationId, data) {
  if (wm._onApprovalRequest) {
    wm._onApprovalRequest(data, conversationId);
  }
}

// ── run-strategy-hook (worker-driven; engine-only) ───────────────────

/**
 * Run a strategy lifecycle hook (onActivate / onWorkerIdle) on the engine's
 * loaded copy of the conversation, on behalf of the worker. The worker is the
 * single decider of WHEN a hook fires; the engine is the single place this
 * session-wide flow runs. For onActivate (which carries a requestId) the engine
 * reports the ids of the items the hook injected, so the worker can block until
 * that durable guidance has synced into its doc before building the turn.
 *
 * This is the ONLY sanctioned place these hooks fire. Running them in a viewer —
 * elected via the old strategyOwnerIframeId — is the regression we deleted, so
 * the engine role is hard-asserted here.
 * @param {any} wm - WorkerManager instance
 * @param {string} conversationId
 * @param {any} data - {hook, strategyId, threadItemId?, requestId?, previousStrategyId?}
 * @returns {Promise<void>} Resolves once the hook has run (and, for onActivate, the response is sent)
 */
export async function handleRunStrategyHook(wm, conversationId, data) {
  if (!isEngine()) {
    throw new Error('run-strategy-hook received in a viewer — strategy flow runs only in the engine');
  }
  const hook = /** @type {string} */ (data.hook);
  const requestId = /** @type {string|undefined} */ (data.requestId);

  const conversation = await ensureEngineConversationLoaded(wm, conversationId);

  // Strategy is PER-THREAD, so the hook runs on the thread the worker named —
  // never on root by default. A sub-agent thread activating its own strategy
  // must not install that strategy over the root's: the root instance is cached
  // for the conversation's life and nothing puts it back, so a leaked sub-agent
  // strategy would go on refusing the user's own tool approvals.
  const thread = resolveHookThread(conversation, data.threadItemId, conversationId);

  // Run the hook on the WORKER's authoritative strategy. The engine's synced
  // copy of currentStrategyId can lag (it auto-loaded an earlier snapshot, or
  // the switch update hasn't applied yet), so align the thread's strategy to the
  // id the worker sent before invoking — otherwise we'd run the stale strategy's
  // hook (e.g. default's no-op) and silently inject nothing.
  const strategyId = /** @type {string|undefined} */ (data.strategyId);
  if (thread && strategyId && thread.currentStrategyId !== strategyId) {
    thread.currentStrategyId = strategyId;
    thread.strategy = strategyRegistry.createStrategy(strategyId, thread);
  }
  const strategy = thread?.strategy;

  if (requestId) {
    // onActivate: CAPTURE the guidance rather than writing it to the doc. The
    // worker is the single writer of these durable items (it appends them after
    // the already-promoted user message), so the order is deterministic with no
    // CRDT race between the engine and the worker over where the guidance lands.
    // injectGuidance is the strategy's only doc-writing action in onActivate, so
    // intercepting it captures the hook's full effect.
    /** @type {Array<{content: string, source?: string}>} */
    const guidance = [];
    const original = strategy?.injectGuidance?.bind(strategy);
    if (strategy && original) {
      strategy.injectGuidance = (/** @type {string} */ content, /** @type {{source?: string}} */ opts = {}) => {
        // Preserve injectGuidance's default source tag (the active strategy id)
        // so worker-written guidance keeps the same provenance as before.
        if (content) guidance.push({ content, source: opts.source ?? strategyId });
      };
    }
    try {
      await runStrategyHookGuarded(strategy, hook, data.previousStrategyId, conversationId);
    } finally {
      if (strategy && original) strategy.injectGuidance = original;
    }
    sendStrategyHookResponse(wm, conversationId, requestId, guidance);
    return;
  }

  // onWorkerIdle (fire-and-forget): runs normally. Its effects — e.g. plan
  // execution spawning sub-threads — re-enter through the worker, so there is
  // nothing to capture or reply.
  await runStrategyHookGuarded(strategy, hook, data.previousStrategyId, conversationId);
}

/**
 * Resolve the MessageThread a strategy hook targets. An empty/absent
 * threadItemId means the root thread. A named sub-thread that can't be found —
 * the engine's copy hasn't synced it yet, or it was folded away — resolves to
 * nothing rather than falling back to root: running a sub-thread's strategy on
 * root is the leak this argument exists to prevent.
 * @param {any} conversation - The engine's loaded conversation (may be undefined)
 * @param {string|undefined} threadItemId - Thread the hook belongs to, empty for root
 * @param {string} conversationId - For the error log only
 * @returns {any} The MessageThread, or undefined when the sub-thread is unknown
 */
function resolveHookThread(conversation, threadItemId, conversationId) {
  if (!threadItemId) return conversation?.rootMessageThread;
  try {
    return conversation?.resolveMessageThread(threadItemId);
  } catch {
    console.error(`[worker-manager] strategy hook for unknown thread ${threadItemId} in ${conversationId} — skipped`);
    return undefined;
  }
}

/**
 * Run a strategy lifecycle hook, swallowing (and logging) any error it throws so
 * a misbehaving hook can never wedge the worker's turn. Shared by both the
 * onActivate and onWorkerIdle paths of handleRunStrategyHook.
 * @param {any} strategy - The active strategy instance (may be undefined)
 * @param {string} hook - Hook name ('onActivate' | 'onWorkerIdle')
 * @param {string|null|undefined} previousStrategyId
 * @param {string} conversationId - For the error log only
 * @returns {Promise<void>}
 */
async function runStrategyHookGuarded(strategy, hook, previousStrategyId, conversationId) {
  try {
    await strategy?.[hook]?.(previousStrategyId || null);
  } catch (err) {
    console.error(`[worker-manager] strategy ${hook} threw for ${conversationId}:`, err);
  }
}

// ── run-context-hook (worker-driven; engine-only) ────────────────────

/**
 * Per-conversation abort scope for the in-flight context-turn hook run. Keyed by
 * conversationId; the newest run's controller supersedes and aborts the previous
 * one so overlapping turns don't pile up. Module-level: the engine is one
 * process and this flow only ever runs there.
 * @type {Map<string, AbortController>}
 */
const _contextHookAborters = new Map();

/**
 * Run a context-item lifecycle hook (onTurnEnd) across every registered
 * context-item TYPE, on the engine's loaded copy of the conversation, on behalf
 * of the worker. Dispatched from the worker's root-idle chokepoint (one call per
 * completed turn), this is the context-item counterpart to the onWorkerIdle
 * strategy hook.
 *
 * Unlike a strategy hook — which runs the conversation's one active strategy
 * instance — this fans out over the registry and invokes each type's STATIC hook.
 * That is deliberate: context items are per-tool-call (there is no canonical
 * per-conversation instance), and the hook must fire even for a type that
 * produced no items this turn (a memory extension retaining every turn is the
 * motivating case). A type opts in purely by defining `static onTurnEnd`; types
 * that don't are skipped, so the fan-out is free unless something opts in.
 *
 * Fire-and-forget: onTurnEnd performs external side-effects (not doc writes), so
 * there is nothing to capture or reply. Each type's call is isolated so one
 * throwing hook can neither wedge the turn nor stop the others.
 *
 * Engine-only, like all session-wide flow — hard-asserted here.
 * @param {any} wm - WorkerManager instance
 * @param {string} conversationId
 * @param {any} data - {hook, turnIndex}
 * @returns {Promise<void>} Resolves once every type's hook has run
 */
export async function handleRunContextHook(wm, conversationId, data) {
  if (!isEngine()) {
    throw new Error('run-context-hook received in a viewer — context-item flow runs only in the engine');
  }
  const hook = /** @type {string} */ (data.hook);
  const conversation = await ensureEngineConversationLoaded(wm, conversationId);
  if (!conversation) return;
  conversation.flushPendingSyncs?.();

  // A context hook is fire-and-forget and can still be running when the next
  // turn's hook arrives. Open a fresh abort scope for this run and abort the
  // prior one for this conversation, so turn N+1 supersedes turn N: a slow
  // retain can't pile up or keep running against superseded state. A hook opts
  // into this by forwarding ctx.signal to its own async work.
  _contextHookAborters.get(conversationId)?.abort();
  const aborter = new AbortController();
  _contextHookAborters.set(conversationId, aborter);

  const ctx = {
    conversation,
    messageThread: conversation.rootMessageThread,
    session: conversation.session,
    turnIndex: /** @type {number} */ (data.turnIndex),
    signal: aborter.signal,
  };

  // Fan out over every registered type concurrently, each isolated: a type that
  // hangs or throws can't block or break the others (runContextHookGuarded never
  // rejects). Types without the hook are skipped, so the fan-out is free unless
  // an extension opts in.
  const runs = [];
  for (const { class: ItemClass } of contextItemRegistry.getAll()) {
    const Typed = /** @type {any} */ (ItemClass);
    if (typeof Typed[hook] !== 'function') continue;
    runs.push(runContextHookGuarded(Typed, hook, ctx, conversationId));
  }
  try {
    await Promise.all(runs);
  } finally {
    // Only clear if we're still the current scope — a superseding turn may have
    // already replaced us, and it owns cleanup of its own aborter.
    if (_contextHookAborters.get(conversationId) === aborter) {
      _contextHookAborters.delete(conversationId);
    }
  }
}

/**
 * Run one context-item type's static lifecycle hook, swallowing (and logging)
 * any error it throws so a misbehaving hook can neither wedge the worker's turn
 * nor stop the remaining types' hooks from running.
 * @param {any} ItemClass - The context-item class (static hook holder)
 * @param {string} hook - Hook name ('onTurnEnd')
 * @param {any} ctx - The TurnEndContext passed to the hook
 * @param {string} conversationId - For the error log only
 * @returns {Promise<void>}
 */
async function runContextHookGuarded(ItemClass, hook, ctx, conversationId) {
  try {
    await ItemClass[hook](ctx);
  } catch (err) {
    const id = ItemClass.MANIFEST?.id || ItemClass.name;
    console.error(`[worker-manager] context-item ${id} ${hook} threw for ${conversationId}:`, err);
  }
}

/**
 * How long the preamble may take before it is worth a trace of its own.
 *
 * The preamble is invisible by construction: a command's first trace is emitted
 * after it, so a worker tape showing `tool-command` at T and `evaluate-start` at
 * T+3s says only that three seconds went somewhere. Every timestamped sighting in
 * scratch/flaky-tests.md brackets exactly that gap, and the gap has never been
 * split into the four things inside it — transit, an awaited auto-load, a load
 * from disk, and the sync flush.
 *
 * Only a slow one is traced. A preamble that costs nothing is the normal case and
 * a trace per command would bury the interesting one; a quarter second is far
 * past anything the healthy path does and far below the seconds these sightings
 * report.
 */
const PREAMBLE_SLOW_MS = 250;

/**
 * Ensure the engine's copy of a conversation is loaded, then flush its batched-
 * but-unapplied syncs so any state the worker pushed ahead of this command is
 * visible. The shared preamble for every worker-driven engine command
 * (render-context-items, build-subthread-spec, evaluate-tool,
 * execute-tool, cancel-tool). Returns the loaded conversation, or null if it
 * could not be loaded.
 *
 * The flush matters because the worker's tool commands are the ONLY driver of
 * the tool lifecycle (the engine has no reactive tool observer), so the engine
 * must read the freshest doc before resolving a command's toolUseId: the
 * tool-action the command refers to was pushed ahead of the command through the
 * same ordered mailbox, and applySyncUpdate defers behind a setTimeout. This is
 * the engine half of the command-driven ordering invariant (the worker pushes
 * state ahead of the command; the engine applies pending syncs before acting).
 * @param {any} wm - WorkerManager instance
 * @param {string} conversationId
 * @param {string} [command] - Which command is waiting on it, for the slow-preamble trace.
 * @returns {Promise<any>} The loaded conversation, or null
 */
async function loadAndFlush(wm, conversationId, command = 'command') {
  const started = Date.now();
  /** @type {{awaitedAutoLoad: boolean, loadedFromDisk: boolean}} */
  const notes = { awaitedAutoLoad: false, loadedFromDisk: false };
  const c = await ensureEngineConversationLoaded(wm, conversationId, notes);
  const loadMs = Date.now() - started;
  c?.flushPendingSyncs?.();
  const elapsedMs = Date.now() - started;
  if (elapsedMs >= PREAMBLE_SLOW_MS) {
    sendEngineTrace(wm, conversationId, 'preamble-slow', {
      command,
      elapsedMs,
      loadMs,
      awaitedAutoLoad: notes.awaitedAutoLoad,
      loadedFromDisk: notes.loadedFromDisk,
      found: Boolean(c)
    });
  }
  return c;
}

/**
 * Find the message thread (root or nested) that holds a given tool-action.
 * The worker addresses tool-commands by toolUseId only; the engine resolves
 * which thread owns it.
 * @param {any} c - Conversation instance
 * @param {string} toolUseId
 * @returns {any} The owning MessageThread, or null
 */
function findThreadForTool(c, toolUseId) {
  for (const mt of c.getAllMessageThreads()) {
    if (mt.getToolAction(toolUseId)) return mt;
  }
  return null;
}

/**
 * The tool states that sit AFTER `approved`. Seeing one of these while handling
 * an `execute-tool` command means the worker's doc is behind this engine's: the
 * worker only commands execute-tool for a tool it still reads as `approved`.
 */
const PAST_APPROVED = /** @type {Set<string>} */ (new Set([
  TOOL_STATES.RUNNING, TOOL_STATES.COMPLETED, TOOL_STATES.CANCELLED,
]));

/**
 * Push this engine's full doc state to the worker when a tool command was
 * declined because the worker is behind on that very tool.
 *
 * The worker drives the tool lifecycle off its own doc, so a `running` or
 * terminal write of ours that never reached it leaves it commanding execute-tool
 * forever against a tool this engine has already dealt with. It re-drives to its
 * attempt cap and fails a tool that ran — the failure the user sees as "the
 * engine acknowledged the request but never carried it out", since our decline
 * traces are exactly what proves the engine is alive.
 *
 * Only pushed when we are AHEAD (PAST_APPROVED). Being behind instead needs no
 * repair: the worker pushes its own state ahead of every command it dispatches.
 * The push is a Yjs merge and cannot revert the worker — ops it already holds
 * are a no-op, and anything it wrote more recently still wins — so the worst
 * case is a wasted encode.
 * @param {any} wm - WorkerManager instance
 * @param {any} c - Conversation instance
 * @param {string} conversationId
 * @param {string} toolUseId
 * @param {string} observedState - This engine's state for the tool
 * @returns {void}
 */
function resyncWorkerBehindTool(wm, c, conversationId, toolUseId, observedState) {
  if (!PAST_APPROVED.has(observedState)) return;
  try {
    c.resyncToWorker();
  } catch (err) {
    sendEngineTrace(wm, conversationId, 'resync-diverged-failed', { toolUseId, error: extractErrorMessage(err) });
    return;
  }
  sendEngineTrace(wm, conversationId, 'resync-diverged', { toolUseId, state: observedState });
}

/**
 * Engine handler for the worker's `evaluate-tool` command: evaluate a newly
 * created tool-action (approval-gate or auto-approve) by id. The worker is the
 * sole driver of the tool lifecycle (the engine has no reactive tool reducer);
 * the `_handlingNewToolAction` guard makes this idempotent against a re-driven
 * command for the same tool.
 * @param {any} wm - WorkerManager instance
 * @param {string} conversationId
 * @param {string} toolUseId
 * @returns {Promise<boolean>} true if handled, false if it could not act. The
 *   caller ignores it — the worker re-drives from doc state, not from an ack —
 *   but the value stays as a diagnostic of whether this command found its tool.
 */
export async function handleEvaluateTool(wm, conversationId, toolUseId) {
  if (!isEngine()) {
    throw new Error('evaluate-tool received in a viewer — tool execution runs only in the engine');
  }
  // false → could not act (conv/tool not loaded yet); the worker re-drives this
  // tool from its unchanged doc state once the dispatch goes stale.
  //
  // Each no-act exit is traced (evaluate-noact + reason), symmetrically with
  // handleExecuteTool. A tool the engine never evaluates stays at state='' until
  // the worker escalates it to a terminal error (escalateStaleToolCommand), and
  // an untraced no-act makes that indistinguishable from a command the engine
  // never received — the two have opposite causes and opposite fixes.
  //
  // The `reason` is a WIRE CONTRACT, not just a log string: the worker classifies
  // it against engineUnreachableReasons (cmd/juggler/worker/tool_command_state.go)
  // to decide whether this decline is about the TOOL — in which case the tool is
  // failed at the attempt cap — or about the ENGINE's own readiness, in which case
  // the tool is held while we finish loading. A reason meaning "I couldn't reach
  // the tool at all" must be listed there, or the engine's loading window is
  // reported to the user as a tool that never carried out its command. A Go test
  // reads this file and fails on any reason string it has never heard of.
  // Emitted before the preamble, so the worker's `tool-command` line and this one
  // bracket the transit alone. Everything the engine then does before
  // evaluate-start is inside loadAndFlush, which traces itself when slow — so a
  // gap that used to be one unattributable number is now three: worker→engine,
  // load, and the evaluation itself.
  sendEngineTrace(wm, conversationId, 'command-recv', { toolUseId, command: 'evaluate-tool' });
  const c = await loadAndFlush(wm, conversationId, 'evaluate-tool');
  if (!c) { sendEngineTrace(wm, conversationId, 'evaluate-noact', { toolUseId, reason: 'conv-not-loaded' }); return false; }
  const mt = findThreadForTool(c, toolUseId);
  if (!mt) { sendEngineTrace(wm, conversationId, 'evaluate-noact', { toolUseId, reason: 'no-thread' }); return false; }
  // Synchronous guard: don't launch a second concurrent evaluation while one is
  // in flight for this tool (e.g. a re-driven command). The in-flight evaluation
  // will produce the result, so this is "handled", not a retry.
  if (c._handlingNewToolAction.has(toolUseId)) {
    // Traced too: a re-drive only reaches this after redriveInterval, so seeing
    // it means the first evaluation has been running that long — an evaluation
    // stalled inside action.prepare() reads as repeated 'in-flight' lines.
    sendEngineTrace(wm, conversationId, 'evaluate-noact', { toolUseId, reason: 'in-flight' });
    return true;
  }
  c._handlingNewToolAction.add(toolUseId);
  // Entering and leaving are traced separately because the gap between them is
  // unbounded: the evaluation awaits action.prepare(), which for the edit family
  // is an HTTP round-trip whose only backstop is measured in minutes. Without the
  // pair, an evaluation still inside prepare() and one that finished and lost its
  // write look the same from the worker — and so does a command that never
  // arrived, since success used to say nothing at all.
  sendEngineTrace(wm, conversationId, 'evaluate-start', { toolUseId });
  try {
    await handleNewToolAction(mt, toolUseId, c);
  } catch (err) {
    // Carried as `error`, like the other acting traces, rather than as `reason`:
    // a reason is the worker's wire contract for classifying a DECLINE, and this
    // is not one — the engine acted and the action threw, which is engagement and
    // should reach the attempt cap rather than be held as an unreachable engine.
    sendEngineTrace(wm, conversationId, 'evaluate-error', { toolUseId, error: extractErrorMessage(err) });
    throw err;
  } finally {
    c._handlingNewToolAction.delete(toolUseId);
  }
  sendEngineTrace(wm, conversationId, 'evaluate-done', { toolUseId });
  return true;
}

/**
 * Engine handler for the worker's `execute-tool` command: claim an approved
 * tool-action (approved→running) and run its side effect by id. The worker is
 * the sole driver of the tool lifecycle (the engine has no reactive tool
 * reducer). Exactly-once against a re-driven command rests on two guards: the
 * claimRunning compare-and-set (only one caller wins the APPROVED → RUNNING
 * transition), and — because that claim is only as durable as the doc state
 * holding it — the executor's own in-flight map, which decides re-entrancy
 * when the doc has lost the claim.
 * @param {any} wm - WorkerManager instance
 * @param {string} conversationId
 * @param {string} toolUseId
 * @returns {Promise<boolean>} true if handled, false if it could not act. The
 *   caller ignores it — the worker re-drives from doc state, not from an ack —
 *   but the value stays as a diagnostic of whether this command found its tool.
 */
export async function handleExecuteTool(wm, conversationId, toolUseId) {
  if (!isEngine()) {
    throw new Error('execute-tool received in a viewer — tool execution runs only in the engine');
  }
  // false → could not act (conv/tool not loaded yet); the worker re-drives this
  // tool from its unchanged doc state. Once claimRunning moves it to running,
  // driveToolActions no longer selects it, so a re-driven command is a no-op.
  // See handleEvaluateTool: this is the anchor that separates transit from the
  // engine's own preamble.
  sendEngineTrace(wm, conversationId, 'command-recv', { toolUseId, command: 'execute-tool' });
  const c = await loadAndFlush(wm, conversationId, 'execute-tool');
  if (!c) { sendEngineTrace(wm, conversationId, 'execute-noact', { toolUseId, reason: 'conv-not-loaded' }); return false; }
  const mt = findThreadForTool(c, toolUseId);
  if (!mt) { sendEngineTrace(wm, conversationId, 'execute-noact', { toolUseId, reason: 'no-thread' }); return false; }
  const ymap = mt.getToolAction(toolUseId);
  if (!ymap) { sendEngineTrace(wm, conversationId, 'execute-noact', { toolUseId, reason: 'no-ymap' }); return false; }
  // Re-entrancy guard: never start a second concurrent run of a toolUseId this
  // engine is already executing. claimRunning's compare-and-set holds only while
  // the doc keeps the `running` it wrote; when that claim is lost the worker's
  // level-based re-drive dispatches again and the CAS succeeds a second time.
  // Nothing cancels the first run, so both complete and the later result
  // overwrites the earlier one IN PLACE — which runs a side-effecting tool twice
  // and, for a provider that has already sent the earlier result (claudecode's
  // held session), diverges its transcript and burns the whole prompt cache.
  // The executor's map outranks doc state here: this engine is the sole
  // executor, so if it says the id is running, it is. Repair the doc rather than
  // just declining — a tool left at approved is re-driven to the worker's
  // attempt cap and escalated to a terminal error while it is still running.
  const inFlight = c._actionExecutor?.runningActionFor(toolUseId, c.id);
  if (inFlight) {
    const repaired = reassertRunning(c, ymap, inFlight);
    // `state` is what the repair turned on: reassertRunning only writes when it
    // reads `approved`, so repaired=false means the doc was already past it and
    // the divergence is the worker's. Without the state in the trace the two are
    // indistinguishable in the log, and repaired=false reaches the worker as
    // nothing at all.
    const state = /** @type {string} */ (ymap.get('state'));
    sendEngineTrace(wm, conversationId, 'execute-noact', { toolUseId, reason: 'already-executing', repaired, state });
    if (!repaired) resyncWorkerBehindTool(wm, c, conversationId, toolUseId, state);
    return false;
  }
  // 'yes-always' persists the auto-approval permission. resolveApproval writes
  // approvalResponse='yes-always' and state='approved' in one transaction, so
  // by the time the worker commands execute-tool the response is already set.
  // Save it here (move, not duplicate) before claiming → running.
  if (ymap.get('approvalResponse') === 'yes-always') {
    saveAutoApprovalPermission(c, ymap, mt);
  }
  // Trace the execution lifecycle so the "tool stuck in running" wedge is
  // diagnosable: claim → execute-start → execute-done. A wedge appears in the
  // log as execute-start with no following execute-done/execute-error — the tool
  // claimed running but stalled inside executeToolAction (e.g. a bash awaiting a
  // shell-output 'done' that never arrives). See handleEngineTrace (worker).
  // Read the state BEFORE the claim: it is the state the compare-and-set acted
  // on, and the only thing that explains a claimed=false. A bare claimed=false
  // says the doc did not read `approved` without saying what it did read, which
  // is the difference between a tool this engine has already run (worker behind)
  // and one it has not reached yet.
  const observed = /** @type {string} */ (ymap.get('state'));
  const claimed = claimRunning(c, ymap);
  sendEngineTrace(wm, conversationId, 'execute-claim', { toolUseId, toolName: ymap.get('toolName'), claimed, state: observed });
  if (!claimed) resyncWorkerBehindTool(wm, c, conversationId, toolUseId, observed);
  if (claimed) {
    sendEngineTrace(wm, conversationId, 'execute-start', { toolUseId });
    // Arm the level-based tool-execution reporter for the duration of this run.
    // Idempotent (single shared timer); it self-disarms once the executor drains.
    // Armed here — after the claim, before executeToolAction registers the action —
    // so the first tick after registration reports this execution to the worker.
    noteToolExecutionActivity(wm);
    try {
      await executeToolAction(mt, toolUseId, c);
      sendEngineTrace(wm, conversationId, 'execute-done', { toolUseId });
    } catch (err) {
      sendEngineTrace(wm, conversationId, 'execute-error', { toolUseId, error: extractErrorMessage(err) });
      throw err;
    }
    // A cancelled-no-write exit (execution left the tool RUNNING with no result —
    // _runActionAndComplete's `result.cancelled` branch, where the browser
    // deliberately wrote nothing under the single-writer rule) is recovered by the
    // worker's level-based tool-execution-report rule: the executing set this
    // engine reports no longer contains this id, so the worker finalizes it.
  }
  return true;
}

/**
 * Emit a diagnostic trace event from the engine to the worker, which logs it to
 * the per-project server log (handleEngineTrace). The engine's WebView console
 * isn't captured anywhere, so this is the only durable record of the engine-side
 * tool-execution lifecycle — used to diagnose the "tool stuck in running" wedge.
 * Fire-and-forget and purely diagnostic; never gate behaviour on it.
 *
 * Sent straight down the WS rather than through wm.sendToWorker: a trace has to
 * survive the very conditions it reports. sendToWorker drops the message when
 * the engine holds no worker entry for the conversation and otherwise awaits
 * worker-ready (a promise that REJECTS on timeout, which here would surface as
 * an unhandled rejection) — exactly the states an 'evaluate-noact
 * conv-not-loaded' trace exists to record. The Go worker is addressed by
 * conversation id and is necessarily initialized: it sent the command being
 * traced. The wm argument is kept for call-site symmetry with the handlers.
 * @param {any} wm - WorkerManager instance (unused; call-site symmetry)
 * @param {string} conversationId
 * @param {string} event - short event name (e.g. 'execute-start', 'cancel')
 * @param {Record<string, any>} [fields] - extra correlation fields (toolUseId, etc.)
 */
export function sendEngineTrace(wm, conversationId, event, fields = {}) {
  try {
    wsService.sendWorkerMessage(conversationId, { type: 'engine-trace', event, ...fields });
  } catch {
    // Diagnostics never break the path they observe.
  }
}

/**
 * Engine handler for the worker's `cancel-tool` command: abort an in-flight
 * execution by id. Idempotent — a no-op unless this engine has the action
 * running. The optional runningEpoch scopes the abort to one execution
 * generation so a cancel meant for a prior run can't kill a fresh re-run of the
 * same toolUseId (cancelByToolUseId's generation guard); absent → unscoped.
 * @param {any} wm - WorkerManager instance
 * @param {string} conversationId
 * @param {string} toolUseId
 * @param {number} [runningEpoch] - Execution generation the worker cancelled
 * @returns {Promise<void>}
 */
export async function handleCancelTool(wm, conversationId, toolUseId, runningEpoch) {
  if (!isEngine()) {
    throw new Error('cancel-tool received in a viewer — tool execution runs only in the engine');
  }
  const c = await loadAndFlush(wm, conversationId, 'cancel-tool');
  if (!c) { sendEngineTrace(wm, conversationId, 'cancel-noconv', { toolUseId }); return; }
  // outcome disambiguates the three cases: 'hit' — a real execution was aborted;
  // 'miss' — this engine had NO registered in-flight execution for the id (the
  // tool was flagged running in the doc but nothing was executing here to abort,
  // the wedge signature); 'epoch-mismatch' — an execution was running but under a
  // DIFFERENT generation (a re-run re-claimed the id), so this stale cancel was
  // correctly ignored. "Escape visibly cancels" looks identical for all three.
  const outcome = c._actionExecutor?.cancelByToolUseId(toolUseId, c.id, runningEpoch);
  sendEngineTrace(wm, conversationId, 'cancel', { toolUseId, runningEpoch, outcome, hit: outcome === 'hit' });
}

/**
 * Send the strategy-hook response — the guidance the hook captured — back to the
 * worker, which writes those durable items itself (single writer).
 * @param {any} wm
 * @param {string} conversationId
 * @param {string} requestId
 * @param {Array<{content: string, source?: string}>} guidance
 */
export function sendStrategyHookResponse(wm, conversationId, requestId, guidance) {
  wm.sendToWorker(conversationId, {
    type: 'strategy-hook-response',
    requestId,
    guidance
  });
}

/**
 * Resolve and fully load the engine's copy of a conversation, awaiting any
 * in-flight auto-load — on a cold engine restart the worker may have only just
 * pushed its state, so the conversation can still be loading when the hook
 * arrives. Returns null if it cannot be loaded.
 * @param {any} wm
 * @param {string} conversationId
 * @param {{awaitedAutoLoad: boolean, loadedFromDisk: boolean}} [notes] - Filled in
 *   with which of the two waits this call actually did. Both are unbounded and
 *   neither is otherwise visible, so a caller timing the preamble can say which
 *   one it spent its time in rather than reporting a bare total.
 * @returns {Promise<any>} The loaded conversation, or null
 */
async function ensureEngineConversationLoaded(wm, conversationId, notes = undefined) {
  const pending = wm._pendingAutoLoads?.get(conversationId);
  if (pending) {
    if (notes) notes.awaitedAutoLoad = true;
    try {
      await pending.promise;
    } catch {
      // Auto-load failed; fall through to an explicit load attempt below.
    }
  }
  let conversation = wm._session?.conversations.get(conversationId);
  if (wm._session && (!conversation || conversation.loadState !== 'loaded')) {
    if (notes) notes.loadedFromDisk = true;
    try {
      conversation = await wm.loadExistingConversation(conversationId, wm._session);
    } catch (err) {
      console.error(`[worker-manager] could not load ${conversationId} for strategy hook:`, err);
      return null;
    }
  }
  return conversation;
}

/**
 * Send the approval response back to the worker.
 * @param {any} wm
 * @param {string} conversationId
 * @param {string} toolUseId
 * @param {string} response
 */
export function sendApprovalResponse(wm, conversationId, toolUseId, response) {
  wm.sendToWorker(conversationId, {
    type: 'approval-response',
    toolUseId,
    response
  });
}

/**
 * Re-ask a completed tool-action: reset it to its pending approval state,
 * clearing the result and prior response so the approval/question UI
 * re-renders for a fresh answer (e.g. re-running AskUserQuestion).
 * @param {any} wm
 * @param {string} conversationId
 * @param {string} toolUseId
 */
export function retryToolApproval(wm, conversationId, toolUseId) {
  wm.sendToWorker(conversationId, { type: 'retry-tool-approval', toolUseId });
}

/**
 * Retry a tool action (reset to pending state).
 * @param {any} wm
 * @param {string} conversationId
 * @param {string} toolUseId
 */
export function retryToolAction(wm, conversationId, toolUseId) {
  wm.sendToWorker(conversationId, { type: 'retry-tool-action', toolUseId });
}

/**
 * Update tool action for retry: set approvalOptions and displayData.
 * Called when retrying an action — worker resets to pending, main updates options.
 * @param {any} wm
 * @param {string} conversationId
 * @param {string} toolUseId
 * @param {object} approvalOptions
 * @param {object} [displayData]
 */
export function updateToolActionForRetry(wm, conversationId, toolUseId, approvalOptions, displayData) {
  wm.sendToWorker(conversationId, {
    type: 'update-tool-action-for-retry',
    toolUseId,
    approvalOptions,
    displayData
  });
}

/**
 * Update tool-actions to clear itemId and set placeholder content. Used
 * when repositioning context items — old tool-action becomes placeholder.
 * Worker owns items[], so mutation must happen there.
 * @param {any} wm
 * @param {string} conversationId
 * @param {string} itemId
 */
export function repositionContextItemPlaceholder(wm, conversationId, itemId) {
  wm.sendToWorker(conversationId, {
    type: 'reposition-context-item-placeholder',
    itemId
  });
}

/**
 * Update tool-actions with new hash and reposition changed ones to end.
 * Worker finds all tool-actions for the itemId, compares hashes, updates
 * mismatched ones and moves them to the end.
 * @param {any} wm
 * @param {string} conversationId
 * @param {string} itemId
 * @param {number} newHash
 */
export function updateAndRepositionToolActions(wm, conversationId, itemId, newHash) {
  wm.sendToWorker(conversationId, {
    type: 'update-and-reposition-tool-actions',
    itemId,
    newHash
  });
}
