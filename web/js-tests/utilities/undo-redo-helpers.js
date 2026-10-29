//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @file The harness the undo/redo suites share
 *
 * The undo/redo cases are five suites — `undo-redo`, `undo-redo-context-items`,
 * `undo-redo-tools`, `undo-redo-deletion` and `undo-redo-deletion-edges` —
 * because all 33 of them in one suite cost about five seconds alone and 20–45s of a 45s budget in a full
 * pool. That inflation is not the code under test: nearly every step of every
 * case is a worker round trip, and in a full pool one round trip can wait
 * 100–300ms on the lane's socket while the worker answers it within
 * milliseconds. A suite's run time is therefore its round trips times that
 * wait, which is why the barriers here cost one ping each and no more, and why
 * a failure reports what each slow case spent its time on.
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation as createTestConversationRaw,
  releaseTestConversation
} from './test-helpers.js';
import { snapshotOwnConversationIds } from './conversation-claims.js';

import workerManager from '../../js/services/worker-manager.js';
import { pingWorker as pingWorkerRaw } from './worker-test-hooks.js';
import logger from './test-logger.js';
import { budgetFor, noteCaseFinished } from './test-deadline.js';
import { racePatiently } from './test-patience.js';

// =============================================================================
// Where a case's time goes
// =============================================================================

/**
 * What the running case has spent, by kind. Nearly every step of every case is
 * a worker round trip, so a suite's wall time is mostly their count times their
 * latency — and in a full pool that latency is the lane's socket, which has
 * been measured holding one round trip for 100–300ms at a time while the worker
 * answered in microseconds. A case that ran long says which kind grew only if
 * every kind is recorded, so the runner resets this per case and a failure
 * prints it beside each slow case.
 * @type {{createMs: number, releaseMs: number, pings: number, pingMs: number, slowPings: number}}
 */
let spent = { createMs: 0, releaseMs: 0, pings: 0, pingMs: 0, slowPings: 0 };

/** A round trip past this is a stall rather than a slow ping. */
const SLOW_PING_MS = 100;

/**
 * The drain barrier ({@link pingWorkerRaw}), timed into {@link spent}.
 * @param {string} conversationId - Conversation ID
 * @returns {Promise<void>}
 */
async function pingWorker(conversationId) {
  const startedAt = performance.now();
  try {
    await pingWorkerRaw(conversationId);
  } finally {
    const ms = performance.now() - startedAt;
    spent.pings++;
    spent.pingMs += ms;
    if (ms > SLOW_PING_MS) spent.slowPings++;
  }
}

/**
 * createTestConversation, timed into {@link spent}.
 * @param {import('../../js/model/session.js').default} session - Session instance
 * @returns {Promise<import('../../js/model/conversation.js').default>} The new conversation
 */
export async function createTestConversation(session) {
  const startedAt = performance.now();
  try {
    return await createTestConversationRaw(session);
  } finally {
    spent.createMs += performance.now() - startedAt;
  }
}

/**
 * One case's spending, for the failure line.
 * @param {typeof spent} s - What the case spent
 * @param {number} totalMs - The case's wall time
 * @returns {string} e.g. "create 240, release 12, 14 pings 61 (1 over 100ms), rest 30"
 */
function describeSpent(s, totalMs) {
  const r = Math.round;
  const stalls = s.slowPings ? ` (${s.slowPings} over ${SLOW_PING_MS}ms)` : '';
  return `create ${r(s.createMs)}, release ${r(s.releaseMs)}, ${s.pings} pings ${r(s.pingMs)}${stalls}, ` +
    `rest ${r(totalMs - s.createMs - s.releaseMs - s.pingMs)}`;
}

// =============================================================================
// Conversation budget
// =============================================================================

/**
 * How many conversations a suite may hold open at once. Every case creates
 * its own, so one is the working number and two is slack for a case that
 * overlaps a create with the release of its predecessor.
 */
const MAX_HELD_CONVERSATIONS = 2;

