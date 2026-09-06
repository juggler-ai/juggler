//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Test Runner
 *
 * Executes declarative integration test definitions through the full
 * framework pipeline with mock LLM responses.
 * @module integration/integration-test-runner
 */

import { UITestHarness } from './ui-test-harness.js';
import { executeUIOperation } from './ui-operation-executor.js';
import {
  normalizeDocumentSnapshot,
  assertDocumentGolden,
  assertItemsExist,
  documentMatchesGolden,
  itemsMatchExpected
} from './golden-comparator.js';
import { ITEM_TYPE_TO_TAG } from './test-assertions.js';
import logger from './test-logger.js';
import { dumpTape, clearTape } from '../../js/utils/event-tape.js';
import { snapshotOwnConversationIds, deleteOwnConversationsCreatedSince, setCurrentTestName } from './conversation-claims.js';
import { setTestDeadline, clearTestDeadline } from './test-deadline.js';
import { fetchProjectSize, projectSizeLines } from './project-size.js';
import { lastConfirmGiveUp } from './ui-operation-executor.js';

/**
 * Race a promise against a timeout so a wedged/slow server can never hang the
 * test lane. Resolves to the promise's value if it settles in time, otherwise
 * to `fallback` — and NEVER rejects (a rejection also yields `fallback`).
 *
 * This is the backstop that keeps a single unresponsive worker from turning
 * one test failure into a lane-wide 60s black hole. Two invariants depend on
 * it: the per-test result MUST always be posted (else the Go harness times out
 * the whole subtest after 60s with no diagnostics — exactly the "timeout
 * polling /api/test/result" failure) and the conversations a test created MUST
 * always be cleaned up (else they leak into the shared pool session, fail the
 * run's leak check, and march it toward the MAX_CONVERSATIONS cross-lane
 * bulldoze). Every post-timeout await — building the failure diagnostics (which
 * fetch tapes from the very worker that may be stuck) and the finally{} cleanup
 * — is wrapped in this so none of them can stall the lane.
 * @template T
 * @param {Promise<T>} promise - The work to bound.
 * @param {number} ms - Deadline in milliseconds.
 * @param {T} fallback - Value to resolve with if the deadline is hit or the promise rejects.
 * @param {string} [label] - Optional label logged when the fallback is used.
 * @returns {Promise<T>} The promise's value, or `fallback` on timeout/rejection.
 */
function _withDeadline(promise, ms, fallback, label) {
  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (label) logger.error(`[runner] ${label} exceeded ${ms}ms — using fallback so the lane can't stall`);
      resolve(fallback);
    }, ms);
    Promise.resolve(promise).then(
      (v) => { if (!settled) { settled = true; clearTimeout(timer); resolve(v); } },
      (e) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (label) logger.error(`[runner] ${label} errored: ${e}`);
        resolve(fallback);
      }
    );
  });
}

// Set the per-iframe trace flag so event-tape.js starts recording. The flag
// is a single boolean test on every recordTape() call, so production page
// loads (which never reach this module) pay nothing.
/** @type {any} */ (window).__jugglerTrace = true;

// Cross-iframe event-tape correlation: when a test in this iframe fails,
// the failure builder broadcasts a dump-request on `juggler-tape-dump`.
// Sibling iframes listen and reply with their own tape entries filtered by
// the affected conversation IDs. The replies are joined into the failure
// block so a single scrollback shows every iframe's view of what happened
// on the racing conversation.
const __tapeChan = new BroadcastChannel('juggler-tape-dump');
__tapeChan.onmessage = (/** @type {MessageEvent} */ ev) => {
  const m = ev.data;
  if (!m || m.kind !== 'dump-request') return;
  const entries = dumpTape(m.convIds || null);
  const lane = (() => {
    try { return new URLSearchParams(location.search).get('lane'); }
    catch { return null; }
  })();
  __tapeChan.postMessage({
    kind: 'dump-reply',
    requestId: m.requestId,
    iframe: lane !== null ? `pool-${lane}` : (window.name || 'top'),
    entries
  });
};

/**
 * @typedef {import('./test-harness.js').MockResponse} MockResponse
 * @typedef {import('./golden-comparator.js').DocumentSnapshot} DocumentSnapshot
 * @typedef {import('./golden-comparator.js').NormalizedItem} NormalizedItem
 */

