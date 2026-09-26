//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The two ways a transaction blob arrives and the token meter still never draws
 * it. Both are silent: the number simply never appears, and the only trace is a
 * blank footer.
 *
 * The meter is driven entirely by events. It reads its count from a blob it
 * fetches for the newest assistant round-trip, and every path back from that
 * fetch to the DOM runs in one `finally`. So each way that `finally` can decline
 * to render is a way the meter stays blank for good — there is no timer, poll or
 * animation frame anywhere behind it that would ever try again.
 *
 * 1. The blob was not on disk yet. The worker stamps `transactionId` on the
 *    streaming assistant item BEFORE it saves the blob, so the first ask can
 *    land in the gap. Nothing is cached, and on a finished conversation there
 *    is no further `conversation:changed` to ride: the render that would ask
 *    again is the one waiting on this answer.
 * 2. The column rebuilt while the fetch was in flight. A rebuild mints a fresh
 *    MessageThread wrapper around the same Y.Array, so a check for the same
 *    wrapper OBJECT throws the answer away because the view repainted.
 * @module unit-tests/token-meter-recovery-test
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  releaseTestConversation,
  waitFor,
  assert
} from '../utilities/test-helpers.js';
import { budgetFor } from '../utilities/test-deadline.js';
import workerManager from '../../js/services/worker-manager.js';
import MessageThread from '../../js/model/message-thread.js';
import { TOKEN_UPDATE_MAX_WAIT_MS } from '../../js/components/conversation-footer.js';
import '../../js/components/token-display.js';

/** A blob reporting a measured prompt, most of it served from cache. */
const MEASURED_BLOB = { inputTokens: 3000, cachedTokens: 2000 };

/**
 * Mount a footer showing `thread`, and return it with a reader for the meter's
 * rendered text. Re-queried on every read, so a rebuilt element is followed
 * rather than polled as an orphan.
 *
 * The footer's debounced refresh is stubbed out for the duration. It is a
 * second, slower route to the same render — it re-reads a cache the fetch fills
 * whether or not the fetch's own render lands — and leaving it in place makes
 * both cases below pass on a tree with the fault still in it, two seconds late.
 * The subject here is what the fetch does with its own answer.
 * @param {any} thread - Message thread the footer should show
 * @returns {{footer: any, meterText: () => string}} The footer and its meter reader
 */
function mountFooter(thread) {
  const footer = /** @type {any} */ (document.createElement('conversation-footer'));
  document.body.appendChild(footer);
  footer._scheduleTokenDisplayUpdate = () => {};
  footer.setMessageThread(thread);
  footer._scheduleTokenDisplayUpdate = () => {};
  return {
    footer,
    meterText: () => footer.querySelector('token-display')?.textContent?.trim() ?? ''
  };
}

/**
 * Seed the thread with the assistant round-trip the meter anchors on.
 * @param {any} thread - Message thread to seed
 * @param {string} txnId - Transaction id to stamp on the assistant item
 */
function addAnchoredTurn(thread, txnId) {
  thread.addEvent({ type: 'user', content: 'measure this' });
  thread.addEvent({ type: 'assistant', content: 'measured.', transactionId: txnId });
}

