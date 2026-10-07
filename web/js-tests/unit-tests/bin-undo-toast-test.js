//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the transient bin Undo button in the conversation bar.
 *
 * Binning is silent and instant — no confirmation — so the only immediate way
 * back from a misclick is the Undo that appears above the Bin for a few
 * seconds. What must hold:
 *
 *   1. A successful bin shows it, docked directly above the Bin button (it is
 *      the way back to the thing the tab just flew into).
 *   2. Clicking it restores THAT conversation and retires the offer.
 *   3. It retires on its own when the timeout fires — the Bin below it remains
 *      the unhurried way back, so a stale offer is worse than none.
 *   4. A second bin retargets the one button rather than stacking, so Undo can
 *      only ever reverse the bin the user just did, and replays its entrance so
 *      the second bin doesn't look like nothing happened.
 *
 * The session is a stub: this pins the bar's own behaviour (guard → bin →
 * offer → restore), not the server round-trip, which `integration-tests/
 * bin-guard-tests.js` covers against the real session.
 * @module unit-tests/bin-undo-toast-test
 */

import { assert } from '../utilities/test-helpers.js';
import '../../js/components/conversation-bar.js';

/**
 * Minimal stand-in for the session surface `render()` and `_binConversation`
 * touch. Conversations are bare `{id, name}` records — no `llmState`, so the
 * bar's busy-guard reads them as idle and every bin is allowed.
 * @returns {any} Stub session with call logs on `.binned` / `.restored`.
 */