/**
 * @typedef {object} TestOperation
 * @property {'send-message'|'send-message-no-wait'|'send-thread-message'|'send-thread-message-no-wait'|'assert-input-warning'|'approve'|'approve-no-wait'|'deny'|'wait-for-approval'|'wait-for-thread-approval'|'approve-thread-tool'|'approve-thread-tool-no-wait'|'deny-thread-tool'|'run-command'|'compact-up-to'|'simulate-disconnect'|'wait-for-state'|'wait-for-idle'|'create-conversation'|'duplicate-conversation'|'switch-conversation'|'delete-conversation'|'undo'|'redo'|'set-model'|'assert-document'|'assert-transaction-markers'|'validate-context-snapshot'|'validate-thread-context'|'start-capture-progress'|'wait-for-progress'|'assert-streaming-chunks'|'assert-no-result'|'cancel'|'cancel-from-root'|'cancel-thread'|'delete-last-item'|'delete-last-item-in-thread'|'delete-first-item-in-thread'|'delete-item-in-thread'|'assert-thread-item-count'|'wait-for-execution'|'rerun-tool'|'rerun-tool-no-wait'|'cancel-via-ui-flow'|'continue'|'continue-sub-thread'|'continue-in-new-thread'|'assert-dom'|'click-dom'|'set-dom-value'|'move-items'|'copy-items'|'copy-items-new-tab'|'move-items-new-tab'|'expand-thread'|'promote-thread'|'start-tool-exec-counter'|'assert-tool-exec-count'|'start-spinner-capture'|'assert-spinner-was-visible'|'capture-tool-result'|'assert-tool-result-changed'|'add-context-item-to-sub-thread'|'add-context-item-to-root'|'add-ai-files-to-sub-thread'|'remove-context-item-from-sub-thread'|'wait-ms'|'at-mention-file'|'wait-for-mock-paused'|'release-mock'|'add-execute-pattern'|'set-strategy'|'run-command-no-wait'|'expect-confirm'|'assert-confirm-shown'} type - Operation type
 * @property {string} [message] - Message text (for send-message)
 * @property {string} [toolUseId] - Tool use ID (for approve/deny/wait-for-approval/streaming operations)
 * @property {string} [response] - Custom response value (for approve - used by AskUserQuestion answers)
 * @property {number} [timeoutMs] - Custom timeout in ms
 * @property {string} [command] - Command name (for run-command)
 * @property {string} [args] - Command arguments (for run-command)
 * @property {number} [reconnectMs] - Time before reconnection (for simulate-disconnect)
 * @property {object} [condition] - State condition to wait for (for wait-for-state)
 * @property {string} [name] - Conversation name (for create-conversation)
 * @property {MockResponse[]} [llmResponses] - Explicit mock script for the new conversation (for create-conversation); omitted = remaining shared responses
 * @property {string} [conversationId] - Conversation ID or $CONV_N placeholder (for switch/delete-conversation)
 * @property {string} [sourceId] - Source conversation ID or $CONV_N placeholder (for duplicate-conversation)
 * @property {string} [resultId] - Filled in by harness with created conversation ID
 * @property {string} [provider] - Provider name (for set-model)
 * @property {string} [model] - Model ID (for set-model)
 * @property {DocumentSnapshot} [expected] - Expected document state (for assert-document)
 * @property {number} [count] - Expected distinct transaction count (for assert-transaction-markers)
 * @property {number} [minChunks] - Minimum chunks expected (for assert-streaming-chunks)
 * @property {number} [minEvents] - Minimum events to wait for (for wait-for-progress)
 * @property {string} [contains] - Text the accumulated output must contain (for wait-for-action-output)
 * @property {number} [index] - Item index (for compact-up-to)
 * @property {number} [threadIndex] - Which thread item (0-based) in root items (for validate-thread-context, continue-sub-thread)
 * @property {number} [ms] - Milliseconds to wait (for wait-ms)
 * @property {number} [nestedThreadIndex] - Which nested thread inside the outer thread (for validate-thread-context)
 * @property {number} [expectedMessageCount] - Exact message count (for validate-thread-context, validate-context-snapshot)
 * @property {number} [expectedMinMessageCount] - Minimum message count (for validate-thread-context, validate-context-snapshot)
 * @property {Array<{role: string, contentIncludes: string}>} [expectedMessages] - Partial message matches (for validate-thread-context, validate-context-snapshot)
 * @property {string[]} [expectedContent] - Content strings that MUST appear in messages (for validate-thread-context, validate-context-snapshot)
 * @property {string[]} [unexpectedContent] - Content strings that must NOT appear (for validate-thread-context, validate-context-snapshot)
 * @property {string} [selector] - CSS selector (for assert-dom / click-dom / set-dom-value)
 * @property {boolean} [global] - Search the whole tab (all columns) not just the root area (for assert-dom / click-dom / set-dom-value)
 * @property {string} [value] - Value to set on an input/textarea (for set-dom-value)
 * @property {'root'|'thread'} [from] - Source container (for move-items / copy-items)
 * @property {'root'|'thread'} [to] - Destination container (for move-items / copy-items)
 * @property {number[]} [indices] - Source indices to move/copy (for move-items / copy-items)
 * @property {number} [position] - Insert position in destination (for move-items / copy-items)
 * @property {string} [text] - Visible text the clicked element must contain (for click-dom)
 * @property {boolean} [absent] - Assert element does NOT exist (for assert-dom / assert-input-warning)
 * @property {string} [textContains] - Substring the matched element's text must contain (for assert-input-warning)
 * @property {number} [minCount] - Minimum matching elements (for assert-dom, assert-streaming-chunks)
 * @property {number} [expectedCount] - Expected numeric count (for assert-tool-exec-count)
 * @property {'main'|'sub'} [threadType] - Which column to check spinner in (for start-spinner-capture)
 * @property {string} [key] - Named slot key (for capture-tool-result / assert-tool-result-changed)
 * @property {string} [path] - File path (for at-mention-file)
 * @property {string} [pattern] - Execute pattern glob (for add-execute-pattern)
 * @property {string} [strategy] - Strategy ID to switch to mid-test (for set-strategy)
 * @property {boolean} [answer] - How to answer the dialog: true confirms, false cancels (for expect-confirm; defaults to true)
 * @property {string} [titleContains] - Substring the dialog title must contain (for assert-confirm-shown)
 * @property {string} [messageContains] - Substring the dialog body must contain (for assert-confirm-shown)
 */

/**
 * @typedef {object} FileAssertion
 * @property {string} path - File path (relative to fixture)
 * @property {string} content - Expected content
 */

/**
 * @typedef {object} UndoStateAssertion
 * @property {boolean} canUndo - Expected canUndo state
 * @property {boolean} canRedo - Expected canRedo state
 */

/**
 * @typedef {object} IntegrationTestDefinition
 * @property {string} name - Test name
 * @property {string} description - Test description
 * @property {string} fixture - Fixture name
 * @property {string} [strategy] - Strategy ID to use (e.g., 'read-only')
 * @property {MockResponse[]} llmResponses - Scripted LLM responses
 * @property {TestOperation[]} operations - User operations to perform
 * @property {DocumentSnapshot} [expectedDocument] - Expected document state (full golden)
 * @property {Partial<NormalizedItem>[]} [expectedItems] - Expected items (partial match)
 * @property {FileAssertion[]} [fileAssertions] - File content assertions
 * @property {UndoStateAssertion} [expectedUndoState] - Expected undo/redo state
 * @property {Record<string, any>} [expectedMetadata] - Expected metadata (partial match)
 * @property {(conversation: import('../../model/conversation.js').default, ctx?: {harness: any}) => void|Promise<void>} [customAssertions] - Custom assertions run after standard checks (throw to fail). The second argument exposes the harness so assertions can scope to this test's own conversations (avoids cross-iframe session sharing under JUGGLER_TEST_IFRAMES > 1)
 * @property {(conversation: import('../../model/conversation.js').default, ctx: {harness: any}) => boolean} [settleUntil] - Side-effect-free predicate fenced on BEFORE the assertions run (alongside expectedItems/expectedDocument). Use it when `customAssertions` inspects state that can still be syncing into this viewer after the operations resolve — e.g. a freshly cloned/peer conversation whose Yjs doc lands a beat late, so a one-shot check would race an empty/partial doc. Re-evaluated on each doc change up to the per-test deadline; MUST NOT mutate (it is polled), and must not throw (return false instead).
 * @property {Record<string, string>} [setupFiles] - Files to write into the fixture before the test runs (e.g. { 'CLAUDE.md': '# AI instructions\n' }). The runner adds files but never wipes — safe in iframe-pool mode where sibling tests share the fixture dir. Use this in place of a custom `fixture:` declaration when only a few extra seed files are needed.
 * @property {boolean} [pollutesFixtureRoot] - Set true when the test writes a fixed-name file to the shared fixture root that production auto-detection scans (e.g. CLAUDE.md, which addAIAssistantFiles picks up on every createConversation). Such a file cannot be namespaced behind a per-test prefix, so while it exists any sibling lane's createConversation injects a phantom context item. The Go runner schedules these tests sequentially after the parallel phase, with a fixture reset around each, so no sibling test is ever in flight.
 * @property {number} [timeoutMs] - Per-test timeout in ms (default 30000)
 * @property {boolean} [approvalFlow] - Force the non-permissive conversation (no blanket `execute *` grant / auto-approve). Defaults to true when the operations include an approval op. Set explicitly when the test's point is that *something else* (a strategy's approval policy) does the approving, so the harness's blanket grant must NOT mask it.
 */

/**
 * @typedef {object} TestResult
 * @property {boolean} passed - Whether test passed
 * @property {string} [error] - Error message if failed
 * @property {number} durationMs - Test duration in milliseconds
 */

