//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A project's colour and its window border (utils/project-colour.js,
 * utils/window-border.js).
 *
 * What would regress silently:
 *   1. The automatic colour moving: every project's windows would change
 *      colour on an upgrade, which is the whole of what the colour is for.
 *   2. A palette name with no token in a theme: its border would fall back to
 *      the hairline colour with nothing to say why.
 *   3. A pick not reaching the Machine realm, or not reaching the other
 *      windows of the project when it arrives from another one.
 *   4. The picks outgrowing settings.json's cap on one value, which would have
 *      the server refuse the whole write.
 *   5. The window's own on/off not reaching the marks the border is drawn by.
 *
 * Checked by eye instead: how the border looks, and that it follows the
 * window's corners (cmd/juggler-app's TestHostQueryCarriesTheCornerRadius
 * covers the radius the app hands the page).
 *
 * Exclusive: it stands in for the server and writes the localStorage cache of
 * one fixed preference name, on an origin every lane shares.
 * @module unit-tests/project-colour-test
 */

import {
  PROJECT_COLOURS, PROJECT_COLOURS_EVENT, PROJECT_COLOURS_PREF, automaticProjectColour,
  pickedProjectColour, projectColour, setProjectColour,
} from '../../js/utils/project-colour.js';
import { isWindowBorderOn, paintWindowBorder, setWindowBorder } from '../../js/utils/window-border.js';
import {
  __resetPrefsForTests, adoptGlobalSettings, cachedMachinePref,
} from '../../js/services/prefs.js';

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} The result.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

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
   * Stand in for the server, so nothing a case writes reaches the settings
   * other lanes share.
   * @param {any} url
   * @param {any} init
   * @returns {Promise<any>} What services/http.js reads.
   */
  const stubFetch = async (url, init) => {
    const method = (init && init.method) || 'GET';
    const body = init && typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method, body });
    const text = JSON.stringify({ ui: {} });
    return { ok: true, status: 200, statusText: '', text: async () => text, json: async () => JSON.parse(text) };
  };

  const root = document.documentElement;
  const originalProjectKey = window.__projectKey;
  const originalWindowMode = root.dataset.windowMode;
  const originalRemoteViewer = root.dataset.remoteViewer;
  const originalPicks = localStorage.getItem(PROJECT_COLOURS_PREF);
  const originalBorder = root.dataset.windowBorder;
  const originalColour = root.style.getPropertyValue('--project-colour');
  let seq = 0;
  /** @returns {string} A project key no other case or lane uses. */
  const uniqueKey = () => `test${Date.now().toString(36)}${seq++}`;

  /** Start a case as this computer's own desktop window, with no picks. */
  const reset = () => {
    __resetPrefsForTests();
    calls = [];
    localStorage.removeItem(PROJECT_COLOURS_PREF);
    root.dataset.windowMode = '1';
    delete root.dataset.remoteViewer;
  };

  /**
   * Count the colour events fn causes.
   * @param {() => void|Promise<void>} fn
   * @returns {Promise<number>} How many fired.
   */
  const colourEvents = async (fn) => {
    let n = 0;
    const count = () => { n++; };
    window.addEventListener(PROJECT_COLOURS_EVENT, count);
    try { await fn(); } finally { window.removeEventListener(PROJECT_COLOURS_EVENT, count); }
    return n;
  };

  try {
    window.fetch = stubFetch;

    await run('the automatic colour of a key never changes', () => {
      // Pinned: changing the palette's order or length, or the hash, recolours
      // every project's windows on upgrade.
      eq(PROJECT_COLOURS, ['orange', 'yellow', 'lime', 'green', 'teal', 'blue', 'purple', 'pink'], 'the palette');
      eq(automaticProjectColour('0123456789abcdef'), 'blue', '0123456789abcdef');
      eq(automaticProjectColour('ffffffffffffffff'), 'blue', 'ffffffffffffffff');
      eq(automaticProjectColour('a1b2c3d4e5f60718'), 'pink', 'a1b2c3d4e5f60718');
    });

    await run('every palette colour has a shade in the theme on screen', () => {
      const style = getComputedStyle(root);
      const missing = PROJECT_COLOURS.filter((name) => !style.getPropertyValue(`--project-colour-${name}`).trim());
      eq(missing, [], 'colours with no --project-colour-* token');
    });

    await run('a pick goes to the Machine realm, is announced, and is undone by going automatic', async () => {
      reset();
      const key = uniqueKey();
      const other = PROJECT_COLOURS.find((c) => c !== automaticProjectColour(key)) || 'teal';
      eq(await colourEvents(() => setProjectColour(key, other)), 1, 'events on a pick');
      eq(pickedProjectColour(key), other, 'the pick');
      eq(projectColour(key), other, 'the project\u2019s colour');
      const put = calls.filter((c) => c.method === 'PUT');
      eq(put.length, 1, 'one write');
      eq(put[0]?.body, { ui: { [PROJECT_COLOURS_PREF]: { [key]: other } } }, 'what was written');

      calls = [];
      eq(await colourEvents(() => setProjectColour(key, null)), 1, 'events on going automatic');
      eq(pickedProjectColour(key), null, 'no pick');
      eq(projectColour(key), automaticProjectColour(key), 'back to automatic');
      eq(calls.filter((c) => c.method === 'PUT')[0]?.body, { ui: { [PROJECT_COLOURS_PREF]: null } },
        'the last pick gone forgets the preference rather than storing an empty map');
    });

    await run('a pick made in another window recolours this one', async () => {
      reset();
      const key = uniqueKey();
      window.__projectKey = key;
      const target = document.createElement('div');
      paintWindowBorder(target);
      eq(target.style.getPropertyValue('--project-colour'), `var(--project-colour-${automaticProjectColour(key)})`, 'automatic to start');
      const other = PROJECT_COLOURS.find((c) => c !== automaticProjectColour(key)) || 'teal';
      const fired = await colourEvents(() => {
        adoptGlobalSettings({ ui: { [PROJECT_COLOURS_PREF]: { [key]: other } } });
      });
      eq(fired, 1, 'the broadcast is announced');
      paintWindowBorder(target);
      eq(target.style.getPropertyValue('--project-colour'), `var(--project-colour-${other})`, 'the other window\u2019s pick');
    });

    await run('a pick that is not a palette colour counts as none', async () => {
      reset();
      const key = uniqueKey();
      adoptGlobalSettings({ ui: { [PROJECT_COLOURS_PREF]: { [key]: 'chartreuse' } } });
      eq(pickedProjectColour(key), null, 'an unknown name');
      eq(projectColour(key), automaticProjectColour(key), 'falls back to automatic');
    });

    await run('the oldest picks make room, so the map stays under the server\u2019s cap', async () => {
      reset();
      const keys = Array.from({ length: 204 }, () => uniqueKey());
      const newest = uniqueKey();
      adoptGlobalSettings({ ui: { [PROJECT_COLOURS_PREF]: Object.fromEntries(keys.map((k) => [k, 'teal'])) } });
      await setProjectColour(newest, 'lime');
      const stored = cachedMachinePref(PROJECT_COLOURS_PREF, {});
      eq(Object.keys(stored).length, 200, 'picks kept');
      eq(stored[newest], 'lime', 'the new pick is kept');
      eq(String(keys[0]) in stored, false, 'the oldest pick made room');
      const bytes = JSON.stringify(stored).length;
      if (bytes > 8 << 10) throw new Error(`the map is ${bytes} bytes, over settings.json's 8 KiB value cap`);
    });

    await run('this window\u2019s border marks the page it is drawn on, and only when on', async () => {
      reset();
      window.__projectKey = uniqueKey();
      const target = document.createElement('div');
      await setWindowBorder(true);
      eq(isWindowBorderOn(), true, 'on');
      paintWindowBorder(target);
      eq(target.dataset.windowBorder, '1', 'marked on');
      await setWindowBorder(false);
      paintWindowBorder(target);
      eq(target.dataset.windowBorder, undefined, 'unmarked when off');
    });

    await run('a page with no project is never framed', async () => {
      reset();
      window.__projectKey = '';
      const target = document.createElement('div');
      paintWindowBorder(target);
      eq(target.dataset.windowBorder, undefined, 'no border');
      eq(target.style.getPropertyValue('--project-colour'), '', 'no colour');
    });

  } finally {
    window.fetch = realFetch;
    window.__projectKey = originalProjectKey;
    if (originalWindowMode === undefined) delete root.dataset.windowMode;
    else root.dataset.windowMode = originalWindowMode;
    if (originalRemoteViewer === undefined) delete root.dataset.remoteViewer;
    else root.dataset.remoteViewer = originalRemoteViewer;
    // The module repaints the lane's own root on the events these cases fire.
    if (originalBorder === undefined) delete root.dataset.windowBorder;
    else root.dataset.windowBorder = originalBorder;
    if (originalColour) root.style.setProperty('--project-colour', originalColour);
    else root.style.removeProperty('--project-colour');
    if (originalPicks === null) localStorage.removeItem(PROJECT_COLOURS_PREF);
    else localStorage.setItem(PROJECT_COLOURS_PREF, originalPicks);
    __resetPrefsForTests();
  }

  return { passed, failed, errors };
}