/**
 * The most conversations this suite was holding when a case ended, and the size
 * of the lane's session map at the same moment. Sampled per case, so a run
 * reports the peak rather than whatever the last case happened to leave.
 */
let heldConversationPeak = 0;
let sessionMapPeak = 0;

/**
 * Record what this suite is holding, at a case boundary.
 * @param {import('../../js/model/session.js').default} session - Session under test
 * @param {Set<string>} claimsAtSuiteStart - Claims this lane held before the suite began
 * @returns {void}
 */
function noteConversationPeak(session, claimsAtSuiteStart) {
  const held = [...snapshotOwnConversationIds()].filter((id) => !claimsAtSuiteStart.has(id));
  heldConversationPeak = Math.max(heldConversationPeak, held.length);
  sessionMapPeak = Math.max(sessionMapPeak, session.conversations.size);
}

/**
 * Delete the conversations one case created, and release this lane's claims on
 * them. Best-effort: cleanup after a failing case must never replace the error
 * that case is reporting.
 * @param {import('../../js/model/session.js').default} session - Session under test
 * @param {Set<string>} claimsBeforeCase - Claims this lane held before the case ran
 * @param {string} reason - Attribution for the server's delete log
 * @returns {Promise<void>}
 */
async function releaseCaseConversations(session, claimsBeforeCase, reason) {
  const created = [...snapshotOwnConversationIds()].filter((id) => !claimsBeforeCase.has(id));
  for (const id of created) {
    try {
      await releaseTestConversation(session, id, reason);
    } catch (error) {
      logger.warn(`[undo-redo-test] Couldn't release ${id}: ${error}`);
    }
  }
}

/**
 * The suite holds one conversation at a time.
 *
 * This is a fact about the whole run, not about undo/redo. Every lane in the
 * browser pool loads the same project on disk, and a session load stubs and
 * queues a Yjs hydration for every conversation in it — so a suite that creates
 * one conversation per case and keeps them all is charging every sibling lane
 * for its own history. Runs last, once every case has been sampled.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testSuiteHoldsOneConversationAtATime() {
  if (heldConversationPeak > MAX_HELD_CONVERSATIONS) {
    throw new Error(
      `This suite held ${heldConversationPeak} conversations at once ` +
      `(the lane's session map peaked at ${sessionMapPeak}), over the budget of ` +
      `${MAX_HELD_CONVERSATIONS}. Every lane in the pool loads this same project and ` +
      `hydrates a document per conversation in it, so each case must release the ` +
      `conversation it created.`
    );
  }
  return { passed: 1, failed: 0, errors: [] };
}

// =============================================================================
// Runner
// =============================================================================

/**
 * @typedef {object} UndoRedoCase
 * @property {string} name - Case name, as reported
 * @property {(session: import('../../js/model/session.js').default) => Promise<{passed: number, failed: number, errors: string[]}>} fn - The case
 */

/**
 * Run one undo/redo suite's cases in order, each on a conversation of its own
 * that is released when it ends, then check the suite held one at a time.
 * @param {string} suiteName - The suite's name, for logs and delete attribution
 * @param {UndoRedoCase[]} cases - The cases to run
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results
 */