/**
 * Run the token-meter recovery suite.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /**
   * @param {unknown} e - Whatever a check threw
   * @returns {string} Its message
   */
  const msg = (e) => e instanceof Error ? e.message : String(e);

  await initializeRegistries();
  const session = await createTestSession();
  const realGetTransaction = workerManager.getTransaction;

  // =========================================================================
  // 1: a blob that was not saved yet is asked for again
  // =========================================================================
  let conversation = null;
  let mounted = null;
  try {
    conversation = await createTestConversation(session);
    const thread = conversation.rootMessageThread;
    addAnchoredTurn(thread, 'txn-late-save');

    // The save lands after the first two asks — the end-of-turn race, made
    // deterministic. A meter that only ever asks once never sees this blob.
    let asks = 0;
    workerManager.getTransaction = async () => {
      asks++;
      return asks > 2 ? MEASURED_BLOB : undefined;
    };

    mounted = mountFooter(thread);

    await waitFor(() => /\bcached\b/.test(mounted.meterText()), {
      timeoutMs: budgetFor(2000),
      description: 'the meter draws a blob that was saved after the first ask'
    });
    assert(asks > 2, `the meter must ask again after an empty answer, asked ${asks}×`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`re-asks for a late-saved blob: ${msg(e)}`);
  } finally {
    workerManager.getTransaction = realGetTransaction;
    mounted?.footer.remove();
    if (conversation) await releaseTestConversation(session, conversation.id, 'token-meter-1');
  }

  // =========================================================================
  // 2: the answer survives a rebuild of the column that asked for it
  // =========================================================================
  conversation = null;
  mounted = null;
  try {
    conversation = await createTestConversation(session);
    const thread = conversation.rootMessageThread;
    addAnchoredTurn(thread, 'txn-rebuilt-column');

    // Hold the answer until the test has rebuilt the column, so the reply lands
    // on a footer whose wrapper is no longer the one that asked.
    /** @type {() => void} */
    let release = () => {};
    const held = new Promise((resolve) => { release = () => resolve(MEASURED_BLOB); });
    workerManager.getTransaction = () => held;

    mounted = mountFooter(thread);

    // What a column rebuild does: a new wrapper around the SAME thread. The
    // conversation is unchanged, so this is a repaint, not a navigation.
    const rebuilt = new MessageThread(conversation, thread.container, null);
    assert(rebuilt !== thread, 'the rebuild must produce a different wrapper');
    assert(rebuilt.container === thread.container, 'over the same thread');
    mounted.footer._messageThread = rebuilt;

    release();
    await waitFor(() => /\bcached\b/.test(mounted.meterText()), {
      timeoutMs: budgetFor(2000),
      description: 'the meter draws an answer that arrived after the column rebuilt'
    });

    passed++;
  } catch (e) {
    failed++;
    errors.push(`survives a column rebuild: ${msg(e)}`);
  } finally {
    workerManager.getTransaction = realGetTransaction;
    mounted?.footer.remove();
    if (conversation) await releaseTestConversation(session, conversation.id, 'token-meter-2');
  }

  // =========================================================================
  // 3: a conversation still changing must not cancel the re-ask
  // =========================================================================
  conversation = null;
  mounted = null;
  try {
    conversation = await createTestConversation(session);
    const thread = conversation.rootMessageThread;
    addAnchoredTurn(thread, 'txn-busy-conversation');

    let asks = 0;
    workerManager.getTransaction = async () => {
      asks++;
      return asks > 2 ? MEASURED_BLOB : undefined;
    };

    const footer = /** @type {any} */ (document.createElement('conversation-footer'));
    document.body.appendChild(footer);
    // Every conversation:changed reaches the meter as a request to coalesce a
    // render, and during a turn that is every status frame. Standing in for one
    // here with only the cancellation it performs — no rescheduled render —
    // leaves the blob re-ask as the sole route to the number, which is exactly
    // what _retryBlobLoad's comment claims it is. If a coalescing request can
    // take that route away, the meter stays blank for good.
    footer._scheduleTokenDisplayUpdate = () => footer._cancelDeferredTokenDisplayUpdate();
    footer.setMessageThread(thread);
    mounted = {
      footer,
      meterText: () => footer.querySelector('token-display')?.textContent?.trim() ?? ''
    };

    // A turn's worth of frames, arriving faster than the re-ask waits.
    const busy = setInterval(() => footer._scheduleTokenDisplayUpdate(), 50);
    try {
      await waitFor(() => /\bcached\b/.test(mounted.meterText()), {
        timeoutMs: budgetFor(2000),
        description: 'the meter draws its blob while the conversation keeps changing'
      });
    } finally {
      clearInterval(busy);
    }
    assert(asks > 2, `the meter must keep asking while events arrive, asked ${asks}×`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`re-asks while the conversation keeps changing: ${msg(e)}`);
  } finally {
    workerManager.getTransaction = realGetTransaction;
    mounted?.footer.remove();
    if (conversation) await releaseTestConversation(session, conversation.id, 'token-meter-3');
  }

  // =========================================================================
  // 4: a conversation that never goes quiet still gets its coalesced render
  // =========================================================================
  //
  // The coalescer alone, with no thread and a stubbed render. Deliberately
  // isolated: with a thread attached, the blob fetch's own `finally` renders the
  // meter too, so a spy on _updateTokenDisplay counts that instead and the case
  // passes with the fault still in place — which is what the first draft of this
  // one did. Stubbing the render before anything is attached leaves the settling
  // timer as the only thing that can satisfy it.
  //
  // The fault it pins: a settling timer that every event restarts has no floor.
  // While events keep arriving closer together than the debounce, the render is
  // not delayed but abandoned, and during a turn every status frame is one of
  // those events.
  try {
    const footer = /** @type {any} */ (document.createElement('conversation-footer'));
    document.body.appendChild(footer);
    let renders = 0;
    footer._updateTokenDisplay = () => { renders++; };

    const busy = setInterval(() => footer._scheduleTokenDisplayUpdate(), 50);
    try {
      await waitFor(() => renders > 0, {
        timeoutMs: budgetFor(TOKEN_UPDATE_MAX_WAIT_MS + 2000),
        description: `a coalesced render inside ${TOKEN_UPDATE_MAX_WAIT_MS}ms of events that never stop`
      });
    } finally {
      clearInterval(busy);
      footer.remove();
    }

    passed++;
  } catch (e) {
    failed++;
    errors.push(`renders while the conversation never goes quiet: ${msg(e)}`);
  }

  return { passed, failed, errors };
}
