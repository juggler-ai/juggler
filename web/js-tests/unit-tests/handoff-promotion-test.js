//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @file Tests for /handoff summary promotion
 *
 * `maybePromoteHandoffThread` is the completion step of /handoff: once the
 * handoff summary thread (tagged `handoffPromote`) has a `result`, it replaces
 * the thread tile with a PARKED user message carrying that summary — the first
 * message of the new "(continued)" tab. These tests exercise the promotion
 * against a real Yjs doc (no mock LLM needed), including the two negative cases
 * that must be left untouched:
 *   - a handoffPromote thread that hasn't summarised yet (no result), and
 *   - an ordinary thread that carries a result but no handoffPromote marker.
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  waitFor,
  assert
} from '../utilities/test-helpers.js';
import { maybePromoteHandoffThread } from '../../js/utils/compaction-utils.js';
import { createThreadMessage } from '../../sdk/lib/message.js';

const SUMMARY = 'Handoff summary: earlier tab set up the build and ran the tests.';

/**
 * Count the `conversation:changed` announcements for one conversation. The
 * items observer — the other caller of maybePromoteHandoffThread — announces
 * it and then runs the promotion in the same synchronous pass, so once an
 * insert's announcement is seen, whatever that observer would promote it has.
 * @param {any} session - Session owning the conversation
 * @param {string} conversationId - Conversation to watch
 * @returns {{seen: () => number, stop: () => void}} The count, and its unsubscribe
 */
function watchItemsObserver(session, conversationId) {
  let seen = 0;
  const stop = session.subscribe('conversation:changed', (/** @type {any} */ e) => {
    if (e.data?.conversationId === conversationId) seen++;
  });
  return { seen: () => seen, stop };
}

/**
 * Wait until every auto-name request a promotion has already issued has been
 * delivered. maybePromoteHandoffThread sends it from behind a dynamic import of
 * worker-manager; an import of the same, already evaluated, module issued now
 * settles after every one issued before it, so a request is in by then.
 * @returns {Promise<void>} Resolves once earlier requests have landed.
 */
async function autoNameRequestsDelivered() {
  await import('../../js/services/worker-manager.js');
}

/**
 * Insert a thread tile at the end of the root thread.
 * @param {any} mt - Root message thread
 * @param {object} extra - Fields merged onto the thread message (result, handoffPromote, …)
 * @returns {string} The inserted thread's itemId
 */
function insertThreadTile(mt, extra) {
  const threadMsg = /** @type {any} */ (createThreadMessage({ goal: 'Handoff summary', result: null }));
  threadMsg.noAutoSelect = true;
  Object.assign(threadMsg, extra);
  mt.transact(() => {
    const ymap = mt.buildThreadYMap(threadMsg, []);
    mt.insertAt(mt.length, ymap);
  });
  return threadMsg.itemId;
}

/**
 * @param {any} mt - Root message thread
 * @returns {any[]} The thread tiles at the root
 */
const threadTiles = (mt) => mt.items.filter((/** @type {any} */ it) => it.get('type') === 'thread');
/**
 * @param {any} mt - Root message thread
 * @returns {any[]} The user messages at the root
 */
const userMsgs = (mt) => mt.items.filter((/** @type {any} */ it) => it.get('type') === 'user');

