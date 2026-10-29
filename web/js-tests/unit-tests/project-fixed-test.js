//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: choosing another project from a session whose project is fixed.
 *
 * A session the machine server spawned stays on the project it was spawned
 * for — its server refuses to switch — and another folder is another session.
 * So the project chip, there, opens the machine server's sessions page (one
 * named tab, reused on each click) instead of a picker whose choice would be
 * refused. Anywhere else it opens the picker.
 * @module unit-tests/project-fixed-test
 */

import { assert } from '../utilities/test-helpers.js';
import { closePopupById } from '../../js/utils/popup-manager.js';
import apiService from '../../js/services/api.js';
import { projectIsFixed, sessionsPageUrl, SESSIONS_PAGE_TARGET } from '../../js/utils/project-open-mode.js';
import { chooseProject } from '../../js/components/header-controls.js';

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  const root = document.documentElement;
  const hadFixed = root.dataset.fixedProject;
  const realGetRecents = apiService.getRecents;
  apiService.getRecents = async () => ({ paths: [] });
  // The picker presents against the header's project chip.
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
    await test('the page marker says whether the project is fixed', () => {
      root.dataset.fixedProject = '1';
      assert(projectIsFixed(), 'data-fixed-project="1" did not read as fixed');
      delete root.dataset.fixedProject;
      assert(!projectIsFixed(), 'no marker read as fixed');
    });

    await test('the sessions page is the root of the origin the session is served from', () => {
      assert(sessionsPageUrl() === `${window.location.origin}/`,
        `sessionsPageUrl() = ${sessionsPageUrl()}, want ${window.location.origin}/`);
    });

    await test('a fixed project opens the sessions page in its named tab, and no picker', async () => {
      root.dataset.fixedProject = '1';
      /** @type {Array<[string, string]>} */
      const opened = [];
      await chooseProject('/p', null, (url, target) => { opened.push([url, target]); });
      assert(opened.length === 1, `opened ${opened.length} windows, want 1`);
      assert(opened[0][0] === sessionsPageUrl() && opened[0][1] === SESSIONS_PAGE_TARGET,
        `opened ${JSON.stringify(opened[0])}, want the sessions page in ${SESSIONS_PAGE_TARGET}`);
      assert(!document.querySelector('.pp-panel-popup'), 'a picker was presented for a fixed project');
    });

    await test('a switchable project opens the picker, and nothing else', async () => {
      delete root.dataset.fixedProject;
      /** @type {string[]} */
      const opened = [];
      await chooseProject('/p', null, (url) => { opened.push(url); });
      assert(opened.length === 0, `opened ${JSON.stringify(opened)} for a switchable project`);
      assert(!!document.querySelector('.pp-panel-popup'), 'no picker was presented');
      closePopupById('project-picker');
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  } finally {
    chip.remove();
    apiService.getRecents = realGetRecents;
    if (hadFixed === undefined) delete root.dataset.fixedProject;
    else root.dataset.fixedProject = hadFixed;
  }

  return { passed, failed, errors };
}