/**
 * Connect WebSocket to a session.
 * @param {any} wsService - WebSocket service
 * @returns {Promise<void>}
 */
async function connectWebSocket(wsService) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      wsService.off('open', onOpen);
      wsService.off('error', onError);
      reject(new Error('WebSocket connection timeout'));
    }, 5000);

    const onOpen = () => {
      clearTimeout(timeout);
      wsService.off('open', onOpen);
      wsService.off('error', onError);
      resolve();
    };

    const onError = (/** @type {any} */ err) => {
      clearTimeout(timeout);
      wsService.off('open', onOpen);
      wsService.off('error', onError);
      reject(err);
    };

    wsService.on('open', onOpen);
    wsService.on('error', onError);
    wsService.connect();
  });
}

/**
 * Assert that no two items within the same thread array share an itemId.
 * Duplicate itemIds cause silent selection/routing bugs that are hard to diagnose.
 * Called after every operation so violations are caught immediately.
 * @param {import('../../model/conversation.js').default} conversation
 * @param {string} opLabel - Operation label for error messages
 */
function assertNoItemIdDuplicates(conversation, opLabel) {
  const threads = conversation.getAllMessageThreads();
  for (const thread of threads) {
    const seen = /** @type {Set<string>} */ (new Set());
    const items = thread.items;
    for (let i = 0; i < items.length; i++) {
      const item = /** @type {any} */ (items[i]);
      const itemId = item.get('itemId');
      if (itemId && !item.get('toolUseId')) {
        if (seen.has(itemId)) {
          const threadLabel = thread.threadItemId || 'root';
          throw new Error(
            `[${opLabel}] Duplicate itemId "${itemId}" in thread "${threadLabel}" — ` +
                        `two items with the same ID at index ${i}`
          );
        }
        seen.add(itemId);
      }
    }
  }
}

/**
 * Compute the per-test sandbox subfolder for a test name. The runner
 * mkdirs this before the test runs and rm -rfs it after, so any path a
 * test writes that starts with this prefix is automatically isolated from
 * sibling tests in the iframe-pool topology.
 *
 * Test authors reference the same value at every path-bearing site
 * (setupFiles keys, mock-LLM tool-input paths, fileAssertions, glob
 * patterns). Convention is "test_${name}" — sanitised to filesystem-safe
 * chars and matched verbatim by the runner.
 * @param {string} testName
 * @returns {string} the sandbox subfolder name for the test
 */
export function testDirFor(testName) {
  return 'test_' + String(testName).replace(/[^a-zA-Z0-9_-]/g, '_');
}

/**
 * Pick a compact subset of an op's args for the failure trace. Kept tiny so
 * the diagnostic line is one row, not a wall of JSON. Includes only the
 * fields most useful for "what was the runner trying to do when it gave up?".
 * @param {TestOperation} op
 * @returns {object} a small object of the op's identifying arg fields
 */
function _summariseOp(op) {
  const out = {};
  const keys = ['message', 'toolUseId', 'command', 'index', 'threadIndex', 'key',
    'selector', 'path', 'minEvents', 'contains', 'count', 'expectedCount'];
  for (const k of keys) {
    const v = /** @type {any} */ (op)[k];
    if (v !== undefined) out[k] = typeof v === 'string' && v.length > 40 ? v.slice(0, 40) + '…' : v;
  }
  if (op.condition) out.condition = op.condition;
  return out;
}

/**
 * Pick the iframe's identity for the failure trace. In iframe-pool mode
 * each iframe is named `pool-N` by the test page; in single-window mode
 * the window has no name.
 * @returns {{iframe: string, visibleConversationId: string|null, ownConversationIds: string[]}} this iframe's label plus its visible and owned conversation ids
 */
function _captureIframeIdentity() {
  const w = /** @type {any} */ (window);
  const owned = w.__ownConversationIds instanceof Set ? Array.from(w.__ownConversationIds) : [];
  let visible = null;
  try {
    // Lazy/optional — session may not be reachable from here in every harness mode.
    const session = w.__sessionForTests || null;
    visible = session?.visibleConversationId ?? null;
  } catch (_e) { /* no-op */ }
  let iframeLabel = window.name || 'top';
  if (!window.name && window.parent && window.parent !== window) {
    try {
      const lane = new URLSearchParams(location.search).get('lane');
      iframeLabel = lane !== null ? `pool-${lane}` : 'pool-?';
    } catch (_e) {
      iframeLabel = 'pool-?';
    }
  }
  return {
    iframe: iframeLabel,
    visibleConversationId: visible,
    ownConversationIds: owned
  };
}

/**
 * Render a compact, multi-line document snapshot for the failure trace.
 * Truncates per-item content so a 50-item doc stays readable. Returns
 * empty string on any failure — the diagnostic itself must never throw.
 * @param {any} conversation
 * @returns {string} a compact multi-line snapshot of the doc, or an empty/fallback string on failure
 */
function _renderDocSnapshot(conversation) {
  try {
    if (!conversation) return '(no conversation)';
    const snap = normalizeDocumentSnapshot(conversation);
    if (!snap?.items?.length) return '(empty doc)';
    const lines = snap.items.map((/** @type {any} */ it, /** @type {number} */ i) => {
      const c = typeof it.content === 'string' ? it.content : JSON.stringify(it.content ?? '');
      const trimmed = c.length > 80 ? c.slice(0, 80) + '…' : c;
      // Tool-actions: the lifecycle fields are usually the whole story in
      // a stuck-tool failure, so surface them inline.
      let toolInfo = '';
      if (it.type === 'tool-action') {
        const r = it.result === undefined || it.result === null
          ? 'none'
          : (typeof it.result === 'string' ? it.result : JSON.stringify(it.result)).slice(0, 60);
        toolInfo = ` tool=${it.toolName ?? '?'} state=${it.state ?? '(unset)'} result=${r}`;
      }
      return `  [${i}] ${it.type}${it.role ? ` role=${it.role}` : ''}${toolInfo} ${JSON.stringify(trimmed)}`;
    });
    return lines.join('\n');
  } catch (e) {
    return `(snapshot failed: ${e instanceof Error ? e.message : String(e)})`;
  }
}

/**
 * Render one tape entry into the failure block. Compact and grep-friendly:
 * `12:34:56.789  pool-0  ws-out         {type:"send-message"}`.
 * @param {string} prefix - Per-line prefix (iframe label, or `[worker]`).
 * @param {{ts: number, kind: string, summary?: object, convId?: string}} e
 * @returns {string} a single formatted, grep-friendly tape line
 */
function _renderTapeEntry(prefix, e) {
  const d = new Date(e.ts);
  const hh = String(d.getHours()).padStart(2, '0');
  const mm = String(d.getMinutes()).padStart(2, '0');
  const ss = String(d.getSeconds()).padStart(2, '0');
  const ms = String(d.getMilliseconds()).padStart(3, '0');
  const cid = e.convId ? `convId=${e.convId}` : '';
  const sumStr = e.summary ? JSON.stringify(e.summary) : '';
  return `  ${hh}:${mm}:${ss}.${ms}  ${prefix.padEnd(10)} ${e.kind.padEnd(14)} ${cid} ${sumStr}`.trimEnd();
}

