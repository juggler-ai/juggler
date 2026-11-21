//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Git pin windowed list tests — the Changes and Refs places drawing a big
 * list a window at a time: few elements for thousands of rows, a scroll
 * bringing later rows in, `j` keeping the selection drawn and in view,
 * staging a row far down, the filter over a big list, and the elements of
 * rows that stay in the window surviving a redraw, and a retained element
 * giving way to the row that takes its place. The fake services are
 * git-pin-helpers'.
 * @module _tests/git-virtual-list-test
 */

import GitPin from '../pins/git-pin.js';
import { assert, nextTask, waitFor } from '../../../js-tests/utilities/test-helpers.js';
import { isolateFocus } from '../../../js-tests/utilities/isolate-focus.js';
import { changesOf, mountPin, refsOf, treeOf } from './git-pin-helpers.js';
import { createElement } from 'juggler/ui';
import { createVirtualList } from 'juggler/utils/virtual-list';

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
    }
  }

  const pin = new GitPin();
  const BIG = 2000;
  /**
   * @param {number} i - A file's number.
   * @returns {string} Its path.
   */
  const pathOf = (i) => `f${String(i).padStart(4, '0')}.txt`;
  const bigChanges = () => changesOf(Array.from({ length: BIG }, (_, i) => ({
    path: pathOf(i), index: '.', worktree: 'M', unstaged: { added: 1, removed: 0 },
  })));

  /**
   * @param {object} [options] - Passed to `mountPin`.
   * @returns {Promise<any>} The pin, mounted in Changes with its first read drawn.
   */
  const mountedChanges = async (options = {}) => {
    const m = mountPin(pin, { place: 'changes', changes: bigChanges(), ...options });
    await waitFor(() => m.body.querySelector('.git-changes__row'), 'the changes to be drawn');
    return m;
  };
  /**
   * @param {any} m - The mounted pin.
   * @returns {HTMLElement} The Changes scroller.
   */
  const changesScroller = (m) => m.body.querySelector('.git-changes__scroll');
  /**
   * @param {any} m - The mounted pin.
   * @param {string} key - `group:path`.
   * @returns {HTMLElement|null} That row, when drawn.
   */
  const changeRow = (m, key) => m.body.querySelector(`.git-changes__row[data-key="${CSS.escape(key)}"]`);
  /**
   * @param {any} m - The mounted pin.
   * @returns {string[]} The keys of the rows drawn.
   */
  const changeKeys = (m) => [...m.body.querySelectorAll('.git-changes__row')].map((r) => r.getAttribute('data-key') || '');
  /**
   * @param {any} m - The mounted pin.
   * @param {string} key - The key.
   */
  const press = (m, key) => {
    m.body.querySelector('.git-pin').dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  };
  /**
   * Scroll a list and tell it so, as the browser would.
   * @param {HTMLElement} el - The scroller.
   * @param {number} top - The new scrollTop.
   */
  const scrollTo = (el, top) => {
    el.scrollTop = top;
    el.dispatchEvent(new Event('scroll'));
  };
  /**
   * @param {HTMLElement|null} row - A row.
   * @param {HTMLElement} scroller - Its scroller.
   * @returns {boolean} Whether all of it is inside the scroller's view.
   */
  const inView = (row, scroller) => {
    if (!row) return false;
    const r = row.getBoundingClientRect();
    const s = scroller.getBoundingClientRect();
    return r.top >= s.top - 1 && r.bottom <= s.bottom + 1 && r.height > 0;
  };

  await test('2,000 changed files draw far fewer row elements than that', async () => {
    const m = await mountedChanges();
    const drawn = changeKeys(m);
    assert(drawn.length > 0 && drawn.length < 200, `rows drawn: ${drawn.length}`);
    assert(drawn[0] === `changes:${pathOf(0)}`, `the top of the list is drawn: ${drawn[0]}`);
    m.teardown();
  });

  await test('scrolling the Changes list brings later rows in', async () => {
    const m = await mountedChanges();
    const scroller = changesScroller(m);
    assert(!changeRow(m, `changes:${pathOf(1500)}`), 'a row far down is not drawn at first');
    scrollTo(scroller, scroller.scrollHeight * 0.75);
    const drawn = changeKeys(m);
    const at = changeRow(m, `changes:${pathOf(1500)}`);
    assert(Boolean(at), `a row three-quarters down is drawn after the scroll: ${drawn[0]}…${drawn.at(-1)}`);
    assert(drawn.length < 200 && !changeRow(m, `changes:${pathOf(0)}`), `and the top went: ${drawn.length}`);
    assert(inView(at, scroller) || drawn.some((k) => inView(changeRow(m, k), scroller)), 'rows are drawn where the view is');
    m.teardown();
  });

  await test('j past the window keeps the selected row drawn and in view', async () => {
    const focus = isolateFocus();
    try {
      const m = await mountedChanges();
      const scroller = changesScroller(m);
      for (let i = 0; i < 80; i++) press(m, 'j');
      const sel = changeRow(m, `changes:${pathOf(79)}`);
      assert(sel?.getAttribute('aria-selected') === 'true', `the 80th row is drawn and selected: ${JSON.stringify(changeKeys(m).slice(0, 3))}`);
      assert(inView(sel, scroller), `and in view: row ${JSON.stringify(sel?.getBoundingClientRect())} view ${JSON.stringify(scroller.getBoundingClientRect())}`);
      assert(changeKeys(m).length < 200, `still windowed: ${changeKeys(m).length}`);
      for (let i = 0; i < 50; i++) press(m, 'k');
      const back = changeRow(m, `changes:${pathOf(29)}`);
      assert(back?.getAttribute('aria-selected') === 'true' && inView(back, scroller), 'k back up keeps it in view too');
      m.teardown();
    } finally {
      focus.restore();
    }
  });

  await test('staging a row far down sends its stage and moves it', async () => {
    const focus = isolateFocus();
    try {
      const m = await mountedChanges();
      const scroller = changesScroller(m);
      m.holdRuns(true);
      const far = `changes:${pathOf(1800)}`;
      scrollTo(scroller, scroller.scrollHeight * 0.9);
      const target = changeRow(m, far)?.querySelector('.git-changes__st');
      assert(target instanceof HTMLElement, `the far row is drawn: ${changeKeys(m)[0]}`);
      /** @type {HTMLElement} */ (target).click();
      const op = m.runs()[0]?.op;
      assert(op?.kind === 'stage' && JSON.stringify(op.paths) === JSON.stringify([pathOf(1800)]), `op ${JSON.stringify(op)}`);
      assert(!changeRow(m, far), 'the row leaves Changes at once');
      scrollTo(scroller, 0);
      const moved = changeRow(m, `staged:${pathOf(1800)}`);
      assert(Boolean(moved?.hasAttribute('data-pending')), `it is drawn pending in Staged: ${JSON.stringify(changeKeys(m).slice(0, 3))}`);
      // A far row selected with j is staged by space.
      for (let i = 0; i < 70; i++) press(m, 'j');
      const selected = m.body.querySelector('.git-changes__row[aria-selected="true"]');
      const key = selected?.getAttribute('data-key') || '';
      assert(key.startsWith('changes:'), `a far row is selected: ${key}`);
      press(m, ' ');
      const op2 = m.runs()[1]?.op;
      assert(op2?.kind === 'stage' && `changes:${op2.paths[0]}` === key, `space stages it: ${JSON.stringify(op2)}`);
      m.finishRun(0);
      m.finishRun(1);
      for (let i = 0; i < 6; i++) await nextTask();
      m.teardown();
    } finally {
      focus.restore();
    }
  });

  await test('the filter narrows a big list, windowed or whole', async () => {
    const focus = isolateFocus();
    try {
      const m = await mountedChanges();
      const scroller = changesScroller(m);
      const filter = /** @type {HTMLInputElement} */ (m.body.querySelector('.git-changes .git-list-filter__input'));
      press(m, '/');
      filter.value = 'f19';
      filter.dispatchEvent(new Event('input', { bubbles: true }));
      const few = changeKeys(m);
      assert(few.length === 100 && few.every((k) => k.includes('f19')), `a hundred rows, all of them: ${few.length}`);
      filter.value = 'f1';
      filter.dispatchEvent(new Event('input', { bubbles: true }));
      const many = changeKeys(m);
      assert(many.length > 0 && many.length < 200 && many.every((k) => k.startsWith('changes:f1')), `a thousand, windowed: ${many.length} ${many[0]}`);
      scrollTo(scroller, scroller.scrollHeight);
      assert(Boolean(changeRow(m, `changes:${pathOf(1999)}`)), `the last of them is reached: ${changeKeys(m).at(-1)}`);
      assert(!changeRow(m, `changes:${pathOf(999)}`), 'what is filtered out stays out');
      filter.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }));
      assert(changeKeys(m).length < 200, `clearing it keeps the whole list windowed: ${changeKeys(m).length}`);
      m.teardown();
    } finally {
      focus.restore();
    }
  });

  await test('a row that stays in the window keeps its element across a scroll and a re-read', async () => {
    const m = await mountedChanges();
    const scroller = changesScroller(m);
    const rowPx = /** @type {HTMLElement} */ (changeRow(m, `changes:${pathOf(0)}`)).getBoundingClientRect().height;
    scrollTo(scroller, rowPx * 40);
    const kept = changeRow(m, `changes:${pathOf(45)}`);
    assert(Boolean(kept), 'the row is drawn');
    scrollTo(scroller, rowPx * 42);
    assert(changeRow(m, `changes:${pathOf(45)}`) === kept, 'a small scroll keeps its element');
    m.emitChange([{ path: '', kinds: ['worktree'] }]);
    for (let i = 0; i < 8; i++) await nextTask();
    assert(changeRow(m, `changes:${pathOf(45)}`) === kept, 'a re-read with the same answer keeps it too');
    m.teardown();
  });

  // The History list retains the row under the pointer; a refresh that moves
  // the rows under it (new commits on top) gives every row a new key, so the
  // hovered row's place is taken by another. It must not stay there too,
  // drawn over its replacement.
  await test('a retained element whose place in the window is taken goes; one out of the window stays', () => {
    const scroller = createElement('div');
    scroller.style.cssText = 'position: fixed; left: 0; top: 0; width: 200px; height: 100px; overflow: auto;';
    document.body.append(scroller);
    try {
      /** @type {import('juggler/utils/virtual-list').VirtualList<string>} */
      const list = createVirtualList({
        scroller,
        rowHeight: 10,
        overscan: 2,
        keyOf: (item) => item,
        build: (item) => createElement('div', 'vl-probe', item),
        retain: () => true,
      });
      scroller.append(list.spacer);
      const ids = (/** @type {string} */ gen) => Array.from({ length: 100 }, (_, i) => `${gen}${i}`);
      list.setItems(ids('a'));
      list.render();
      list.setItems(ids('b'));
      list.render();
      const atTop = [...list.spacer.children].filter((el) => /** @type {HTMLElement} */ (el).style.top === '0px');
      assert(atTop.length === 1 && atTop[0]?.textContent === 'b0', `one element at the top, the new one: ${atTop.map((el) => el.textContent)}`);
      const first = list.elementAt(0);
      scroller.scrollTop = 600;
      list.render();
      assert(Boolean(first?.isConnected), 'an element scrolled out of the window is still retained');
    } finally {
      scroller.remove();
    }
  });

  await test('the conflict jump reaches a conflict in a big list', async () => {
    const files = bigChanges().files;
    files.push({ path: 'zz-conflict.txt', index: 'U', worktree: 'U', conflicted: true });
    const m = await mountedChanges({ changes: changesOf(files, { operation: 'merge', stopped: { kind: 'merge' } }) });
    const scroller = changesScroller(m);
    scrollTo(scroller, scroller.scrollHeight);
    assert(!changeRow(m, 'conflicts:zz-conflict.txt'), 'the conflict, at the top, is out of the window');
    const primary = /** @type {HTMLElement} */ (m.body.querySelector('.git-pin__primary'));
    assert((primary.textContent || '').includes('1 conflict'), `the primary offers the conflict: ${primary.textContent}`);
    primary.click();
    const row = changeRow(m, 'conflicts:zz-conflict.txt');
    assert(row?.getAttribute('aria-selected') === 'true', `the conflict is drawn and selected: ${changeKeys(m)[0]}`);
    assert(inView(row, scroller), 'and in view');
    m.teardown();
  });

  // --- Refs ---------------------------------------------------------------

  const bigRefs = refsOf({
    branches: Array.from({ length: BIG }, (_, i) => ({
      name: `b${String(i).padStart(4, '0')}`, sha: 'a'.repeat(40), subject: 'S', date: 0, ahead: 0, behind: 0,
      ...(i === 0 ? { worktree: '/tmp/proj', head: true } : {}),
    })),
  });
  const main = treeOf({ path: '/tmp/proj', main: true, current: true, branch: 'b0000', tree: '' });
  /** @returns {Promise<any>} The pin, mounted in Refs with the branches drawn. */
  const mountedRefs = async () => {
    const m = mountPin(pin, { place: 'refs', refs: bigRefs, worktrees: { repo: '', trees: [main] } });
    await waitFor(() => m.body.querySelector('.git-refs__row[data-key^="br:"]'), 'the branches to be drawn');
    return m;
  };
  /**
   * @param {any} m - The mounted pin.
   * @returns {string[]} The keys of the refs rows drawn.
   */
  const refKeys = (m) => [...m.body.querySelectorAll('.git-refs__row')].map((r) => r.getAttribute('data-key') || '');
  /**
   * @param {any} m - The mounted pin.
   * @param {string} key - A row's key.
   * @returns {HTMLElement|null} It, when drawn.
   */
  const refRow = (m, key) => m.body.querySelector(`.git-refs__row[data-key="${CSS.escape(key)}"]`);

  await test('2,000 branches draw a window; scrolling and j bring the rest in', async () => {
    const focus = isolateFocus();
    try {
      const m = await mountedRefs();
      const scroller = /** @type {HTMLElement} */ (m.body.querySelector('.git-refs__scroll'));
      assert(refKeys(m).length < 200, `rows drawn: ${refKeys(m).length}`);
      assert(Boolean(m.body.querySelector('.git-refs__sect[data-section="worktrees"]')), 'the first header is drawn');
      scrollTo(scroller, scroller.scrollHeight);
      assert(Boolean(refRow(m, 'br:b1999')), `the last branch is reached: ${refKeys(m).at(-1)}`);
      assert(Boolean(m.body.querySelector('.git-refs__sect[data-section="stashes"]')), 'and the headers after it');
      scrollTo(scroller, 0);
      for (let i = 0; i < 80; i++) press(m, 'j');
      // j walks the branches: the project's lone checkout is no row.
      const sel = refRow(m, 'br:b0079');
      assert(sel?.getAttribute('aria-selected') === 'true', `the 80th row is drawn and selected: ${refKeys(m)[0]}`);
      assert(inView(sel, scroller), 'and in view');
      const filter = /** @type {HTMLInputElement} */ (m.body.querySelector('.git-refs .git-list-filter__input'));
      press(m, '/');
      filter.value = 'b19';
      filter.dispatchEvent(new Event('input', { bubbles: true }));
      const few = refKeys(m);
      assert(few.length === 100 && few.every((k) => k.startsWith('br:b19')), `the filter narrows it: ${few.length}`);
      m.teardown();
    } finally {
      focus.restore();
    }
  });

  await test('a right-click on a branch far down selects it and opens its menu', async () => {
    const m = await mountedRefs();
    const scroller = /** @type {HTMLElement} */ (m.body.querySelector('.git-refs__scroll'));
    scrollTo(scroller, scroller.scrollHeight * 0.8);
    const target = refKeys(m).find((k) => k.startsWith('br:b1'));
    assert(Boolean(target), `a far branch is drawn: ${refKeys(m)[0]}`);
    const row = /** @type {HTMLElement} */ (refRow(m, /** @type {string} */ (target)));
    row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 10, clientY: 10 }));
    try {
      assert(refRow(m, /** @type {string} */ (target))?.getAttribute('aria-selected') === 'true', 'the row is selected');
      const labels = [...document.querySelectorAll('.juggler-context-menu .menu-item')].map((el) => el.textContent);
      assert(labels[0] === 'Checkout', `the branch's menu opens: ${JSON.stringify(labels)}`);
    } finally {
      for (const el of document.querySelectorAll('.juggler-context-menu')) el.remove();
      m.teardown();
    }
  });

  return { passed, failed, errors };
}
