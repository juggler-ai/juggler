//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The footer token pill and the two answers a provider can give about the
 * prompt cache.
 *
 * A transaction blob carries `cachedTokens` only when the provider reported
 * cache usage for that call; a provider that reports nothing (claudecode
 * suppresses it on every mid-turn tool_use pause, where the same warm prefix
 * is re-read by each chained call) leaves the key out. Absent is unknown, a
 * present 0 is a reported miss, and the pill must keep them apart: a
 * fabricated miss trains people to ignore the one signal that would otherwise
 * tell them something true.
 * @module unit-tests/token-cache-unknown-test
 */

import { assert } from '../utilities/test-helpers.js';
import '../../js/components/conversation-footer.js';
import '../../js/components/token-display.js';
import { budgetFor } from '../utilities/test-deadline.js';

const BUDGET = 200000;

/**
 * A thread's items list, shaped for the reads `findLastAssistantTxnId` makes:
 * the assistant message carries the transactionId the footer anchors on.
 * @param {string} txnId - transactionId stamped on the assistant item
 * @returns {Array<{get: (key: string) => any}>} Y.Map-shaped items
 */
function anchoredItems(txnId) {
  /**
   * @param {Record<string, any>} fields - The item's fields
   * @returns {{get: (key: string) => any}} A Y.Map-shaped item
   */
  const item = (fields) => ({ get: (key) => fields[key] });
  return [
    item({ itemId: 'MSG_1', type: 'user', content: 'hello' }),
    item({ itemId: 'MSG_2', type: 'assistant', content: 'OK.', transactionId: txnId }),
  ];
}

/**
 * Poll until a predicate holds. The footer fetches the transaction blob
 * asynchronously and re-renders when it lands.
 * @param {() => boolean} predicate - Condition to wait for
 * @param {string} label - What is being waited for, for the timeout message
 * @returns {Promise<void>} Resolves once the predicate holds
 */
async function waitFor(predicate, label) {
  const deadline = Date.now() + budgetFor(2000);
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`timed out waiting for ${label}`);
}

/**
 * Mount a footer over a thread whose one anchor resolves to `blob`, and wait
 * for the pill to render it. The worker's blob fetch is stubbed, so the test
 * drives the exact wire shape it cares about.
 * @param {Record<string, any>} blob - Transaction blob the worker returns
 * @returns {Promise<{td: HTMLElement, cleanup: () => void}>} The rendered pill and its teardown
 */
async function mountFooterWithBlob(blob) {
  const { default: workerManager } = await import('../../js/services/worker-manager.js');
  const originalGetTransaction = workerManager.getTransaction;
  /** @type {any} */ (workerManager).getTransaction = async () => blob;

  const container = document.createElement('div');
  document.body.appendChild(container);
  const footer = /** @type {any} */ (document.createElement('conversation-footer'));
  container.appendChild(footer);

  const cleanup = () => {
    container.remove();
    /** @type {any} */ (workerManager).getTransaction = originalGetTransaction;
  };

  try {
    footer.setMessageThread({
      container: {},
      items: anchoredItems('txn_1'),
      threadItemId: null,
      // onStatusChange is the footer's live-usage subscription; a real
      // conversation hands back an unsubscribe, so the stand-in does too.
      conversation: {
        id: 'CONV_1',
        contextWindow: BUDGET,
        isProcessing: false,
        onStatusChange: () => () => {},
      },
    });

    const td = /** @type {HTMLElement} */ (footer.querySelector('token-display'));
    assert(!!td, 'footer must contain a token-display');
    await waitFor(() => (td.textContent || '').trim() !== '', 'the pill to render the blob');
    return { td, cleanup };
  } catch (e) {
    cleanup();
    throw e;
  }
}

/**
 * Run the unknown-cache display tests.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test counts and errors
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * Run one test case and collect its outcome.
   * @param {string} name - Test case name
   * @param {() => Promise<void>} fn - Test case body
   * @returns {Promise<void>} Resolves once the case has run
   */
  async function test(name, fn) {
    try { await fn(); passed++; }
    catch (e) { failed++; errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`); }
  }

  await test('a blob with no cache figure warns about nothing', async () => {
    // 130k input and not one word about the cache: the pill may say the total
    // and no more. Reading the absent key as 0 would call the whole prompt new.
    const { td, cleanup } = await mountFooterWithBlob({ inputTokens: 130000, outputTokens: 40 });
    try {
      assert(!td.classList.contains('cache-warn'),
        `unknown cache must not warn; classes were ${td.className}`);
      const text = td.textContent || '';
      assert(!/\bnew\b/.test(text), `unknown cache must render no "+N new" segment, got ${JSON.stringify(text)}`);
      assert(!/\bcached\b/.test(text), `unknown cache must render no cached count, got ${JSON.stringify(text)}`);
      const cachedSeg = /** @type {HTMLElement|null} */ (td.querySelector('.token-fill-cached'));
      assert(!!cachedSeg && cachedSeg.style.width === '0%',
        `unknown cache must draw no cached bar segment, got ${cachedSeg ? cachedSeg.style.width : '<missing>'}`);
      assert(td.getAttribute('title') === 'Cache use not reported for this turn.',
        `unknown cache must say so in the tooltip, got ${td.getAttribute('title')}`);
    } finally {
      cleanup();
    }
  });

  await test('a reported zero is a real miss and still warns', async () => {
    const { td, cleanup } = await mountFooterWithBlob({ inputTokens: 130000, outputTokens: 40, cachedTokens: 0 });
    try {
      assert(td.classList.contains('cache-warn'),
        `a reported 0 with 130k input must warn; classes were ${td.className}`);
      assert(!td.hasAttribute('title'),
        `a reported figure needs no "not reported" tooltip, got ${td.getAttribute('title')}`);
    } finally {
      cleanup();
    }
  });

  await test('a large cached count reads as the hit it is', async () => {
    const { td, cleanup } = await mountFooterWithBlob({ inputTokens: 129916, outputTokens: 40, cachedTokens: 128425 });
    try {
      assert(!td.classList.contains('cache-warn'),
        `a 98% hit must not warn; classes were ${td.className}`);
      const text = td.textContent || '';
      assert(/\bcached\b/.test(text), `a reported hit must render its cached count, got ${JSON.stringify(text)}`);
      assert(!/\bnew\b/.test(text), `a 98% hit must render no "+N new" segment, got ${JSON.stringify(text)}`);
      const cachedSeg = /** @type {HTMLElement|null} */ (td.querySelector('.token-fill-cached'));
      assert(!!cachedSeg && parseFloat(cachedSeg.style.width) > 0,
        `a reported hit must fill the cached bar segment, got ${cachedSeg ? cachedSeg.style.width : '<missing>'}`);
    } finally {
      cleanup();
    }
  });

  return { passed, failed, errors };
}