/**
 * Broadcast a dump-request on `juggler-tape-dump` and collect replies for
 * `waitMs`. Each iframe is expected to reply with its own tape filtered to
 * the affected convIds. Returns a flat list of `{prefix, entries}` blocks.
 * @param {string[]} convIds - The conversations to filter on; empty = all.
 * @param {number} [waitMs] - How long to wait for replies.
 * @returns {Promise<Array<{prefix: string, entries: any[]}>>} a flat list of per-iframe `{prefix, entries}` tape blocks
 */
async function _collectCrossIframeTapes(convIds, waitMs = 500) {
  if (typeof BroadcastChannel === 'undefined') return [];
  const requestId = 'dump_' + Math.random().toString(36).slice(2);
  const chan = new BroadcastChannel('juggler-tape-dump');
  /** @type {Array<{prefix: string, entries: any[]}>} */
  const replies = [];
  const onMsg = (/** @type {MessageEvent} */ ev) => {
    const m = ev.data;
    if (!m || m.kind !== 'dump-reply' || m.requestId !== requestId) return;
    replies.push({ prefix: m.iframe || 'unknown', entries: m.entries || [] });
  };
  chan.onmessage = onMsg;
  chan.postMessage({ kind: 'dump-request', requestId, convIds });
  await new Promise((r) => setTimeout(r, waitMs));
  chan.close();
  return replies;
}

/**
 * Fetch the per-worker event tape for `convId` from the test diagnostic
 * endpoint. Returns an empty array if the worker doesn't exist or tracing
 * is off on the server. Failure is silent — the rest of the failure block
 * is still useful without the worker tape.
 * @param {string} convId
 * @returns {Promise<any[]>} the worker's event tape entries, or an empty array if unavailable
 */
