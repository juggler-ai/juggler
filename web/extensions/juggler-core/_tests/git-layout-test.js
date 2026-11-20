//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Git pin tests for its sizes: which mode a size puts it in, the Refs sidebar
 * a full-width pin shows beside Changes and History, and the chip's commit
 * popover. The fake services are git-pin-helpers'.
 * @module _tests/git-layout-test
 */

import GitPin from '../pins/git-pin.js';
import { assert, waitFor } from '../../../js-tests/utilities/test-helpers.js';
import { changesOf, mountPin, refsOf, shaOf, treeOf } from './git-pin-helpers.js';

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
  const staged = { path: 'a.js', index: 'M', worktree: '.', staged: { added: 1, removed: 0 } };

  /**
   * @param {any} m - The mounted pin.
   * @returns {HTMLElement} The pin's root.
   */
  const rootOf = (m) => /** @type {HTMLElement} */ (m.body.querySelector('.git-pin'));
  /**
   * @param {any} m - The mounted pin.
   * @returns {HTMLElement} The Refs place.
   */
  const refsPlace = (m) => /** @type {HTMLElement} */ (m.body.querySelector('.git-pin__place--refs'));

  await test('each size puts the pin in its mode, and only a full one shows the Refs sidebar', async () => {
    /** @type {[string, string, string][]} */
    const sizes = [['20rem', '30rem', 'stack'], ['48rem', '30rem', 'split'], ['70rem', '30rem', 'full'], ['30rem', '4rem', 'chip']];
    for (const [width, height, mode] of sizes) {
      // The mode, and the styles it decides, are the pin's at mount: no read
      // has to land first.
      const m = mountPin(pin, { place: 'changes', changes: changesOf([staged]), width, height });
      try {
        assert(rootOf(m).dataset.mode === mode, `${width}×${height} is ${mode}: ${rootOf(m).dataset.mode}`);
        const sidebar = getComputedStyle(refsPlace(m)).display !== 'none';
        assert(sidebar === (mode === 'full'), `${mode}: the Refs sidebar is ${sidebar ? 'shown' : 'hidden'}`);
        if (mode === 'full') {
          const detail = /** @type {HTMLElement} */ (refsPlace(m).querySelector('.git-refs__detail'));
          assert(getComputedStyle(detail).display === 'none', 'the sidebar is the Refs list alone');
          const tab = /** @type {HTMLElement} */ (m.body.querySelector('.git-pin__place-btn[data-place="refs"]'));
          assert(getComputedStyle(tab).display === 'none', 'and the Refs tab gives way to it');
        }
        const places = /** @type {HTMLElement} */ (m.body.querySelector('.git-pin__places'));
        assert((getComputedStyle(places).display === 'none') === (mode === 'chip'), `${mode}: the switcher only goes in a chip`);
      } finally {
        m.teardown();
      }
    }
  });

  await test('a full pin never shows Refs as a place or a tab: Refs chosen is History with the sidebar', async () => {
    for (const place of ['refs', 'review']) {
      const m = mountPin(pin, { place, changes: changesOf([staged]), width: '70rem' });
      try {
        const tab = /** @type {HTMLElement} */ (m.body.querySelector('.git-pin__place-btn[data-place="refs"]'));
        assert(getComputedStyle(tab).display === 'none', `${place}: no Refs tab`);
        const shown = rootOf(m).dataset.place;
        assert(shown === (place === 'refs' ? 'history' : 'review'), `${place} shows ${shown}`);
        if (place === 'refs') {
          assert(getComputedStyle(refsPlace(m)).display !== 'none', 'with the Refs sidebar beside it');
          // Chosen, not shown: a narrower pin goes back to the Refs place.
          assert(m.configWrites().every((/** @type {any} */ w) => w.config.place !== 'history'), 'and Refs stays the place chosen');
        }
      } finally {
        m.teardown();
      }
    }
  });

  await test('a full pin reads the Refs sidebar beside Changes; a split one leaves Refs unread', async () => {
    const wide = mountPin(pin, { place: 'changes', changes: changesOf([staged]), width: '70rem' });
    const narrow = mountPin(pin, { place: 'changes', changes: changesOf([staged]), width: '48rem' });
    try {
      // A read is asked as it is requested, so mounting is the whole of it.
      const kinds = (/** @type {any} */ m) => m.reads().map((/** @type {any} */ r) => r.kind);
      assert(kinds(wide).includes('refs') && kinds(wide).includes('worktrees'), `full reads the sidebar: ${JSON.stringify(kinds(wide))}`);
      assert(!kinds(narrow).includes('refs'), `split does not: ${JSON.stringify(kinds(narrow))}`);
      // The project's lone checkout is no row of its own: the section is empty.
      await waitFor(() => wide.body.querySelector('.git-refs__sect[data-section="worktrees"][data-empty]'), 'the sidebar drawn');
    } finally {
      wide.teardown();
      narrow.teardown();
    }
  });

  await test('a click in the sidebar shows a branch in History, views a worktree, and reviews a stash', async () => {
    const tip = shaOf(7);
    const stash = shaOf(8);
    const m = mountPin(pin, {
      place: 'changes',
      changes: changesOf([staged]),
      width: '70rem',
      refs: refsOf({ branches: [{ name: 'feat', sha: tip, subject: 'Feat' }], stashes: [{ sha: stash, message: 'wip' }] }),
      worktrees: { repo: '', trees: [treeOf({ main: true, current: true }), treeOf({ path: '/tmp/wt', branch: 'other', tree: 'ws1' })] },
    });
    try {
      const row = (/** @type {string} */ key) => /** @type {HTMLElement|null} */ (m.body.querySelector(`.git-refs__row[data-key="${key}"]`));
      const click = (/** @type {string} */ key) => {
        const name = row(key)?.querySelector('.git-refs__name');
        if (!(name instanceof HTMLElement)) throw new Error(`no row ${key}`);
        name.click();
      };
      await waitFor(() => row('br:feat') && row('wt:/tmp/wt') && row(`st:${stash}`), 'the sidebar rows');
      click('br:feat');
      assert(rootOf(m).dataset.place === 'history', `a branch brings History forward: ${rootOf(m).dataset.place}`);
      await waitFor(() => m.reads().some((/** @type {any} */ r) => r.kind === 'commit' && r.options.commit === tip), 'its tip shown');

      click('wt:/tmp/wt');
      const write = m.configWrites().at(-1);
      assert(write?.config.workspace === 'ws1' && write.options.inPlace === true, `a worktree is viewed, in place: ${JSON.stringify(write)}`);

      // The tree it now views is read afresh, sidebar and all.
      await waitFor(() => row(`st:${stash}`), 'the new tree\'s sidebar');
      click(`st:${stash}`);
      assert(rootOf(m).dataset.place === 'review', `a stash opens Review: ${rootOf(m).dataset.place}`);
      const scoped = m.configWrites().map((/** @type {any} */ w) => w.config.scope).filter(Boolean);
      assert(scoped.includes(`${stash}^1..${stash}`), `on the stash's changes: ${JSON.stringify(scoped)}`);
    } finally {
      m.teardown();
    }
  });

  await test('a split keeps where it was left, moves with the arrow keys, is saved, and goes back on a double-click', async () => {
    // Stored past its bound, which it is held to.
    const m = mountPin(pin, { place: 'changes', changes: changesOf([staged]), width: '48rem', config: { splits: { changes: 0.95, nonsense: 3 } } });
    try {
      const list = /** @type {HTMLElement} */ (m.body.querySelector('.git-changes__list'));
      const handle = /** @type {HTMLElement} */ (m.body.querySelector('.git-changes__body > .git-split'));
      assert(getComputedStyle(handle).display !== 'none', 'a split shows its handle');
      const body = /** @type {HTMLElement} */ (m.body.querySelector('.git-changes__body'));
      const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
      // 85% of the body, less the 16rem the detail keeps.
      const widest = body.clientWidth - 16 * rem;
      assert(Math.abs(list.offsetWidth - widest) <= 1, `the list as wide as the detail lets it be: ${list.offsetWidth} vs ${widest}`);
      const before = Math.round(body.clientWidth * 0.42);
      handle.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
      assert(Math.abs(list.offsetWidth - before) <= 1, `a double-click puts it back: ${list.offsetWidth} vs ${before}`);
      assert(!('splits' in (m.configWrites().at(-1)?.config || {})), `and forgets it: ${JSON.stringify(m.configWrites().at(-1)?.config)}`);
      handle.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }));
      const write = m.configWrites().at(-1);
      assert(write?.config.splits?.changes === 0.44 && write.options.inPlace === true, `saved in place: ${JSON.stringify(write)}`);
      assert(list.offsetWidth > before, `the list grew: ${list.offsetWidth} > ${before}`);
    } finally {
      m.teardown();
    }
  });

  await test('a chip commits from a popover holding the commit box itself, which goes back when it closes', async () => {
    const m = mountPin(pin, { place: 'changes', changes: changesOf([staged]), width: '30rem', height: '4rem' });
    try {
      const primary = /** @type {HTMLButtonElement} */ (m.body.querySelector('.git-pin__primary'));
      await waitFor(() => primary.dataset.kind === 'commit', 'the Commit primary');
      const inList = () => Boolean(m.body.querySelector('.git-changes__list > .git-commit'));
      const popped = () => /** @type {HTMLTextAreaElement|null} */ (document.querySelector('.git-pop .git-commit .git-commit__msg'));
      assert(inList(), 'the box starts in the list');

      primary.click();
      assert(Boolean(popped()) && !inList(), 'Commit with no message opens the box on a popover');
      assert(/develop/.test(document.querySelector('.git-pop')?.textContent || ''), 'saying which branch it commits to');
      popped()?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      assert(!popped() && inList(), 'Escape puts it back');

      primary.click();
      const field = popped();
      if (!field) throw new Error('no popover the second time');
      field.value = 'From the chip';
      field.dispatchEvent(new Event('input', { bubbles: true }));
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true, cancelable: true }));
      const op = m.runs()[0]?.op;
      assert(op?.kind === 'commit' && op.message === 'From the chip', `⌘↵ commits what was typed there: ${JSON.stringify(op)}`);
      await waitFor(() => !popped() && inList(), 'the popover closed, the box home');
    } finally {
      m.teardown();
    }
  });

  return { passed, failed, errors };
}