export async function runUndoRedoSuite(suiteName, cases) {
  await initializeRegistries();
  workerManager.terminateAll();

  const session = await createTestSession();

  // Clear any loaded conversations
  const loadedConvIds = Array.from(session.conversations.keys());
  for (const convId of loadedConvIds) {
    logger.info(`[${suiteName}] Terminating and clearing conversation: ${convId}`);
    workerManager.terminate(convId);
    session.registry.forget(convId, 'test');
  }

  const tests = [
    ...cases,
    // Last: reports on the cases above, so it has to follow all of them.
    { name: 'Suite Holds One Conversation At A Time', fn: testSuiteHoldsOneConversationAtATime },
  ];

  let passed = 0;
  let failed = 0;
  const errors = [];
  heldConversationPeak = 0;
  sessionMapPeak = 0;
  const claimsAtSuiteStart = snapshotOwnConversationIds();
  // Each case's wall time, release included, and what it went on. The cases
  // share one budget, so the case that times out is only the one left holding
  // what the others spent; a failure reports the slowest cases so the one that
  // spent it can be named, and what it spent it on.
  /** @type {Array<[string, number, typeof spent]>} */
  const caseTimes = [];

  for (const test of tests) {
    // Per-case guard, riding the suite's budget. Its job is attribution — so a
    // wedged case is reported by name instead of surfacing as the whole suite
    // timing out — which means it must sit ABOVE the waits inside the case,
    // not below them: a guard tighter than its own contents would fire first
    // and undo their patience.
    const caseBudgetMs = budgetFor(15000);
    if (caseBudgetMs <= 0) {
      failed++;
      errors.push(`${test.name}: not run — an earlier case in this suite spent the whole budget`);
      continue;
    }
    const claimsBeforeCase = snapshotOwnConversationIds();
    spent = { createMs: 0, releaseMs: 0, pings: 0, pingMs: 0, slowPings: 0 };
    const caseStartedAt = performance.now();
    try {
      logger.info(`[${suiteName}] Running: ${test.name}`);
      const settled = await racePatiently(test.fn(session), caseBudgetMs, { what: `undo/redo case "${test.name}"` });
      if (!settled) throw new Error(`Timeout after ${caseBudgetMs}ms, with the suite no longer moving its deadline`);
      const result = settled.value;
      passed += result.passed;
      failed += result.failed;
      errors.push(...result.errors);
      logger.info(`[${suiteName}] ✓ ${test.name}`);
    } catch (error) {
      failed++;
      const msg = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : '';
      errors.push(`${test.name}: ${msg}`);
      logger.error(`[${suiteName}] ✗ ${test.name}: ${msg}`);
      if (stack) logger.error(`[${suiteName}]   Stack: ${stack}`);
    } finally {
      // Sample before the release, so the peak is what the case actually held.
      noteConversationPeak(session, claimsAtSuiteStart);
      const releaseStartedAt = performance.now();
      await releaseCaseConversations(session, claimsBeforeCase, `${suiteName}:${test.name}`);
      spent.releaseMs += performance.now() - releaseStartedAt;
      caseTimes.push([test.name, Math.round(performance.now() - caseStartedAt), spent]);
      noteCaseFinished();
    }
  }

  if (failed > 0) {
    const slowest = [...caseTimes].sort((a, b) => b[1] - a[1]).slice(0, 6)
      .map(([name, ms, s]) => `${name} ${ms}ms (${describeSpent(s, ms)})`).join(', ');
    errors.push(`  CASE TIMES (slowest of ${caseTimes.length} run): ${slowest}`);
  }

  return { passed, failed, errors };
}

// =============================================================================
// Barriers and assertions
// =============================================================================

/**
 * Synchronization barrier between mutations and undo-state assertions.
 * Deterministic — no sleep.
 *
 * The mutation's yjs-sync is already on the ordered worker channel ahead of
 * this ping: Yjs fires its `update` event synchronously on the local write, so
 * the outbound sync is sent before we get here. The worker processes messages
 * in FIFO order, so by the time it handles this ping the mutation is applied and
 * captured; `handlePing` then force-closes the undo capture window
 * (StopCapturing → undoState written synchronously) and flushes its outbound
 * batcher, emitting the undoState frame *before* the ack.
 *
 * Inbound Yjs updates are timer-batched on the main thread, so the undoState
 * frame — received ahead of the ack — is sitting in the pending-update buffer
 * when ping() resolves. flushPendingUpdates() applies it synchronously, so
 * canUndo()/canRedo() read current state on the next line. This replaces a
 * load-bearing 100ms sleep that merely gambled the batch had flushed — too
 * short on slow/contended CI runners.
 * @param {import('../../js/model/conversation.js').default} conversation
 * @returns {Promise<void>}
 */
export async function waitForUndoStateSync(conversation) {
  await pingWorker(conversation.id);
  conversation._doc.flushPendingUpdates();
}