async function _fetchWorkerTape(convId) {
  // Abort the fetch after a short budget: this endpoint is served by the same
  // process whose worker may have wedged (the reason the test failed), so an
  // unbounded fetch here is a prime way for the diagnostics build to hang. The
  // outer _withDeadline in the catch is the final backstop; this keeps a
  // single stuck conv from eating that whole budget when several convs exist.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 1500);
  try {
    const resp = await fetch(`/api/test/dump-tape?convId=${encodeURIComponent(convId)}`, { signal: ctrl.signal });
    if (!resp.ok) return [];
    const body = await resp.json();
    return Array.isArray(body?.entries) ? body.entries : [];
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

/**
 * Build a self-sufficient failure message from the trace. Single string,
 * multi-line, no JSON-blob format — the goal is for one scrollback to be
 * enough to triage without rerunning. Now also collects this iframe's
 * tape, every sibling iframe's tape filtered to the affected conv, and
 * the worker tape for the conv — interleaved so the divergence point is
 * visible at a glance.
 * @param {object} args
 * @param {string} args.testName
 * @param {string} args.rawMsg
 * @param {number} args.durationMs
 * @param {number} args.perTestTimeoutMs
 * @param {RunTrace} args.trace
 * @param {TestOperation[]} args.operations
 * @param {any} args.harness
 * @returns {Promise<string>} the assembled multi-line failure message
 */
async function _buildFailureMessage({ testName, rawMsg, durationMs, perTestTimeoutMs, trace, operations, harness }) {
  const ident = _captureIframeIdentity();
  // Start the shared-project size probe now and read it at the end: it is an
  // HTTP round-trip like the tape fetches below, and overlapping it with them
  // keeps it free inside the diagnostics build's own 5s budget.
  const projectSize = fetchProjectSize();
  const totalOps = operations?.length ?? 0;
  const completedTypes = trace.opsCompleted.slice(-8).join(' → ') || '(none)';

  let opLine;
  if (trace.stage !== 'operations') {
    opLine = `stage=${trace.stage} (no op in flight)`;
  } else if (trace.currentOpType) {
    opLine = `failed mid-op [${trace.opIndex}/${totalOps}] type=${trace.currentOpType} args=${JSON.stringify(trace.currentOpSummary || {})}`;
  } else {
    opLine = `between ops, after [${trace.opIndex}/${totalOps}]`;
  }

  const snapshot = _renderDocSnapshot(harness?.conversation);

  // An operation that raises a confirmation is blocked on a promise only a
  // click settles, so a watcher that gave up explains a hang that otherwise
  // arrives as a bare "timed out mid-op" with nothing in any tape.
  const gaveUp = lastConfirmGiveUp();
  const confirmLines = gaveUp ? [`  ARMED CONFIRM GAVE UP: ${gaveUp}`] : [];

  // Gather every tape source the failure block needs. The convIds we care
  // about are the ones this iframe owns — they are the affected
  // conversations for cross-iframe correlation.
  const convIds = ident.ownConversationIds.slice();

  /** @type {string[]} */
  const tapeLines = [];

  // This iframe's tape, filtered to the affected convs (oldest first).
  try {
    const own = dumpTape(convIds.length > 0 ? convIds : null);
    if (own.length > 0) {
      tapeLines.push('  === EVENT TAPE (this iframe) ===');
      for (const e of own) tapeLines.push(_renderTapeEntry(ident.iframe, e));
    }
  } catch (e) { /* swallow */ }

  // Sibling iframes' tapes (BroadcastChannel round-trip).
  try {
    const cross = await _collectCrossIframeTapes(convIds, 400);
    const merged = [];
    for (const { prefix, entries } of cross) {
      if (prefix === ident.iframe) continue;
      for (const e of entries) merged.push({ prefix, e });
    }
    if (merged.length > 0) {
      merged.sort((a, b) => a.e.ts - b.e.ts);
      tapeLines.push('  === EVENT TAPE (other iframes) ===');
      for (const m of merged) tapeLines.push(_renderTapeEntry(m.prefix, m.e));
    }
  } catch (e) { /* swallow */ }

  // Worker tapes for each affected conv (one HTTP round-trip per conv).
  try {
    for (const cid of convIds) {
      const entries = await _fetchWorkerTape(cid);
      if (entries.length > 0) {
        tapeLines.push(`  === WORKER TAPE (${cid}) ===`);
        for (const e of entries) tapeLines.push(_renderTapeEntry('worker', e));
      }
    }
  } catch (e) { /* swallow */ }

  // Uncaught JS errors (window 'error'/'unhandledrejection', trapped by the
  // inline script in headless-test.html) are almost always the REAL cause
  // when components silently fail to render — surface them ahead of the
  // symptom the assertion saw.
  const earlyErrors = /** @type {any} */ (window).__earlyErrors ?? [];
  const jsErrorLines = earlyErrors.length > 0
    ? [`  UNCAUGHT JS ERRORS (${earlyErrors.length} — likely the real cause):`,
      ...earlyErrors.slice(-10).map((/** @type {string} */ e) => `    ${e}`)]
    : [];

  const header = [
    `[${testName}] ${rawMsg}`,
    ...jsErrorLines,
    `  duration: ${durationMs}ms (per-test timeout: ${perTestTimeoutMs}ms)`,
    `  iframe: ${ident.iframe}  visible-conv: ${ident.visibleConversationId || 'none'}  own: [${ident.ownConversationIds.join(', ')}]`,
    ...projectSizeLines(await projectSize),
    ...confirmLines,
    `  ${opLine}`,
    `  ops completed (last 8 of ${trace.opsCompleted.length}): ${completedTypes}`,
    `  doc snapshot:`,
    snapshot
  ];
  if (tapeLines.length > 0) header.push(...tapeLines);
  return header.join('\n');
}

/**
 * Mutable trace recording the runner's progress through a test. Built up
 * in-place by _runTestBody so the catch{} block can render it into the
 * failure message even when the body throws (or is aborted by timeout).
 * @typedef {object} RunTrace
 * @property {'setup'|'setupFiles'|'strategy'|'operations'|'final-assertions'} stage - runner phase the test reached when it failed
 * @property {number} opIndex - index of currently-running op (-1 before ops start)
 * @property {string[]} opsCompleted - op `type` of each fully-finished operation
 * @property {string} [currentOpType] - type of the op currently in flight
 * @property {object} [currentOpSummary] - small subset of args for currentOp
 */

/**
 * Run the body of a single integration test (setup, operations, assertions).
 * Separated so runIntegrationTest can wrap it with a timeout.
 * @param {UITestHarness} harness - Test harness
 * @param {IntegrationTestDefinition} testDef - Test definition
 * @param {RunTrace} trace - In-place trace updated as the body progresses
 * @returns {Promise<void>}
 */
async function _runTestBody(harness, testDef, trace) {
  trace.stage = 'setup';
  await harness.setup();

  // Optional setupFiles: write specific files into the fixture before the
  // test starts running operations. Used by tests like
  // thread-ai-files-to-sub-thread that need CLAUDE.md (or similar) on disk
  // to exercise an existing-file code path, but can't rely on the
  // fixture-template swap because the iframe-pool topology doesn't
  // per-test-reset the shared fixture dir. Files are deleted in the
  // runner's finally{} cleanup so sibling tests don't see the seeded
  // state (e.g. CLAUDE.md would trigger session.addAIAssistantFiles
  // auto-add and shift item IDs in unrelated tests).
  if (testDef.setupFiles) {
    trace.stage = 'setupFiles';
    const { writeFileOp } = await import('../../js/services/ops-api.js');
    for (const [path, content] of Object.entries(testDef.setupFiles)) {
      await writeFileOp({ path, content });
    }
  }

  if (testDef.strategy) {
    trace.stage = 'strategy';
    harness.conversation.rootMessageThread.setStrategy(testDef.strategy);
    // setStrategy writes to Yjs; the strategy WS message and any subsequent
    // user-message WS sends are ordered by the WebSocket itself, so the
    // worker will see the strategy before the first send-message. No wait
    // needed.
  }

  trace.stage = 'operations';
  for (let i = 0; i < testDef.operations.length; i++) {
    const op = testDef.operations[i];
    trace.opIndex = i;
    trace.currentOpType = op.type;
    trace.currentOpSummary = _summariseOp(op);
    await executeUIOperation(harness, op);
    assertNoItemIdDuplicates(harness.conversation, `${testDef.name}:${op.type}`);
    trace.opsCompleted.push(op.type);
    trace.currentOpType = undefined;
    trace.currentOpSummary = undefined;
  }

  trace.stage = 'final-assertions';

  // Fence on the EXACT shape the assertions below check — not just the item
  // count. A count-only gate (the old waitForItemsSync) can fire while a seeded
  // context item (e.g. system-prompt) is still syncing but in-flight items have
  // already pushed the count past the threshold, so the assertion then races a
  // transiently-incomplete document (right count, wrong items). Waiting for the
  // expected types/fields at their positions removes that race; on the deadline
  // it falls through and the assertion reports the precise mismatch. `settleUntil`
  // extends the same fence to custom-assertion tests whose terminal state isn't
  // expressible as expectedItems/expectedDocument (e.g. a clone whose doc syncs
  // in a beat late) — it is a side-effect-free predicate, so unlike re-running
  // customAssertions it can't disturb tests whose assertions have side effects.
  if (testDef.expectedDocument || testDef.expectedItems || testDef.settleUntil) {
    await harness.waitForDocumentMatch(snap =>
      (!testDef.expectedDocument || documentMatchesGolden(snap, testDef.expectedDocument)) &&
			(!testDef.expectedItems || itemsMatchExpected(snap, testDef.expectedItems)) &&
			(!testDef.settleUntil || !!testDef.settleUntil(harness.conversation, { harness })));
  }

  const snapshot = normalizeDocumentSnapshot(harness.conversation);

  if (testDef.expectedDocument) {
    assertDocumentGolden(snapshot, testDef.expectedDocument, testDef.name);
  }

  if (testDef.expectedItems) {
    assertItemsExist(snapshot, testDef.expectedItems, testDef.name);
  }

  if (testDef.fileAssertions) {
    for (const fa of testDef.fileAssertions) {
      const content = await harness.readFile(fa.path);
      if (content !== fa.content) {
        throw new Error(
          `[${testDef.name}] File ${fa.path} mismatch!\n` +
					`Expected: ${fa.content}\n` +
					`Actual: ${content}`
        );
      }
    }
  }

  if (testDef.expectedUndoState) {
    const actualCanUndo = harness.conversation.canUndo();
    const actualCanRedo = harness.conversation.canRedo();
    if (actualCanUndo !== testDef.expectedUndoState.canUndo) {
      throw new Error(`[${testDef.name}] canUndo=${actualCanUndo}, expected ${testDef.expectedUndoState.canUndo}`);
    }
    if (actualCanRedo !== testDef.expectedUndoState.canRedo) {
      throw new Error(`[${testDef.name}] canRedo=${actualCanRedo}, expected ${testDef.expectedUndoState.canRedo}`);
    }
  }

  if (testDef.expectedMetadata) {
    if (!snapshot.metadata) {
      throw new Error(`[${testDef.name}] Expected metadata but snapshot has none`);
    }
    /** @type {(obj: any) => any} */
    const sortKeys = (obj) => {
      if (obj === null || typeof obj !== 'object') return obj;
      if (Array.isArray(obj)) return obj.map(sortKeys);
      return Object.keys(obj).sort().reduce((/** @type {Record<string, any>} */ acc, k) => {
        acc[k] = sortKeys(obj[k]);
        return acc;
      }, {});
    };
    for (const [key, expectedValue] of Object.entries(testDef.expectedMetadata)) {
      const expectedStr = JSON.stringify(sortKeys(expectedValue));
      const actualStr = JSON.stringify(sortKeys(snapshot.metadata[key]));
      if (expectedStr !== actualStr) {
        throw new Error(`[${testDef.name}] Metadata '${key}': expected ${expectedStr}, got ${actualStr}`);
      }
    }
  }

  if (testDef.customAssertions) {
    await testDef.customAssertions(harness.conversation, { harness });
  }

  if (testDef.expectedDocument?.items?.length) {
    await harness.driver.waitForDOMStable();
    assertDOMMatchesExpected(harness.driver, testDef.expectedDocument.items, testDef.name);
  }
}

/**
 * Run a single integration test with a per-test timeout.
 * Each test resets the fixture and creates a fresh conversation for isolation.
 * @param {IntegrationTestDefinition} testDef - Test definition
 * @param {TestContext} ctx - Test context with fixtureDir
 * @returns {Promise<TestResult>} The test result with pass/fail status and duration
 */
export async function runIntegrationTest(testDef, ctx) {
  const startTime = Date.now();

  // Per-test sandbox: every test gets its own subfolder under the shared
  // fixture dir. Tests author paths starting with this dir so sibling
  // tests' file ops don't cross-pollinate (glob matches, readFile content
  // shifts, etc.). The runner just creates the dir before and rm -rfs it
  // after — no path rewriting, no magic. Tests reference the dir directly,
  // derived deterministically from the test name (see testDirFor below).
  const testDir = testDirFor(testDef.name);

  // Reset the per-iframe event tape so failures show only events from
  // THIS test. Without this, a long-running suite's tape would be
  // dominated by prior tests' noise by the time any one of them failed.
  clearTape();

  // Same for uncaught-JS-error attribution: errors surfaced in this test's
  // failure block must be THIS test's. (Page-LOAD errors were snapshotted
  // by headless-test.html before any test ran and fail tests fast there.)
  /** @type {any} */ (window).__earlyErrors = [];

  // Tag every conversation this test creates with the test's name (server
  // ?reason=), so if one leaks the suite-end dump names this test directly.
  setCurrentTestName(testDef.name);

  // Claims snapshot for the finally{} cleanup: everything this lane claims
  // beyond this set was created by THIS test and gets deleted afterwards.
  const claimsBeforeTest = snapshotOwnConversationIds();

  // Skip the destructive per-test fixture wipe in the multi-iframe pool
  // topology — the subprocess's project dir is shared by N parallel tests,
  // each using a per-test sandbox (testDir) to avoid collisions. Wiping it
  // per-test would delete other tests' in-flight files. In single-window
  // mode this is unchanged.
  if (!window.parent || window.parent === window) {
    const resetUrl = `/api/test/reset-fixture?fixture=${encodeURIComponent(testDef.fixture)}&dir=${encodeURIComponent(ctx.fixtureDir)}`;
    logger.info(`Resetting fixture for ${testDef.name}`);
    const resetResp = await fetch(resetUrl, { method: 'POST' });
    if (!resetResp.ok) {
      const errText = await resetResp.text();
      logger.essential(`Fixture reset FAILED for ${testDef.name}: ${resetResp.status} ${errText}`);
      return { passed: false, error: `Fixture reset failed: ${resetResp.status} ${errText}`, durationMs: Date.now() - startTime };
    }
  }

  // Create the per-test sandbox dir. mkdir -p semantics; idempotent.
  if (ctx.fixtureDir) {
    const mkUrl = `/api/test/mkdir?dir=${encodeURIComponent(ctx.fixtureDir)}&path=${encodeURIComponent(testDir)}`;
    const mkResp = await fetch(mkUrl, { method: 'POST' });
    if (!mkResp.ok) {
      const errText = await mkResp.text();
      return { passed: false, error: `testDir mkdir failed: ${mkResp.status} ${errText}`, durationMs: Date.now() - startTime };
    }
  }

  const APPROVAL_OP_TYPES = new Set([
    'approve', 'approve-no-wait', 'deny', 'wait-for-approval',
    'wait-for-thread-approval', 'approve-thread-tool',
    'approve-thread-tool-no-wait', 'deny-thread-tool'
  ]);
  // Tests with an approval operation implicitly need the non-permissive
  // conversation (no blanket `execute *` / auto-approve). A test can also opt in
  // explicitly via `approvalFlow: true` — required when the test's whole point is
  // that *something else* (a strategy's approval policy) does the approving, so it
  // must NOT get the harness's blanket grant masking that.
  const approvalFlow = testDef.approvalFlow ??
		(testDef.operations?.some(op => APPROVAL_OP_TYPES.has(op.type)) ?? false);

  const harnessOptions = {
    llmResponses: testDef.llmResponses,
    fixture: testDef.fixture,
    fixtureDir: ctx.fixtureDir,
    approvalFlow
  };

  const harness = new UITestHarness(harnessOptions);
  // The default budget for one test, and through `_perTestDeadlineMs` below the
  // bound on every wait inside it. It buys nothing on a passing test and is
  // spent only by a failing one, so the number to pick is the largest that
  // still leaves the failure reported HERE, with its operation trace and event
  // tapes, rather than as the Go harness's bare 60s result-poll timeout: 25s of
  // test plus the 5s diagnostics build. The nine lanes of the pool share one
  // machine and now genuinely run at once, so the work a lane is waiting on can
  // be sitting behind eight siblings' — a budget tight enough to notice that is
  // measuring the pool, not the code.
  const perTestTimeoutMs = testDef.timeoutMs || 25000;
  const ac = new AbortController();
  // In-test condition waits stay patient up to this deadline instead of
  // pre-empting it with their own shorter sub-timeouts. The per-test hard
  // timeout below remains the single fail-fast for a genuinely stuck test —
  // and its abort tears the patient waits down immediately so a failing
  // test's observers don't leak past the deadline and starve sibling lanes.
  harness._perTestDeadlineMs = Date.now() + perTestTimeoutMs;
  harness._abortSignal = ac.signal;
  // The same deadline, where the waits that have no harness to ask can find
  // it — `waitFor` is a free function called from hundreds of sites.
  setTestDeadline(harness._perTestDeadlineMs);

  /** @type {RunTrace} */
  const trace = { stage: 'setup', opIndex: -1, opsCompleted: [] };

  let timeoutId;

  try {
    await Promise.race([
      _runTestBody(harness, testDef, trace),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => {
          ac.abort();
          reject(new Error(`Test timed out after ${perTestTimeoutMs}ms`));
        }, perTestTimeoutMs);
      })
    ]);
    clearTimeout(timeoutId);

    return { passed: true, durationMs: Date.now() - startTime };

  } catch (error) {
    clearTimeout(timeoutId);
    ac.abort();
    const rawMsg = error instanceof Error ? error.message : String(error);
    const durationMs = Date.now() - startTime;
    // Bound the diagnostics build: it fetches event tapes from the worker(s)
    // this test used, and a test that failed BECAUSE its worker wedged would
    // otherwise hang here forever (unbounded fetch to a stuck server) — the
    // result would never post and the Go harness would time the subtest out
    // at 60s with zero diagnostics. On the deadline we fall back to the bare
    // message so the failure is always reported, just without the tapes.
    const errorWithDiag = await _withDeadline(
      _buildFailureMessage({
        testName: testDef.name,
        rawMsg,
        durationMs,
        perTestTimeoutMs,
        trace,
        operations: testDef.operations,
        harness
      }),
      5000,
      `[${testDef.name}] ${rawMsg}\n  (failure diagnostics unavailable — the diagnostics build timed out; the server/worker may be unresponsive)`,
      `failure-diagnostics build for ${testDef.name}`
    );
    return { passed: false, error: errorWithDiag, durationMs };

  } finally {
    // Disarm before cleanup: the deadline belongs to the test, and cleanup
    // running under an expired one would give every wait in it a zero budget.
    clearTestDeadline();

    // Close any second-viewer WebSockets a test opened (open-second-viewer).
    // These are extra real server clients; closing them lets the server's
    // ClientDisconnected unregister their per-worker callbacks so they don't
    // leak into sibling lanes.
    if (harness._secondViewers) {
      for (const sv of harness._secondViewers.values()) {
        try { sv.close(); } catch (err) { logger.error(`[runner] second-viewer close error: ${err}`); }
      }
      harness._secondViewers.clear();
    }

    // Delete server-side conversations BEFORE tearing down the harness.
    // teardown() destroys the session and detaches services; doing the
    // deletes after that race-loses against a fresh session.load() in
    // the next test.
    //
    // Critical: delete ONLY the conversations THIS test created — in the
    // /test-pool iframe topology, multiple tests run in parallel against
    // the same SessionManager. The claim registry diff is the complete
    // record of "created by this test": claims are auto-registered at the
    // apiService chokepoint, so conversations created by production paths
    // inside a test (/duplicate, the + button, promote-to-tab) are
    // covered too — those used to slip past harness-level tracking and
    // leak into the shared session. Each delete is lane-tagged, and the
    // server's ownership guard would reject it if it weren't ours.
    // Bounded: each delete is an HTTP round-trip to the shared server, and a
    // server that wedged mid-test would otherwise hang the finally{} here —
    // blocking the return of the (already-computed) result and stalling the
    // lane past the harness's 60s poll. On the deadline we give up on the
    // delete (the conversation may leak and surface in the run's leak check,
    // which is the correct loud signal) rather than freeze the whole lane.
    await _withDeadline(
      deleteOwnConversationsCreatedSince(claimsBeforeTest, `runner-cleanup:${testDef.name}`),
      5000,
      undefined,
      `post-test conversation cleanup for ${testDef.name}`
    );

    // Wipe the per-test sandbox: one rm -rf of the testDir takes care of
    // every file/dir the test created UNDER its sandbox. Path-traversal
    // guarded by /api/test/delete-file (uses os.RemoveAll). This is the
    // catch-all for tests using the testDir convention.
    if (ctx.fixtureDir) {
      const url = `/api/test/delete-file?dir=${encodeURIComponent(ctx.fixtureDir)}&path=${encodeURIComponent(testDir)}`;
      await _withDeadline(
        fetch(url, { method: 'POST' }),
        3000,
        undefined,
        `testDir cleanup for ${testDef.name}`
      );
    }

    // Also clean up explicit setupFiles paths. Tests that legitimately
    // need to seed files OUTSIDE the testDir (e.g. CLAUDE.md at the
    // project root, because the production code only auto-adds it from
    // the root) still rely on this per-path cleanup. Inside-testDir
    // setupFiles get caught by both this loop and the rm -rf above —
    // harmless redundancy.
    if (testDef.setupFiles && ctx.fixtureDir) {
      await _withDeadline(
        Promise.allSettled(
          Object.keys(testDef.setupFiles).map((/** @type {string} */ path) => {
            const url = `/api/test/delete-file?dir=${encodeURIComponent(ctx.fixtureDir)}&path=${encodeURIComponent(path)}`;
            return fetch(url, { method: 'POST' });
          })
        ),
        3000,
        undefined,
        `setupFiles cleanup for ${testDef.name}`
      );
    }

    // Bounded: teardown destroys the session and detaches services; if a
    // socket close or final flush blocks on the wedged server, an unbounded
    // await would once again strand the result behind the finally{}.
    await _withDeadline(harness.teardown(), 5000, undefined, `harness teardown for ${testDef.name}`);
  }
}

