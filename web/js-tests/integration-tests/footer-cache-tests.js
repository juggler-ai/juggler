//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration tests for the conversation-footer token display.
 *
 * The display reads the most recent transaction blob in the thread:
 *
 *  1. Every successful LLM turn stamps a `transactionId` onto the
 *     items it produced, and the worker persists an input/output
 *     blob keyed by that id (carrying authoritative inputTokens /
 *     cachedTokens from the provider).
 *  2. `<conversation-footer>` walks its thread's items backward to
 *     find the most recent transactionId, asks the worker for the
 *     blob, and renders the result.
 *  3. With no anchor in the thread (brand-new conversation, or every
 *     LLM-produced item rewound past) the element hides entirely —
 *     a bar against a budget with no count is information-free noise.
 *
 * Text assertions are substring matches so the formatter rules in
 * token-display.js can evolve without breaking the tests.
 * @module integration-tests/footer-cache-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';
import providersCache from '../../js/services/providers-cache.js';
import { tabFor } from '../utilities/conversation-tab-lookup.js';
import { waitFor } from '../utilities/test-helpers.js';

/**
 * Locate the `<token-display>` element rendered for this conversation.
 * Returns null in headless mode (no tab element) so tests can early-out.
 * @param {import('../../js/model/conversation.js').default} conversation
 * @returns {HTMLElement|null} The token-display element, or null in headless mode.
 */
function findTokenDisplay(conversation) {
  const tab = tabFor(conversation);
  if (!tab) return null;
  return /** @type {HTMLElement|null} */ (tab.querySelector('conversation-footer token-display'));
}

/**
 * Locate the `<conversation-footer>` element rendered for this conversation.
 * Returns null in headless mode (no tab element) so tests can early-out.
 * @param {import('../../js/model/conversation.js').default} conversation
 * @returns {HTMLElement|null} The conversation-footer element, or null in headless mode.
 */
function findFooter(conversation) {
  const tab = tabFor(conversation);
  if (!tab) return null;
  return /** @type {HTMLElement|null} */ (tab.querySelector('conversation-footer'));
}

/**
 * The integration test fixture short-circuits /api/providers, so
 * conversation.contextWindow stays null and the footer's bar collapses
 * to budget=0 (empty render). Force a known budget so the rest of the
 * test can assert real numbers, and notify the session so the footer
 * re-runs `_updateTokenDisplay` against the new budget.
 *
 * The notify alone is not enough to wait on, and waiting on it is what made
 * this file's first assertion the most-reported flake in the suite. The footer
 * takes session events through a 2000ms coalescing timer that every further
 * event restarts, so the earliest a notified meter can paint is 2000ms plus a
 * worker round-trip, plus another 250ms if the blob was not saved when it
 * asked — against budgets of 3000ms. That leaves a few hundred milliseconds of
 * headroom on an idle machine and none at all on one running four suites, which
 * is exactly where the give-ups landed (3242ms, 3610ms).
 *
 * So drive the render as well as notifying it. The notify stays because the
 * event path is part of what these tests cover; the direct call is what removes
 * two seconds of dead time from every wait below, and it fetches through the
 * same `_updateTokenDisplay` the timer would have called.
 * @param {import('../../js/model/conversation.js').default} conversation
 * @param {number} budget
 */
function forceContextWindow(conversation, budget) {
  /** @type {any} */ (conversation).contextWindow = budget;
  const session = /** @type {any} */ (conversation)._session;
  session.events.notify('conversation:context-window-updated', conversation);
  /** @type {any} */ (findFooter(conversation))?._updateTokenDisplay?.();
}

