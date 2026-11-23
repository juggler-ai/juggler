//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Git pin History place tests — the virtualized list over a paged history, the
 * graph cells drawn from a page's lanes, the ref chips, the scope picker, and a
 * refresh that keeps the row in view where it was. The fake services, and the
 * synthetic paged history, are git-pin-helpers'.
 * @module _tests/git-history-test
 */

import GitPin from '../pins/git-pin.js';
import { assert, nextTask, waitFor } from '../../../js-tests/utilities/test-helpers.js';
import { underPseudoLocale, shownStrings } from '../../../js-tests/utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../../sdk/lib/i18n.js';
import { changesOf, commitOf, historyOf, mountPin, pick, pickerChoices, pickerValue, refsOf, shaOf, treeOf } from './git-pin-helpers.js';

/** The list's row height, in px (history-list's ROW_PX). */
const ROW = 26;

/** The first thousand rows of the default history, for the parents a commit read gives. */
const BASE = historyOf(1000)({ offset: 0, limit: 1000 }).rows;

/**
 * @param {string} sha - A commit of the default history.
 * @returns {string[]} Its parents there.
 */
const parentsOf = (sha) => BASE.find((/** @type {any} */ r) => r.sha === sha)?.parents || [];

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
      for (const pop of document.querySelectorAll('.git-pop')) pop.remove();
    }
  }

  const pin = new GitPin();

  /**
   * Mount in the History place.
   * @param {object} [options] - Passed to `mountPin`.
   * @returns {any} The mounted pin.
   */
  const mount = (options = {}) => mountPin(pin, {
    place: 'history',
    log: historyOf(1000),
    commit: (/** @type {string} */ rev) => commitOf(rev, { parents: parentsOf(rev) }),
    worktrees: { repo: '', trees: [treeOf({ main: true, current: true, head: shaOf(0) })] },
    ...options,
  });

  /**
   * @param {any} m - The mounted pin.
   * @returns {HTMLElement} The list's scroller.
   */
  const scroller = (m) => /** @type {HTMLElement} */ (m.body.querySelector('.git-history__scroll'));
  /**
   * @param {any} m - The mounted pin.
   * @returns {HTMLElement[]} The drawn rows.
   */
  const rows = (m) => /** @type {HTMLElement[]} */ ([...m.body.querySelectorAll('.git-history__row')]);
  /**
   * @param {any} m - The mounted pin.
   * @param {number} index - A row's position in the list.
   * @returns {HTMLElement|null} It, when drawn.
   */
  const rowAt = (m, index) => /** @type {HTMLElement|null} */ (m.body.querySelector(`.git-history__row[data-index="${index}"]`));
  /**
   * @param {any} m - The mounted pin.
   * @returns {any[]} The log queries asked, in order.
   */
  const logReads = (m) => m.reads().filter((/** @type {any} */ r) => r.kind === 'log').map((/** @type {any} */ r) => r.options.log || {});
  /**
   * Scroll the list, as a user does: the position, then the event.
   * @param {any} m - The mounted pin.
   * @param {number} top - The new scrollTop.
   */
  const scrollTo = (m, top) => {
    const el = scroller(m);
    el.scrollTop = top;
    el.dispatchEvent(new Event('scroll'));
  };
  /**
   * @param {any} m - The mounted pin.
   * @param {number} index - A row.
   * @returns {Promise<HTMLElement>} It, once drawn.
   */
  const drawn = async (m, index) => /** @type {HTMLElement} */ (await waitFor(() => rowAt(m, index), `row ${index} to be drawn`));
  /**
   * @param {any} m - The mounted pin.
   * @returns {HTMLElement} The detail pane.
   */
  const detail = (m) => /** @type {HTMLElement} */ (m.body.querySelector('.git-history__detail'));
  /**
   * @param {any} m - The mounted pin.
   * @param {number} index - A row.
   * @returns {boolean} Whether it is the selected one.
   */
  const isSelected = (m, index) => rowAt(m, index)?.getAttribute('aria-selected') === 'true';
  /**
   * @param {any} m - The mounted pin.
   * @returns {number[]} The rows drawn as part of the marked run, in order.
   */
  const inRun = (m) => [...m.body.querySelectorAll('.git-history__row--in-run')]
    .map((el) => Number(/** @type {HTMLElement} */ (el).dataset.index)).sort((a, b) => a - b);
  /**
   * @param {EventTarget} target - Where the key goes.
   * @param {string} key - The key.
   */
  const press = (target, key) => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
  };

  await test('100k commits open with one page read and a window of rows', async () => {
    const m = mount({ log: historyOf(100_000) });
    await drawn(m, 0);
    const reads = logReads(m);
    assert(reads.length === 1, `one log read: ${JSON.stringify(reads)}`);
    assert((reads[0].offset || 0) === 0, `from the top: ${JSON.stringify(reads[0])}`);
    assert(rows(m).length > 5 && rows(m).length < 80, `a window of rows: ${rows(m).length}`);
    const spacer = /** @type {HTMLElement} */ (m.body.querySelector('.git-history__spacer'));
    // Compared as a number: WebView2 serialises this height as `2.6e+06px`.
    assert(parseFloat(spacer.style.height) === 100_000 * ROW, `the spacer is the whole history: ${spacer.style.height}`);
    m.teardown();
  });

  await test('a scroll reads only the pages it reaches, each once', async () => {
    const m = mount({ log: historyOf(100_000) });
    await drawn(m, 0);
    m.holdReads('log', true);
    scrollTo(m, 250 * ROW);
    scrollTo(m, 251 * ROW);
    await waitFor(() => m.heldReads().length >= 1, 'the page 250 is on');
    /** @returns {number[]} The offsets the held reads asked for. */
    const offsets = () => m.heldReads().map((/** @type {any} */ h) => h.options.log?.offset || 0);
    assert(JSON.stringify(offsets()) === JSON.stringify([200]), `one read of page 200, in flight once: ${JSON.stringify(offsets())}`);
    m.releaseRead(0);
    await drawn(m, 250);
    scrollTo(m, 5000 * ROW);
    await waitFor(() => m.heldReads().length >= 2, 'the page 5000 is on');
    const later = offsets().slice(1).sort((a, b) => a - b);
    assert(later.every((o) => o === 4800 || o === 5000) && later.includes(5000), `only the pages in reach: ${JSON.stringify(later)}`);
    for (let i = 1; i < m.heldReads().length; i++) m.releaseRead(i);
    await drawn(m, 5000);
    assert(!offsets().some((o) => o > 0 && o < 4800 && o !== 200), `no page between: ${JSON.stringify(offsets())}`);
    m.teardown();
  });

  await test('graph cells draw through-lanes, a merge, a joined parent and the HEAD ring', async () => {
    const m = mount();
    await drawn(m, 4);
    // Row 0 is HEAD and a merge: its parents continue in lanes 0 and 1.
    const r0 = /** @type {HTMLElement} */ (rowAt(m, 0));
    assert(Boolean(r0.querySelector('.git-graph__dot--head')), 'HEAD is a ring');
    const outs0 = [...r0.querySelectorAll('.git-graph__out')].map((p) => p.getAttribute('data-to')).sort();
    assert(JSON.stringify(outs0) === '["0","1"]', `the merge's out-edges: ${JSON.stringify(outs0)}`);
    // Row 1 is on lane 0 while lane 1 waits for row 2: lane 1 passes through.
    const r1 = /** @type {HTMLElement} */ (rowAt(m, 1));
    const through1 = [...r1.querySelectorAll('.git-graph__through')].map((p) => p.getAttribute('data-lane'));
    assert(JSON.stringify(through1) === '["1"]', `lane 1 passes row 1: ${JSON.stringify(through1)}`);
    assert(Boolean(r1.querySelector('.git-graph__in')), 'row 1 is entered from above');
    // Row 3's parent (row 4) already waits in lane 0: the edge joins it.
    const r3 = /** @type {HTMLElement} */ (rowAt(m, 3));
    const dot3 = r3.querySelector('.git-graph__dot');
    assert(dot3?.getAttribute('data-lane') === '1', `row 3 on lane 1: ${dot3?.getAttribute('data-lane')}`);
    const out3 = [...r3.querySelectorAll('.git-graph__out')].map((p) => p.getAttribute('data-to'));
    assert(JSON.stringify(out3) === '["0"]', `row 3 joins lane 0: ${JSON.stringify(out3)}`);
    assert(!r1.querySelector('.git-graph__dot--head'), 'only HEAD is a ring');
    m.teardown();
  });

  await test('a lane past the cap is drawn as a marker at the edge', async () => {
    const wide = {
      graph: 'w', gen: 0, offset: 0, more: false, total: 1, graphed: true, found: -1, lanes: [0, 1, 2, 3, 4],
      rows: [{ sha: shaOf(9), parents: [shaOf(10)], author: 'A', email: '', date: 0, subject: 'Far out', lane: 4, out: [4] }],
    };
    const m = mount({ log: () => wide });
    // Set before the first page lands, which is when the cap is read.
    scroller(m).style.setProperty('--git-history-lanes', '3');
    await drawn(m, 0);
    const r0 = /** @type {HTMLElement} */ (rowAt(m, 0));
    const dot = r0.querySelector('.git-graph__dot');
    assert(Boolean(dot?.classList.contains('git-graph__dot--over')), `a hollow marker: ${dot?.getAttribute('class')}`);
    const lanes = [...r0.querySelectorAll('.git-graph__through')].map((p) => Number(p.getAttribute('data-lane')));
    assert(lanes.length > 0 && lanes.every((l) => l < 3), `only lanes under the cap are drawn: ${JSON.stringify(lanes)}`);
    const svg = /** @type {SVGSVGElement} */ (r0.querySelector('svg'));
    assert(Number(svg.getAttribute('width')) <= 3 * 12, `three lanes wide: ${svg.getAttribute('width')}`);
    m.teardown();
  });

  await test('chips: the viewed branch, a branch out in another tree, a detached tree, a remote and a tag', async () => {
    const trees = [
      treeOf({ path: '/tmp/proj', main: true, current: true, branch: 'develop', head: shaOf(0) }),
      treeOf({ path: '/tmp/wt-feat', branch: 'feat', head: shaOf(1), tree: 'wt:feat' }),
      treeOf({ path: '/tmp/wt-det', branch: '', detached: true, head: shaOf(4), tree: 'wt:det' }),
    ];
    const refs = refsOf({
      branches: [
        { name: 'develop', sha: shaOf(0), subject: '', date: 0, ahead: 0, behind: 0, worktree: '/tmp/proj', head: true },
        { name: 'feat', sha: shaOf(1), subject: '', date: 0, ahead: 0, behind: 0, worktree: '/tmp/wt-feat' },
        { name: 'old', sha: shaOf(2), subject: '', date: 0, ahead: 0, behind: 0 },
      ],
      remotes: [{ name: 'origin', branches: [{ name: 'HEAD', sha: shaOf(0), subject: '', date: 0 }, { name: 'develop', sha: shaOf(0), subject: '', date: 0 }] }],
      tags: [{ name: 'v1', sha: 'b'.repeat(40), target: shaOf(3), annotated: true, subject: '', date: 0 }],
    });
    const m = mount({ refs, worktrees: { repo: '', trees } });
    /**
     * @param {number} index - A row.
     * @returns {string[]} Its chips, as `kind:text`.
     */
    const chips = (index) => [...(rowAt(m, index)?.querySelectorAll('.git-history__chip') || [])]
      .map((c) => `${c.getAttribute('data-kind')}:${(c.textContent || '').trim()}`);
    await waitFor(() => chips(3).length > 0, 'the chips to be drawn');
    assert(JSON.stringify(chips(0)) === '["head:develop","remote:origin/develop"]', `row 0: ${JSON.stringify(chips(0))}`);
    assert(JSON.stringify(chips(1)) === '["wt:feat"]', `row 1: ${JSON.stringify(chips(1))}`);
    const wt = rowAt(m, 1)?.querySelector('.git-history__chip');
    assert((wt?.getAttribute('title') || '').includes('wt-feat'), `the tree it is out in: ${wt?.getAttribute('title')}`);
    assert(JSON.stringify(chips(2)) === '["branch:old"]', `row 2: ${JSON.stringify(chips(2))}`);
    assert(JSON.stringify(chips(3)) === '["tag:v1"]', `row 3: ${JSON.stringify(chips(3))}`);
    const det = chips(4)[0] || '';
    assert(chips(4).length === 1 && det.startsWith('detached:') && det.includes('wt-det'), `row 4: ${JSON.stringify(chips(4))}`);
    m.teardown();
  });

  await test('the scope picker reads all refs, or one ref, as a fresh list', async () => {
    const refs = refsOf({
      branches: [{ name: 'develop', sha: shaOf(0), subject: '', date: 0, ahead: 0, behind: 0, head: true }],
      tags: [{ name: 'v1', sha: shaOf(3), target: shaOf(3), annotated: false, subject: '', date: 0 }],
    });
    /**
     * @param {any} q - A LogQuery.
     * @returns {any} A page whose subjects say which scope asked.
     */
    const log = (q) => historyOf(50, { graph: `g-${q.scope || 'head'}`, subject: `${q.scope || 'head'}${q.ref ? `:${q.ref}` : ''}` })(q);
    const m = mount({ log, refs });
    await drawn(m, 0);
    const select = m.body.querySelector('.git-history__scope');
    // The ref choices are built as the picker is opened.
    await waitFor(() => pickerChoices(select).some((c) => c.value === 'ref:v1'), 'the tag to be offered');
    pick(select, 'all');
    await waitFor(() => (rowAt(m, 0)?.textContent || '').includes('all 0'), 'the all-refs list');
    const all = logReads(m).at(-1);
    assert(all.scope === 'all' && !all.graph && !all.offset, `a fresh all-refs read: ${JSON.stringify(all)}`);
    pick(select, 'ref:v1');
    await waitFor(() => (rowAt(m, 0)?.textContent || '').includes('ref:v1 0'), 'the ref list');
    const one = logReads(m).at(-1);
    assert(one.scope === 'ref' && one.ref === 'v1' && !one.graph, `a fresh ref read: ${JSON.stringify(one)}`);
    assert(!rows(m).some((r) => (r.textContent || '').includes('all ')), 'the all-refs rows are gone');
    m.teardown();
  });

  await test('a refs change refreshes and keeps the row in view where it was', async () => {
    const m = mount({ log: historyOf(1000) });
    await drawn(m, 0);
    scrollTo(m, 300 * ROW + 5);
    await drawn(m, 300);
    m.setLog(historyOf(1000, { gen: 1, top: 2 }));
    m.emitChange([{ path: '', kinds: ['refs'] }]);
    await waitFor(() => logReads(m).some((q) => q.refresh), 'a refresh read');
    const q = logReads(m).find((x) => x.refresh);
    assert(q.find === shaOf(300) && q.graph === 'g1', `found by the top row: ${JSON.stringify(q)}`);
    await waitFor(() => rowAt(m, 302)?.getAttribute('data-sha') === shaOf(300), 'the row to move down two');
    // Within a device pixel: a scaled display snaps scrollTop to one (7857.33 at 150%).
    assert(Math.abs(scroller(m).scrollTop - (302 * ROW + 5)) < 1 / window.devicePixelRatio,
      `anchored: ${scroller(m).scrollTop}, want ${302 * ROW + 5}`);
    m.teardown();
  });

  for (const [where, top] of /** @type {[string, number][]} */ ([['at the top', 0], ['a few rows down', 4 * ROW + 5]])) {
    await test(`commits that arrive while the view is ${where} are scrolled into view, the list at its top`, async () => {
      const m = mount({ log: historyOf(1000) });
      await drawn(m, 0);
      scrollTo(m, top);
      m.setLog(historyOf(1000, { gen: 1, top: 2 }));
      m.emitChange([{ path: '', kinds: ['refs'] }]);
      await waitFor(() => rowAt(m, 0)?.getAttribute('data-sha') === shaOf(0, 'f'), 'the newest commit, drawn first');
      await nextTask();
      assert(scroller(m).scrollTop === 0, `at the top: ${scroller(m).scrollTop}`);
      m.teardown();
    });
  }

  await test('a refresh that brings nothing new leaves a view near the top where it is', async () => {
    const m = mount({ log: historyOf(1000) });
    await drawn(m, 0);
    scrollTo(m, 4 * ROW + 5);
    m.emitChange([{ path: '', kinds: ['refs'] }]);
    await waitFor(() => logReads(m).some((q) => q.refresh), 'a refresh read');
    await nextTask();
    await nextTask();
    // Within a device pixel: a scaled display snaps scrollTop to one.
    assert(Math.abs(scroller(m).scrollTop - (4 * ROW + 5)) < 1 / window.devicePixelRatio,
      `left alone: ${scroller(m).scrollTop}, want ${4 * ROW + 5}`);
    m.teardown();
  });

  /** A changed file, for a tree with changes. */
  const CHANGED = { path: 'a.txt', index: '.', worktree: 'M', added: 1, removed: 0 };

  await test('the working tree is a row of the graph: above HEAD, under commits HEAD has not caught up with', async () => {
    // Two commits on top of HEAD (shaOf(0)): an upstream not pulled.
    const m = mount({ log: historyOf(50, { top: 2 }), changes: changesOf([CHANGED]) });
    const wip = /** @type {HTMLElement} */ (await waitFor(() => m.body.querySelector('.git-history__row--worktree'), 'the working tree\u2019s row'));
    assert(logReads(m).some((q) => q.worktree === true), `asked for: ${JSON.stringify(logReads(m))}`);
    assert(wip.dataset.index === '2', `between the upstream and HEAD: row ${wip.dataset.index}`);
    const head = await drawn(m, 3);
    assert(head.dataset.sha === shaOf(0) && Boolean(head.querySelector('.git-graph__dot--head')), 'HEAD right under it');
    // Drawn by the graph as any row is: its own lane, an edge into HEAD's,
    // which HEAD's row is entered by from above.
    const headLane = head.querySelector('.git-graph__dot')?.getAttribute('data-lane');
    const wipLane = wip.querySelector('.git-graph__dot--worktree')?.getAttribute('data-lane');
    const to = [...wip.querySelectorAll('.git-graph__out')].map((p) => p.getAttribute('data-to'));
    assert(JSON.stringify(to) === JSON.stringify([headLane]), `its edge runs into HEAD's lane ${headLane}: ${JSON.stringify(to)}`);
    assert(wipLane !== undefined && wipLane !== headLane, `beside the upstream's line, not on it: lane ${wipLane}, HEAD ${headLane}`);
    assert(Boolean(head.querySelector('.git-graph__in')), 'HEAD is entered from above');
    assert(wip.textContent?.includes('1 file'), `its count: ${wip.textContent}`);

    // Never selected: the arrows step over it.
    /** @type {HTMLElement} */ (await drawn(m, 1)).click();
    press(scroller(m), 'j');
    await waitFor(() => isSelected(m, 3), 'down from the upstream lands on HEAD');
    press(scroller(m), 'k');
    await waitFor(() => isSelected(m, 1), 'and back up');
    wip.click();
    await waitFor(() => !m.body.querySelector('.git-pin__place--changes')?.hidden, 'a click brings Changes forward');
    m.teardown();
  });

  await test('the working tree\u2019s row comes and goes with the changes, keeping the rows in view', async () => {
    const m = mount({ log: historyOf(1000), changes: changesOf([]) });
    await drawn(m, 0);
    scrollTo(m, 300 * ROW + 5);
    await drawn(m, 300);
    assert(!m.body.querySelector('.git-history__row--worktree') && !logReads(m).some((q) => q.worktree), 'none while clean');
    m.setChanges(changesOf([CHANGED]));
    m.emitChange([{ path: '', kinds: ['worktree'] }]);
    await waitFor(() => logReads(m).some((q) => q.refresh && q.worktree), 'a refresh asking for it');
    await waitFor(() => rowAt(m, 301)?.getAttribute('data-sha') === shaOf(300), 'the rows below it move down one');
    // Within a device pixel: a scaled display snaps scrollTop to one.
    assert(Math.abs(scroller(m).scrollTop - (301 * ROW + 5)) < 1 / window.devicePixelRatio,
      `anchored: ${scroller(m).scrollTop}, want ${301 * ROW + 5}`);
    scrollTo(m, 0);
    const wip = /** @type {HTMLElement} */ (await drawn(m, 0));
    assert(wip.classList.contains('git-history__row--worktree'), 'it is the first row, above HEAD');
    m.teardown();
  });

  await test('a page of an older generation that lands late is dropped', async () => {
    const m = mount({ log: historyOf(1000) });
    await drawn(m, 0);
    m.holdReads('log', true);
    m.setLog(historyOf(1000, { gen: 1, top: 2 }));
    m.emitChange([{ path: '', kinds: ['refs'] }]);
    await waitFor(() => m.heldReads().length >= 1, 'the refresh to be asked');
    // The page further down is read of the old generation, and lands last.
    scrollTo(m, 210 * ROW);
    await waitFor(() => m.heldReads().some((/** @type {any} */ h) => (h.options.log?.offset || 0) === 200), 'page 200 to be asked');
    const late = m.heldReads().findIndex((/** @type {any} */ h) => (h.options.log?.offset || 0) === 200);
    const old = historyOf(1000)({ graph: 'g1', offset: 200, limit: 200 });
    m.releaseRead(m.heldReads().findIndex((/** @type {any} */ h) => h.options.log?.refresh));
    m.holdReads('log', false);
    m.releaseRead(late, old);
    await waitFor(() => rowAt(m, 210)?.getAttribute('data-sha') === shaOf(208), 'row 210 of the new generation');
    m.teardown();
  });

  await test('a repository named in a config written from outside is shown; one the tree lacks is not', async () => {
    const m = mount({ place: 'history', status: { root: '/tmp/proj', repos: [{ path: '' }, { path: 'sub' }] } });
    const picker = /** @type {HTMLElement} */ (m.body.querySelector('.git-pin__repo'));
    await waitFor(() => !picker.hidden && pickerChoices(picker).some((c) => c.value === 'sub'), 'the repository picker');
    m.reconfigure({ place: 'history', repo: 'sub' });
    assert(pickerValue(picker) === 'sub', `the pin moves to sub: ${pickerValue(picker)}`);
    await waitFor(() => m.reads().some((/** @type {any} */ r) => r.kind === 'log' && r.options.repo === 'sub'), 'History to read sub');
    m.reconfigure({ place: 'history', repo: 'gone' });
    assert(pickerValue(picker) === 'sub', `a repository the tree lacks is not switched to: ${pickerValue(picker)}`);
    m.reconfigure({ place: 'history' });
    assert(pickerValue(picker) === '', `no repository named is the root one: ${pickerValue(picker)}`);
    m.teardown();
  });

  await test('switching places keeps the repository picked, because the pin is not rebuilt', async () => {
    const m = mount({ place: 'changes', status: { root: '/tmp/proj', repos: [{ path: '' }, { path: 'sub' }] } });
    const picker = /** @type {HTMLElement} */ (m.body.querySelector('.git-pin__repo'));
    await waitFor(() => !picker.hidden && pickerChoices(picker).some((c) => c.value === 'sub'), 'the repository picker');
    pick(picker, 'sub');
    /**
     * @param {any} on - The mounted pin.
     * @param {string} place - A place's id.
     */
    const tab = (on, place) => {
      /** @type {HTMLElement} */ (on.body.querySelector(`.git-pin__place-btn[data-place="${place}"]`)).click();
    };
    tab(m, 'history');
    await waitFor(() => logReads(m).length > 0, 'History to read its log');
    const log = m.reads().find((/** @type {any} */ r) => r.kind === 'log');
    assert(log.options.repo === 'sub', `History reads the repository picked: ${JSON.stringify(log.options)}`);
    tab(m, 'changes');
    // A write the board takes for a change made elsewhere mounts the pin afresh,
    // at the root repository: each one here records what the pin already shows.
    const writes = m.configWrites();
    assert(writes.length >= 2 && writes.every((/** @type {any} */ w) => w.options.inPlace === true),
      `every place switch is written in place: ${JSON.stringify(writes)}`);
    assert(pickerValue(picker) === 'sub', `still on sub: ${pickerValue(picker)}`);
    const saved = writes.at(-1)?.config;
    assert(saved?.repo === 'sub', `the repository picked is written down: ${JSON.stringify(saved)}`);
    m.teardown();

    // Mounted again from what was written — the board rebuilt, the app
    // reloaded — it opens where it was left, in Changes on sub, not at the root
    // repository; History, opened there, reads sub too. History is opened by
    // its tab: the hidden list's only other read is a ResizeObserver delivery,
    // which a lane may never make.
    const again = mount({ config: saved, status: { root: '/tmp/proj', repos: [{ path: '' }, { path: 'sub' }] } });
    const shown = /** @type {HTMLElement} */ (again.body.querySelector('.git-pin__repo'));
    await waitFor(() => pickerValue(shown) === 'sub', 'the remounted picker to name sub');
    assert(saved.place === 'changes' && !again.body.querySelector('.git-pin__place--changes')?.hidden,
      `it opens in Changes, where it was left: ${JSON.stringify(saved)}`);
    tab(again, 'history');
    const reopened = logReads(again);
    assert(reopened.length > 0, 'History, opened, reads its log');
    const first = again.reads().find((/** @type {any} */ r) => r.kind === 'log');
    assert(first.options.repo === 'sub', `it reads the repository it was left on: ${JSON.stringify(first.options)}`);
    again.teardown();
  });

  /**
   * @param {any} m - The mounted pin.
   * @returns {any[]} The `commit` reads asked, held or not, in order.
   */
  const commitReads = (m) => m.reads().filter((/** @type {any} */ r) => r.kind === 'commit');

  await test('a click on another row while a commit is out aborts it and reads the new one at once', async () => {
    const m = mount();
    await drawn(m, 1);
    m.holdReads('commit', true);
    /** @type {HTMLElement} */ (rowAt(m, 0)).click();
    await waitFor(() => m.heldReads().length === 1, 'the commit of row 0 to be asked');
    const first = m.heldReads()[0];
    assert(first.options.commit === shaOf(0), `row 0's commit: ${JSON.stringify(first.options)}`);
    /** @type {HTMLElement} */ (rowAt(m, 1)).click();
    // Row 0's read is never answered: row 1's must not wait for it.
    await waitFor(() => m.heldReads().length === 2, 'row 1 to be asked while row 0 is still out');
    assert(first.options.signal?.aborted === true && first.aborted, 'row 0\u2019s read is aborted');
    assert(m.heldReads()[1].options.commit === shaOf(1), `then row 1's: ${JSON.stringify(m.heldReads()[1].options)}`);
    m.releaseRead(1);
    await waitFor(() => (detail(m).textContent || '').includes('Body of 0001'), 'row 1\u2019s body');
    const text = detail(m).textContent || '';
    assert(text.includes('Subject of 0001') && text.includes('Ada') && text.includes('Grace'), `its subject, author and committer: ${text}`);
    assert(!text.includes('Body of 0000') && !text.includes('Subject of 0000'), `nothing of row 0: ${text}`);
    m.teardown();
  });

  await test('ten moves in one task draw each row at once and read one commit, the last, once they stop', async () => {
    const m = mount();
    await drawn(m, 12);
    const root = /** @type {HTMLElement} */ (m.body.querySelector('.git-pin'));
    m.holdReads('commit', true);
    press(root, 'j');
    await waitFor(() => m.heldReads().length === 1, 'row 0\u2019s commit to be asked');
    const out = m.heldReads()[0];
    const before = commitReads(m).length;
    for (let i = 0; i < 10; i++) press(root, 'j');
    assert(isSelected(m, 10), 'row 10 is selected at once');
    const title = detail(m).querySelector('.git-history__title')?.textContent || '';
    assert(title === 'Commit 10', `the detail names row 10 from its row at once: ${title}`);
    assert(out.options.signal?.aborted === true, 'the read out for row 0 is aborted');
    await waitFor(() => commitReads(m).length > before, 'a read once the moves stop');
    await nextTask();
    const asked = commitReads(m).slice(before).map((/** @type {any} */ r) => r.options.commit);
    assert(JSON.stringify(asked) === JSON.stringify([shaOf(10)]), `one read, for row 10: ${JSON.stringify(asked)}`);
    m.teardown();
  });

  await test('a held arrow reads no commit until it is let go', async () => {
    // Losing focus lets a held key go (the keyup never comes), and a sibling
    // lane's focus() takes this frame's whenever it likes: so the hold is
    // shielded from it, and a steal is made mid-hold to show the shield holds.
    // The shield goes on before the pin mounts. At the root, capture on the
    // window runs first anyway; but at the window itself Chromium runs
    // listeners in the order they were added, capture or not, so only a
    // shield added before the pin's own `blur` runs ahead of it.
    const shield = (/** @type {Event} */ e) => e.stopImmediatePropagation();
    window.addEventListener('focusout', shield, true);
    window.addEventListener('blur', shield, true);
    const m = mount();
    try {
      await drawn(m, 12);
      const root = /** @type {HTMLElement} */ (m.body.querySelector('.git-pin'));
      press(root, 'j');
      await waitFor(() => (detail(m).textContent || '').includes('Body of 0000'), 'row 0\u2019s commit');
      const before = commitReads(m).length;
      for (let i = 0; i < 5; i++) {
        root.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', repeat: true, bubbles: true, cancelable: true }));
        if (i === 2) {
          root.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }));
          window.dispatchEvent(new window.FocusEvent('blur'));
        }
        await nextTask();
      }
      assert(isSelected(m, 5), 'the selection moved with the key');
      assert(commitReads(m).length === before, `nothing read while it is held: ${JSON.stringify(commitReads(m).slice(before).map((r) => r.options.commit))}`);
      root.dispatchEvent(new KeyboardEvent('keyup', { key: 'ArrowDown', bubbles: true }));
      await waitFor(() => (detail(m).textContent || '').includes('Body of 0005'), 'row 5\u2019s commit once let go');
      const asked = commitReads(m).slice(before).map((/** @type {any} */ r) => r.options.commit);
      assert(JSON.stringify(asked) === JSON.stringify([shaOf(5)]), `one read, for row 5: ${JSON.stringify(asked)}`);
    } finally {
      m.teardown();
      window.removeEventListener('focusout', shield, true);
      window.removeEventListener('blur', shield, true);
    }
  });

  await test('one refs change redraws once both reads land, and only the rows with new chips', async () => {
    const develop = { name: 'develop', sha: shaOf(0), subject: '', date: 0, ahead: 0, behind: 0, head: true };
    const m = mount({ refs: refsOf({ branches: [develop] }) });
    await drawn(m, 3);
    const select = m.body.querySelector('.git-history__scope');
    await waitFor(() => pickerChoices(select).some((c) => c.value === 'ref:develop'), 'the picker to offer develop');
    /**
     * @param {number} index - A row.
     * @returns {string[]} Its chips' words.
     */
    const chipsOf = (index) => [...(rowAt(m, index)?.querySelectorAll('.git-history__chip') || [])].map((c) => (c.textContent || '').trim());
    const row0 = rowAt(m, 0);
    const row2 = rowAt(m, 2);
    /** @returns {any[]} The held refs and worktrees reads. */
    const held = () => m.heldReads().filter((/** @type {any} */ h) => !h.settled);
    /** @param {string} kind - Which to answer. */
    const release = (kind) => {
      m.releaseRead(m.heldReads().findIndex((/** @type {any} */ h) => !h.settled && h.kind === kind));
    };
    m.holdReads('refs', true);
    m.holdReads('worktrees', true);

    m.emitChange([{ path: '', kinds: ['refs', 'head'] }]);
    await waitFor(() => held().length === 2, 'refs and worktrees to be asked');
    release('refs');
    release('worktrees');
    await nextTask();
    await nextTask();
    assert(rowAt(m, 0) === row0 && rowAt(m, 2) === row2, 'refs that did not change leave every row as it was');

    m.setRefs(refsOf({ branches: [develop, { name: 'feat', sha: shaOf(2), subject: '', date: 0, ahead: 0, behind: 0 }] }));
    m.emitChange([{ path: '', kinds: ['refs', 'head'] }]);
    await waitFor(() => held().length === 2, 'refs and worktrees to be asked again');
    release('refs');
    await nextTask();
    assert(chipsOf(2).length === 0, 'nothing is redrawn until the worktrees land too');
    release('worktrees');
    await waitFor(() => chipsOf(2).includes('feat'), 'row 2 to carry feat');
    assert(pickerChoices(select).some((c) => c.value === 'ref:feat'), 'the picker offers feat');
    assert(rowAt(m, 0) === row0, 'a row whose chips did not change is kept');
    m.teardown();
  });

  await test('a hidden History reads nothing on a change, and catches up once when shown', async () => {
    const m = mount();
    await drawn(m, 0);
    /** @param {string} place - A place's id. */
    const tab = (place) => {
      /** @type {HTMLElement} */ (m.body.querySelector(`.git-pin__place-btn[data-place="${place}"]`)).click();
    };
    tab('changes');
    const before = m.reads().length;
    /** @returns {string[]} The History's reads since it was hidden, by kind. */
    const since = () => m.reads().slice(before).map((/** @type {any} */ r) => (r.kind === 'log' && r.options.log?.refresh ? 'log-refresh' : r.kind))
      .filter((/** @type {string} */ k) => k !== 'commit-context' && k !== 'attribution');
    m.emitChange([{ path: '', kinds: ['refs', 'head'] }]);
    m.emitChange([{ path: '', kinds: ['refs'] }]);
    await nextTask();
    await nextTask();
    assert(since().length === 0, `nothing read while hidden: ${JSON.stringify(since())}`);
    tab('history');
    await waitFor(() => since().includes('log-refresh'), 'the list to catch up');
    await nextTask();
    assert(JSON.stringify(since().sort()) === JSON.stringify(['log-refresh', 'refs', 'worktrees']),
      `one catch-up: ${JSON.stringify(since())}`);
    m.teardown();
  });

  await test('a commit\u2019s files are a review of it: a file\u2019s diff is asked in the commit\u2019s scope', async () => {
    const m = mount();
    await drawn(m, 0);
    /** @type {HTMLElement} */ (rowAt(m, 0)).click();
    await waitFor(() => m.diffs().length > 0, 'the first file\u2019s diff');
    const asked = m.diffs()[0];
    assert(asked.path === 'src/a.go' && asked.options?.scope === `${shaOf(0)}^!`, `in the commit's scope: ${JSON.stringify(asked)}`);
    assert(Boolean(detail(m).querySelector('.review-panel__file')), 'the file is listed');
    m.teardown();
  });

  await test('a parent is a link to its row, found by the server when it is not held', async () => {
    const far = shaOf(500);
    const m = mount({ commit: (/** @type {string} */ rev) => commitOf(rev, { parents: rev === shaOf(3) ? [far] : parentsOf(rev) }) });
    await drawn(m, 3);
    /** @type {HTMLElement} */ (rowAt(m, 0)).click();
    await waitFor(() => (detail(m).textContent || '').includes('Body of 0000'), 'row 0\u2019s commit');
    const link = /** @type {HTMLElement} */ (detail(m).querySelector(`.git-history__parent[data-sha="${shaOf(2)}"]`));
    link.click();
    await waitFor(() => isSelected(m, 2), 'row 2 to be selected');
    /** @type {HTMLElement} */ (rowAt(m, 3)).click();
    await waitFor(() => (detail(m).textContent || '').includes('Body of 0003'), 'row 3\u2019s commit');
    const farLink = /** @type {HTMLElement} */ (await waitFor(() => detail(m).querySelector(`.git-history__parent[data-sha="${far}"]`), 'row 3\u2019s parent'));
    farLink.click();
    await waitFor(() => logReads(m).some((q) => q.find === far), 'a read that finds it');
    await waitFor(() => isSelected(m, 500), 'row 500 to be drawn, selected');
    assert(scroller(m).scrollTop > 400 * ROW, `scrolled to it: ${scroller(m).scrollTop}`);
    m.teardown();
  });

  await test('in a stack, Enter opens the detail, keys in its file list stay there, and Escape comes back', async () => {
    const m = mount({ width: '24rem' });
    await drawn(m, 1);
    const root = /** @type {HTMLElement} */ (m.body.querySelector('.git-pin'));
    press(root, 'j');
    await waitFor(() => isSelected(m, 0), 'row 0 to be selected');
    press(root, 'Enter');
    assert(root.dataset.level === 'detail', `the detail is pushed: ${root.dataset.level}`);
    const file = /** @type {HTMLElement} */ (await waitFor(() => detail(m).querySelector('.review-panel__file'), 'the commit\u2019s files'));
    press(file, 'ArrowDown');
    assert(isSelected(m, 0) && !isSelected(m, 1), 'an arrow in the file list leaves the history selection alone');
    press(file, 'Escape');
    assert(root.dataset.level === 'list', `Escape pops it: ${root.dataset.level}`);
    m.teardown();
  });

  /**
   * @param {any} m - The mounted pin.
   * @returns {HTMLInputElement} The filter field.
   */
  const filterOf = (m) => /** @type {HTMLInputElement} */ (m.body.querySelector('.git-history__filter'));
  /**
   * Type into the filter, as a user does: the text, then the event.
   * @param {any} m - The mounted pin.
   * @param {string} text - What is in the field now.
   */
  const typeFilter = (m, text) => {
    const input = filterOf(m);
    input.value = text;
    input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  await test('the filter applies after a pause as a flat list, by message, author or path', async () => {
    const m = mount();
    await drawn(m, 0);
    assert(Boolean(rowAt(m, 0)?.querySelector('.git-graph')), 'a graph before');
    typeFilter(m, 'fix');
    await waitFor(() => logReads(m).some((q) => q.message === 'fix'), 'a message read');
    const read = logReads(m).find((q) => q.message === 'fix');
    assert(!read.graph && !read.author && !read.path, `a fresh session, by message: ${JSON.stringify(read)}`);
    await waitFor(() => rowAt(m, 0) && !rowAt(m, 0)?.querySelector('.git-graph'), 'a flat list');
    const field = m.body.querySelector('.git-history__field');
    pick(field, 'author');
    await waitFor(() => logReads(m).some((q) => q.author === 'fix' && !q.message), 'an author read');
    pick(field, 'path');
    await waitFor(() => logReads(m).some((q) => q.path === 'fix' && !q.author), 'a path read');
    m.teardown();
  });

  await test('/ focuses the filter, Enter applies it at once, Escape clears it', async () => {
    const m = mount();
    await drawn(m, 0);
    const root = /** @type {HTMLElement} */ (m.body.querySelector('.git-pin'));
    press(root, '/');
    assert(document.activeElement === filterOf(m), `focused: ${document.activeElement?.className}`);
    filterOf(m).value = 'login';
    const before = logReads(m).length;
    press(filterOf(m), 'Enter');
    const read = logReads(m).slice(before).find((q) => q.message === 'login');
    assert(Boolean(read), `read as Enter is pressed: ${JSON.stringify(logReads(m).slice(before))}`);
    press(filterOf(m), 'Escape');
    assert(filterOf(m).value === '' && document.activeElement !== filterOf(m), 'cleared and left');
    await waitFor(() => logReads(m).slice(before + 1).some((q) => !q.message && !q.graph), 'the whole list again');
    m.teardown();
  });

  await test('a sha in the filter filters by it and jumps to its commit; one outside the scope is shown with a way to all refs', async () => {
    const outside = shaOf(7, 'e');
    const m = mount({
      commit: (/** @type {string} */ rev) => {
        if (rev === 'abc1234' || rev === shaOf(450)) return commitOf(shaOf(450), { parents: parentsOf(shaOf(450)) });
        if (rev === 'def5678' || rev === outside) return commitOf(outside);
        return new Error(`Unknown revision ${rev}`);
      },
    });
    await drawn(m, 0);
    // A commit outside the current branch is offered all refs: start there.
    pick(m.body.querySelector('.git-history__scope'), 'head');
    await waitFor(() => logReads(m).some((q) => q.scope === 'head'), 'the current branch read');
    await drawn(m, 0);
    typeFilter(m, 'abc1234');
    press(filterOf(m), 'Enter');
    await waitFor(() => isSelected(m, 450), 'row 450, selected');
    assert(logReads(m).some((q) => q.find === shaOf(450) && q.message === 'abc1234'),
      `found by the server in the list filtered by the sha: ${JSON.stringify(logReads(m))}`);
    assert(filterOf(m).value === 'abc1234', `the filter keeps the sha: ${filterOf(m).value}`);

    typeFilter(m, 'def5678');
    press(filterOf(m), 'Enter');
    await waitFor(() => detail(m).querySelector('.git-history__outside'), 'the not-in-scope note');
    await waitFor(() => (detail(m).textContent || '').includes('Body of 0007'), 'that commit\u2019s detail');
    /** @type {HTMLElement} */ (detail(m).querySelector('.git-history__widen')).click();
    await waitFor(() => logReads(m).some((q) => q.scope === 'all' && q.find === outside), 'found again among all refs');
    const scope = pickerValue(m.body.querySelector('.git-history__scope'));
    assert(scope === 'all', `the picker says all refs: ${scope}`);

    typeFilter(m, 'beef');
    press(filterOf(m), 'Enter');
    await waitFor(() => logReads(m).some((q) => q.message === 'beef'), 'hex that names no commit is a message filter');
    m.teardown();
  });

  await test('a pin left on History over a scoped review opens on History again', async () => {
    const m = mount({ config: { place: 'history', scope: `${shaOf(4)}..${shaOf(1)}` } });
    const root = /** @type {HTMLElement} */ (m.body.querySelector('.git-pin'));
    assert(root.dataset.place === 'history', `the place last chosen, not Review: ${root.dataset.place}`);
    m.teardown();
  });

  await test('shift-click or x marks a second commit; Compare reviews the two, older first', async () => {
    const m = mount();
    await drawn(m, 5);
    const root = /** @type {HTMLElement} */ (m.body.querySelector('.git-pin'));
    /** @type {HTMLElement} */ (rowAt(m, 1)).click();
    /** @type {HTMLElement} */ (rowAt(m, 4)).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    assert(isSelected(m, 1), 'the selection stays');
    assert(Boolean(rowAt(m, 4)?.classList.contains('git-history__row--marked')), 'row 4 is marked');
    // Rows 2 and 3 are the side branch row 0 merges: row 1's parent is row 4.
    assert(JSON.stringify(inRun(m)) === '[1,4]', `the run is highlighted, the side branch drawn between left out: ${JSON.stringify(inRun(m))}`);
    const compare = /** @type {HTMLElement} */ (await waitFor(() => detail(m).querySelector('.git-history__compare'), 'a Compare button'));
    assert((compare.textContent || '').includes(`${shaOf(4).slice(0, 7)}..${shaOf(1).slice(0, 7)}`), `older..newer: ${compare.textContent}`);

    /** @type {HTMLElement} */ (rowAt(m, 2)).click();
    assert(!m.body.querySelector('.git-history__row--marked'), 'a plain click clears the mark');
    assert(inRun(m).length === 0, `and the run: ${JSON.stringify(inRun(m))}`);
    press(root, 'x');
    press(root, 'k');
    press(root, 'k');
    assert(isSelected(m, 0) && Boolean(rowAt(m, 2)?.classList.contains('git-history__row--marked')), 'x marks the selected row');
    assert(JSON.stringify(inRun(m)) === '[0,1,2]', `the run follows the selection: ${JSON.stringify(inRun(m))}`);
    const again = /** @type {HTMLElement} */ (await waitFor(() => detail(m).querySelector('.git-history__compare'), 'Compare again'));
    again.click();
    assert(root.dataset.place === 'review', `Review comes forward: ${root.dataset.place}`);
    await waitFor(() => m.reviewOptions().some((/** @type {any} */ o) => o.scope === `${shaOf(2)}..${shaOf(0)}`), 'the range reviewed');

    root.querySelector(`.git-pin__place-btn[data-place="history"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    press(root, 'Escape');
    assert(!m.body.querySelector('.git-history__row--marked'), 'Escape clears the mark');
    assert(inRun(m).length === 0, `and the run: ${JSON.stringify(inRun(m))}`);
    m.teardown();
  });

  /**
   * Mount in Refs, over a history whose every-ref scope has three commits on
   * top of what HEAD reaches, and whose one-ref scope has one.
   * @param {object} [options] - Passed to `mountPin`.
   * @returns {any} The mounted pin.
   */
  const mountRefs = (options = {}) => {
    const head = historyOf(1000);
    const all = historyOf(1000, { top: 3, graph: 'gall' });
    const one = historyOf(10, { top: 1, graph: 'gref' });
    return mount({
      place: 'refs',
      log: (/** @type {any} */ q) => (q.scope === 'all' ? all : q.scope === 'ref' ? one : head)(q),
      refs: refsOf({
        branches: [
          { name: 'develop', sha: shaOf(0), subject: '', date: 0, ahead: 0, behind: 0, head: true },
          { name: 'old', sha: shaOf(300), subject: 'Old', date: 0, ahead: 0, behind: 0 },
          { name: 'side', sha: shaOf(1, 'f'), subject: 'Side', date: 0, ahead: 0, behind: 0 },
        ],
        tags: [{ name: 'v1', sha: shaOf(3), target: shaOf(3), annotated: false, subject: 'Tagged', date: 0 }],
        stashes: [{ sha: shaOf(0, 'f'), message: 'WIP on develop', date: 0 }],
      }),
      ...options,
    });
  };
  /**
   * Open a Refs row's detail and press one of its buttons.
   * @param {any} m - The mounted pin.
   * @param {string} key - The row's key.
   * @param {string} selector - The button, within the detail.
   */
  const pressInRefs = async (m, key, selector) => {
    const row = /** @type {HTMLElement} */ (await waitFor(() => m.body.querySelector(`.git-refs__row[data-key="${key}"]`), `the ${key} row`));
    row.click();
    const button = /** @type {HTMLElement} */ (await waitFor(() => m.body.querySelector(`.git-refs__detail ${selector}`), `${selector} in ${key}`));
    button.click();
  };
  /**
   * @param {any} m - The mounted pin.
   * @returns {string} The scope picker's value.
   */
  const scopeOf = (m) => pickerValue(m.body.querySelector('.git-history__scope'));

  await test('Refs \u2192 History: a branch\u2019s tip is selected in the list', async () => {
    const m = mountRefs();
    const root = /** @type {HTMLElement} */ (m.body.querySelector('.git-pin'));
    await pressInRefs(m, 'br:old', '.git-refs__act[data-action="show-history"]');
    assert(root.dataset.place === 'history', `History comes forward: ${root.dataset.place}`);
    // All refs, where History starts, puts three commits above what HEAD reaches.
    await waitFor(() => isSelected(m, 303), 'row 303, selected');
    assert(scopeOf(m) === 'all', `among all refs: ${scopeOf(m)}`);
    m.teardown();
  });

  await test('Refs \u2192 History: a tip HEAD does not reach widens to all refs', async () => {
    const m = mountRefs();
    await pressInRefs(m, 'br:side', '.git-refs__act[data-action="show-history"]');
    await waitFor(() => isSelected(m, 1) && rowAt(m, 1)?.getAttribute('data-sha') === shaOf(1, 'f'), 'its row among all refs');
    assert(scopeOf(m) === 'all', `the picker says all refs: ${scopeOf(m)}`);
    m.teardown();
  });

  await test('Refs \u2192 History: a stash is shown as its own history', async () => {
    const m = mountRefs();
    const stash = shaOf(0, 'f');
    await pressInRefs(m, `st:${stash}`, '.git-refs__act[data-action="show-history"]');
    await waitFor(() => isSelected(m, 0) && rowAt(m, 0)?.getAttribute('data-sha') === stash, 'the stash, selected');
    assert(scopeOf(m) === `ref:${stash}`, `scoped to it: ${scopeOf(m)}`);
    assert(logReads(m).some((q) => q.scope === 'ref' && q.ref === stash), 'read as one ref');
    m.teardown();
  });

  await test('Refs \u2192 History: the detail\u2019s commit id is a link to it', async () => {
    const m = mountRefs();
    await pressInRefs(m, 'tg:v1', '.git-refs__sha');
    await waitFor(() => isSelected(m, 6), 'the tagged commit, selected');
    m.teardown();
  });

  /** The pin's own words the case below draws, registered pseudo-localised. */
  const CORE_TEXT = [
    'Changes', 'Review', 'Refs', 'History', 'Current branch', 'All refs', 'Branches', 'Remote branches', 'Tags',
    'Which commits', 'Select a commit.', 'Back (esc)', 'More',
    'Author', 'Commit ID', 'Commit messages', 'Authors', 'Changed paths', 'in messages', 'in authors', 'in paths',
    'The filter matches commit messages, and a commit id', 'What the filter searches',
    'Filter the history', 'Filter by message or commit id (/)',
    'Uncommitted changes', 'Show in Changes', '{count, plural, one {# file} other {# files}}',
    'Committer', 'Parents', '{author} · {date}', 'Select {sha}', 'Changes in {sha}', 'Compare {range}',
    'Review what changed between the marked commit and this one',
    'Checkout (detached)', 'Branch here…', 'Tag here…', 'New worktree from here…', 'Cherry-pick onto {branch}', 'Revert',
    'Reset {branch} here — keep changes staged', 'Reset {branch} here — keep changes', 'Reset {branch} here — discard changes…',
    'Copy SHA', 'Reflog', 'Edit commit message…', 'Fix up with staged changes', 'Drop commit', 'Squash {count} commits',
    'Make the commits from the marked one to this one a single commit, their messages joined',
    'Fold what is staged into this commit', 'Take this commit out of the branch (undoable)', 'Resize the commit list',
  ];

  await test('en-XA: the History place speaks the user\u2019s language', async () => {
    await underPseudoLocale('git-history-test', async () => {
      const refs = refsOf({ branches: [{ name: 'develop', sha: shaOf(0), subject: '', date: 0, ahead: 0, behind: 0, head: true }] });
      const m = mount({ refs, log: historyOf(5) });
      await drawn(m, 1);
      // Opened, so its section headings and fixed scopes are judged too; a
      // ref's name is data.
      const choices = pickerChoices(m.body.querySelector('.git-history__scope'));
      const picked = [...new Set(choices.map((c) => c.group).filter(Boolean)),
        ...choices.filter((c) => !c.value.startsWith('ref:')).map((c) => c.label)];
      assert(choices.some((c) => c.group), 'the picker has sections');
      /** @type {HTMLElement} */ (rowAt(m, 0)).click();
      /** @type {HTMLElement} */ (rowAt(m, 1)).dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
      await waitFor(() => detail(m).querySelector('.git-history__compare') && detail(m).querySelector('.review-panel__file'), 'the detail, with its files');
      const place = /** @type {Element} */ (m.body.querySelector('.git-history'));
      const shown = [
        ...picked,
        ...shownStrings(/** @type {Element} */ (m.body.querySelector('.git-pin__places'))),
        // Data, not words: ids, names, subjects, paths, the diff; the back button's ‹ is a glyph.
        ...shownStrings(place, [
          '.git-history__row', '.git-history__back', '.git-history__crumb-title', '.git-history__id > .git-history__mono',
          '.git-history__parent', '.git-history__chip', '.git-history__title', '.git-history__message',
          '.review-panel__file', '.review-panel__diff',
        ].join(', ')),
      ];
      // Words that carry data (the fixture's short ids, names and branch) are
      // judged without it: what is left must hold no plain letters.
      const data = /\b[af][0-9a-f]{6}\b|\bAda\b|\bGrace\b|\bdevelop\b/g;
      const raw = shown.map((x) => x.trim()).filter((x) => x && !isPseudoLocalized(x)
        && /[A-Za-z]/.test(x.replace(data, '').replace(/\{[A-Za-z0-9_]+\}/g, '')));
      assert(shown.length >= 6, `expected the place to show text: ${JSON.stringify(shown)}`);
      assert(raw.length === 0, `plain English under en-XA: ${JSON.stringify(raw)}`);
      m.teardown();
    }, { '@juggler/core': CORE_TEXT });
  });

  return { passed, failed, errors };
}
