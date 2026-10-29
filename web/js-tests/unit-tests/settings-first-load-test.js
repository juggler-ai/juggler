//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Settings panel first-load gating.
 *
 * /api/providers serves a cache the server fills asynchronously after it starts
 * listening, so for the first moment of a launch it answers 200 with an empty
 * list and `ready: false`. Opening Settings in that window used to render the
 * empty list and then latch `_hasLoadedOnce`, leaving the Provider API Keys page
 * blank for as long as the window stayed open. These tests pin both halves: the
 * unsettled snapshot must not be rendered, and a failed load must not latch.
 *
 * It also pins where the global settings document comes from: one fetch for the
 * panel, dispatched to every tab, rather than one fetch per tab reading its own
 * section out of the same bytes.
 * @module unit-tests/settings-first-load-test
 */

import { assert, nextTask } from '../utilities/test-helpers.js';
import wsService from '../../js/services/websocket.js';
import { __resetPrefsForTests, getGlobalSettings } from '../../js/services/prefs.js';
import providersCache from '../../js/services/providers-cache.js';
import { holdBroadcasts } from '../utilities/hold-broadcasts.js';
import '../../js/components/settings-panel.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/** A keyless provider — the simplest field the providers tab can build. */
const FAKE_PROVIDER = {
  name: 'fake-provider',
  displayName: 'Fake Provider',
  description: 'Stands in for a real provider entry.',
  authType: 'none',
  configKeyName: '',
  envVarName: '',
  apiKeyURL: '',
  keySource: '',
  available: true,
  modelsWithContext: [{ id: 'fake-model', contextWindow: 1000, maxOutputTokens: 100, fromAPI: false }],
};

/**
 * Install a fake backend for the five endpoints loadConfig() fans out over. The
 * returned `state` is live, so a test can heal a failing backend and reopen the
 * same panel.
 * @param {{providersPayload?: any, configOk?: boolean}} [opts]
 * @returns {{restore: () => void, calls: string[], state: {providersPayload: any, configOk: boolean}}} Handle for cleanup/inspection.
 */