// ============================================================================
// TEST 1: After a successful turn, the footer renders the blob's inputTokens.
// ============================================================================

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const footerShowsBlobTokensTest = {
  name: 'footer-shows-blob-tokens',
  description: 'After a successful turn, the footer fetches the assistant item\'s transaction blob and renders inputTokens.',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('OK.', { inputTokens: 3000, outputTokens: 50, cachedTokens: 2000 })
  ],

  operations: [
    { type: 'send-message', message: 'hello' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'hello' },
      { type: 'assistant', content: 'OK.' }
    ]
  },

  customAssertions: async (conversation) => {
    // The assistant item must carry a transactionId stamped by the
    // worker — that's the only persisted handle to per-turn tokens.
    // The footer fetches the blob from disk on demand keyed by it.
    const items = conversation.rootMessageThread.items;
    const assistant = items.find((/** @type {any} */ it) => it.get('type') === 'assistant');
    if (!assistant) throw new Error('No assistant item found');
    const txnId = assistant.get('transactionId');
    if (!txnId) throw new Error('Assistant item has no transactionId — worker must stamp one');

    // DOM: the footer's async fetch must resolve and render
    // "Nk cached" reflecting the provider-reported numbers
    // (inputTokens=3000, cachedTokens=2000 from the mock).
    const td = findTokenDisplay(conversation);
    if (!td) return; // headless

    forceContextWindow(conversation, 200000);
    await waitFor(() => /\bcached\b/.test(td.textContent || ''),
      'token-display renders cached count from blob', 3000);
  }
};

// ============================================================================
// TEST 2: Deleting the assistant item hides the footer entirely.
// ============================================================================

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const footerHidesAfterRewindTest = {
  name: 'footer-hides-after-rewind',
  description: 'Rewinding past every LLM-produced item leaves no transactionId in the thread, so the footer hides entirely.',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('first.', { inputTokens: 1000, cachedTokens: 800 })
  ],

  operations: [
    { type: 'send-message', message: 'one' }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'one' },
    { type: 'assistant', content: 'first.' }
  ],

  async customAssertions(conversation) {
    const td = findTokenDisplay(conversation);
    if (!td) return; // headless

    forceContextWindow(conversation, 200000);
    await waitFor(() => /\bcached\b/.test(td.textContent || ''),
      'footer renders cached count initially', 3000);

    // Delete the user message — range-delete cleans up the trailing
    // assistant too, leaving no item with a transactionId.
    const root = conversation.rootMessageThread;
    const items = root.items;
    const firstUserIdx = items.findIndex((/** @type {any} */ it) => it.get('type') === 'user');
    if (firstUserIdx < 0) throw new Error('No user message to delete');
    conversation.deleteRangeWithCleanup(root, firstUserIdx);

    // No anchor → element collapses to empty innerHTML.
    await waitFor(() => (td.textContent || '').trim() === '',
      'token-display hides entirely once no anchor remains', 2000);
  }
};

// ============================================================================
// TEST 3: cache-warn class fires when uncached delta crosses the threshold.
// ============================================================================

/**
 * Drives the warning state directly via `setUsage` — same surface
 * the footer uses — so the test is fast and deterministic.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const footerCacheWarnTest = {
  name: 'footer-cache-warn',
  description: 'token-display gains the cache-warn class when the uncached delta exceeds the warn threshold.',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('OK.', { inputTokens: 100 })
  ],

  operations: [
    { type: 'send-message', message: 'hi' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'hi' },
      { type: 'assistant', content: 'OK.' }
    ]
  },

  async customAssertions(conversation) {
    const td = findTokenDisplay(conversation);
    if (!td) return;

    forceContextWindow(conversation, 200000);

    // total > cached so the cached span renders and warn is computed.
    // 20000 - 5000 cached = 15000 uncached (well above the 5000 warn).
    /** @type {any} */ (td).setUsage({
      total: 20000,
      cached: 5000,
      budget: 200000,
    });
    if (!td.classList.contains('cache-warn')) {
      throw new Error(`Expected .cache-warn class with total=20000/cached=5000; classes were: ${td.className}`);
    }
    if (!/\bnew\b/.test(td.textContent || '')) {
      throw new Error(`Expected "Pk new" segment in warning state; got ${JSON.stringify(td.textContent)}`);
    }

    /** @type {any} */ (td).setUsage({
      total: 1000,
      cached: 1000,
      budget: 200000,
    });
    if (td.classList.contains('cache-warn')) {
      throw new Error(`Expected .cache-warn class to clear when uncached==0; classes were: ${td.className}`);
    }
  }
};

// ============================================================================
// TEST 4: While a turn is processing, the footer must not display "cached".
// ============================================================================

