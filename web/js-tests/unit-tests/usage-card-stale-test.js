//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The Usage card when its numbers could not be refreshed.
 *
 * The usage cache keeps the last good snapshot when a later fetch fails, so the
 * card goes on showing meters. Those meters are no longer current, and the card
 * must say so rather than present them as live — a quota reset upstream is
 * otherwise invisible for as long as the fetches keep failing.
 *
 * The cache is primed directly (a good fetch, then a failed one) against a
 * stubbed `window.fetch`, restored in a finally. It is a module singleton with
 * real-time debouncing, so the provider name is unique to this file.
 * @module unit-tests/usage-card-stale-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import UsageCard from '../../extensions/juggler-core/cards/usage-card.js';
import usageStatsCache from '../../js/services/usage-stats-cache.js';
import { underPseudoLocale } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * Answer every fetch with `body`, restoring `window.fetch` afterwards.
 * @param {any} body - The JSON the stub server returns.
 * @param {() => Promise<void>} fn - Work to run while stubbed.
 * @returns {Promise<void>}
 */
async function withFetch(body, fn) {
  const orig = window.fetch;
  window.fetch = /** @type {any} */ (async () => ({ ok: true, json: async () => body }));
  try {
    await fn();
  } finally {
    window.fetch = orig;
  }
}

/**
 * A stub session showing one conversation on `provider`.
 * @param {string} provider - The visible conversation's provider.
 * @returns {any} A session exposing only what the card reads.
 */
function stubSession(provider) {
  const conversation = { modelConfig: { provider, model: 'stub-model' } };
  return {
    conversations: new Map([['visible', conversation]]),
    loadedConversationId: 'visible',
    getVisibleConversation: () => conversation,
    getServices: () => ({ llmState: { isActive: false } }),
    subscribe: () => () => {},
    onLLMStatusChange: () => () => {},
  };
}

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Aggregated results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await run('meters kept after a failed refresh are marked as not current', async () => {
    const p = 'ucs-stale';
    const good = {
      usage: [{
        provider: p,
        updatedAt: new Date().toISOString(),
        stats: [{ name: 'Session (5h)', usedPercent: 100, category: 'primary' }],
      }],
      errors: {},
    };
    const bad = { usage: [], errors: { [p]: 'usage endpoint returned 403' } };
    await withFetch(good, () => usageStatsCache.refresh(p, { force: true }).then(() => {}));
    await withFetch(bad, () => usageStatsCache.refresh(p, { force: true }).then(() => {}));

    await underPseudoLocale('usage-card-stale-test', async () => {
      const host = document.createElement('div');
      host.style.cssText = 'position:absolute;left:-9999px;top:0;width:240px;';
      document.body.appendChild(host);
      // The card's own refresh is held by the cache's retry gap, so whatever it
      // shows comes from the primed cache; the stub only guards against leaks.
      let dispose = () => {};
      await withFetch(bad, async () => {
        dispose = new UsageCard().mount(host, stubSession(p));
        try {
          await waitFor(() => host.innerHTML.includes('usage-stat'), { timeoutMs: 2000, description: 'the meter' });
        } catch { /* the assertions say what happened instead */ }
      });
      try {
        assert(host.innerHTML.includes('usage-stat'), 'the retained meter must still be shown');
        const note = host.querySelector('.usage-card__stale');
        assert(!!note, `a failed refresh behind retained meters must be marked, got ${host.innerHTML.replace(/\s+/g, ' ')}`);
        assert(isPseudoLocalized(note?.textContent || ''), `the mark must be in the UI language, got ${JSON.stringify(note?.textContent)}`);
        assert((note?.getAttribute('title') || '').includes('403'), 'the full error must be available as a tooltip');
      } finally {
        dispose();
        host.remove();
      }
    }, { '@juggler/core': ['Couldn’t refresh — showing earlier figures'] });
  });

  return { passed, failed, errors };
}
