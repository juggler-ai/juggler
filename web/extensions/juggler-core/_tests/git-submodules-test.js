//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Git pin tests for submodules: the Refs place's Submodules section and its
 * Update, with Undo; Update from a submodule's row in Changes; and the head
 * showing an update running. The fake services are git-pin-helpers'.
 * @module _tests/git-submodules-test
 */

import GitPin from '../pins/git-pin.js';
import { assert, waitFor } from '../../../js-tests/utilities/test-helpers.js';
import { underPseudoLocale } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';
import { changesOf, mountPin, shaOf } from './git-pin-helpers.js';

/** What the library's submodule records, and the commit it has out instead. */
const RECORDED = shaOf(1, 'b');
const HEAD = shaOf(2, 'b');

/** A repository with a submodule moved off its recorded commit, and one never checked out. */
const SUBMODULES = {
  repo: '',
  truncated: false,
  submodules: [
    { name: 'lib', path: 'lib', url: '../lib.git', recorded: RECORDED, head: HEAD, branch: 'topic', state: 'moved' },
    { name: 'un', path: 'vendor/un', url: '../un.git', recorded: shaOf(3, 'b'), state: 'uninitialized' },
  ],
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
      for (const pop of document.querySelectorAll('.git-pop, .juggler-context-menu')) pop.remove();
    }
  }

  const pin = new GitPin();

  /**
   * @param {any} m - The mounted pin.
   * @param {string} key - A Refs row's key.
   * @returns {HTMLElement|null} The row.
   */
  const refRow = (m, key) => m.body.querySelector(`.git-refs__row[data-key="${key}"]`);
  /**
   * Click a Refs row, opening its detail.
   * @param {any} m - The mounted pin.
   * @param {string} key - The row's key.
   */
  const openRow = (m, key) => {
    const name = refRow(m, key)?.querySelector('.git-refs__name');
    if (!(name instanceof HTMLElement)) throw new Error(`no row ${key}`);
    name.click();
  };
  /**
   * @param {any} m - The mounted pin.
   * @returns {HTMLButtonElement|null} The toast's Undo, while it is up.
   */
  const undoButton = (m) => m.body.querySelector('.git-pin__toast:not([hidden]) .git-pin__toast-undo:not([hidden])');
  /**
   * @param {any} m - The mounted pin.
   * @param {string} key - The key pressed.
   */
  const press = (m, key) => {
    m.body.querySelector('.git-pin').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  };

  await test('Refs lists the submodules, and Update checks one out at its recorded commit, with Undo', async () => {
    const m = mountPin(pin, { place: 'refs', submodules: SUBMODULES });
    try {
      await waitFor(() => refRow(m, 'sm:lib') && refRow(m, 'sm:vendor/un'), 'the Submodules section');
      assert(/topic/.test(refRow(m, 'sm:lib')?.textContent || ''), `a moved one says what it has out: ${refRow(m, 'sm:lib')?.textContent}`);
      openRow(m, 'sm:lib');
      const update = /** @type {HTMLButtonElement|null} */ (await waitFor(
        () => m.body.querySelector('.git-refs__act[data-action="submodule-update"]'), 'its Update'));
      assert(Boolean(update) && !update?.disabled, 'Update is offered');
      m.holdRuns(true);
      update?.click();
      const op = m.runs()[0]?.op;
      assert(op?.kind === 'submodule-update' && op.repo === '' && op.path === 'lib', `Update's write: ${JSON.stringify(op)}`);
      m.finishRun(0, { result: { sha: HEAD, branch: 'topic' } });
      /** @type {HTMLElement} */ (await waitFor(() => undoButton(m), 'the Updated toast')).click();
      const undo = m.runs()[1]?.op;
      assert(undo?.kind === 'switch' && undo.repo === 'lib' && undo.branch === 'topic',
        `Undo switches the submodule's own repository back: ${JSON.stringify(undo)}`);

      openRow(m, 'sm:vendor/un');
      const open = /** @type {HTMLButtonElement|null} */ (await waitFor(
        () => m.body.querySelector('.git-refs__act[data-action="open-repo"]'), 'its Open as repository'));
      assert(Boolean(open?.disabled), 'one never checked out cannot be opened');
    } finally {
      m.teardown();
    }
  });

  await test('a submodule changed in Changes offers Update, in its menu and its detail, and no Discard', async () => {
    const lib = { path: 'lib', index: '.', worktree: 'M', submodule: true, submoduleCommit: true };
    const m = mountPin(pin, { place: 'changes', changes: changesOf([lib]) });
    try {
      const row = /** @type {HTMLElement} */ (await waitFor(() => m.body.querySelector('.git-changes__row[data-key="changes:lib"]'), 'the row'));
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
      const labels = [...document.querySelectorAll('.juggler-context-menu .menu-item')].map((el) => el.textContent);
      assert(labels.includes('Update submodule'), `its menu: ${JSON.stringify(labels)}`);
      // Its change is the commit it is checked out at: Update is what puts that
      // back, and a discard, which saves and restores files, has no file to save.
      assert(!labels.includes('Discard changes (undoable)'), `its menu offers no Discard: ${JSON.stringify(labels)}`);
      for (const el of document.querySelectorAll('.juggler-context-menu')) el.remove();

      /** @type {HTMLElement} */ (row.querySelector('.git-changes__path') || row).click();
      const update = /** @type {HTMLButtonElement} */ (await waitFor(() => m.body.querySelector('.git-changes__crumb-update'), 'the detail\u2019s Update'));
      assert(!m.body.querySelector('.git-changes__crumb-discard'), 'its detail offers no Discard');
      update.click();
      const op = m.runs()[0]?.op;
      assert(op?.kind === 'submodule-update' && op.path === 'lib', `Update's write: ${JSON.stringify(op)}`);
    } finally {
      m.teardown();
    }
  });

  await test('a submodule whose commit is staged and which has edits inside offers no second Stage', async () => {
    // `git add` of a submodule records only its checked-out commit, so edits
    // inside it are listed, as git status lists them, but nothing here stages them.
    const lib = { path: 'lib', index: 'M', worktree: 'M', submodule: true, submoduleModified: true, submoduleUntracked: true };
    const m = mountPin(pin, { place: 'changes', changes: changesOf([lib]) });
    try {
      const row = /** @type {HTMLElement} */ (await waitFor(() => m.body.querySelector('.git-changes__row[data-key="changes:lib"]'), 'its Changes row'));
      assert(Boolean(m.body.querySelector('.git-changes__row[data-key="staged:lib"]')), 'its commit is listed as staged');
      const text = row.textContent || '';
      assert(/modified content/.test(text) && /untracked content/.test(text), `the row says what changed inside: ${text}`);
      assert(!row.querySelector('.git-changes__part'), 'it is not drawn as partly staged');

      m.holdRuns(true);
      /** @type {HTMLElement} */ (row.querySelector('.git-changes__st')).click();
      /** @type {HTMLElement} */ (row.querySelector('.git-changes__path')).dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
      /** @type {HTMLElement|null} */ (m.body.querySelector('.git-changes__group-act[data-group="changes"]'))?.click();
      assert(m.runs().length === 0, `nothing was run: ${JSON.stringify(m.runs().map((/** @type {any} */ r) => r.op))}`);
      assert(Boolean(m.body.querySelector('.git-changes__row[data-key="changes:lib"]')), 'and the row stays in Changes');

      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
      const labels = [...document.querySelectorAll('.juggler-context-menu .menu-item')].map((el) => el.textContent);
      for (const label of ['Stage', 'Update submodule', 'Discard changes (undoable)']) {
        assert(!labels.includes(label), `its menu offers no ${label}: ${JSON.stringify(labels)}`);
      }
      for (const el of document.querySelectorAll('.juggler-context-menu')) el.remove();

      /** @type {HTMLElement} */ (row.querySelector('.git-changes__path')).click();
      await waitFor(() => m.body.querySelector('.git-changes__crumb-title'), 'its detail');
      for (const cls of ['stage', 'update', 'discard']) {
        assert(!m.body.querySelector(`.git-changes__crumb-${cls}`), `its detail offers no ${cls}`);
      }
      press(m, ' ');
      assert(m.runs().length === 0, `space runs nothing: ${JSON.stringify(m.runs().map((/** @type {any} */ r) => r.op))}`);
    } finally {
      m.teardown();
    }
  });

  await test('an update running shows on the head, which can stop it', async () => {
    const m = mountPin(pin, { place: 'changes', changes: changesOf([]) });
    try {
      const primary = /** @type {HTMLButtonElement} */ (m.body.querySelector('.git-pin__primary'));
      const refresh = /** @type {HTMLElement} */ (m.body.querySelector('.git-pin__refresh'));
      await waitFor(() => primary.dataset.kind, 'the head');
      m.emitJob({ id: 'job_9', workspace: '', repo: '', kind: 'submodule-update', commands: [], state: 'running', output: '', errorKind: '', result: {} });
      await waitFor(() => refresh.classList.contains('git-pin__refresh--stop'), 'Refresh to stop it');
      assert(refresh.title === 'Updating… — click to stop', `it says what it is doing: ${refresh.title}`);
      assert(refresh.getAttribute('aria-busy') === 'true', 'Refresh is not busy while it runs');
    } finally {
      m.teardown();
    }
  });

  /** The English this suite's en-XA case shows, registered pseudo-localised. */
  const CORE_TEXT = [
    'Submodules', '{head}, not {recorded}', 'not checked out', 'State', 'Recorded', 'HEAD', 'URL', 'Update',
    'Open as repository', 'Check out {sha}, the commit recorded for it', 'Updated submodule {name}', 'Undo',
    'Commit to {branch}', 'Update submodule', 'Check the submodule out at the commit recorded for it',
  ];

  await test('en-XA: submodules, their Update, and the chip\u2019s commit popover speak the user\u2019s language', async () => {
    await underPseudoLocale('git-submodules-test', async () => {
      const m = mountPin(pin, { place: 'refs', submodules: SUBMODULES });
      const chip = mountPin(pin, {
        place: 'changes', width: '30rem', height: '4rem',
        changes: changesOf([{ path: 'a.js', index: 'M', worktree: '.', staged: { added: 1, removed: 0 } }]),
      });
      try {
        await waitFor(() => refRow(m, 'sm:lib'), 'the Submodules section');
        openRow(m, 'sm:lib');
        const update = /** @type {HTMLButtonElement} */ (await waitFor(
          () => m.body.querySelector('.git-refs__act[data-action="submodule-update"]'), 'its Update'));
        const shown = [
          m.body.querySelector('.git-refs__sect[data-section="submodules"] .git-refs__title')?.textContent || '',
          refRow(m, 'sm:lib')?.querySelector('.git-refs__dir')?.textContent || '',
          ...[...m.body.querySelectorAll('.git-refs__detail dt, .git-refs__detail .git-refs__act')].map((el) => el.textContent || ''),
          update.title,
        ];
        update.click();
        const toast = /** @type {HTMLElement} */ (await waitFor(() => m.body.querySelector('.git-pin__toast:not([hidden]) .git-pin__toast-text'), 'the toast'));
        shown.push(toast.textContent || '');
        const primary = /** @type {HTMLButtonElement} */ (chip.body.querySelector('.git-pin__primary'));
        await waitFor(() => primary.dataset.kind === 'commit', 'the chip\u2019s Commit');
        primary.click();
        shown.push(document.querySelector('.git-pop .git-pop__title')?.textContent || '');
        // Paths, branch names and short ids are data, not words.
        const data = /\b(lib|topic|develop|vendor\/un)\b|\b[a-f0-9]{7}\b|\.\.\/\w+\.git/g;
        const raw = shown.map((x) => x.trim())
          .filter((x) => x && !isPseudoLocalized(x) && /[A-Za-z]/.test(x.replace(data, '')));
        assert(shown.every(Boolean), `expected text: ${JSON.stringify(shown)}`);
        assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      } finally {
        m.teardown();
        chip.teardown();
      }
    }, { '@juggler/core': CORE_TEXT });
  });

  return { passed, failed, errors };
}