/**
 * Run all handoff-promotion tests.
 * @param {object} _ctx
 * @returns {Promise<{ passed: number, failed: number, errors: string[] }>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();

  // =========================================================================
  // Test 1: a completed handoffPromote thread is promoted to a parked user
  //         message carrying the summary; the thread tile is removed.
  // =========================================================================
  try {
    const conversation = await createTestConversation(session);
    const mt = conversation.rootMessageThread;

    insertThreadTile(mt, { handoffPromote: true, result: SUMMARY });

    // Idempotent: promotes if the items observer hasn't already. Asserting the
    // end state keeps the test independent of who fired the promotion.
    maybePromoteHandoffThread(mt);
    await waitFor(() => threadTiles(mt).length === 0,
      () => `the summary thread to be promoted away (${threadTiles(mt).length} thread tile(s) left)`);

    assert(threadTiles(mt).length === 0,
      `expected the summary thread to be promoted away, found ${threadTiles(mt).length} thread tile(s)`);
    const promoted = userMsgs(mt).find((/** @type {any} */ it) => it.get('content') === SUMMARY);
    assert(!!promoted, 'expected a parked user message carrying the handoff summary');
    assert(!!promoted.get('itemId'),
      'the promoted user message must carry an itemId so it is selectable/deletable');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`promotes a completed handoff thread: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 2: a handoffPromote thread with NO result yet is left untouched
  //         (the summary turn hasn't finished — nothing to promote).
  // =========================================================================
  try {
    const conversation = await createTestConversation(session);
    const mt = conversation.rootMessageThread;

    const observer = watchItemsObserver(session, conversation.id);
    const threadId = insertThreadTile(mt, { handoffPromote: true });

    const promotedNow = maybePromoteHandoffThread(mt);
    try {
      await waitFor(() => observer.seen() > 0, 'the items observer to see the inserted thread');
    } finally {
      observer.stop();
    }

    assert(promotedNow === false, 'a result-less handoff thread must not be promoted');
    assert(mt.findIndexByItemId(threadId) >= 0, 'the un-summarised thread must still be present');
    assert(userMsgs(mt).every((/** @type {any} */ it) => it.get('content') !== SUMMARY),
      'no summary user message should exist before the thread has a result');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`leaves a result-less handoff thread alone: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 3: an ordinary thread with a result but no handoffPromote marker is
  //         never touched (a normal /compact thread must not be promoted).
  // =========================================================================
  try {
    const conversation = await createTestConversation(session);
    const mt = conversation.rootMessageThread;

    const observer = watchItemsObserver(session, conversation.id);
    const threadId = insertThreadTile(mt, { result: SUMMARY });

    const promotedNow = maybePromoteHandoffThread(mt);
    try {
      await waitFor(() => observer.seen() > 0, 'the items observer to see the inserted thread');
    } finally {
      observer.stop();
    }

    assert(promotedNow === false, 'an unmarked thread must not be promoted');
    assert(mt.findIndexByItemId(threadId) >= 0, 'the unmarked compaction thread must still be present');
    assert(userMsgs(mt).every((/** @type {any} */ it) => it.get('content') !== SUMMARY),
      'an unmarked thread must not spawn a summary user message');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`ignores an unmarked thread with a result: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 4: promoting the summary asks the server to auto-name the continued
  //         tab — non-forced, so the marker and the user's auto-naming setting
  //         still decide. A thread with no result asks for nothing.
  // =========================================================================
  {
    const { default: workerManager } = await import('../../js/services/worker-manager.js');
    const original = workerManager.requestAutoName;
    /** @type {Array<{id: string, force: boolean|undefined}>} */
    const requests = [];
    /** @type {any} */ (workerManager).requestAutoName = (
      /** @type {string} */ id,
      /** @type {{force?: boolean}} */ opts
    ) => {
      requests.push({ id, force: opts?.force });
    };
    try {
      const pending = await createTestConversation(session);
      const pendingMt = pending.rootMessageThread;
      insertThreadTile(pendingMt, { handoffPromote: true });
      maybePromoteHandoffThread(pendingMt);
      await autoNameRequestsDelivered();

      assert(requests.length === 0,
        'a handoff thread with no summary yet must not request an auto-name');

      const conversation = await createTestConversation(session);
      const mt = conversation.rootMessageThread;
      insertThreadTile(mt, { handoffPromote: true, result: SUMMARY });
      maybePromoteHandoffThread(mt);
      // The request is sent from behind a dynamic import, so it lands an
      // unbounded number of tasks after the promotion — wait for it rather than
      // for a fixed delay, then for any duplicate issued alongside it to land.
      await waitFor(() => requests.some(r => r.id === conversation.id), {
        timeoutMs: 2000,
        description: 'the auto-name request after promotion'
      });
      await autoNameRequestsDelivered();

      const forConv = requests.filter(r => r.id === conversation.id);
      assert(forConv.length === 1,
        `expected exactly 1 auto-name request after promotion, got ${forConv.length}`);
      assert(forConv[0].force === false,
        'the promotion must request a NON-forced auto-name, or it would bypass the enable setting');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`requests a non-forced auto-name on promotion: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      /** @type {any} */ (workerManager).requestAutoName = original;
    }
  }

  return { passed, failed, errors };
}
