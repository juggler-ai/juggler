//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Which provider the Usage card shows.
 *
 * The card lives in the sidebar chrome, not in a conversation panel, so it stays
 * mounted while a workspace panel is on screen — and a workspace selection has no
 * visible conversation to name a provider. Reading only the visible conversation
 * left the card sitting on "No usage data" for as long as a workspace tab was
 * selected, having issued no fetch at all. These tests pin the resolution order:
 * the visible conversation, else the one behind the panel, else the provider a new
 * conversation would be seeded with.
 *
 * Driven through `mount()` against a stub session and a stubbed `window.fetch`
 * (restored in a finally, per the usage-stats-cache convention). The usage cache
 * is a module singleton with real-time debouncing, so every test uses provider
 * names of its own to stay order-independent.
 * @module unit-tests/usage-card-provider-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import UsageCard from '../../extensions/juggler-core/cards/usage-card.js';
import defaultModelCache from '../../js/services/default-model-cache.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * Stub `window.fetch`, recording every URL. Usage requests answer with one meter
 * for whichever provider was asked for; `/api/default-model` answers with
 * `defaultProvider` (or a cleared default when it is '').
 * @param {string} defaultProvider - The provider /api/default-model reports.
 * @returns {{urls: string[], restore: () => void}} Recorded URLs and a restore
 *   function (call in a finally).
 */
function stubFetch(defaultProvider) {
  const orig = window.fetch;
  /** @type {string[]} */
  const urls = [];
  window.fetch = /** @type {any} */ (async (/** @type {any} input */ input) => {
    const url = String(input);
    urls.push(url);
    if (url.startsWith('/api/default-model')) {
      return { ok: true, json: async () => ({ provider: defaultProvider, model: 'stub-model', explicit: true }) };
    }
    const provider = new URL(url, 'http://localhost').searchParams.get('provider') || '';
    return {
      ok: true,
      json: async () => ({
        usage: [{
          provider,
          plan: 'pro',
          updatedAt: new Date().toISOString(),
          stats: [{ name: 'Session (5h)', usedPercent: 42, category: 'primary' }],
        }],
        errors: {},
      }),
    };
  });
  return { urls, restore: () => { window.fetch = orig; } };
}

/**
 * A stub session in one of the two states the card has to cope with: a
 * conversation on screen, or a workspace panel with a conversation behind it.
 * @param {{visible?: string, behind?: string}} providers - Provider of the
 *   visible conversation, and of the conversation behind the panel.
 * @returns {any} A session exposing only what the card reads.
 */
function stubSession({ visible = '', behind = '' } = {}) {
  const conversation = (/** @type {string} */ provider) => ({ modelConfig: { provider, model: 'stub-model' } });
  const conversations = new Map();
  if (behind) conversations.set('behind', conversation(behind));
  if (visible) conversations.set('visible', conversation(visible));
  return {
    conversations,
    loadedConversationId: visible ? 'visible' : (behind ? 'behind' : null),
    getVisibleConversation: () => (visible ? conversations.get('visible') : null),
    getServices: () => ({ llmState: { isActive: false } }),
    subscribe: () => () => {},
    onLLMStatusChange: () => () => {},
  };
}

/**
 * Mount the card off-screen and wait for `until` to hold.
 *
 * A timed-out wait is not thrown: the caller's assertions then report what was
 * fetched and rendered, which is a sharper message than "condition not met".
 * @param {any} session - The stub session.
 * @param {string} defaultProvider - The provider /api/default-model reports.
 * @param {(state: {urls: string[], html: string}) => boolean} until - What to wait for.
 * @returns {Promise<{urls: string[], html: () => string, usageURLs: () => string[], teardown: () => void}>} The mounted card.
 */
async function mountCard(session, defaultProvider, until) {
  // The default-model cache is a module singleton with its own debounce, so each
  // test starts it empty rather than inheriting the previous test's answer.
  defaultModelCache.invalidate();
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:0;width:240px;';
  document.body.appendChild(host);
  const stub = stubFetch(defaultProvider);
  const dispose = new UsageCard().mount(host, session);
  try {
    await waitFor(() => until({ urls: stub.urls, html: host.innerHTML }),
      { timeoutMs: 2000, description: 'the card to settle' });
  } catch { /* the assertions say what happened instead */ }
  return {
    urls: stub.urls,
    usageURLs: () => stub.urls.filter(url => url.startsWith('/api/providers/usage')),
    html: () => host.innerHTML,
    teardown: () => { dispose(); stub.restore(); host.remove(); },
  };
}

/**
 * A rendered meter — the card's end state once a provider resolved and answered.
 * @param {{html: string}} state - The card's recorded fetches and current HTML.
 * @returns {boolean} True once a meter is on screen.
 */
function meterShown(state) {
  return state.html.includes('usage-stat');
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

  await run('the visible conversation names the provider', async () => {
    const card = await mountCard(stubSession({ visible: 'ucp-visible' }), '', meterShown);
    try {
      assert(card.usageURLs().some(url => url.includes('provider=ucp-visible')),
        `usage must be fetched for the visible conversation's provider, got ${JSON.stringify(card.usageURLs())}`);
      assert(!card.urls.some(url => url.startsWith('/api/default-model')),
        'a conversation on screen must not provoke a default-model lookup');
      assert(card.html().includes('usage-stat'), 'the meter must be rendered');
    } finally {
      card.teardown();
    }
  });

  await run('a workspace panel falls back to the conversation behind it', async () => {
    const card = await mountCard(stubSession({ behind: 'ucp-behind' }), 'ucp-unused-default', meterShown);
    try {
      assert(card.usageURLs().some(url => url.includes('provider=ucp-behind')),
        `usage must be fetched for the conversation behind the panel, got ${JSON.stringify(card.usageURLs())}`);
      assert(!card.urls.some(url => url.startsWith('/api/default-model')),
        'a conversation behind the panel answers it — no default-model lookup needed');
      assert(card.html().includes('usage-stat'), 'the meter must be rendered, not "No usage data"');
    } finally {
      card.teardown();
    }
  });

  await run('with no conversation at all it falls back to the default provider', async () => {
    const card = await mountCard(stubSession(), 'ucp-default', meterShown);
    try {
      assert(card.urls.some(url => url.startsWith('/api/default-model')),
        'the default model must be asked for when nothing on screen names a provider');
      assert(card.usageURLs().some(url => url.includes('provider=ucp-default')),
        `usage must be fetched for the default provider, got ${JSON.stringify(card.usageURLs())}`);
      assert(card.html().includes('usage-stat'), 'the meter must be rendered');
    } finally {
      card.teardown();
    }
  });

  await run('no provider anywhere leaves the card empty without fetching usage', async () => {
    const card = await mountCard(stubSession(), '',
      (state) => state.urls.some(url => url.startsWith('/api/default-model')));
    try {
      // The lookup came back with nothing. The card draws its empty state once it
      // has decided there is no provider, which is after any usage fetch it
      // would have started.
      await waitFor(() => card.html().includes('No usage data'), 'the card to draw its empty state');
      assert(card.usageURLs().length === 0,
        `nothing to show must fetch no usage, got ${JSON.stringify(card.usageURLs())}`);
      assert(card.html().includes('No usage data'), 'the card must report its own empty state');
    } finally {
      card.teardown();
    }
  });

  return { passed, failed, errors };
}