/**
 * The anchor was captured at the *previous* turn's end. While a new
 * turn is streaming, the live items list and the persisted blob may
 * transiently describe different prompts — so we suppress the cached
 * portion to avoid implying a hit we don't know we'll get.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const footerCacheHiddenWhileProcessingTest = {
  name: 'footer-cache-hidden-while-processing',
  description: 'token-display suppresses the "cached" portion while the conversation is processing.',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('OK.', { inputTokens: 1000 })
  ],

  operations: [
    { type: 'send-message', message: 'hi' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'hi' },
      { type: 'assistant', content: 'OK.' }
    ]
  },

  async customAssertions(conversation) {
    const td = findTokenDisplay(conversation);
    if (!td) return;

    forceContextWindow(conversation, 200000);

    // Idle baseline.
    /** @type {any} */ (td).setUsage({
      total: 1000,
      cached: 800,
      budget: 200000,
      processing: false,
    });
    if (!/\bcached\b/.test(td.textContent || '')) {
      throw new Error(`Idle: expected "cached" in text; got ${JSON.stringify(td.textContent)}`);
    }

    // Processing — cached must disappear from the line.
    /** @type {any} */ (td).setUsage({
      total: 1000,
      cached: 800,
      budget: 200000,
      processing: true,
    });
    if (/\bcached\b/.test(td.textContent || '')) {
      throw new Error(`Processing: "cached" must NOT appear; got ${JSON.stringify(td.textContent)}`);
    }
    const cachedSeg = /** @type {HTMLElement|null} */ (td.querySelector('.token-fill-cached'));
    if (!cachedSeg || cachedSeg.style.width !== '0%') {
      throw new Error(`Processing: cached bar segment must be 0%; got ${cachedSeg ? cachedSeg.style.width : '<missing>'}`);
    }
    if (td.classList.contains('cache-warn')) {
      throw new Error(`Processing: cache-warn class must not be set; classes were ${td.className}`);
    }

    // Returning to idle restores cached.
    /** @type {any} */ (td).setUsage({
      total: 1000,
      cached: 800,
      budget: 200000,
      processing: false,
    });
    if (!/\bcached\b/.test(td.textContent || '')) {
      throw new Error(`Idle after processing: expected "cached" to return; got ${JSON.stringify(td.textContent)}`);
    }
  }
};

// ============================================================================
// TEST 5: an unreported cached count is unknown, and unknown warns about nothing.
// ============================================================================

/**
 * A provider that reports no cache usage for a call leaves `cachedTokens` out
 * of the blob, and the footer passes that absence on as null. Unknown is not a
 * miss: it draws no warning, no `+Nk new`, and no cached slice of the bar. A
 * reported 0 is a measured miss and keeps warning.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const footerCacheUnknownTest = {
  name: 'footer-cache-unknown',
  description: 'token-display treats a null cached count as unknown — no cache-warn, no "+Nk new", no cached bar segment — while a reported 0 still warns.',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('OK.', { inputTokens: 100 })
  ],

  operations: [
    { type: 'send-message', message: 'hi' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'hi' },
      { type: 'assistant', content: 'OK.' }
    ]
  },

  async customAssertions(conversation) {
    const td = findTokenDisplay(conversation);
    if (!td) return;

    forceContextWindow(conversation, 200000);

    // 130000 tokens the provider said nothing about. The uncached delta the
    // warning is built on cannot be computed, so none of it may be drawn.
    /** @type {any} */ (td).setUsage({
      total: 130000,
      cached: null,
      budget: 200000,
    });
    if (td.classList.contains('cache-warn')) {
      throw new Error(`Unknown cache must not warn; classes were: ${td.className}`);
    }
    if (/\bnew\b/.test(td.textContent || '')) {
      throw new Error(`Unknown cache must render no "+Nk new" segment; got ${JSON.stringify(td.textContent)}`);
    }
    if (/\bcached\b/.test(td.textContent || '')) {
      throw new Error(`Unknown cache must render no cached count; got ${JSON.stringify(td.textContent)}`);
    }
    const cachedSeg = /** @type {HTMLElement|null} */ (td.querySelector('.token-fill-cached'));
    if (!cachedSeg || cachedSeg.style.width !== '0%') {
      throw new Error(`Unknown cache must leave the cached bar segment at 0%; got ${cachedSeg ? cachedSeg.style.width : '<missing>'}`);
    }

    // Omitting the field says the same thing as passing null.
    /** @type {any} */ (td).setUsage({
      total: 130000,
      budget: 200000,
    });
    if (td.classList.contains('cache-warn')) {
      throw new Error(`An absent cached count must not warn; classes were: ${td.className}`);
    }
    if (/\bnew\b/.test(td.textContent || '')) {
      throw new Error(`An absent cached count must render no "+Nk new" segment; got ${JSON.stringify(td.textContent)}`);
    }

    // A reported 0 is a miss the provider measured, and reads as one.
    /** @type {any} */ (td).setUsage({
      total: 130000,
      cached: 0,
      budget: 200000,
    });
    if (!td.classList.contains('cache-warn')) {
      throw new Error(`A reported 0 with 130k input must warn; classes were: ${td.className}`);
    }

    // And a reported hit stays quiet, with its count on the line.
    /** @type {any} */ (td).setUsage({
      total: 129916,
      cached: 128425,
      budget: 200000,
    });
    if (td.classList.contains('cache-warn')) {
      throw new Error(`A 98% hit must not warn; classes were: ${td.className}`);
    }
    if (!/\bcached\b/.test(td.textContent || '')) {
      throw new Error(`A reported hit must render its cached count; got ${JSON.stringify(td.textContent)}`);
    }
  }
};

