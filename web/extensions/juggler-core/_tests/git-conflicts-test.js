//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Git pin tests for the files in conflict in Changes: a row's Ours and Theirs,
 * the detail's Take ours, Take theirs and Mark resolved, the row's menu, each
 * resolve moving the row at once with an Undo, and a file still holding
 * conflict markers asked about before it is marked resolved. The fake services
 * are git-pin-helpers'.
 * @module _tests/git-conflicts-test
 */

import GitPin from '../pins/git-pin.js';
import { assert, waitFor } from '../../../js-tests/utilities/test-helpers.js';
import { underPseudoLocale } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';
import { changesOf, mountPin, patchOf, shaOf } from './git-pin-helpers.js';

/** The commit a rebase stopped on. */
const PICKED = shaOf(5);
/** The save a resolve names in its result. */
const SAVE = 'd'.repeat(40);

/**
 * A tree rebasing feat onto develop with src/a.js in conflict, and one file
 * changed besides.
 * @returns {any} Its changes.
 */
const rebasing = () => changesOf([
  { path: 'src/a.js', index: 'U', worktree: 'U', conflicted: true },
  { path: 'notes.md', index: '.', worktree: 'M', unstaged: { added: 1, removed: 0 } },
], {
  branch: '', detached: true, operation: 'rebase',
  stopped: { kind: 'rebase', branch: 'feat', other: 'develop', otherSha: shaOf(1), commit: { sha: PICKED, subject: 'Teach it' }, step: 1, steps: 2 },
});

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
  const KEY = 'conflicts:src/a.js';

  /**
   * @param {any} m - The mounted pin.
   * @param {string} key - A row's key.
   * @returns {HTMLElement|null} The row, when drawn.
   */
  const row = (m, key) => /** @type {HTMLElement|null} */ (m.body.querySelector(`.git-changes__row[data-key="${key}"]`));
  /**
   * @param {any} m - The mounted pin.
   * @param {string} key - A row's key.
   * @param {string} selector - Within it.
   * @returns {HTMLElement} The element.
   */
  const inRow = (m, key, selector) => {
    const found = /** @type {HTMLElement|null} */ (row(m, key)?.querySelector(selector) || null);
    if (!found) throw new Error(`no ${selector} in ${key}`);
    return found;
  };
  /**
   * Mount in Changes on the rebase, and wait for its rows.
   * @returns {Promise<any>} The mounted pin.
   */
  const mounted = async () => {
    const m = mountPin(pin, {
      place: 'changes', changes: rebasing(),
      patch: (/** @type {string} */ _repo, /** @type {string} */ path) => patchOf(path, { conflicted: true, status: 'conflicted' }),
    });
    await waitFor(() => row(m, KEY) && row(m, 'changes:notes.md'), 'the rows');
    return m;
  };
  /**
   * @param {any} m - The mounted pin.
   * @param {string} cls - A crumb button's class, after `git-changes__crumb-`.
   * @returns {HTMLButtonElement} It.
   */
  const crumbButton = (m, cls) => {
    const found = /** @type {HTMLButtonElement|null} */ (m.body.querySelector(`.git-changes__crumb .git-changes__crumb-${cls}`));
    if (!found) throw new Error(`no crumb ${cls}: ${m.body.querySelector('.git-changes__crumb')?.textContent}`);
    return found;
  };
  /**
   * Select the conflicted file and wait for its diff.
   * @param {any} m - The mounted pin.
   */
  const open = async (m) => {
    inRow(m, KEY, '.git-changes__path').click();
    await waitFor(() => m.diffs().some((/** @type {any} */ d) => d.path === 'src/a.js'), 'its diff to be read');
  };
  /** @returns {string[]} The open menu's rows' words. */
  const menuLabels = () => [...document.querySelectorAll('.juggler-context-menu .menu-item')].map((el) => el.textContent || '');
  /**
   * @param {HTMLElement} el - What to right-click.
   */
  const rightClick = (el) => {
    el.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
  };
  /**
   * @param {any} m - The mounted pin.
   * @returns {Promise<HTMLElement>} The toast's Undo, once it is up.
   */
  const undoButton = (m) => /** @type {Promise<HTMLElement>} */ (waitFor(
    () => m.body.querySelector('.git-pin__toast:not([hidden]) .git-pin__toast-undo:not([hidden])'), 'the Undo'));

  await test('a conflicted row takes either side at once, naming the rebase’s sides for what they are', async () => {
    const m = await mounted();
    const ours = inRow(m, KEY, '.git-changes__side[data-side="ours"]');
    const theirs = inRow(m, KEY, '.git-changes__side[data-side="theirs"]');
    assert(ours.title === 'Take develop’s version', `ours: ${ours.title}`);
    assert(theirs.title === `Take yours (${PICKED.slice(0, 7)})`, `theirs: ${theirs.title}`);
    assert(!row(m, KEY)?.querySelector('.git-changes__nums'), 'a conflict has no line counts');

    m.holdRuns(true);
    inRow(m, KEY, '.git-changes__path').click();
    ours.click();
    await waitFor(() => m.runs().length === 1, 'the resolve');
    const op = m.runs()[0].op;
    assert(op.kind === 'resolve' && op.path === 'src/a.js' && op.mode === 'ours' && !op.force, `sent ${JSON.stringify(op)}`);
    await waitFor(() => !row(m, KEY) && row(m, 'staged:src/a.js')?.dataset.pending === 'true', 'the row to move to Staged at once');
    assert(row(m, 'staged:src/a.js')?.getAttribute('aria-selected') === 'true', 'the selection follows the file');
    m.teardown();
  });

  await test('the detail shows the conflict and offers each way; markers are asked about, then forced', async () => {
    const m = await mounted();
    await open(m);
    const asked = m.diffs().find((/** @type {any} */ d) => d.path === 'src/a.js');
    assert(asked.options?.scope === '@uncommitted', `the diff is of the working file: ${JSON.stringify(asked.options)}`);
    assert(!m.body.querySelector('.git-changes__viewer')?.hasAttribute('hidden'), 'the diff is shown');
    const labels = ['ours', 'theirs', 'resolved'].map((c) => crumbButton(m, c).textContent);
    assert(JSON.stringify(labels) === JSON.stringify(['Take ours', 'Take theirs', 'Mark resolved']), `crumb: ${JSON.stringify(labels)}`);
    assert(crumbButton(m, 'ours').title === 'Take develop’s version', `crumb ours: ${crumbButton(m, 'ours').title}`);

    m.holdRuns(true);
    crumbButton(m, 'resolved').click();
    await waitFor(() => m.runs().length === 1, 'the resolve');
    assert(m.runs()[0].op.mode === 'resolved' && !m.runs()[0].op.force, `sent ${JSON.stringify(m.runs()[0].op)}`);
    m.failRun(0, { kind: 'markers', message: 'src/a.js still has conflict markers.' });
    const question = /** @type {Element} */ (await waitFor(() => document.querySelector('.git-pop .git-pop__text'), 'the question'));
    assert(question.textContent === 'a.js still has conflict markers. Mark it resolved anyway?', `asked: ${question.textContent}`);
    assert(Boolean(row(m, KEY)), 'the row is back in Conflicts meanwhile');
    /** @type {HTMLElement} */ (document.querySelector('.git-pop .git-pop__ok')).click();
    await waitFor(() => m.runs().length === 2, 'the forced resolve');
    const op = m.runs()[1].op;
    assert(op.kind === 'resolve' && op.mode === 'resolved' && op.force === true, `sent ${JSON.stringify(op)}`);
    m.teardown();
  });

  await test('Undo unresolves, naming the save', async () => {
    const m = await mounted();
    m.holdRuns(true);
    inRow(m, KEY, '.git-changes__side[data-side="theirs"]').click();
    await waitFor(() => m.runs().length === 1, 'the resolve');
    m.finishRun(0, { result: { discard: SAVE } });
    (await undoButton(m)).click();
    await waitFor(() => m.runs().length === 2, 'the unresolve');
    const op = m.runs()[1].op;
    assert(op.kind === 'unresolve' && op.path === 'src/a.js' && op.discard === SAVE, `sent ${JSON.stringify(op)}`);
    await waitFor(() => row(m, KEY), 'the row back in Conflicts at once');
    m.teardown();
  });

  await test('right-click on a conflict offers its ways and the editor; on a change, staging', async () => {
    const m = await mounted();
    rightClick(/** @type {HTMLElement} */ (row(m, KEY)));
    const want = ['Take ours', 'Take theirs', 'Mark resolved', 'Open in editor', 'Add to pinboard', 'Copy path'];
    assert(JSON.stringify(menuLabels()) === JSON.stringify(want), `conflict menu: ${JSON.stringify(menuLabels())}`);
    for (const el of document.querySelectorAll('.juggler-context-menu')) el.remove();

    rightClick(/** @type {HTMLElement} */ (row(m, 'changes:notes.md')));
    assert(menuLabels()[0] === 'Stage' && menuLabels().includes('Discard changes (undoable)'), `change menu: ${JSON.stringify(menuLabels())}`);
    m.teardown();
  });

  /** The pin's own words the case below draws, registered pseudo-localised. */
  const CORE_TEXT = [
    'Ours', 'Theirs', 'Take ours', 'Take theirs', 'Mark resolved', 'Take yours ({name})', 'Stage the file as it is now',
    '{kind, select, revert {Take the version without {name}} other {Take {name}’s version}}',
    '{name} still has conflict markers. Mark it resolved anyway?', 'Open in editor', 'Add to pinboard', 'Copy path', 'Cancel',
  ];

  await test('en-XA: what a conflict offers speaks the user\u2019s language', async () => {
    await underPseudoLocale('git-conflicts-test', async () => {
      const m = await mounted();
      const sides = [...(row(m, KEY)?.querySelectorAll('.git-changes__side') || [])]
        .flatMap((b) => [b.textContent || '', /** @type {HTMLElement} */ (b).title]);
      await open(m);
      const crumb = ['ours', 'theirs', 'resolved'].flatMap((c) => [crumbButton(m, c).textContent || '', crumbButton(m, c).title]);
      rightClick(/** @type {HTMLElement} */ (row(m, KEY)));
      const menu = menuLabels();
      for (const el of document.querySelectorAll('.juggler-context-menu')) el.remove();
      m.holdRuns(true);
      crumbButton(m, 'resolved').click();
      await waitFor(() => m.runs().length === 1, 'the resolve');
      m.failRun(0, { kind: 'markers' });
      await waitFor(() => document.querySelector('.git-pop .git-pop__text'), 'the question');
      const question = [...document.querySelectorAll('.git-pop .git-pop__text, .git-pop button')].map((el) => el.textContent || '');
      const shown = [...sides, ...crumb, ...menu, ...question].filter(Boolean);
      // Branch names, file names and short ids are data, not words.
      const data = /\b(develop|a\.js)\b|\b[a-f0-9]{7}\b/g;
      const raw = shown.map((x) => x.trim()).filter((x) => x && !isPseudoLocalized(x) && /[A-Za-z]/.test(x.replace(data, '')));
      assert(sides.length === 4 && menu.length === 6 && question.length >= 3, `expected text: ${JSON.stringify(shown)}`);
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      m.teardown();
    }, { '@juggler/core': CORE_TEXT });
  });

  return { passed, failed, errors };
}