/**
 * @typedef {object} TestContext
 * @property {string} fixtureDir - Fixture directory path
 */

/**
 * Suite-level state initialised lazily on the first runIntegrationTests call
 * and reused across every subsequent call. Each test in the headless-test
 * page used to disconnect and reconnect the WebSocket *and* clear the worker
 * routing map — that introduced reconnect storms and dropped messages
 * proportional to the test count, manifesting as batch-mode hangs.
 * @type {{ initialized: boolean }}
 */
const _suiteState = { initialized: false };

/**
 * Initialise the WebSocket and worker-message routing once per page lifecycle.
 * Idempotent.
 * @returns {Promise<void>}
 */
async function _initSuite() {
  if (_suiteState.initialized) return;
  const wsService = (await import('../../js/services/websocket.js')).default;
  const { default: workerManager } = await import('../../js/services/worker-manager.js');
  if (!wsService.isConnected()) {
    await connectWebSocket(wsService);
  }
  wsService.on('message', (/** @type {any} */ data) => {
    if (data.type === 'worker-message') {
      workerManager.handleWorkerMessageFromWS(data);
    }
  });
  _suiteState.initialized = true;
}

/**
 * Run multiple integration tests sequentially. WebSocket and worker routing
 * are set up once on the first call and persist across all subsequent calls.
 * @param {IntegrationTestDefinition[]} tests - Test definitions
 * @param {TestContext} ctx - Test context with fixtureDir
 * @returns {Promise<{passed: number, failed: number, results: Map<string, TestResult>}>} Aggregated test results
 */