// ============================================================================
// TEST 6: a newest blob that reports no usage falls back to one that does.
// ============================================================================

/**
 * Not every round-trip can say what it sent. A turn that errored before the
 * provider reported usage writes a blob with no input count at all, and a
 * provider that reports usage only at the end of a call has nothing to record
 * for a call that was stopped. Those blobs are real and they are the newest in
 * the thread, so they are what the footer anchors on.
 *
 * A count that vanishes is the worst reading of that: the context did not empty,
 * and every item in the transcript still shows its own tokens. The meter walks
 * back to the most recent round-trip that measured its prompt and shows that
 * instead — the last known size of this conversation, which is what the pill is
 * for.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const footerFallsBackPastUnmeasuredTurnTest = {
  name: 'footer-falls-back-past-unmeasured-turn',
  description: 'When the newest transaction blob reports no input tokens, the footer falls back to the most recent round-trip that did, instead of showing nothing.',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('first.', { inputTokens: 3000, outputTokens: 20, cachedTokens: 2000 }),
    // Reports nothing — the shape a stopped or failed round-trip leaves behind.
    textResponse('second.', { inputTokens: 0, outputTokens: 0 })
  ],

  operations: [
    { type: 'send-message', message: 'one' },
    { type: 'send-message', message: 'two' }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'one' },
    { type: 'assistant', content: 'first.' },
    { type: 'user', content: 'two' },
    { type: 'assistant', content: 'second.' }
  ],

  async customAssertions(conversation) {
    const td = findTokenDisplay(conversation);
    if (!td) return; // headless

    forceContextWindow(conversation, 200000);

    // The second turn's blob has no count. The first turn's has 3000, which
    // formats as "3k" — that is what the pill must settle on.
    await waitFor(() => /\b3k\b/.test(td.textContent || ''),
      'footer falls back to the last round-trip that reported its input tokens', 4000);
  }
};

/**
 * A round-trip that only thinks and calls tools writes no assistant message,
 * yet it measured its prompt like any other, and in an agentic run it is most
 * of them. The meter must count it. Anchored on assistant messages alone, a
 * sub-thread whose later round-trips were all tool calls read 58k — its second
 * round-trip — while its newest measured one was 224k, and kept reading it.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const footerAnchorsOnToolOnlyRoundTripTest = {
  name: 'footer-anchors-on-tool-only-round-trip',
  description: 'A round-trip that wrote only tool calls is still the newest measurement; the footer must not skip back past it to an older round-trip that happened to write text.',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'glob', { pattern: '**/*.go' }, 'Searching.', { inputTokens: 3000, outputTokens: 20, cachedTokens: 2000 }),
    // No prefix text: this round-trip leaves only a tool-action behind.
    toolUseResponse('call_2', 'glob', { pattern: '**/*.js' }, undefined, { inputTokens: 250000, outputTokens: 20, cachedTokens: 240000 }),
    // Reports nothing, like the stopped call that ended the run in the report.
    textResponse('Done.', { inputTokens: 0, outputTokens: 0 })
  ],

  operations: [
    { type: 'send-message', message: 'find things' }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'find things' },
    { type: 'assistant', content: 'Searching.' },
    { type: 'tool-action', toolName: 'glob' },
    { type: 'tool-action', toolName: 'glob' },
    { type: 'assistant', content: 'Done.' }
  ],

  async customAssertions(conversation) {
    const td = findTokenDisplay(conversation);
    if (!td) return; // headless

    forceContextWindow(conversation, 1000000);

    await waitFor(() => /\b250k\b/.test(td.textContent || ''),
      'footer anchors on the newest measured round-trip even when it wrote no assistant message', 4000);
  }
};