function installFetch(opts = {}) {
  const state = {
    providersPayload: opts.providersPayload || { providers: [], ready: false },
    configOk: opts.configOk !== false,
  };
  const orig = window.fetch;
  /** @type {string[]} */
  const calls = [];
  window.fetch = /** @type {any} */ (async (url) => {
    const u = String(url);
    calls.push(u);
    const ok = (/** @type {any} */ body) => ({ ok: true, status: 200, json: async () => body });
    if (u === '/api/config') {
      return state.configOk
        ? ok({ configDir: '/tmp/juggler-test' })
        : { ok: false, status: 500, statusText: 'Internal Server Error', text: async () => '', json: async () => ({}) };
    }
    if (u === '/api/providers') return ok(state.providersPayload);
    if (u === '/api/default-model') return ok({ provider: 'fake-provider', model: 'fake-model' });
    if (u === '/api/cheap-model') return ok({ provider: 'fake-provider', model: 'fake-model' });
    if (u === '/api/connectivity') {
      return ok({
        lanEnabled: false, lanURLs: [], tunnelEnabled: false,
        tunnelURL: '', tunnelMode: '', tunnelRelay: false, wanModes: [],
      });
    }
    // The global settings document, with a distinguishable value in each of the
    // sections a different tab reads.
    if (u === '/api/settings') {
      return ok({
        updates: { mode: 'notify' },
        network: { proxy: { mode: 'none' } },
        connectivity: { lanOnLaunch: true, wanOnLaunch: '' },
        models: {},
      });
    }
    return { ok: false, status: 404, statusText: 'Not Found', text: async () => '', json: async () => ({}) };
  });
  return { restore: () => { window.fetch = orig; }, calls, state };
}

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Aggregated test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => Promise<void>} fn
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

  /**
   * Mount a settings-panel against a fake backend, run body, then clean up.
   * @param {{providersPayload?: any, configOk?: boolean}} opts
   * @param {(el: any, backend: ReturnType<typeof installFetch>) => Promise<void>} body
   */
  const withPanel = async (opts, body) => {
    const backend = installFetch(opts);
    const priorShowModal = /** @type {any} */ (window).showModal;
    // A failed load alerts; keep it from blocking on a real dialog. Every
    // dialog helper presents through window.showModal, so standing in for it
    // intercepts the alert whether the caller imported showAlert or not.
    /** @type {any} */ (window).showModal = async () => {};
    const el = /** @type {any} */ (document.createElement('settings-panel'));
    document.body.appendChild(el);
    try {
      await body(el, backend);
    } finally {
      el.close();
      el.remove();
      /** @type {any} */ (window).showModal = priorShowModal;
      backend.restore();
    }
  };

  // The settled list arrives over the WebSocket; seed the cache the same way the
  // server's post-refresh broadcast does, so waitForReady() resolves.
  const seedSettledProviders = () => {
    wsService._emit('providers-update', [FAKE_PROVIDER]);
    wsService._emit('providers-ready', true);
  };

  await run('an unsettled empty provider snapshot renders the settled list, not a blank page', async () => {
    seedSettledProviders();
    assert(providersCache.hasReceived(), 'the settled push seeded the providers cache');

    await withPanel({ providersPayload: { providers: [], ready: false } }, async (el) => {
      await el.open();

      const fields = el.querySelectorAll('#provider-fields-container .provider-field');
      assert(fields.length === 1, `one provider field rendered; got ${fields.length}`);
      assert(el._tabs.providers.providers.length === 1,
        `the tab received the settled list; got ${el._tabs.providers.providers.length} providers`);
      assert(el._hasLoadedOnce === true, 'a successful load latches the first-load flag');
    });
  });

  await run('a settled snapshot from REST is used as-is', async () => {
    await withPanel({ providersPayload: { providers: [FAKE_PROVIDER], ready: true } }, async (el) => {
      await el.open();
      const fields = el.querySelectorAll('#provider-fields-container .provider-field');
      assert(fields.length === 1, `one provider field rendered; got ${fields.length}`);
    });
  });

  await run('a failed first load is not latched, so reopening the same panel retries', async () => {
    await withPanel({ configOk: false }, async (el, backend) => {
      await el.open();
      assert(el._hasLoadedOnce === false,
        'a failed load must leave the first-load flag clear so the next open retries');
      const fields = el.querySelectorAll('#provider-fields-container .provider-field');
      assert(fields.length === 0, `a failed load renders no fields; got ${fields.length}`);

      // Heal the backend and reopen the SAME panel: the retry must actually
      // re-fetch and render, rather than being skipped by a latched flag.
      el.close();
      backend.state.configOk = true;
      backend.state.providersPayload = { providers: [FAKE_PROVIDER], ready: true };
      await el.open();

      assert(el._hasLoadedOnce === true, 'the retry latched after a successful load');
      const retried = el.querySelectorAll('#provider-fields-container .provider-field');
      assert(retried.length === 1, `the retry rendered the provider field; got ${retried.length}`);
    });
  });

  // The settings document is one document, and every tab reads a different
  // section of it. Fetched per tab, opening Settings asked for the same bytes
  // three times and each tab held its own copy — so a tab was stale between the
  // moments it happened to be shown, and every new tab quietly added a fourth
  // request. One read, owned by the prefs store and dispatched to every tab, is
  // also what the settings-changed broadcast arrives through, so there is one path
  // into the panel rather than two.
  await run('the settings document is read once, for the prefs store and every tab', async () => {
    seedSettledProviders();
    // The prefs store memoises its read for the life of the page, so an earlier
    // case here would otherwise have paid for it and this one would count none.
    __resetPrefsForTests();
    // What is counted is what opening the panel costs. This lane's socket
    // reconnecting re-reads the document (prefs.js, rightly: nothing could be
    // delivered while it was down) — and that, mid-case, was this case's second
    // GET on a quiet machine. A sibling lane saving a setting broadcasts one
    // too. Both are held, and played here on every run, so the count is the
    // panel's alone (holdBroadcasts).
    const hold = holdBroadcasts(['settings-changed', 'open']);
    try {
      await withPanel({ providersPayload: { providers: [FAKE_PROVIDER], ready: true } }, async (el, backend) => {
        await el.open();
        hold.simulate('settings-changed', {
          updates: { mode: 'notify' },
          network: { proxy: { mode: 'none' } },
          connectivity: { lanOnLaunch: true, wanOnLaunch: '' },
          models: {},
          ui: { 'a-sibling-lane-pref': 1 },
        });
        hold.simulate('open', new Event('open'));
        // Visiting a tab must not re-fetch: every tab is live from construction
        // and was handed the document already.
        el.switchTab('updates');
        el.switchTab('connectivity');
        // A re-fetch is what must NOT happen, so there is no event to wait for:
        // four task hops carry a tab's fetch → json chain, had either visit started one.
        for (let i = 0; i < 4; i++) await nextTask();

        const gets = backend.calls.filter((u) => u === '/api/settings');
        assert(gets.length === 1, `exactly one GET /api/settings; got ${gets.length} (${hold.describe()})`);

        // Localise a failure: did the store read the document, or did the panel fail
        // to receive what it read?
        const doc = await getGlobalSettings();
        assert(doc && doc.updates && doc.updates.mode === 'notify',
          `the store holds the document; got ${JSON.stringify(doc)}`);

        // The one fetch still reached every section that reads it.
        const mode = [...el.querySelectorAll('.updates-mode-radio')].find((r) => r.checked);
        assert(mode && mode.value === 'notify', `Updates read its section; got ${mode && mode.value}`);
        const proxy = el.querySelector('#proxy-mode');
        assert(proxy && proxy.value === 'none', `the proxy box read its section; got ${proxy && proxy.value}`);
        const lan = el.querySelector('.connectivity-launch-checkbox[data-launch="lan"]');
        assert(lan && lan.checked === true, 'Connectivity read its section');
      });
    } finally {
      // After the backend stub is gone, so a real event held meanwhile talks to
      // the real server, as it would have.
      hold.release();
    }
  });

  return { passed, failed, errors };
}
