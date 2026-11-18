//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: the sessions page's header buttons (web/machine/header-buttons.js)
 * and this computer's Settings, which its Settings button opens — the settings
 * panel on a page with no session (services/settings-endpoint.js).
 *
 * The page's settings go to the machine server, with the control API's token,
 * and its Settings has only the tabs that need no session; Settings is offered
 * only to a viewer on this machine. Its theme and zoom are its own, kept on
 * this device and handed on (to a page it frames) as they change.
 * @module unit-tests/machine-settings-test
 */

import { assert, waitFor } from '../utilities/test-helpers.js';
import { mountHeaderButtons, followFramerAppearance, APPEARANCE_EVENT } from '../../machine/header-buttons.js';
import { useMachineSettings, __resetSettingsEndpointForTests } from '../../js/services/settings-endpoint.js';
import { getMode, setMode, getPaintedTheme, SESSIONS_PAGE_THEME_PREF } from '../../js/utils/theme-manager.js';
import { getCurrentZoom, setZoomLevel, SESSIONS_PAGE_ZOOM_PREF } from '../../js/utils/zoom-manager.js';
import { getDevicePref, setDevicePref } from '../../js/services/prefs.js';
import '../../js/components/machine-settings-panel.js';

/** The control API's root a test's page is handed, and its token. */
const BASE = '/machine-settings-test/api/server';
const TOKEN = 'machine-settings-test-token';

/**
 * Run fn as the sessions page: settings to the machine server, the page's own
 * theme and zoom — put back as they were afterwards, on screen and stored.
 * @param {() => Promise<void>} fn
 * @returns {Promise<void>} Resolves once fn has, and the page is put back.
 */
async function asSessionsPage(fn) {
  const mode = getMode();
  const zoom = getCurrentZoom();
  const fontSize = document.documentElement.style.fontSize;
  useMachineSettings({ base: BASE, headers: { 'X-Juggler-Token': TOKEN }, version: '9.9.9' });
  try {
    await fn();
  } finally {
    if (getMode() !== mode) setMode(mode);
    if (getCurrentZoom() !== zoom) setZoomLevel(zoom);
    document.documentElement.style.fontSize = fontSize;
    setDevicePref(SESSIONS_PAGE_THEME_PREF, null);
    setDevicePref(SESSIONS_PAGE_ZOOM_PREF, null);
    __resetSettingsEndpointForTests();
  }
}

/**
 * Stand in for fetch while fn runs: requests under BASE are recorded and
 * answered as the machine server would; any other request is recorded and
 * answered 404, so a request the page should not make is seen, not served.
 * @param {Array<{url: string, method: string, token: string|null, body: any}>} requests - Where each request is recorded.
 * @param {() => Promise<void>} fn
 * @returns {Promise<void>} Resolves once fn has, and fetch is put back.
 */
