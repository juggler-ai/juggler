//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Updates tab — settings UI tests.
 *
 * The Updates tab reads the persisted update mode from GET /api/settings and
 * reflects it on a 3-way radio, PUTs the new mode on change, and runs a manual
 * check via POST /api/update-status/check. These cases drive the component
 * against a stubbed backend (no real server) to pin: the radio reflects the
 * loaded mode, changing it PUTs the new value, and the manual button hits the
 * check endpoint and surfaces the result.
 *
 * Also pinned here: a mode chosen in another window arrives on a settings-changed
 * broadcast and moves these radios — one machine runs a server per open project
 * and they all share settings.json — but never while the user is inside the radio
 * group, where it would move the selection under them mid-choice.
 * @module unit-tests/updates-settings-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import wsService from '../../js/services/websocket.js';
import { __resetPrefsForTests } from '../../js/services/prefs.js';
import { fetchJson } from '../../js/services/http.js';
import { apiUrl } from '../../js/utils/api-url.js';
import {
  setLocale, registerCatalog, unregisterCatalog, isPseudoLocalized, PSEUDO_LOCALE,
} from '../../sdk/lib/i18n.js';
import '../../js/components/settings-panel.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Route window.fetch to an in-memory settings/update backend.
 * @param {{mode?: string, status?: object}} [opts]
 * @returns {{restore: () => void, calls: Array<{method: string, url: string, body: any}>, state: {mode: string}}} A fake backend with a restore fn, recorded calls, and mutable mode state.
 */
function installFetch(opts = {}) {
  const orig = window.fetch;
  const state = { mode: opts.mode || 'automatic' };
  const status = opts.status || { currentVersion: 'v1.0.0', latestVersion: 'v1.2.0', updateAvailable: true };
  /** @type {Array<{method: string, url: string, body: any}>} */
  const calls = [];
  window.fetch = /** @type {any} */ (async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url: u, body });
    if (u === '/api/settings' && method === 'GET') {
      return { ok: true, json: async () => ({ updates: { mode: state.mode } }) };
    }
    if (u === '/api/settings' && method === 'PUT') {
      state.mode = body.updates.mode;
      return { ok: true, json: async () => ({ updates: { mode: state.mode } }) };
    }
    if (u === '/api/update-status') {
      return { ok: true, json: async () => status };
    }
    if (u === '/api/update-status/check') {
      return { ok: true, json: async () => status };
    }
    return { ok: false, json: async () => ({}) };
  });
  return { restore: () => { window.fetch = orig; }, calls, state };
}

/**
 * Wait for the tab's first load: the version line drawn from /api/update-status
 * (every status here is version 1.0.0, digits that survive the pseudo-locale)
 * and the radios showing the mode.
 * @param {any} el - The settings panel.
 * @param {string} [mode] - The radio that should be checked.
 * @returns {Promise<unknown>} Resolves once both are showing.
 */
const loaded = (el, mode = 'automatic') => waitFor(() => {
  const info = el.querySelector('#updates-version-info')?.textContent || '';
  const checked = [...el.querySelectorAll('.updates-mode-radio')].find((r) => r.checked);
  return info.includes('1.0.0') && checked?.value === mode;
}, () => `the Updates tab to load (version line ${JSON.stringify(el.querySelector('#updates-version-info')?.textContent)}, want mode ${mode})`);

/**
 * Wait for the PUT /api/settings a radio click issues.
 * @param {ReturnType<typeof installFetch>} backend - The fake backend.
 * @returns {Promise<unknown>} Resolves once it was made.
 */
const putMade = (backend) => waitFor(() => backend.calls.some((c) => c.url === '/api/settings' && c.method === 'PUT'),
  'the radio click to PUT /api/settings');

/**
 * Wait for a manual check to finish: the button is disabled for its length.
 * @param {any} el - The settings panel.
 * @returns {Promise<unknown>} Resolves once it re-enables.
 */
