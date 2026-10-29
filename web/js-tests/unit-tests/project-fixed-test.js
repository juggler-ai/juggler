//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: choosing another project from a session.
 *
 * A session stays on the project it was opened for, and another folder is
 * another session. So Session ▸ Open… opens the machine server's sessions page
 * (one named tab, reused each time), or, in the desktop app, asks it for a
 * window on that page. Nothing presents a picker that loads a folder into this
 * page. (The header's project path is read-only: unit:header-undo-lock.)
 * @module unit-tests/project-fixed-test
 */

import { assert } from '../utilities/test-helpers.js';
import { sessionsPageUrl, SESSIONS_PAGE_TARGET } from '../../js/utils/project-open-mode.js';
import { chooseProject } from '../../js/components/header-controls.js';

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  // What a picker would present against, so its absence proves something.
  const chip = document.createElement('button');
  chip.id = 'project-path-chip';
  document.body.appendChild(chip);

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

  try {
    await test('the sessions page is the root of the origin the session is served from', () => {
      assert(sessionsPageUrl() === `${window.location.origin}/`,
        `sessionsPageUrl() = ${sessionsPageUrl()}, want ${window.location.origin}/`);
    });

    await test('over a rendezvous link the sessions page is reached through the link', () => {
      const w = /** @type {any} */ (window);
      const had = Object.prototype.hasOwnProperty.call(w, '__jugglerStudio');
      const previous = w.__jugglerStudio;
      w.__jugglerStudio = { pageURL: (/** @type {string} */ path) => `/c/abcdefghijklmnop#${path}` };
      try {
        assert(sessionsPageUrl() === `${window.location.origin}/c/abcdefghijklmnop#/`,
          `sessionsPageUrl() = ${sessionsPageUrl()}, want the link's own address for /`);
      } finally {
        if (had) w.__jugglerStudio = previous; else delete w.__jugglerStudio;
      }
    });

    await test('another project opens the sessions page in its named tab, and no picker', async () => {
      /** @type {Array<[string, string]>} */
      const opened = [];
      await chooseProject((url, target) => { opened.push([url, target]); }, null);
      assert(opened.length === 1, `opened ${opened.length} windows, want 1`);
      assert(opened[0][0] === sessionsPageUrl() && opened[0][1] === SESSIONS_PAGE_TARGET,
        `opened ${JSON.stringify(opened[0])}, want the sessions page in ${SESSIONS_PAGE_TARGET}`);
      assert(!document.querySelector('.pp-panel-popup'), 'a picker was presented');
    });

    await test('in a desktop window another project asks the app for a window on the server\'s page', async () => {
      /** @type {string[]} */
      const opened = [];
      let asked = 0;
      await chooseProject((url) => { opened.push(url); }, { newWindow: async () => { asked++; } });
      assert(asked === 1, `asked the app ${asked} times, want 1`);
      assert(opened.length === 0, `opened ${JSON.stringify(opened)} in a desktop window`);
      assert(!document.querySelector('.pp-panel-popup'), 'a picker was presented');
    });

    await test('in a desktop window on a server by URL another project shows that server\'s page in this window', async () => {
      /** @type {string[]} */
      const opened = [];
      let shown = 0;
      await chooseProject((url) => { opened.push(url); }, { serverPage: async () => { shown++; } });
      assert(shown === 1, `asked the app to show the server's page ${shown} times, want 1`);
      assert(opened.length === 0, `opened ${JSON.stringify(opened)} in a desktop window`);
    });
  } finally {
    chip.remove();
  }

  return { passed, failed, errors };
}