async function withMachineServer(requests, fn) {
  const real = window.fetch;
  /** @type {any} */
  let doc = { updates: { mode: 'automatic' }, network: { proxy: { mode: 'system' } }, projects: {}, ui: {} };
  window.fetch = /** @type {typeof fetch} */ (async (input, init = {}) => {
    const url = typeof input === 'string' ? input : /** @type {Request} */ (input).url;
    const method = (init.method || 'GET').toUpperCase();
    const headers = /** @type {Record<string, string>} */ (init.headers || {});
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : null;
    requests.push({ url, method, token: headers['X-Juggler-Token'] ?? null, body });
    const json = (/** @type {any} */ value) => new window.Response(JSON.stringify(value), {
      status: 200, headers: { 'Content-Type': 'application/json' },
    });
    if (url === `${BASE}/settings` && method === 'PUT') {
      doc = { ...doc, ...body, updates: { ...doc.updates, ...(body?.updates || {}) } };
      return json(doc);
    }
    if (url === `${BASE}/settings`) return json(doc);
    if (url === `${BASE}/i18n/locales`) return json({ locales: [] });
    return new window.Response('not here', { status: 404 });
  });
  try {
    await fn();
  } finally {
    window.fetch = real;
  }
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void> | void} fn
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (err) {
      failed++;
      errors.push(`${name}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  await test('Settings is offered to a viewer on this machine alone', async () => {
    await asSessionsPage(async () => {
      /** @type {Array<string|undefined>} */
      const opened = [];
      const local = document.createElement('div');
      const remote = document.createElement('div');
      const downLocal = mountHeaderButtons(local, { settings: true, open: (tab) => { opened.push(tab); } });
      const downRemote = mountHeaderButtons(remote, { settings: false, open: (tab) => { opened.push(tab); } });
      try {
        for (const [name, slot] of [['local', local], ['remote', remote]]) {
          const ids = [.../** @type {HTMLElement} */ (slot).querySelectorAll('button')].map((b) => b.id);
          const want = name === 'local'
            ? ['zoom-out-button', 'zoom-in-button', 'theme-button', 'settings-button']
            : ['zoom-out-button', 'zoom-in-button', 'theme-button'];
          assert(JSON.stringify(ids) === JSON.stringify(want), `${name} header has ${JSON.stringify(ids)}, want ${JSON.stringify(want)}`);
        }
        /** @type {HTMLButtonElement} */ (local.querySelector('#settings-button')).click();
        assert(opened.length === 1 && opened[0] === undefined, `Settings opened ${JSON.stringify(opened)}`);
      } finally {
        downLocal();
        downRemote();
      }
    });
  });

  await test('the theme button flips the theme, keeps it for the page and hands it on', async () => {
    await asSessionsPage(async () => {
      /** @type {Array<{mode: string, zoom: number}>} */
      const told = [];
      const slot = document.createElement('div');
      const down = mountHeaderButtons(slot, { settings: false, onAppearance: (a) => told.push(a) });
      try {
        const before = getPaintedTheme();
        const button = /** @type {HTMLButtonElement} */ (slot.querySelector('#theme-button'));
        button.click();
        const after = getPaintedTheme();
        assert(after !== before, `the page stayed ${before}`);
        assert(document.documentElement.getAttribute('data-theme') === after, 'the document is not painted the new theme');
        assert(getDevicePref(SESSIONS_PAGE_THEME_PREF, null) === getMode(),
          `stored ${JSON.stringify(getDevicePref(SESSIONS_PAGE_THEME_PREF, null))}, mode is ${getMode()}`);
        assert(told.some((a) => a.mode === getMode()), `onAppearance was told ${JSON.stringify(told)}`);
        assert((button.title || '').length > 0 && !!button.querySelector('path')?.getAttribute('d'), 'the button shows no theme');
      } finally {
        down();
      }
    });
  });

  await test('zoom − and + step the page and hand on the level', async () => {
    await asSessionsPage(async () => {
      setZoomLevel(100);
      /** @type {Array<{mode: string, zoom: number}>} */
      const told = [];
      const slot = document.createElement('div');
      const down = mountHeaderButtons(slot, { settings: false, onAppearance: (a) => told.push(a) });
      try {
        /** @type {HTMLButtonElement} */ (slot.querySelector('#zoom-in-button')).click();
        assert(getCurrentZoom() === 110 && document.documentElement.style.fontSize === '110%',
          `after + the zoom is ${getCurrentZoom()} (${document.documentElement.style.fontSize})`);
        window.dispatchEvent(new CustomEvent('juggler:zoom-out'));
        window.dispatchEvent(new CustomEvent('juggler:zoom-out'));
        assert(getCurrentZoom() === 90, `after the menu's Zoom Out twice the zoom is ${getCurrentZoom()}`);
        assert(getDevicePref(SESSIONS_PAGE_ZOOM_PREF, null) === 90, `stored ${getDevicePref(SESSIONS_PAGE_ZOOM_PREF, null)}`);
        assert(JSON.stringify(told.map((a) => a.zoom)) === '[110,100,90]', `onAppearance was told ${JSON.stringify(told)}`);
      } finally {
        down();
      }
    });
  });

  await test('a framed page wears the theme and zoom its framer hands it', async () => {
    await asSessionsPage(async () => {
      const stop = followFramerAppearance(window);
      try {
        const other = getPaintedTheme() === 'dark' ? 'light' : 'dark';
        window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT, { detail: { mode: other, zoom: 130 } }));
        assert(getMode() === other && getPaintedTheme() === other, `the page is ${getMode()}/${getPaintedTheme()}, want ${other}`);
        assert(getCurrentZoom() === 130, `the zoom is ${getCurrentZoom()}, want 130`);
        window.dispatchEvent(new CustomEvent(APPEARANCE_EVENT, { detail: { mode: 'sepia', zoom: 'big' } }));
        assert(getMode() === other && getCurrentZoom() === 130, 'a malformed hand-off changed the page');
      } finally {
        stop();
      }
    });
  });

  await test("this computer's Settings has only the tabs that need no session, and saves to the machine server", async () => {
    await asSessionsPage(async () => {
      const el = /** @type {any} */ (document.createElement('settings-panel'));
      /** @type {Array<{url: string, method: string, token: string|null, body: any}>} */
      const requests = [];
      await withMachineServer(requests, async () => {
        try {
          document.body.appendChild(el);
          const tabs = [...el.querySelectorAll('.settings-tab')].map((b) => /** @type {HTMLElement} */ (b).dataset.tab);
          assert(JSON.stringify(tabs) === '["language","connectivity","appearance","shortcuts","project-files","updates"]',
            `tabs ${JSON.stringify(tabs)}`);
          const sections = [...el.querySelectorAll('.settings-tab-content')].map((s) => s.id).sort();
          assert(JSON.stringify(sections) === JSON.stringify(['tab-appearance', 'tab-connectivity', 'tab-language', 'tab-project-files', 'tab-shortcuts', 'tab-updates']),
            `sections ${JSON.stringify(sections)}`);
          assert(!el.querySelector('#appearance-form .toggle-switch, #appearance-form input[type="checkbox"]'), 'Appearance offers the tips switch');
          assert(el.querySelector('#settings-scope-note')?.textContent, "nothing says these are this computer's settings");
          await el.open('updates');
          assert(el.querySelector('#tab-updates.is-active'), 'Updates is not the tab shown');
          await waitFor(() => /9\.9\.9/.test(el.querySelector('#updates-version-info')?.textContent || ''),
            { description: "the machine server's version shown" });
          assert(!el.querySelector('#updates-check-btn'), 'a check is offered with no update checker to ask');
          const notify = /** @type {HTMLInputElement} */ (el.querySelector('.updates-mode-radio[value="notify"]'));
          notify.checked = true;
          notify.dispatchEvent(new Event('change'));
          await waitFor(() => requests.some((r) => r.method === 'PUT'), { description: 'the mode saved' });
        } finally {
          el.close?.();
          el.remove();
        }
      });
      const put = requests.find((r) => r.method === 'PUT');
      assert(!!put && put.url === `${BASE}/settings`, `the save went to ${JSON.stringify(put?.url)}`);
      assert(put?.token === TOKEN, `the save carried token ${JSON.stringify(put?.token)}`);
      assert(put?.body?.updates?.mode === 'notify', `the save said ${JSON.stringify(put?.body)}`);
      const session = requests.filter((r) => /\/api\/(config|providers|default-model|cheap-model|decision-model|connectivity|update-status|project-state|session\/)/.test(r.url));
      assert(session.length === 0, `asked a session's routes: ${JSON.stringify(session.map((r) => r.url))}`);
    });
  });

  return { passed, failed, errors };
}