const checkDone = (el) => waitFor(() => !el.querySelector('#updates-check-btn').disabled
  && (el.querySelector('#updates-check-status').textContent || '') !== '', 'the manual check to finish');

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
   * Mount a settings-panel wired to a fake backend, run body, then clean up.
   * @param {{mode?: string, status?: object}} opts
   * @param {(el: any, backend: ReturnType<typeof installFetch>) => Promise<void>} body
   */
  const withPanel = async (opts, body) => {
    const backend = installFetch(opts);
    // The prefs store owns the settings document and reads it once per page —
    // already done at boot, against the real server. Forget that read so this
    // case's backend is the one the panel sees.
    __resetPrefsForTests();
    // The real server still broadcasts its own settings.json to this page, and
    // every lane on a pool server shares that file, so a write anywhere on it
    // lands here mid-case carrying the real mode. The fake backend is the server
    // for the length of the case, so its socket route is held shut too; the
    // cases that test broadcasts emit theirs straight onto the service.
    const routes = /** @type {any} */ (wsService.constructor).TYPED_MESSAGE_ROUTES;
    const serverRoute = routes['settings-changed'];
    routes['settings-changed'] = () => {};
    const el = /** @type {any} */ (document.createElement('settings-panel'));
    document.body.appendChild(el);
    try {
      await body(el, backend);
    } finally {
      el.remove();
      routes['settings-changed'] = serverRoute;
      backend.restore();
    }
  };

  /**
   * The real server's broadcast of its own settings.json, as this lane receives
   * it whenever anything on the shared test server writes that file — another
   * lane's suite, or this page's own preference writes. Its mode is the real
   * file's, not the fake backend's.
   * @returns {void}
   */
  const foreignBroadcast = () => {
    wsService._handleMessageData(JSON.stringify({ type: 'settings-changed', settings: { updates: { mode: 'automatic' } } }));
  };

  await run('radio reflects the loaded mode from /api/settings', async () => {
    await withPanel({ mode: 'off' }, async (el) => {
      el._tabs.updates.show();
      await loaded(el, 'off');
      // Delivered every run rather than left to a sibling lane's timing.
      foreignBroadcast();
      const radios = [...el.querySelectorAll('.updates-mode-radio')];
      assert(radios.length === 3, `three modes; got ${radios.length}`);
      const checked = radios.find((r) => r.checked);
      assert(checked && checked.value === 'off', `off is selected; got ${checked && checked.value}`);
    });
  });

  await run('changing the radio PUTs the new mode', async () => {
    await withPanel({ mode: 'automatic' }, async (el, backend) => {
      el._tabs.updates.show();
      await loaded(el);
      const notify = [...el.querySelectorAll('.updates-mode-radio')].find((r) => r.value === 'notify');
      assert(notify, 'notify radio present');
      notify.click();
      await putMade(backend);
      const put = backend.calls.find((c) => c.url === '/api/settings' && c.method === 'PUT');
      assert(put, 'a PUT /api/settings was issued');
      assert(put.body.updates.mode === 'notify', `PUT body mode = ${put.body.updates.mode}`);
      assert(backend.state.mode === 'notify', `backend mode persisted; got ${backend.state.mode}`);
    });
  });

  await run('manual check hits the check endpoint and surfaces the result', async () => {
    await withPanel({ status: { currentVersion: 'v1.0.0', latestVersion: 'v1.2.0', updateAvailable: true } }, async (el, backend) => {
      el._tabs.updates.show();
      await loaded(el);
      const btn = el.querySelector('#updates-check-btn');
      assert(btn, 'check button present');
      btn.click();
      await checkDone(el);
      const check = backend.calls.find((c) => c.url === '/api/update-status/check' && c.method === 'POST');
      assert(check, 'a POST /api/update-status/check was issued');
      const statusText = el.querySelector('#updates-check-status').textContent || '';
      assert(statusText.includes('v1.2.0'), `status mentions the available version; got ${JSON.stringify(statusText)}`);
    });
  });

  // A build from source is never offered updates, but the status it gets still
  // carries the (newer) latest release. Reporting that as "the latest version"
  // tells the user they are running a release they have not got.
  await run('a build from source is never called current', async () => {
    const status = {
      currentVersion: 'v1.0.0-dev', latestVersion: 'v1.2.0', updateAvailable: false, unpublished: true,
    };
    await withPanel({ status }, async (el) => {
      el._tabs.updates.show();
      await loaded(el);
      const info = el.querySelector('#updates-version-info').textContent || '';
      assert(info.includes('v1.0.0-dev'), `version line names this build; got ${JSON.stringify(info)}`);
      assert(info.includes('v1.2.0'), `version line names the latest release; got ${JSON.stringify(info)}`);
      assert(!/latest version/i.test(info), `no "latest version" claim; got ${JSON.stringify(info)}`);

      el.querySelector('#updates-check-btn').click();
      await checkDone(el);
      const checked = el.querySelector('#updates-check-status').textContent || '';
      assert(checked.includes('v1.2.0'), `manual check names the latest release; got ${JSON.stringify(checked)}`);
      assert(!/latest version/i.test(checked), `manual check makes no "latest version" claim; got ${JSON.stringify(checked)}`);
    });
  });

  // A packager's install never updates itself, so "Automatic" (which downloads)
  // is not on offer: the choice is between hearing about new versions and not.
  await run('a managed install offers notify or off, and names its package manager', async () => {
    const status = {
      currentVersion: 'v1.0.0', latestVersion: 'v1.2.0', updateAvailable: true, managedBy: 'Nix',
    };
    await withPanel({ mode: 'automatic', status }, async (el, backend) => {
      el._tabs.updates.show();
      await loaded(el, 'notify');
      foreignBroadcast();
      const visible = [...el.querySelectorAll('.updates-mode-radio')]
        .filter((r) => !r.closest('.updates-mode-row').hidden);
      assert(JSON.stringify(visible.map((r) => r.value)) === JSON.stringify(['notify', 'off']),
        `visible modes; got ${JSON.stringify(visible.map((r) => r.value))}`);
      const notify = visible[0];
      assert(notify.checked, 'a saved "automatic" shows as notify');
      const name = notify.closest('.updates-mode-row').querySelector('.provider-name').textContent;
      assert(name === 'Tell me about new versions', `notify label; got ${JSON.stringify(name)}`);
      const desc = notify.closest('.updates-mode-row').querySelector('.provider-description').textContent;
      assert(desc.includes('Nix'), `notify description names the package manager; got ${JSON.stringify(desc)}`);

      const info = el.querySelector('#updates-version-info').textContent || '';
      assert(info.includes('Version v1.2.0 is available — update it through Nix.'),
        `version line; got ${JSON.stringify(info)}`);

      visible[1].click();
      await putMade(backend);
      const put = backend.calls.find((c) => c.url === '/api/settings' && c.method === 'PUT');
      assert(put && put.body.updates.mode === 'off', `off is saved; got ${JSON.stringify(put && put.body)}`);

      el.querySelector('#updates-check-btn').click();
      await checkDone(el);
      const checked = el.querySelector('#updates-check-status').textContent || '';
      assert(checked === 'Version v1.2.0 is available — update it through Nix.',
        `manual check result; got ${JSON.stringify(checked)}`);
    });
  });

  /**
   * A settings document as the server broadcasts it.
   * @param {string} mode
   * @returns {void}
   */
  const broadcastMode = (mode) => {
    wsService._emit('settings-changed', { updates: { mode } });
  };

  await run('a mode set in another window reaches the radios', async () => {
    await withPanel({ mode: 'automatic' }, async (el, backend) => {
      el.switchTab('updates');
      await loaded(el);
      const before = backend.calls.filter((c) => c.url === '/api/settings' && c.method === 'GET').length;

      broadcastMode('off');

      const checked = [...el.querySelectorAll('.updates-mode-radio')].find((r) => r.checked);
      assert(checked && checked.value === 'off', `off is selected; got ${checked && checked.value}`);
      // The document rides the broadcast, so converging costs no request.
      const after = backend.calls.filter((c) => c.url === '/api/settings' && c.method === 'GET').length;
      assert(after === before, `no refetch was needed; ${after - before} GET(s) were made`);
    });
  });

  await run('a broadcast leaves the radio group the user is inside alone', async () => {
    await withPanel({ mode: 'automatic' }, async (el) => {
      // A radio in a hidden panel cannot take focus, and the panel is
      // display:none until it is opened — so this case needs it on screen.
      // open() is not used for it: that also loads the shared config, which this
      // fake backend does not serve, and a failed load raises a modal.
      el.classList.add('show', 'loaded');
      el.switchTab('updates');
      await loaded(el);
      const radios = [...el.querySelectorAll('.updates-mode-radio')];
      const notify = radios.find((r) => r.value === 'notify');
      assert(notify, 'notify radio present');
      notify.focus();
      assert(document.activeElement === notify, 'the radio took focus (the case needs it to)');

      broadcastMode('off');

      const checked = radios.find((r) => r.checked);
      assert(checked && checked.value === 'automatic',
        `the selection under the user is untouched; got ${checked && checked.value}`);
    });
  });

  // Every word the tab itself shows comes out accented under the pseudo-locale.
  // Versions are digits only here, because a "v" from the data would read as
  // unconverted English. The panel shell around #updates-form is not walked.
  await run('under en-XA every string the tab shows is pseudo-localised', async () => {
    const body = await fetchJson(apiUrl(`/i18n/catalog?locale=${PSEUDO_LOCALE}`));
    assert(body && Object.keys(body.messages || {}).length > 0, 'the en-XA catalogue is empty');
    registerCatalog('updates-settings-test', PSEUDO_LOCALE, body.messages);
    const previous = setLocale(PSEUDO_LOCALE);
    try {
      // Once as a self-updating build, once as a managed one (whose package
      // manager's name is data, so digits stand in for it).
      for (const status of [
        { currentVersion: '1.0.0', latestVersion: '1.2.0', updateAvailable: true },
        { currentVersion: '1.0.0', latestVersion: '1.2.0', updateAvailable: true, managedBy: '42' },
      ]) await withPanel({ status }, async (el) => {
        el._tabs.updates.show();
        // A managed install shows the saved "automatic" as notify.
        await loaded(el, status.managedBy ? 'notify' : 'automatic');
        el.querySelector('#updates-check-btn').click();
        await checkDone(el);
        const form = el.querySelector('#updates-form');
        /** @type {string[]} */
        const shown = [];
        const walker = document.createTreeWalker(form, NodeFilter.SHOW_TEXT);
        for (let n = walker.nextNode(); n; n = walker.nextNode()) {
          const text = (n.textContent || '').trim();
          if (text) shown.push(text);
        }
        for (const node of form.querySelectorAll('[aria-label], [title], [placeholder]')) {
          for (const attr of ['aria-label', 'title', 'placeholder']) {
            const v = node.getAttribute(attr);
            if (v) shown.push(v);
          }
        }
        assert(shown.length >= 10, `expected the tab's text, found ${shown.length} strings`);
        const raw = shown.filter((s) => !isPseudoLocalized(s));
        assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      });
    } finally {
      setLocale(previous);
      unregisterCatalog('updates-settings-test');
    }
  });

  return { passed, failed, errors };
}
