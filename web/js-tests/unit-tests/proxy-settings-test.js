//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Outbound-proxy box — settings UI tests.
 *
 * The proxy box lives at the bottom of the Connectivity tab. It reads the
 * persisted proxy config from GET /api/settings (network.proxy), reflects the
 * mode on a 3-way <select>, reveals the URL field only for Manual, and PUTs
 * changes. These cases drive the component against a stubbed backend to pin: the
 * select reflects the loaded mode, switching to a plain mode PUTs it, Manual
 * persists only once a valid URL is committed, and an invalid URL surfaces an
 * error without a PUT.
 *
 * Also pinned here: a proxy set in another window arrives on a settings-changed
 * broadcast and lands on these controls, but never over a URL the user is part-way
 * through typing — the field commits on blur, so an uncommitted value is still
 * theirs.
 *
 * The real server's own settings-changed broadcasts are held off every case: the
 * fake backend is the server here, and a sibling lane's write to the shared
 * settings.json would otherwise put the real proxy on the controls mid-case.
 * @module unit-tests/proxy-settings-test
 */

import { assert } from '../utilities/test-helpers.js';
import { isolateFocus } from '../utilities/isolate-focus.js';
import wsService from '../../js/services/websocket.js';
import { __resetPrefsForTests } from '../../js/services/prefs.js';
import '../../js/components/settings-panel.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Route window.fetch to an in-memory proxy-settings backend.
 * @param {{mode?: string, url?: string}} [opts]
 * @returns {{restore: () => void, calls: Array<{method: string, url: string, body: any}>, state: {mode: string, url: string}}} Fake backend with restore, recorded calls, and mutable proxy state.
 */
function installFetch(opts = {}) {
  const orig = window.fetch;
  const state = { mode: opts.mode || 'system', url: opts.url || '' };
  /** @type {Array<{method: string, url: string, body: any}>} */
  const calls = [];
  window.fetch = /** @type {any} */ (async (url, init) => {
    const u = String(url);
    const method = (init && init.method) || 'GET';
    const body = init && init.body ? JSON.parse(init.body) : null;
    calls.push({ method, url: u, body });
    if (u === '/api/settings' && method === 'GET') {
      return { ok: true, json: async () => ({ network: { proxy: { mode: state.mode, url: state.url } } }) };
    }
    if (u === '/api/settings' && method === 'PUT') {
      const p = body.network.proxy;
      // Mirror the server's manual-URL validation: reject a manual mode without
      // a usable URL with a 400 rather than persisting it.
      if (p.mode === 'manual') {
        try {
          if (!new URL((p.url || '').trim()).hostname) throw new Error('bad');
        } catch {
          return { ok: false, status: 400, json: async () => ({ error: 'invalid proxy URL' }) };
        }
      }
      state.mode = p.mode;
      state.url = p.url || '';
      return { ok: true, json: async () => ({ network: { proxy: { mode: state.mode, url: state.url } } }) };
    }
    return { ok: false, json: async () => ({}) };
  });
  return { restore: () => { window.fetch = orig; }, calls, state };
}

/**
 * Let non-awaitable async chains (fetch → json) settle.
 *
 * Yields via MessageChannel rather than `setTimeout(0)`. Measured in the test
 * pool's offscreen WebView, once a settings-panel is mounted each
 * `setTimeout(0)` here took ~1000ms while a MessageChannel message took ~1ms —
 * the difference between this suite running in 0.2s and 38s, long enough to
 * hold a pool lane and starve its siblings. A MessageChannel message is still a
 * macrotask, so promise chains and rendering proceed between yields, which is
 * the point of yielding at all.
 *
 * The ~1000ms is specific to this state, not a blanket property of timers here:
 * probed in an idle lane in the same window, `setTimeout` is accurate
 * (0ms→1ms, 10ms→10ms, 100ms→100ms). What pins timer callbacks behind a full
 * second once the panel is up has not been identified; `requestAnimationFrame`
 * never fires in these lanes at all, so anything similar would be invisible to
 * a timer-based yield but not to this one. Prefer this helper over a bare
 * `setTimeout` yield in panel-mounting suites until that is understood.
 */