/**
 * Force the UndoManager's capture window to close so subsequent mutations
 * form an independent undo group. For browser-driven (yjs-sync) mutations
 * the manager only auto-closes after a 20 ms timeout.
 *
 * One ping is the whole of it. The worker handles messages in order, so the
 * ping runs after every mutation sent before it has been captured, and
 * `handlePing` closes the capture window (`StopCapturing`, exactly what
 * `stop-undo-capturing` does) before it acks. So a boundary is the same
 * barrier as {@link waitForUndoStateSync}, and one that directly follows a
 * sync is already in place. Every round trip is worth saving: this suite is
 * hundreds of them, and in a full pool any one can wait 100–300ms on the lane's
 * socket, so its run time is their count times that.
 * @param {import('../../js/model/conversation.js').default} conversation
 * @returns {Promise<void>}
 */
export async function waitForCaptureBoundary(conversation) {
  await waitForUndoStateSync(conversation);
}

/**
 * Assert undo/redo button states match expectations.
 * @param {import('../../js/model/conversation.js').default} conversation - Conversation instance
 * @param {boolean} canUndo - Expected undo availability
 * @param {boolean} canRedo - Expected redo availability
 * @param {string} context - Test context for error message
 */
export function assertUndoRedoState(conversation, canUndo, canRedo, context) {
  const actualCanUndo = conversation.canUndo();
  const actualCanRedo = conversation.canRedo();

  if (actualCanUndo !== canUndo || actualCanRedo !== canRedo) {
    throw new Error(
      `[${context}] Undo/redo state mismatch!\n` +
			`Expected: canUndo=${canUndo}, canRedo=${canRedo}\n` +
			`Actual:   canUndo=${actualCanUndo}, canRedo=${actualCanRedo}`
    );
  }
}

/**
 * Create a test context item for undo/redo testing.
 * @param {string} id - Context item ID
 * @param {import('../../js/model/session.js').default} session - Session instance
 * @param {import('../../js/model/conversation.js').default} conversation - Conversation instance
 * @returns {Promise<import('juggler/context-item').default>} Context item instance
 */
export async function createTestContextItem(id, session, conversation) {
  const contextItemRegistry = (await import('../../js/registries/context-item-registry.js')).default;

  return contextItemRegistry.createItem({
    id: id,
    type: 'file-content',
    data: {
      path: `test-${id}.md`
    }
  }, session, conversation, conversation.rootMessageThread);
}

/**
 * Verify Yjs document state matches expected context item IDs.
 * @param {import('../../js/model/conversation.js').default} conversation - Conversation instance
 * @param {string[]} expectedIds - Expected context item IDs
 * @param {string} context - Test context
 */
export function assertContextItemIdsMatch(conversation, expectedIds, context) {
  // @ts-ignore - Accessing private _doc for testing
  const items = conversation.rootMessageThread.yarray.toArray();
  const actualIds = items
    .filter((/** @type {any} */ item) => item.get('itemId') && !item.get('preventUserDeletion'))
    .map((/** @type {any} */ item) => item.get('itemId'));

  const expected = [...expectedIds].sort();
  const actual = [...actualIds].sort();

  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(
      `[${context}] Context item IDs mismatch!\n` +
			`Expected: ${JSON.stringify(expected)}\n` +
			`Actual:   ${JSON.stringify(actual)}`
    );
  }
}

/**
 * Count context items in the Yjs document.
 * @param {import('../../js/model/conversation.js').default} conversation - Conversation instance
 * @returns {number} Number of context items
 */
export function getContextItemCount(conversation) {
  // @ts-ignore - Accessing private _doc for testing
  const items = conversation.rootMessageThread.yarray.toArray();
  return items.filter((/** @type {any} */ item) => item.get('itemId') && !item.get('preventUserDeletion')).length;
}

/**
 * Clean up auto-added context items (AI assistant files) from a fresh conversation.
 * Also clears undo history so tests start with a clean slate.
 * @param {import('../../js/model/conversation.js').default} conversation - Conversation instance
 */