// ============================================================================
// TEST 7: mid-turn, a live reading that lapses must not fall back to the anchor.
// ============================================================================

/**
 * The live reading is not continuous. The worker stamps a run's `inputTokens`
 * from a provider usage chunk — once per round-trip — and every subsequent
 * status frame deletes it again, so for most of a multi-step turn the thread has
 * no live figure at all.
 *
 * The meter must hold the last thing it measured through those gaps. Falling
 * back to the previous turn's blob makes the pill alternate between two numbers
 * for the length of the turn, and the number it alternates to is the smaller,
 * older one — so a meter watched during a long turn reads as though the context
 * were repeatedly emptying and refilling.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const footerHoldsLiveCountThroughGapTest = {
  name: 'footer-holds-live-count-through-gap',
  description: 'While a turn runs, a live usage reading that lapses between usage chunks must leave the meter where it was, not flip it back to the previous turn\'s blob.',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('first.', { inputTokens: 3000, outputTokens: 20, cachedTokens: 2000 })
  ],

  operations: [
    { type: 'send-message', message: 'one' }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'one' },
    { type: 'assistant', content: 'first.' }
  ],

  async customAssertions(conversation) {
    const td = findTokenDisplay(conversation);
    const footer = /** @type {any} */ (findFooter(conversation));
    if (!td || !footer) return; // headless

    forceContextWindow(conversation, 200000);

    // Settle on the finished turn's blob: 3000 → "3k".
    await waitFor(() => /\b3k\b/.test(td.textContent || ''),
      'footer settles on the completed turn\'s blob before the next turn starts', 4000);

    // A turn on a provider that reports authoritative per-step usage.
    const conv = /** @type {any} */ (conversation);
    conv.isThreadProcessing = () => true;
    footer._modelStreamsLiveUsage = () => true;

    // Its first usage chunk lands: 250000 → "250k".
    conv.llmState.getLiveInputUsage = () => ({ inputTokens: 250000, cachedTokens: null });
    footer._updateTokenDisplay();
    if (!/\b250k\b/.test(td.textContent || '')) {
      throw new Error(`Live usage must drive the meter mid-turn; got ${JSON.stringify(td.textContent)}`);
    }

    // The next status frame drops the transient counters, so there is no live
    // reading again until the round-trip after this one reports. Nothing about
    // the conversation shrank, so nothing about the meter may.
    conv.llmState.getLiveInputUsage = () => null;
    footer._updateTokenDisplay();
    if (!/\b250k\b/.test(td.textContent || '')) {
      throw new Error(`Meter must hold the last live reading across a gap; got ${JSON.stringify(td.textContent)}`);
    }
  }
};

// ============================================================================
// TEST 8: a column rebuild re-hands the same thread and must not reset the meter.
// ============================================================================