function createStubSession() {
  const session = {
    conversations: new Map([
      ['conv_doomed', { id: 'conv_doomed', name: 'Doomed conversation' }],
      ['conv_next', { id: 'conv_next', name: 'Next one' }]
    ]),
    bin: {
      count: 0,
      sizeBytes: 0,
      /**
       * @param {string} id - Conversation to restore
       * @returns {Promise<void>} Resolves once logged
       */
      async restore(id) {
        session.restored.push(id);
      }
    },
    visibleConversationId: null,
    /** @type {string[]} */ binned: [],
    /** @type {string[]} */ restored: [],
    /**
     * @param {string} id - Conversation to bin
     * @returns {Promise<boolean>} Always true — the stub never fails
     */
    async binConversation(id) {
      session.binned.push(id);
      session.conversations.delete(id);
      session.bin.count += 1;
      return true;
    }
  };
  return session;
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const container = document.createElement('div');
  container.id = 'bin-undo-toast-mount';
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:300px;height:600px;';
  // conversation-bar's keyboard setup looks up <conversation-tabs-container/>
  // via document.querySelector, so it must exist somewhere in the document.
  container.appendChild(document.createElement('conversation-tabs-container'));
  const bar = /** @type {any} */ (document.createElement('conversation-bar'));
  container.appendChild(bar);
  document.body.appendChild(container);

  // The bar's own timer would retire the toast 5s in — far beyond the
  // assertions below — so hold its callback instead of scheduling it, and fire
  // it by hand where the timeout is the behaviour under test. Restored below.
  const realSetTimeout = window.setTimeout;
  /** @type {(() => void)|null} */
  let pendingTimeout = null;
  /** @type {number|null} */
  let pendingDelay = null;
  /** @type {any} */ (window).setTimeout = (/** @type {any} */ fn, /** @type {any} */ ms) => {
    if (ms === 5000) {
      pendingTimeout = fn;
      pendingDelay = ms;
      return 999999;
    }
    return realSetTimeout(fn, ms);
  };

  try {
    // setSession() would spin up per-conversation <conversation-tab> elements
    // and their workers; the toast needs none of that, so the session is
    // attached directly (as test-harness.binConversationViaBar does) and the
    // bar re-rendered against it.
    bar._session = createStubSession();
    bar.render();

    const session = bar._session;
    const footer = bar.querySelector('nav.conversation-bar > .conversation-bar-footer');
    const undoBtn = /** @type {HTMLButtonElement|null} */ (bar.querySelector('.conversation-bin-undo'));
    assert(!!undoBtn, 'no bin Undo button in the rendered bar');
    assert(undoBtn?.tagName === 'BUTTON', 'the Undo offer is not itself a button');
    assert(!!footer && undoBtn?.parentElement === footer, 'the Undo is not docked in the bar\'s footer');
    assert(undoBtn?.hidden === true, 'the Undo is showing before anything was binned');

    // --- 1: a bin shows it, directly above the Bin --------------------------
    await bar._binConversation('conv_doomed');
    assert(session.binned.length === 1 && session.binned[0] === 'conv_doomed',
      `expected conv_doomed to be binned, got ${JSON.stringify(session.binned)}`);
    assert(undoBtn?.hidden === false, 'the Undo stayed hidden after a bin');
    assert((undoBtn?.textContent || '').trim() === 'Restore from Bin',
      `the Undo should say "Restore from Bin", got "${(undoBtn?.textContent || '').trim()}"`);

    const binBtn = bar.querySelector('.conversation-bin-button');
    assert(!!binBtn && undoBtn?.nextElementSibling === binBtn,
      'the Undo is not docked directly above the Bin button');
    assert(pendingDelay === 5000, `expected a 5s retire timer, got ${pendingDelay}`);

    // The button is only useful if it's noticed in the few seconds it exists,
    // so the attention-getting flash is behaviour, not decoration. (The rise is
    // dropped under prefers-reduced-motion; the flash is there either way.)
    const animation = undoBtn ? getComputedStyle(undoBtn).animationName : '';
    assert(animation.includes('bin-undo-flash'),
      `the Undo doesn't flash on arrival: animation-name is "${animation}"`);
    passed++;

    // --- 2: clicking it restores that conversation and retires it -----------
    undoBtn?.click();
    await Promise.resolve();
    assert(session.restored.length === 1 && session.restored[0] === 'conv_doomed',
      `Undo restored the wrong thing: ${JSON.stringify(session.restored)}`);
    assert(undoBtn?.hidden === true, 'the Undo survived its own click');
    passed++;

    // --- 3: it retires on its own when the timeout fires --------------------
    pendingTimeout = null;
    await bar._binConversation('conv_next');
    assert(undoBtn?.hidden === false, 'the second bin did not show the Undo');
    assert(!!pendingTimeout, 'no retire timer was armed for the second bin');
    pendingTimeout?.();
    assert(undoBtn?.hidden === true, 'the Undo outlived its timeout');
    // A retired Undo must not stay live: clicking now (the element is hidden,
    // not gone) can't quietly restore something.
    undoBtn?.click();
    await Promise.resolve();
    assert(session.restored.length === 1,
      `a retired Undo still restored something: ${JSON.stringify(session.restored)}`);
    passed++;

    // --- 4: a second bin retargets the single button, entrance replayed -----
    session.conversations.set('conv_a', { id: 'conv_a', name: 'First' });
    session.conversations.set('conv_b', { id: 'conv_b', name: 'Second' });
    await bar._binConversation('conv_a');
    // Mark the live element so a replay that recreated it would be caught.
    const marked = undoBtn;
    await bar._binConversation('conv_b');
    assert(bar.querySelectorAll('.conversation-bin-undo').length === 1,
      'binning twice stacked a second Undo');
    assert(bar.querySelector('.conversation-bin-undo') === marked,
      'the retarget replaced the Undo element instead of reusing it');
    marked?.click();
    await Promise.resolve();
    assert(session.restored[session.restored.length - 1] === 'conv_b',
      `Undo reversed the wrong bin: ${JSON.stringify(session.restored)}`);
    passed++;

    // --- 5: the tab flies to the Bin looking like the tab it was ------------
    // It leaves the strip's layout so the tabs below close up under it, but it
    // must not leave the bar: every rule that draws a tab is the bar's, and a
    // tab out from under them is a tangle of every status glyph it carries at
    // whatever size an unstyled SVG takes.
    session.conversations.set('conv_fly', { id: 'conv_fly', name: 'Flying' });
    bar.render();
    const flying = /** @type {HTMLElement} */ (
      bar.querySelector('li.conversation-tab[data-conversation-id="conv_fly"]'));
    assert(!!flying, 'no tab to fly');
    const resting = flying.getBoundingClientRect();
    bar._flyTabToBin('conv_fly');
    try {
      const launched = flying.getBoundingClientRect();
      assert(Math.abs(launched.height - resting.height) < 1,
        `the tab changed shape as it took off: ${resting.height}px tall in the strip, ${launched.height}px in flight`);
      assert(Math.abs(launched.left - resting.left) < 1 && Math.abs(launched.top - resting.top) < 1,
        `the tab took off from somewhere else: (${resting.left}, ${resting.top}) in the strip, `
        + `(${launched.left}, ${launched.top}) in flight`);
      const glyphs = Array.from(flying.querySelectorAll('.conversation-tab-glyph'))
        .filter((g) => getComputedStyle(g).display !== 'none');
      assert(glyphs.length === 1, `the flying tab shows ${glyphs.length} status glyphs, not one`);
    } finally {
      for (const a of flying.getAnimations()) a.cancel();
    }
    passed++;
  } catch (e) {
    failed++;
    errors.push(`bin-undo-toast: ${/** @type {any} */ (e)?.message || e}`);
  } finally {
    /** @type {any} */ (window).setTimeout = realSetTimeout;
    container.remove();
  }

  return { passed, failed, errors };
}
