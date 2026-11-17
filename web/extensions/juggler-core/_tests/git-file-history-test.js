//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Git pin file history and reflog tests — a changed file's File history opens
 * History filtered to its path, and the scope picker's Reflog lists where HEAD
 * has been, each row with git's words for the move.
 * @module _tests/git-file-history-test
 */

import GitPin from '../pins/git-pin.js';
import { assert, waitFor } from '../../../js-tests/utilities/test-helpers.js';
import { underPseudoLocale } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';
import { changesOf, commitOf, historyOf, mountPin, pick, pickerChoices, pickerValue, treeOf } from './git-pin-helpers.js';

/**
 * A history whose reflog scope answers rows carrying git's words for each move.
 * @param {any} q - The log query.
 * @returns {any} The page.
 */
const withReflog = (q) => {
  const page = historyOf(6)(q);
  if (q.scope !== 'reflog') return page;
  return {
    ...page, graphed: false, lanes: [],
    rows: page.rows.map((/** @type {any} */ r, /** @type {number} */ i) => ({ ...r, lane: 0, out: [], reflog: i === 0 ? 'reset: moving to HEAD~1' : `commit: step ${i}` })),
  };
};

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Test label.
   * @param {() => Promise<void>|void} fn - Test body.
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    } finally {
      for (const pop of document.querySelectorAll('.juggler-context-menu')) pop.remove();
    }
  }

  const pin = new GitPin();

  /**
   * @param {string} place - Where it opens.
   * @returns {any} The mounted pin.
   */
  const mount = (place) => mountPin(pin, {
    place,
    changes: changesOf([
      { path: 'src/b.js', index: '.', worktree: 'M', unstaged: { added: 3, removed: 0 } },
      { path: 'new.md', index: '?', worktree: '?' },
    ]),
    log: withReflog,
    commit: (/** @type {string} */ rev) => commitOf(rev),
    worktrees: { repo: '', trees: [treeOf({ main: true, current: true })] },
  });
  /**
   * Open a Changes row's ⋯ menu.
   * @param {any} m - The mounted pin.
   * @param {string} key - The row.
   * @returns {Promise<string[]>} The menu's words.
   */
  const rowMenu = async (m, key) => {
    const more = /** @type {HTMLElement} */ (await waitFor(
      () => m.body.querySelector(`.git-changes__row[data-key="${CSS.escape(key)}"] .git-changes__more`), `row ${key}`));
    more.click();
    return [...document.querySelectorAll('.juggler-context-menu .menu-item')].map((el) => el.textContent || '');
  };
  /**
   * @param {any} m - The mounted pin.
   * @returns {any[]} The log queries asked, in order.
   */
  const logReads = (m) => m.reads().filter((/** @type {any} */ r) => r.kind === 'log').map((/** @type {any} */ r) => r.options.log || {});

  await test('File history opens History filtered to the file\u2019s path', async () => {
    const m = mount('changes');
    await rowMenu(m, 'changes:src/b.js');
    const item = [...document.querySelectorAll('.juggler-context-menu .menu-item')].find((el) => el.textContent === 'File history');
    assert(Boolean(item), 'a File history row');
    /** @type {HTMLElement} */ (item).click();
    const root = /** @type {HTMLElement} */ (m.body.querySelector('.git-pin'));
    assert(root.dataset.place === 'history', `History is brought forward: ${root.dataset.place}`);
    await waitFor(() => logReads(m).some((q) => q.path === 'src/b.js'), 'a log read of the path');
    const input = /** @type {HTMLInputElement} */ (m.body.querySelector('.git-history__filter'));
    const field = pickerValue(m.body.querySelector('.git-history__field'));
    assert(input.value === 'src/b.js' && field === 'path', `the filter says so: ${field} ${input.value}`);
    m.teardown();
  });

  await test('an untracked file has no history to offer', async () => {
    const m = mount('changes');
    const labels = await rowMenu(m, 'untracked:new.md');
    assert(!labels.includes('File history'), `no File history: ${JSON.stringify(labels)}`);
    m.teardown();
  });

  await test('the Reflog scope reads where HEAD has been, each row with git\u2019s words', async () => {
    const m = mount('history');
    const select = m.body.querySelector('.git-history__scope');
    await waitFor(() => pickerChoices(select).some((c) => c.value === 'reflog'), 'a Reflog scope');
    pick(select, 'reflog');
    await waitFor(() => logReads(m).some((q) => q.scope === 'reflog'), 'a reflog read');
    const first = /** @type {HTMLElement} */ (await waitFor(() => m.body.querySelector('.git-history__row[data-index="0"] .git-history__reflog'), 'the first entry'));
    assert(first.textContent === 'reset: moving to HEAD~1', `git's words for it: ${first.textContent}`);
    m.teardown();
  });

  await test('en-XA: File history and Reflog speak the user\u2019s language', async () => {
    await underPseudoLocale('git-file-history-test', async () => {
      const m = mount('changes');
      const labels = await rowMenu(m, 'changes:src/b.js');
      for (const pop of document.querySelectorAll('.juggler-context-menu')) pop.remove();
      const scope = m.body.querySelector('.git-history__scope');
      const reflog = /** @type {{label: string}} */ (await waitFor(() => pickerChoices(scope).find((c) => c.value === 'reflog'), 'the Reflog choice'));
      const shown = [...labels, reflog.label];
      const raw = shown.filter((x) => x.trim() && !isPseudoLocalized(x) && /[A-Za-z]/.test(x));
      assert(shown.length >= 4, `expected text: ${JSON.stringify(shown)}`);
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      m.teardown();
    }, {
      '@juggler/core': [
        'File history', 'Reflog', 'Stage', 'Discard changes (undoable)', 'Open', 'Add to pinboard', 'Copy path', 'Update submodule',
        'Current branch', 'All refs',
      ],
    });
  });

  return { passed, failed, errors };
}