const settle = async () => {
  for (let i = 0; i < 4; i++) {
    await new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => { channel.port1.close(); resolve(undefined); };
      channel.port2.postMessage(undefined);
    });
  }
};

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
   * Mount a settings-panel wired to a fake backend, show the Connectivity tab
   * (which loads the proxy box), run body, then clean up.
   * @param {{mode?: string, url?: string}} opts
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
    // lands here mid-case carrying the real proxy. The fake backend is the server
    // for the length of the case, so its socket route is held shut too; the
    // cases that test broadcasts emit theirs straight onto the service.
    const routes = /** @type {any} */ (wsService.constructor).TYPED_MESSAGE_ROUTES;
    const serverRoute = routes['settings-changed'];
    routes['settings-changed'] = () => {};
    const el = /** @type {any} */ (document.createElement('settings-panel'));
    document.body.appendChild(el);
    try {
      // The proxy box loads its settings when the Connectivity tab is shown.
      el._tabs.connectivity.show();
      await settle();
      await body(el, backend);
    } finally {
      el.remove();
      routes['settings-changed'] = serverRoute;
      backend.restore();
    }
  };

  const modeSelect = (el) => el.querySelector('#proxy-mode');

  /**
   * The real server's broadcast of its own settings.json, as this lane receives
   * it whenever anything on the shared test server writes that file — another
   * lane's suite, or this page's own preference writes. Its proxy is the real
   * file's, not the fake backend's.
   * @returns {void}
   */
  const foreignBroadcast = () => {
    wsService._handleMessageData(JSON.stringify({ type: 'settings-changed', settings: { network: { proxy: { mode: 'system' } } } }));
  };

  await run('select reflects the loaded proxy mode from /api/settings', async () => {
    await withPanel({ mode: 'manual', url: 'http://127.0.0.1:7890' }, async (el) => {
      // Delivered every run rather than left to a sibling lane's timing.
      foreignBroadcast();
      const select = modeSelect(el);
      assert(select && [...select.options].length === 3, `three modes; got ${select && select.options.length}`);
      assert(select.value === 'manual', `manual is selected; got ${select.value}`);
      const urlRow = el.querySelector('#proxy-url-row');
      assert(urlRow && !urlRow.hidden, 'URL row is visible in manual mode');
      const urlInput = el.querySelector('#proxy-url');
      assert(urlInput && urlInput.value === 'http://127.0.0.1:7890', 'URL field shows the loaded URL');
    });
  });

  await run('URL row is hidden for non-manual modes', async () => {
    await withPanel({ mode: 'system' }, async (el) => {
      const urlRow = el.querySelector('#proxy-url-row');
      assert(urlRow && urlRow.hidden, 'URL row hidden in system mode');
    });
  });

  await run('switching to Direct PUTs the new mode', async () => {
    await withPanel({ mode: 'system' }, async (el, backend) => {
      const select = modeSelect(el);
      select.value = 'none';
      select.dispatchEvent(new Event('change'));
      await settle();
      const put = backend.calls.find((c) => c.url === '/api/settings' && c.method === 'PUT');
      assert(put, 'a PUT /api/settings was issued');
      assert(put.body.network.proxy.mode === 'none', `PUT mode = ${put.body.network.proxy.mode}`);
      assert(backend.state.mode === 'none', `backend mode persisted; got ${backend.state.mode}`);
    });
  });

  await run('selecting Manual with no URL does not PUT and prompts for a URL', async () => {
    await withPanel({ mode: 'system' }, async (el, backend) => {
      const select = modeSelect(el);
      select.value = 'manual';
      select.dispatchEvent(new Event('change'));
      await settle();
      const put = backend.calls.find((c) => c.url === '/api/settings' && c.method === 'PUT');
      assert(!put, 'no PUT issued for manual without a URL');
      const urlRow = el.querySelector('#proxy-url-row');
      assert(urlRow && !urlRow.hidden, 'URL row revealed for manual');
      const statusText = el.querySelector('#proxy-status').textContent || '';
      assert(statusText.length > 0, 'a prompt for the URL is shown');
    });
  });

  await run('Manual with a valid URL persists on commit', async () => {
    await withPanel({ mode: 'system' }, async (el, backend) => {
      const select = modeSelect(el);
      select.value = 'manual';
      select.dispatchEvent(new Event('change'));
      await settle();
      const urlInput = el.querySelector('#proxy-url');
      urlInput.value = 'http://proxy.example:8080';
      urlInput.dispatchEvent(new Event('blur'));
      await settle();
      const put = backend.calls.find((c) => c.method === 'PUT' && c.body.network.proxy.mode === 'manual');
      assert(put, 'a manual PUT was issued');
      assert(put.body.network.proxy.url === 'http://proxy.example:8080', `PUT url = ${put.body.network.proxy.url}`);
      assert(backend.state.mode === 'manual' && backend.state.url === 'http://proxy.example:8080', 'manual proxy persisted');
    });
  });

  await run('an invalid manual URL surfaces an error and is not persisted', async () => {
    await withPanel({ mode: 'system' }, async (el, backend) => {
      const select = modeSelect(el);
      select.value = 'manual';
      select.dispatchEvent(new Event('change'));
      await settle();
      const urlInput = el.querySelector('#proxy-url');
      urlInput.value = 'not a url';
      urlInput.dispatchEvent(new Event('blur'));
      await settle();
      const put = backend.calls.find((c) => c.method === 'PUT' && c.body.network.proxy.url === 'not a url');
      assert(!put, 'no PUT for an invalid URL');
      const statusText = el.querySelector('#proxy-status').textContent || '';
      assert(/invalid/i.test(statusText), `an error is shown; got ${JSON.stringify(statusText)}`);
    });
  });

  /**
   * A settings document as the server broadcasts it.
   * @param {{mode: string, url?: string}} proxy
   * @returns {void}
   */
  const broadcastProxy = (proxy) => {
    wsService._emit('settings-changed', { network: { proxy } });
  };

  await run('a proxy set in another window reaches the controls', async () => {
    await withPanel({ mode: 'system' }, async (el) => {
      broadcastProxy({ mode: 'manual', url: 'http://elsewhere.example:3128' });
      assert(modeSelect(el).value === 'manual', `manual is selected; got ${modeSelect(el).value}`);
      const urlInput = el.querySelector('#proxy-url');
      assert(urlInput.value === 'http://elsewhere.example:3128', `URL field shows it; got ${urlInput.value}`);
      const urlRow = el.querySelector('#proxy-url-row');
      assert(urlRow && !urlRow.hidden, 'and the URL row is revealed for manual');
    });
  });

  await run('a broadcast does not take a half-typed URL out of the field', async () => {
    await withPanel({ mode: 'manual', url: 'http://127.0.0.1:7890' }, async (el) => {
      const urlInput = el.querySelector('#proxy-url');
      // The test window is not the focused window and its lanes share one focus,
      // so a real focus() call may not take. The box reads exactly one thing to
      // tell it is mid-edit — document.activeElement — so focus is lane-local,
      // starting in the field, and a sibling's steal is taken on every run. Not
      // a blurring one: the field commits on blur, and a blurred field is not
      // mid-edit.
      const focus = isolateFocus({ activeElement: urlInput });
      try {
        // Mid-edit: typed, not yet committed — the field commits on blur and Enter.
        urlInput.value = 'http://half-typed';
        focus.steal();

        broadcastProxy({ mode: 'manual', url: 'http://someone-else.example:3128' });

        assert(urlInput.value === 'http://half-typed',
          `what the user was typing survives; got ${urlInput.value}`);
      } finally {
        focus.restore();
      }
    });
  });

  return { passed, failed, errors };
}
