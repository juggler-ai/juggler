//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Theme and zoom are window preferences unit test.
 *
 * Each window keeps its own theme and UI zoom: the server's own desktop window
 * in this project's session under its window role, and a viewer on another
 * machine — a phone, or the desktop app's own window on a server elsewhere — in
 * its own localStorage, scoped the same way, never writing back. This pins
 * where each client stores them, that nothing another window does changes this
 * one, and where a window starts before it has stored anything: what it was
 * handed (the opener's seed, then what an older build kept for the machine or
 * the project) is stored as its own, the plain default never is, and a viewer
 * on another machine never takes the host's choice as its own.
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

const THEME = 'juggler-window-theme';
const ZOOM = 'juggler-window-zoom';
/** The names an older build kept both under for the whole machine. */
const MACHINE_THEME = 'juggler-theme';
const MACHINE_ZOOM = 'juggler-zoom';
/** The project key these cases pretend the server injected. */
const PROJECT = 'pk-appearance-a';
const OTHER_PROJECT = 'pk-appearance-b';
const BOARD_ROLE = 'pinboard:board_x';

/**
 * Every localStorage cell these cases can write, saved and put back by hand.
 * @type {string[]}
 */
const CELLS = [THEME, ZOOM, MACHINE_THEME, MACHINE_ZOOM, `${MACHINE_THEME}@viewer`, `${MACHINE_ZOOM}@viewer`]
  .flatMap((name) => [name, `${name}:${PROJECT}`, `${name}:${OTHER_PROJECT}`,
    `${name}:${PROJECT}@${BOARD_ROLE}`]);

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
  const { startingWindowPref, adoptGlobalSettings, __resetPrefsForTests } =
    await import('../../js/services/prefs.js');
  const { __setViewModeForTests } = await import('../../js/utils/view-mode.js');

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
   * would otherwise restyle the lane's own session.
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
    projectKey: window.__projectKey,
    search: window.location.search,
    theme: root.getAttribute('data-theme'),
    background: root.style.background,
    fontSize: root.style.fontSize,
    mode: getMode(),
    cells: CELLS.map((key) => localStorage.getItem(key)),
  };

  /**
   * Start a case as one kind of client in one window, with nothing recorded.
   * @param {'owner'|'remote-window'} client - The server's own desktop window,
   *   or the desktop app's window on a server on another machine.
   * @param {object} [where]
   * @param {string} [where.project] - The project key the page was given.
   * @param {string} [where.search] - The window's query string (its role).
   * @param {boolean} [where.keep] - Keep what earlier windows cached, to look at
   *   two windows in one case.
   */
  const as = (client, { project = PROJECT, search = '', keep = false } = {}) => {
    __resetPrefsForTests();
    calls = [];
    root.dataset.windowMode = '1';
    if (client === 'remote-window') root.dataset.remoteViewer = '1';
    else delete root.dataset.remoteViewer;
    window.__projectKey = project;
    __setViewModeForTests(search);
    if (!keep) for (const key of CELLS) localStorage.removeItem(key);
  };

  /** @returns {Array<{url: string, method: string, body: any}>} The writes seen. */
  const puts = () => calls.filter((c) => c.method === 'PUT');

  /**
   * Wait for a write to leave: the realms batch them on a short timer.
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

    await run('the server\u2019s own window stores its theme for itself, not the machine', async () => {
      as('owner');
      setMode(MODES.DARK);
      await aWrite('the theme to be written');
      eq(puts().map((c) => [c.url, c.body]),
        [['/api/session/ui-prefs?role=main', { ui: { [THEME]: MODES.DARK } }]], 'writes');
      eq(localStorage.getItem(`${THEME}:${PROJECT}`), '"dark"', 'this window\u2019s cache');
    });

    await run('the server\u2019s own window stores its zoom for itself, not the machine', async () => {
      as('owner');
      const before = getCurrentZoom();
      zoomOut();
      await aWrite('the zoom to be written');
      eq(puts().map((c) => [c.url, c.body]),
        [['/api/session/ui-prefs?role=main', { ui: { [ZOOM]: before - 10 } }]], 'writes');
    });

    await run('a detached board stores its theme under its own role', async () => {
      as('owner', { search: '?view=pinboard&board=board_x' });
      setMode(MODES.LIGHT);
      await aWrite('the board\u2019s theme to be written');
      eq(puts().map((c) => c.url), [`/api/session/ui-prefs?role=${encodeURIComponent(BOARD_ROLE)}`], 'writes');
      eq(localStorage.getItem(`${THEME}:${PROJECT}@${BOARD_ROLE}`), '"light"', 'the board\u2019s cache');
      eq(localStorage.getItem(`${THEME}:${PROJECT}`), null, 'the main window\u2019s cache');
    });

    await run('a window on another machine keeps its theme and zoom to itself', async () => {
      as('remote-window');
      setMode(MODES.LIGHT);
      const before = getCurrentZoom();
      zoomIn();
      await nextTask();
      eq(puts().length, 0, 'writes sent to the host');
      eq(localStorage.getItem(`${THEME}:${PROJECT}`), '"light"', 'this window\u2019s own theme');
      eq(localStorage.getItem(`${ZOOM}:${PROJECT}`), String(before + 10), 'this window\u2019s own zoom');
      eq(getMode(), MODES.LIGHT, 'the mode in use');
    });

    // --- what another window does ------------------------------------------

    await run('another project\u2019s window changing its theme leaves this one alone', async () => {
      as('owner', { project: OTHER_PROJECT });
      setMode(MODES.LIGHT);
      as('owner', { keep: true });
      setMode(MODES.DARK);
      eq(localStorage.getItem(`${THEME}:${OTHER_PROJECT}`), '"light"', 'the other window\u2019s');
      eq(localStorage.getItem(`${THEME}:${PROJECT}`), '"dark"', 'this window\u2019s');
    });

    await run('a settings broadcast carrying a machine theme and zoom does not restyle this window', async () => {
      as('owner');
      setMode(MODES.DARK);
      const zoom = getCurrentZoom();
      adoptGlobalSettings({ ui: { [MACHINE_THEME]: MODES.LIGHT, [MACHINE_ZOOM]: zoom + 20 } });
      await nextTask();
      eq(getMode(), MODES.DARK, 'the mode after the broadcast');
      eq(getPaintedTheme(), 'dark', 'what is painted');
      eq(getCurrentZoom(), zoom, 'the zoom after the broadcast');
    });

    // --- where a window starts ---------------------------------------------

    await run('a window\u2019s own value wins, and is not stored again', () => {
      eq(startingWindowPref({ own: 'dark', inherited: ['light'], host: 'light', fallback: 'system' }),
        { value: 'dark', adopt: false }, 'start');
    });

    await run('a window with nothing stores what it was handed, best first', () => {
      eq(startingWindowPref({ own: null, inherited: [null, 'light', 'dark'], fallback: 'system' }),
        { value: 'light', adopt: true }, 'start');
    });

    await run('the plain default is never stored', () => {
      eq(startingWindowPref({ own: null, inherited: [110], fallback: 110 }),
        { value: 110, adopt: false }, 'an inherited default');
      eq(startingWindowPref({ own: null, inherited: [], fallback: 110 }),
        { value: 110, adopt: false }, 'nothing anywhere');
    });

    await run('a window on another machine starts from the host\u2019s value but does not keep it', () => {
      eq(startingWindowPref({ own: null, inherited: [null], host: 'light', fallback: 'system' }),
        { value: 'light', adopt: false }, 'the host\u2019s');
      eq(startingWindowPref({ own: null, inherited: ['dark'], host: 'light', fallback: 'system' }),
        { value: 'dark', adopt: true }, 'inherited from the window that opened it');
    });
  } finally {
    window.fetch = realFetch;
    __resetPrefsForTests();
    __setViewModeForTests(original.search);
    window.__projectKey = original.projectKey;
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