export async function cleanupAutoAddedContextItems(conversation) {
  // Remove all context items (AI assistant files added by addAIAssistantFiles in conversation-seeder.js)
  // Delete context items in reverse order (to preserve indices)
  // @ts-ignore - Accessing private _doc for testing
  const items = conversation.rootMessageThread.yarray.toArray();
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].get('itemId') && !items[i].get('toolUseId')) {
      // @ts-ignore - Accessing private _doc for testing
      conversation.rootMessageThread.yarray.delete(i, 1);
    }
  }

  // The worker handles messages in order, so clear-undo-stacks runs after the
  // deletes above are applied and captured, and clears them with the rest. The
  // ping after it closes the capture window and flushes the undoState reset.
  await workerManager.clearUndoStacks(conversation.id);
  await pingWorker(conversation.id);
}

/**
 * Verify document has no duplicate itemIds
 * @param {import('../../js/model/conversation.js').default} conversation - Conversation instance
 * @param {string} context - Test context for error message
 */
export function assertNoDuplicateMessageIds(conversation, context) {
  // @ts-ignore - Accessing private _doc for testing
  const items = conversation.rootMessageThread.yarray.toArray();
  /** @type {Set<string>} */
  const seen = new Set();
  for (const item of items) {
    if (item.get('itemId')) {
      if (seen.has(item.get('itemId'))) {
        throw new Error(`[${context}] Duplicate itemId: ${item.get('itemId')}`);
      }
      seen.add(item.get('itemId'));
    }
  }
}

/**
 * Assert items array length matches expected
 * @param {import('../../js/model/conversation.js').default} conversation - Conversation instance
 * @param {number} expected - Expected item count
 * @param {string} context - Test context
 */
export function assertItemCount(conversation, expected, context) {
  // @ts-ignore - Accessing private _doc for testing
  const actual = conversation.rootMessageThread.yarray.length;
  if (actual !== expected) {
    throw new Error(`[${context}] Item count: expected ${expected}, got ${actual}`);
  }
}

/**
 * Insert test user messages with auto-generated itemIds
 * @param {import('../../js/model/conversation.js').default} conversation - Conversation instance
 * @param {number} count - Number of messages to insert
 * @returns {Promise<void>}
 */
export async function insertTestUserMessages(conversation, count) {
  for (let i = 0; i < count; i++) {
    conversation.rootMessageThread.addEvent({
      type: 'user',
      content: `Test message ${Date.now()}-${i}`
    });
  }
  await waitForUndoStateSync(conversation);
}

/**
 * Assert the FULL document order — both count AND every item's content in sequence.
 * Never use assertItemCount alone; this function must be used instead whenever
 * we care about what is in the document, not just how many items.
 * @param {import('../../js/model/conversation.js').default} conversation
 * @param {string[]} expectedContents - Expected content values in document order
 * @param {string} context - Test context for error messages
 */
export function assertItemContents(conversation, expectedContents, context) {
  // @ts-ignore - Accessing private yarray for testing
  const rawItems = conversation.rootMessageThread.yarray.toArray();
  const actualContents = rawItems.map((/** @type {any} */ item) => item.get('content') ?? '');

  if (actualContents.length !== expectedContents.length) {
    throw new Error(
      `[${context}] Item count mismatch: expected ${expectedContents.length}, got ${actualContents.length}\n` +
			`  Expected contents: ${JSON.stringify(expectedContents)}\n` +
			`  Actual contents:   ${JSON.stringify(actualContents)}`
    );
  }
  for (let i = 0; i < expectedContents.length; i++) {
    if (actualContents[i] !== expectedContents[i]) {
      throw new Error(
        `[${context}] Item[${i}] content mismatch\n` +
				`  Expected: ${JSON.stringify(expectedContents[i])}\n` +
				`  Actual:   ${JSON.stringify(actualContents[i])}\n` +
				`  Full expected: ${JSON.stringify(expectedContents)}\n` +
				`  Full actual:   ${JSON.stringify(actualContents)}`
      );
    }
  }
}