/**
 * A sub-thread column builds a NEW MessageThread wrapper on every rebuild
 * (conversation-tab mints one per non-root column), and a rebuild runs on any
 * conversation:changed — which during a turn is every status frame. The root
 * column reuses `conversation.rootMessageThread`, so this lands on sub-threads
 * and mostly spares the root.
 *
 * The wrapper is new; the thread is not. Treating a re-hand as a change of
 * thread throws away everything the footer had measured, several times a second,
 * which is what makes a nested thread's meter flicker between its live count and
 * the previous turn's blob. `_isOwnThread` already draws this distinction for
 * the Undo offer — the token state is the same problem.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const footerHoldsLiveCountAcrossRebindTest = {
  name: 'footer-holds-live-count-across-rebind',
  description: 'Re-handing a footer the same thread in a fresh wrapper (a column rebuild) must not discard the live reading it is holding.',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('first.', { inputTokens: 3000, outputTokens: 20, cachedTokens: 2000 })
  ],

  operations: [
    { type: 'send-message', message: 'one' }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'one' },
    { type: 'assistant', content: 'first.' }
  ],

  async customAssertions(conversation) {
    const td = findTokenDisplay(conversation);
    const footer = /** @type {any} */ (findFooter(conversation));
    if (!td || !footer) return; // headless

    forceContextWindow(conversation, 200000);
    await waitFor(() => /\b3k\b/.test(td.textContent || ''),
      'footer settles on the completed turn\'s blob', 4000);

    const conv = /** @type {any} */ (conversation);
    conv.isThreadProcessing = () => true;
    footer._modelStreamsLiveUsage = () => true;
    conv.llmState.getLiveInputUsage = () => ({ inputTokens: 250000, cachedTokens: null });
    footer._updateTokenDisplay();
    if (!/\b250k\b/.test(td.textContent || '')) {
      throw new Error(`Live usage must drive the meter mid-turn; got ${JSON.stringify(td.textContent)}`);
    }

    // The next status frame deletes the run's transient counters, so there is no
    // live reading to re-derive the count from...
    conv.llmState.getLiveInputUsage = () => null;

    // ...and that same frame is a conversation:changed, so the column rebuilds
    // and re-hands the footer the same thread in a new wrapper — exactly what
    // conversation-tab hands a sub-thread column. The two arrive together, which
    // is the whole difficulty: the state that would have covered the gap is
    // discarded by the rebuild that accompanies it.
    const rebound = Object.create(footer._messageThread);
    footer.setMessageThread(rebound);
    footer._updateTokenDisplay();

    // The rebuild also emptied the blob cache, so the anchor walk has nothing to
    // render from and leaves the display alone — the count only moves once the
    // re-fetch lands. Wait for that rather than for a fixed delay: the flip is
    // asynchronous, and asserting before it is asserting nothing.
    await waitFor(() => footer._blobTokenCache.size > 0,
      'the rebuild\'s blob re-fetch resolves', 4000);
    footer._updateTokenDisplay();

    if (!/\b250k\b/.test(td.textContent || '')) {
      throw new Error(`A column rebuild must not reset the meter; got ${JSON.stringify(td.textContent)}`);
    }
  }
};

// ============================================================================
// TEST 9: a prompt larger than the window must say so, not read as exactly full.
// ============================================================================

/**
 * The window is a soft operating point, not a wall. With automatic compaction
 * off the conversation is deliberately allowed to run past it — the request is
 * dispatched with the guard bypassed and the provider is left to judge — so a
 * measured total well above the budget is a normal, truthful reading, not a bug
 * in the count.
 *
 * The bar cannot draw past its own width, and shouldn't try. The tooltip has no
 * such excuse: it is computed from the same clamped percentage, so a
 * conversation at nearly twice its window states "100% full" — the one reading
 * that makes an overrun indistinguishable from a perfect fit, at exactly the
 * moment the difference is the whole story.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const footerStatesOverrunTest = {
  name: 'footer-states-overrun',
  description: 'A total above the budget states how far over it is, instead of reporting itself as exactly full.',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('OK.', { inputTokens: 100 })
  ],

  operations: [
    { type: 'send-message', message: 'hi' }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'hi' },
    { type: 'assistant', content: 'OK.' }
  ],

  async customAssertions(conversation) {
    const td = findTokenDisplay(conversation);
    if (!td) return; // headless

    forceContextWindow(conversation, 272000);

    // The shape of the report: 516k measured against a 272k window.
    /** @type {any} */ (td).setUsage({
      total: 516000,
      cached: null,
      budget: 272000,
    });

    const title = td.getAttribute('title') || '';
    if (/\b100%/.test(title)) {
      throw new Error(`An overrun must not report itself as 100% full; title was ${JSON.stringify(title)}`);
    }
    if (!/\b244k\b/.test(title)) {
      throw new Error(`An overrun must state how far over the window it is (244k); title was ${JSON.stringify(title)}`);
    }

    // The bar still cannot exceed its own width — over-budget is stated in
    // words, never by drawing outside the track.
    const fill = /** @type {HTMLElement|null} */ (td.querySelector('.token-fill'));
    if (!fill || fill.style.width !== '100%') {
      throw new Error(`The bar must saturate at 100%; got ${fill ? fill.style.width : '<missing>'}`);
    }

    // And the near-full band it sits above is untouched: 260k of 272k is 95.6%,
    // which still reads as a percentage rather than an overrun.
    /** @type {any} */ (td).setUsage({
      total: 260000,
      cached: null,
      budget: 272000,
    });
    const nearlyFull = td.getAttribute('title') || '';
    if (!/\b96% full\b/.test(nearlyFull)) {
      throw new Error(`Just under the window must still state its percentage; title was ${JSON.stringify(nearlyFull)}`);
    }
  }
};

