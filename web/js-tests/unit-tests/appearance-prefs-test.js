//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Theme and zoom are machine preferences unit test.
 *
 * The theme and the UI zoom describe the screen in front of the user, so they
 * live in the machine realm: one value for every desktop window on the server's
 * own machine, kept in settings.json, and a value of its own for any viewer on
 * another machine — a phone, or the desktop app's own window on a server
 * elsewhere. This pins where each client stores them, that a change made in
 * another window reaches this one, and where a page starts before anything has
 * been stored: a window that inherits a value stores it for its machine, the
 * plain default is never stored, and a viewer on another machine never takes
 * the host's choice as its own.
 * @module unit-tests/appearance-prefs-test
 */

import { waitFor, nextTask } from '../utilities/test-helpers.js';
import { budgetFor } from '../utilities/test-deadline.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed number of passing assertions
 * @property {number} failed number of failing assertions
 * @property {string[]} errors list of error messages from failing assertions
 */

const THEME = 'juggler-theme';
const ZOOM = 'juggler-zoom';
/** Every localStorage cell these cases can write, saved and put back by hand. */
const CELLS = [THEME, `${THEME}@viewer`, ZOOM, `${ZOOM}@viewer`];

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const { setMode, getMode, getPaintedTheme, MODES } = await import('../../js/utils/theme-manager.js');
  const { zoomIn, zoomOut, getCurrentZoom } = await import('../../js/utils/zoom-manager.js');
  const { startingMachinePref, adoptGlobalSettings, __resetPrefsForTests } =
    await import('../../js/services/prefs.js');

  /**
   * @param {string} label
   * @param {() => void|Promise<void>} fn
   */
  const run = async (label, fn) => {
    try { await fn(); passed++; }
    catch (e) { failed++; errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  /**
   * @param {any} actual
   * @param {any} expected
   * @param {string} what
   */
  const eq = (actual, expected, what) => {
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new Error(`${what}: got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);
    }
  };

  /** @type {Array<{url: string, method: string, body: any}>} */
  let calls = [];
  const realFetch = window.fetch;

  /**
   * Stand in for the server, so a write is seen rather than sent: these cases
   * would otherwise restyle every lane through the shared settings document.
   * @param {any} url
   * @param {any} init
   * @returns {Promise<any>} The stubbed response: what services/http.js reads.
   */
  const stubFetch = async (url, init) => {
    const method = (init && init.method) || 'GET';
    const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method, body });
    const text = JSON.stringify({ ui: {} });
    return {
      ok: true,
      status: 200,
      statusText: '',
      text: async () => text,
      json: async () => JSON.parse(text),
    };
  };

  const root = document.documentElement;
  const original = {
    windowMode: root.dataset.windowMode,
    remoteViewer: root.dataset.remoteViewer,
    theme: root.getAttribute('data-theme'),
    background: root.style.background,
    fontSize: root.style.fontSize,
    mode: getMode(),
    cells: CELLS.map((key) => localStorage.getItem(key)),
  };

  /**
   * Start a case as one kind of client, with nothing recorded.
   * @param {'owner'|'remote-window'} client - The server's own desktop window,
   *   or the desktop app's window on a server on another machine.
   */
  const as = (client) => {
    __resetPrefsForTests();
    calls = [];
    root.dataset.windowMode = '1';
    if (client === 'remote-window') root.dataset.remoteViewer = '1';
    else delete root.dataset.remoteViewer;
  };

  /** @returns {Array<{url: string, method: string, body: any}>} The writes seen. */
  const puts = () => calls.filter((c) => c.method === 'PUT');

  /**
   * Wait for a write to leave: the machine realm batches them on a short timer.
   * @param {string} description
   * @returns {Promise<void>} Resolves once a write has been seen.
   */
  const aWrite = (description) => waitFor(() => puts().length > 0, {
    timeoutMs: budgetFor(2000),
    description,
  });

  try {
    window.fetch = stubFetch;

    // --- where a change is stored ------------------------------------------

    await run('the server\u2019s own window stores its theme for the machine', async () => {
      as('owner');
      setMode(MODES.DARK);
      await aWrite('the theme to be written');
      eq(puts().map((c) => [c.url, c.body]), [['/api/settings', { ui: { [THEME]: MODES.DARK } }]], 'writes');
      eq(localStorage.getItem(THEME), '"dark"', 'the machine\u2019s cache');
    });

    await run('a window on another machine keeps its theme to itself', async () => {
      as('remote-window');
      setMode(MODES.LIGHT);
      await nextTask();
      eq(puts().length, 0, 'writes sent to the host');
      eq(localStorage.getItem(`${THEME}@viewer`), '"light"', 'this device\u2019s own copy');
      eq(getMode(), MODES.LIGHT, 'the mode in use');
    });

    await run('the server\u2019s own window stores its zoom for the machine', async () => {
      as('owner');
      const before = getCurrentZoom();
      zoomOut();
      await aWrite('the zoom to be written');
      eq(puts().map((c) => [c.url, c.body]), [['/api/settings', { ui: { [ZOOM]: before - 10 } }]], 'writes');
    });

    await run('a window on another machine keeps its zoom to itself', async () => {
      as('remote-window');
      const before = getCurrentZoom();
      zoomIn();
      await nextTask();
      eq(puts().length, 0, 'writes sent to the host');
      eq(localStorage.getItem(`${ZOOM}@viewer`), String(before + 10), 'this device\u2019s own copy');
    });

    // --- a change made in another window -----------------------------------

    await run('a theme chosen in another window of this machine is applied here', async () => {
      as('owner');
      setMode(MODES.DARK);
      await aWrite('the starting theme to be written');
      adoptGlobalSettings({ ui: { [THEME]: MODES.LIGHT } });
      eq(getMode(), MODES.LIGHT, 'the mode after the broadcast');
      eq(getPaintedTheme(), 'light', 'what is painted');
    });

    await run('a host\u2019s theme change does not restyle a window on another machine', async () => {
      as('remote-window');
      setMode(MODES.DARK);
      adoptGlobalSettings({ ui: { [THEME]: MODES.LIGHT } });
      eq(getMode(), MODES.DARK, 'the mode after the host\u2019s broadcast');
    });

    // --- where a page starts -------------------------------------------------

    await run('the machine\u2019s value wins in its own window, and is not stored again', () => {
      eq(startingMachinePref({ owner: true, machine: 'dark', inherited: ['light'], device: 'light', fallback: 'system' }),
        { value: 'dark', adopt: false }, 'start');
    });

    await run('a window inheriting a value on a machine with none stores it for the machine', () => {
      eq(startingMachinePref({ owner: true, machine: null, inherited: [null, 'light'], device: 'dark', fallback: 'system' }),
        { value: 'light', adopt: true }, 'start');
      // What an older build left in this origin's cache is adopted the same way.
      eq(startingMachinePref({ owner: true, machine: null, inherited: [null], device: 'dark', fallback: 'system' }),
        { value: 'dark', adopt: true }, 'from the cache');
    });

    await run('the plain default is never stored', () => {
      eq(startingMachinePref({ owner: true, machine: null, inherited: [110], device: null, fallback: 110 }),
        { value: 110, adopt: false }, 'an inherited default');
      eq(startingMachinePref({ owner: true, machine: null, inherited: [], device: null, fallback: 110 }),
        { value: 110, adopt: false }, 'nothing anywhere');
    });

    await run('a window on another machine prefers its own value, then what it inherited, then the host\u2019s', () => {
      eq(startingMachinePref({ owner: false, machine: 'light', inherited: ['dark'], device: 'system', fallback: 'system' }),
        { value: 'system', adopt: false }, 'its own');
      eq(startingMachinePref({ owner: false, machine: 'light', inherited: ['dark'], device: null, fallback: 'system' }),
        { value: 'dark', adopt: true }, 'inherited from the window that opened it');
      // The host's choice is where it starts, never what it keeps: stored, it
      // would stop following the host before the user had chosen anything.
      eq(startingMachinePref({ owner: false, machine: 'light', inherited: [null], device: null, fallback: 'system' }),
        { value: 'light', adopt: false }, 'the host\u2019s');
    });
  } finally {
    window.fetch = realFetch;
    __resetPrefsForTests();
    if (original.windowMode === undefined) delete root.dataset.windowMode;
    else root.dataset.windowMode = original.windowMode;
    if (original.remoteViewer === undefined) delete root.dataset.remoteViewer;
    else root.dataset.remoteViewer = original.remoteViewer;
    // The mode the lane had, back in the module; the stub is gone, so this must
    // not be a window that writes it anywhere but the cells restored below.
    if (original.windowMode === undefined) setMode(original.mode);
    CELLS.forEach((key, i) => {
      const value = original.cells[i];
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    });
    if (original.theme) root.setAttribute('data-theme', original.theme);
    root.style.background = original.background;
    root.style.fontSize = original.fontSize;
  }

  return { passed, failed, errors };
}