export async function runIntegrationTests(tests, ctx) {
  await _initSuite();

  let passed = 0;
  let failed = 0;
  /** @type {Map<string, TestResult>} */
  const results = new Map();

  for (const test of tests) {
    logger.info(`Running: ${test.name}...`);
    const result = await runIntegrationTest(test, ctx);
    results.set(test.name, result);

    if (result.passed) {
      passed++;
      logger.essential(`  ✓ ${test.name} (${result.durationMs}ms)`);
    } else {
      failed++;
      logger.error(`  ✗ ${test.name}: ${result.error}`);
    }
  }

  // Check for failed resource loads (404s, network errors) that occurred
  // during the entire page lifecycle — catches broken imports/assets.
  const resourceErrors = detectFailedResources();
  if (resourceErrors.length > 0) {
    const errorMsg = `Failed resource loads detected:\n${resourceErrors.join('\n')}`;
    results.set('no-resource-errors', { passed: false, error: errorMsg, durationMs: 0 });
    failed++;
    logger.error(`  ✗ no-resource-errors: ${errorMsg}`);
  } else {
    results.set('no-resource-errors', { passed: true, durationMs: 0 });
    passed++;
    logger.essential('  ✓ no-resource-errors');
  }

  return { passed, failed, results };
}

/**
 * Detect failed resource loads by inspecting the Performance API.
 * Uses the responseStatus property (Chrome 109+) to find resources
 * that returned non-2xx HTTP status codes (e.g., 404, 500).
 * @returns {string[]} List of error descriptions for failed resources
 */