// ============================================================================
// TEST 10: the meter measures the model THIS thread runs, not the root's.
// ============================================================================

/**
 * A thread can override its model, and a sub-thread inherits by walking up the
 * parent chain (MessageThread.getEffectiveModelConfig) rather than by asking the
 * conversation. `conversation.modelConfig` is literally the ROOT thread's config
 * — so a footer that asks the conversation is asking a different thread which
 * model this column is running.
 *
 * Both halves of the meter depend on the answer: the window it is drawn against,
 * and whether the model reports the per-step usage that makes it grow live at
 * all. Ask the wrong thread and a sub-thread on a large-window model is metered
 * against a small one, and a sub-thread on a live-usage provider hides its meter
 * for the whole turn because the root's model does not stream usage.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const footerMetersThreadOwnModelTest = {
  name: 'footer-meters-thread-own-model',
  description: 'The meter takes its window and its live-usage capability from the model the column\'s own thread will run, not the root thread\'s.',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('first.', { inputTokens: 3000, outputTokens: 20, cachedTokens: 2000 })
  ],

  operations: [
    { type: 'send-message', message: 'one' }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'one' },
    { type: 'assistant', content: 'first.' }
  ],

  async customAssertions(conversation) {
    const td = findTokenDisplay(conversation);
    const footer = /** @type {any} */ (findFooter(conversation));
    if (!td || !footer) return; // headless

    forceContextWindow(conversation, 200000);
    await waitFor(() => /\b3k\b/.test(td.textContent || ''),
      'footer settles on the completed turn\'s blob', 4000);

    const originalGet = providersCache.get;
    const thread = footer._messageThread;
    const originalResolve = thread.getEffectiveModelConfig;
    try {
      // Two models on one provider: the root's, and a bigger one this column's
      // thread has overridden to.
      providersCache.get = () => ([{
        name: 'testprov',
        modelsWithContext: [
          { id: 'root-model', contextWindow: 200000, streamsLiveUsage: false },
          { id: 'thread-model', contextWindow: 872000, streamsLiveUsage: true },
        ],
      }]);
      thread.getEffectiveModelConfig = () => ({ provider: 'testprov', model: 'thread-model' });
      // The footer holds the resolved config rather than re-walking the thread
      // tree on every tick, and is told to drop it by document changes. Changing
      // the answer from underneath it is not a document change, so say so.
      footer._threadModelConfig = undefined;

      footer._updateTokenDisplay();

      const text = td.textContent || '';
      if (!/\b872k\b/.test(text)) {
        throw new Error(`Meter must use the thread's own model window (872k); got ${JSON.stringify(text)}`);
      }
      if (/\b200k\b/.test(text)) {
        throw new Error(`Meter must not fall back to the root thread's window; got ${JSON.stringify(text)}`);
      }
      if (footer._modelStreamsLiveUsage() !== true) {
        throw new Error('Live-usage capability must be read from the thread\'s own model');
      }
    } finally {
      providersCache.get = originalGet;
      thread.getEffectiveModelConfig = originalResolve;
    }
  }
};

export const tests = [
  footerShowsBlobTokensTest,
  footerHidesAfterRewindTest,
  footerCacheWarnTest,
  footerCacheHiddenWhileProcessingTest,
  footerCacheUnknownTest,
  footerFallsBackPastUnmeasuredTurnTest,
  footerAnchorsOnToolOnlyRoundTripTest,
  footerHoldsLiveCountThroughGapTest,
  footerHoldsLiveCountAcrossRebindTest,
  footerStatesOverrunTest,
  footerMetersThreadOwnModelTest
];
