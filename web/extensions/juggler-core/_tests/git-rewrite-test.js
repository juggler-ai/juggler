//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Git pin rewrite tests — the History place's interactive-rebase verbs without
 * the editor: reword, fix up with what is staged, drop, and squash a marked
 * run; a pushed commit is rewritten only once confirmed, changes in the way are
 * stashed on request, and each rewrite toasts an Undo that resets back.
 * @module _tests/git-rewrite-test
 */

import GitPin from '../pins/git-pin.js';
import { assert, waitFor } from '../../../js-tests/utilities/test-helpers.js';
import { underPseudoLocale } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';
import { commitOf, historyOf, mountPin, refsOf, shaOf, treeOf } from './git-pin-helpers.js';

/** The commit the cases act on, HEAD, and where a rewrite leaves the branch. */
const SHA = shaOf(3);
const HEAD = shaOf(0);
const NEW = 'e'.repeat(40);

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
      for (const pop of document.querySelectorAll('.git-pop, .juggler-context-menu')) pop.remove();
    }
  }

  const pin = new GitPin();

  /**
   * Mount in History on branch main at HEAD, runs held, once the chips are drawn.
   * @returns {Promise<any>} The mounted pin.
   */
  const mounted = async () => {
    const m = mountPin(pin, {
      place: 'history',
      log: historyOf(40),
      commit: (/** @type {string} */ rev) => commitOf(rev),
      refs: refsOf({ branches: [{ name: 'main', sha: HEAD, subject: 'Tip', date: 0, ahead: 0, behind: 0, worktree: '/tmp/proj', head: true }] }),
      worktrees: { repo: '', trees: [treeOf({ main: true, current: true, branch: 'main', head: HEAD })] },
    });
    await waitFor(() => rowAt(m, 3) && rowAt(m, 0)?.querySelector('.git-history__chip'), 'the rows and their chips');
    m.holdRuns(true);
    return m;
  };
  /**
   * @param {any} m - The mounted pin.
   * @param {number} index - A row.
   * @returns {HTMLElement|null} It, when drawn.
   */
  const rowAt = (m, index) => /** @type {HTMLElement|null} */ (m.body.querySelector(`.git-history__row[data-index="${index}"]`));
  /**
   * Open a row's ⋯ menu.
   * @param {any} m - The mounted pin.
   * @param {number} index - The row.
   */
  const openMore = (m, index) => {
    const more = /** @type {HTMLElement|null} */ (rowAt(m, index)?.querySelector('.git-history__more') || null);
    if (!more) throw new Error(`row ${index} has no ⋯`);
    more.click();
  };
  /** @returns {HTMLElement[]} The open menu's rows. */
  const menuItems = () => /** @type {HTMLElement[]} */ ([...document.querySelectorAll('.juggler-context-menu .menu-item')]);
  /**
   * Open row `index`'s ⋯ menu and choose a row by the start of its words.
   * @param {any} m - The mounted pin.
   * @param {number} index - The row.
   * @param {string} label - The menu row.
   */
  const choose = (m, index, label) => {
    openMore(m, index);
    const found = menuItems().find((el) => (el.textContent || '').startsWith(label));
    if (!found) throw new Error(`no menu row "${label}": ${JSON.stringify(menuItems().map((el) => el.textContent))}`);
    found.click();
  };
  /**
   * @param {string} selector - Within the open popover.
   * @returns {Promise<HTMLElement>} It, once open.
   */
  const inPop = (selector) => /** @type {Promise<HTMLElement>} */ (waitFor(() => document.querySelector(`.git-pop ${selector}, .git-ask-dialog.is-open ${selector}`), `${selector} in a popover`));
  /**
   * @param {any} m - The mounted pin.
   * @param {string} cls - `undo` or `action`.
   * @returns {Promise<HTMLElement>} That button on the toast.
   */
  const toastButton = (m, cls) => /** @type {Promise<HTMLElement>} */ (waitFor(
    () => m.body.querySelector(`.git-pin__toast:not([hidden]) .git-pin__toast-${cls}:not([hidden])`), `the toast's ${cls} button`));
  /**
   * @param {any} m - The mounted pin.
   * @returns {string} The toast's words.
   */
  const toastText = (m) => m.body.querySelector('.git-pin__toast:not([hidden]) .git-pin__toast-text')?.textContent || '';
  /**
   * @param {any} a - An op.
   * @param {Record<string, any>} b - What it should be.
   * @returns {boolean} Whether they hold the same fields.
   */
  const same = (a, b) => {
    /**
     * @param {any} o - An object.
     * @returns {string} Its fields, sorted.
     */
    const norm = (o) => JSON.stringify(Object.entries(o || {}).sort(([x], [y]) => x.localeCompare(y)));
    return norm(a) === norm(b);
  };
  /**
   * @param {any} m - The mounted pin.
   * @param {number} index - Which run.
   * @returns {any} The op it sent.
   */
  const opAt = (m, index) => m.runs()[index]?.op;

  await test('the menu offers Edit commit message, Fix up and Drop between Revert and the resets', async () => {
    const m = await mounted();
    openMore(m, 3);
    const labels = menuItems().map((el) => el.textContent || '');
    const at = labels.indexOf('Revert');
    assert(JSON.stringify(labels.slice(at + 1, at + 4)) === JSON.stringify(['Edit commit message…', 'Fix up with staged changes', 'Drop commit']),
      `after Revert: ${JSON.stringify(labels)}`);
    assert((labels[at + 4] || '').startsWith('Reset main here'), `then the resets: ${JSON.stringify(labels)}`);
    m.teardown();
  });

  await test('Edit commit message asks for the message, prefilled, and Undo resets back softly', async () => {
    const m = await mounted();
    choose(m, 3, 'Edit commit message…');
    const box = /** @type {HTMLTextAreaElement} */ (await inPop('textarea.git-pop__input'));
    await waitFor(() => box.value === 'Subject of 0003\n\nBody of 0003', `the commit's message: ${JSON.stringify(box.value)}`);
    box.value = 'Better words\n\nAnd why';
    box.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
    assert(same(opAt(m, 0), { repo: '', kind: 'reword', rev: SHA, message: 'Better words\n\nAnd why', expectHead: HEAD }),
      `reword ${JSON.stringify(opAt(m, 0))}`);
    m.finishRun(0, { result: { sha: HEAD, head: NEW } });
    (await toastButton(m, 'undo')).click();
    assert(same(opAt(m, 1), { repo: '', kind: 'reset', rev: HEAD, mode: 'soft', expectHead: NEW }), `undo ${JSON.stringify(opAt(m, 1))}`);
    m.teardown();
  });

  await test('a pushed commit is rewritten only once confirmed, then with force', async () => {
    const m = await mounted();
    choose(m, 3, 'Drop commit');
    assert(same(opAt(m, 0), { repo: '', kind: 'drop', rev: SHA, expectHead: HEAD }), `drop ${JSON.stringify(opAt(m, 0))}`);
    m.failRun(0, { kind: 'published', message: 'It is already on origin/main.' });
    (await inPop('.git-pop__ok')).click();
    assert(same(opAt(m, 1), { repo: '', kind: 'drop', rev: SHA, expectHead: HEAD, force: true }), `forced ${JSON.stringify(opAt(m, 1))}`);
    m.finishRun(1, { result: { sha: HEAD, head: NEW } });
    (await toastButton(m, 'undo')).click();
    assert(same(opAt(m, 2), { repo: '', kind: 'reset', rev: HEAD, mode: 'keep', expectHead: NEW }),
      `a drop's undo keeps local changes: ${JSON.stringify(opAt(m, 2))}`);
    m.teardown();
  });

  await test('Fix up with changes in the way offers to stash them and try again', async () => {
    const m = await mounted();
    choose(m, 3, 'Fix up with staged changes');
    assert(same(opAt(m, 0), { repo: '', kind: 'fixup', rev: SHA, expectHead: HEAD }), `fixup ${JSON.stringify(opAt(m, 0))}`);
    m.failRun(0, { kind: 'dirty', message: 'Local changes are in the way.' });
    (await toastButton(m, 'action')).click();
    assert(same(opAt(m, 1), { repo: '', kind: 'fixup', rev: SHA, expectHead: HEAD, dirty: 'stash' }), `retry ${JSON.stringify(opAt(m, 1))}`);
    m.finishRun(1, { result: { sha: HEAD, head: NEW } });
    await toastButton(m, 'undo');
    assert(toastText(m).includes(SHA.slice(0, 7)), `the toast names the commit: ${toastText(m)}`);
    m.teardown();
  });

  await test('a marked run offers Squash, oldest to newest', async () => {
    const m = await mounted();
    // Rows 2, 3 and 4 are one line: the side branch row 0 merges.
    /** @type {HTMLElement} */ (rowAt(m, 2)).click();
    /** @type {HTMLElement} */ (rowAt(m, 4)).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    const squash = /** @type {HTMLElement} */ (await waitFor(() => m.body.querySelector('.git-history__squash'), 'a Squash button'));
    assert(squash.textContent === 'Squash 3 commits', `its words: ${squash.textContent}`);
    squash.click();
    assert(same(opAt(m, 0), { repo: '', kind: 'squash', rev: shaOf(4), sha: shaOf(2), expectHead: HEAD }), `squash ${JSON.stringify(opAt(m, 0))}`);
    m.teardown();
  });

  await test('a marked pair that is not one line of commits offers no Squash', async () => {
    const m = await mounted();
    // Row 1's parent is row 4; row 3 is on the side branch drawn between.
    /** @type {HTMLElement} */ (rowAt(m, 1)).click();
    /** @type {HTMLElement} */ (rowAt(m, 3)).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    await waitFor(() => m.body.querySelector('.git-history__compare'), 'the pair offered for comparing');
    assert(!m.body.querySelector('.git-history__squash'), 'but not for squashing');
    m.teardown();
  });

  /** The pin's own words the case below draws, registered pseudo-localised. */
  const CORE_TEXT = [
    'Edit commit message…', 'Fix up with staged changes', 'Drop commit', 'Rewrite anyway', 'Cancel', 'Undo', 'Save message',
    'Checkout (detached)', 'Branch here…', 'Tag here…', 'New worktree from here…', 'Cherry-pick onto {branch}', 'Revert',
    'Reset {branch} here — keep changes staged', 'Reset {branch} here — keep changes', 'Reset {branch} here — discard changes…', 'Copy SHA',
    'New message for {sha}',
    '{sha} is already pushed. Rewriting it means the branch can only be pushed by force afterwards.',
    'Dropped {sha}', 'Changed the message of {sha}',
  ];

  await test('en-XA: the rewrites speak the user\u2019s language', async () => {
    await underPseudoLocale('git-rewrite-test', async () => {
      const m = await mounted();
      openMore(m, 3);
      const rows = menuItems().map((el) => el.textContent || '');
      // Drop: before the three resets and Copy SHA.
      const drop = /** @type {HTMLElement} */ (menuItems().at(-5));
      drop.click();
      m.failRun(0, { kind: 'published', message: 'x' });
      await inPop('.git-pop__ok');
      const question = [...document.querySelectorAll('.git-pop .git-pop__text, .git-pop button')].map((el) => el.textContent || '');
      /** @type {HTMLElement} */ (document.querySelector('.git-pop .git-pop__ok')).click();
      m.finishRun(1, { result: { sha: HEAD, head: NEW } });
      await toastButton(m, 'undo');
      const toast = [...m.body.querySelectorAll('.git-pin__toast-text, .git-pin__toast-undo')].map((el) => el.textContent || '');
      const shown = [...rows, ...question, ...toast];
      const data = /\bmain\b|\b[a-f0-9]{7}\b/g;
      const raw = shown.map((x) => x.trim()).filter((x) => x && !isPseudoLocalized(x) && /[A-Za-z]/.test(x.replace(data, '')));
      assert(rows.length >= 12 && question.length >= 3 && toast.length >= 2, `expected text: ${JSON.stringify(shown)}`);
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      m.teardown();
    }, { '@juggler/core': CORE_TEXT });
  });

  return { passed, failed, errors };
}