function detectFailedResources() {
  /** @type {string[]} */
  const errors = [];
  const entries = performance.getEntriesByType('resource');

  for (const entry of entries) {
    const r = /** @type {PerformanceResourceTiming} */ (entry);
    // Only check static assets (scripts, stylesheets, images, fonts).
    // Skip API/fetch calls — those have their own error handling.
    const isStaticAsset = r.initiatorType === 'script' || r.initiatorType === 'link' ||
			r.initiatorType === 'css' || r.initiatorType === 'img';
    if (!isStaticAsset) continue;

    // responseStatus is 0 for cross-origin or when unavailable — skip those.
    // Only flag resources with an explicit non-2xx status.
    const status = /** @type {any} */ (r).responseStatus;
    if (typeof status === 'number' && status > 0 && (status < 200 || status >= 300)) {
      errors.push(`${status} ${r.name}`);
    }
  }
  return errors;
}

/**
 * Helper to create a text-only LLM response.
 * @param {string} text - Response text
 * @param {object} [options] - Optional token counts and stop reason
 * @param {number} [options.inputTokens] - Input token count
 * @param {boolean} [options.inputTokensApproximate] - Whether input tokens are estimated
 * @param {number} [options.outputTokens] - Output token count
 * @param {number} [options.cachedTokens] - Cached token count
 * @param {string} [options.stopReason] - Stop reason override
 * @param {boolean} [options.pauseBeforeReturn] - Pause the worker between streaming and return
 * @returns {MockResponse} A mock response with text content
 */
export function textResponse(text, options = {}) {
  return {
    blocks: [{ type: 'text', content: text }],
    stopReason: options.stopReason || 'end_turn',
    inputTokens: options.inputTokens || 0,
    inputTokensApproximate: !!options.inputTokensApproximate,
    outputTokens: options.outputTokens || 0,
    cachedTokens: options.cachedTokens || 0,
    pauseBeforeReturn: !!options.pauseBeforeReturn
  };
}

/**
 * Helper to create a tool use LLM response.
 * @param {string} toolUseId - Tool use ID
 * @param {string} toolName - Tool name
 * @param {object} toolInput - Tool input
 * @param {string} [prefixText] - Optional text before tool use
 * @param {object} [options] - Optional token counts and stop reason
 * @param {number} [options.inputTokens] - Input token count
 * @param {boolean} [options.inputTokensApproximate] - Whether input tokens are estimated
 * @param {number} [options.outputTokens] - Output token count
 * @param {number} [options.cachedTokens] - Cached token count
 * @param {string} [options.stopReason] - Stop reason override
 * @param {boolean} [options.pauseBeforeReturn] - Pause the worker between streaming and return
 * @returns {MockResponse} A mock response with tool use
 */
export function toolUseResponse(toolUseId, toolName, toolInput, prefixText, options = {}) {
  /** @type {import('./test-harness.js').MockResponseBlock[]} */
  const blocks = [];

  if (prefixText) {
    blocks.push({ type: 'text', content: prefixText });
  }

  blocks.push({
    type: 'tool_use',
    toolUseId,
    toolName,
    toolInput
  });

  return {
    blocks,
    stopReason: options.stopReason || 'tool_use',
    inputTokens: options.inputTokens || 0,
    inputTokensApproximate: !!options.inputTokensApproximate,
    outputTokens: options.outputTokens || 0,
    cachedTokens: options.cachedTokens || 0,
    pauseBeforeReturn: !!options.pauseBeforeReturn
  };
}

/**
 * Helper to create a multi-tool LLM response.
 * @param {Array<{toolUseId: string, toolName: string, toolInput: object}>} tools - Tool uses
 * @param {string} [prefixText] - Optional text before tools
 * @param {object} [options] - Optional token counts and stop reason
 * @param {number} [options.inputTokens] - Input token count
 * @param {boolean} [options.inputTokensApproximate] - Whether input tokens are estimated
 * @param {number} [options.outputTokens] - Output token count
 * @param {number} [options.cachedTokens] - Cached token count
 * @param {string} [options.stopReason] - Stop reason override
 * @returns {MockResponse} A mock response with multiple tool uses
 */
export function multiToolResponse(tools, prefixText, options = {}) {
  /** @type {import('./test-harness.js').MockResponseBlock[]} */
  const blocks = [];

  if (prefixText) {
    blocks.push({ type: 'text', content: prefixText });
  }

  for (const tool of tools) {
    blocks.push({
      type: 'tool_use',
      toolUseId: tool.toolUseId,
      toolName: tool.toolName,
      toolInput: tool.toolInput
    });
  }

  return {
    blocks,
    stopReason: options.stopReason || 'tool_use',
    inputTokens: options.inputTokens || 0,
    inputTokensApproximate: !!options.inputTokensApproximate,
    outputTokens: options.outputTokens || 0,
    cachedTokens: options.cachedTokens || 0
  };
}

// =============================================================================
// DOM Verification (UI mode only)
// =============================================================================

/**
 * Verify the DOM actually rendered the expected items.
 * This is the proof that the UI layer is working — without it,
 * tests could pass on Yjs state alone with a completely broken UI.
 * @param {import('./ui-driver.js').default} driver - UI driver
 * @param {Array<{type: string}>} expectedItems - Expected items from test definition
 * @param {string} testName - Test name for error messages
 */
function assertDOMMatchesExpected(driver, expectedItems, testName) {
  const rendered = driver.getRenderedMessages();

  // Filter expected items to only those that render as DOM elements
  // (system-prompt does not render as a visible message element)
  const renderableItems = expectedItems.filter(item => ITEM_TYPE_TO_TAG[item.type]);

  if (rendered.length !== renderableItems.length) {
    const renderedTypes = rendered.map(r => r.type).join(', ');
    const expectedTypes = renderableItems.map(i => ITEM_TYPE_TO_TAG[i.type]).join(', ');
    throw new Error(
      `[${testName}] DOM element count mismatch!\n` +
			`Expected ${renderableItems.length} rendered elements: [${expectedTypes}]\n` +
			`Got ${rendered.length} rendered elements: [${renderedTypes}]`
    );
  }

  // Verify each rendered element matches the expected type
  for (let i = 0; i < renderableItems.length; i++) {
    const expectedTag = ITEM_TYPE_TO_TAG[renderableItems[i].type];
    const actualTag = rendered[i].type;
    if (actualTag !== expectedTag) {
      throw new Error(
        `[${testName}] DOM element type mismatch at position ${i}!\n` +
				`Expected: ${expectedTag}\n` +
				`Got: ${actualTag}`
      );
    }
  }
}
