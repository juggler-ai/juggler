//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * `<diff-viewer>`'s cost is bounded by what is in view: a patch of the size the
 * server caps at draws a window of rows, not the file, in both layouts; the
 * window follows the scroller; a comment far down the file is neither drawn
 * early nor mistaken for outdated; and a host that hands over a patch and its
 * comments together pays for one render, not two.
 *
 * Every step here is synchronous — the window is drawn in the call that changes
 * it and on the scroll event itself — because a test lane never paints.
 * @module unit-tests/diff-window-test
 */

import { assert } from '../utilities/test-helpers.js';
import { SPLIT_MIN_REM, createDiffViewer } from '../../js/components/diff-viewer.js';
import { createReviewPanel } from '../../js/components/review-panel.js';

/** Lines in the big patch: the server's own cap. */
const LINES = 20000;

/** The most row elements a window may hold, whatever the patch's size. */
const BOUND = 500;

/**
 * One hunk of LINES lines: mostly context, with a removal and an addition
 * every tenth line, numbered the way git numbers them.
 * @returns {any} A `GitFileDiff`.
 */
function bigPatch() {
  /** @type {any[]} */
  const lines = [];
  let oldLine = 1;
  let newLine = 1;
  for (let i = 0; i < LINES; i++) {
    const kind = i % 10 === 4 ? 'remove' : (i % 10 === 5 ? 'add' : 'context');
    /** @type {any} */
    const line = { kind, text: `line ${i} ${'x'.repeat(i % 50)}` };
    if (kind !== 'add') line.oldLine = oldLine++;
    if (kind !== 'remove') line.newLine = newLine++;
    lines.push(line);
  }
  return {
    path: 'big.txt',
    revision: 'r1',
    added: LINES / 10,
    removed: LINES / 10,
    context: 3,
    hunks: [{ oldStart: 1, oldLines: oldLine - 1, newStart: 1, newLines: newLine - 1, lines }],
  };
}

/**
 * Lets the stubs' promises, and the panel's awaits on them, run out. Every stub
 * resolves without a timer, so this is a fixed number of microtask turns.
 * @returns {Promise<void>}
 */
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
   */
  const test = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
  /** @type {HTMLElement[]} */
  const mounted = [];

  /**
   * A viewer in the document, wide enough for two columns. It scrolls itself
   * (the component's own `max-height`), as it does in a transcript.
   * @param {boolean} readOnly - Whether it offers comment anchors.
   * @returns {any} The viewer.
   */
  const mount = (readOnly) => {
    const box = document.createElement('div');
    box.style.cssText = `position:absolute;left:-9999px;top:0;width:${Math.round(SPLIT_MIN_REM * rem * 1.5)}px;`;
    document.body.appendChild(box);
    mounted.push(box);
    const viewer = /** @type {any} */ (createDiffViewer({ readOnly }));
    box.appendChild(viewer);
    viewer.setView('inline');
    viewer.setContextLines(3);
    return viewer;
  };

  /**
   * Scroll the viewer and tell it so, as the browser would.
   * @param {any} viewer - The viewer.
   * @param {number} top - Where to.
   */
  const scrollTo = (viewer, top) => {
    viewer.scrollTop = top;
    viewer.dispatchEvent(new Event('scroll'));
  };

  /**
   * The new-side numbers drawn, in order.
   * @param {any} viewer - The viewer.
   * @returns {number[]} The numbers.
   */
  const drawnNew = (viewer) => [...viewer.querySelectorAll('.diff-line[data-new-line]')]
    .map((line) => Number(/** @type {HTMLElement} */ (line).dataset.newLine));

  /**
   * Scroll until a new-side line is drawn, steering by what each scroll drew.
   * @param {any} viewer - The viewer.
   * @param {number} wanted - The new-side line.
   */
  const scrollToNew = (viewer, wanted) => {
    let top = viewer.scrollHeight * (wanted / (LINES * 0.9));
    for (let attempt = 0; attempt < 8; attempt++) {
      scrollTo(viewer, top);
      const numbers = drawnNew(viewer);
      if (numbers.includes(wanted)) return;
      const first = numbers[0] ?? 0;
      const last = numbers[numbers.length - 1] ?? 0;
      const span = Math.max(1, last - first);
      const perLine = Math.max(1, (viewer.scrollTop - top + viewer.clientHeight) / span) || 20;
      top = viewer.scrollTop + (wanted - (first + last) / 2) * perLine;
    }
    throw new Error(`never drew new line ${wanted}; drawn ${drawnNew(viewer).slice(0, 3)}…`);
  };

  try {
    await test('a 20,000-line patch draws a window of rows, and stands for all of them', () => {
      const viewer = mount(false);
      viewer.setPatch(bigPatch());
      const lines = viewer.querySelectorAll('.diff-line').length;
      assert(lines > 0, 'expected some lines drawn');
      assert(lines <= BOUND, `expected at most ${BOUND} lines in the DOM, got ${lines}`);
      assert(viewer.scrollHeight > LINES * rem, `the scroll height should stand for every line, got ${viewer.scrollHeight}px`);

      scrollTo(viewer, viewer.scrollHeight);
      const numbers = drawnNew(viewer);
      assert(numbers.includes(LINES * 0.9), `scrolled to the end, the last line should be drawn; drawn ${numbers.slice(-3)}`);
      const after = viewer.querySelectorAll('.diff-line').length;
      assert(after <= BOUND, `scrolled, still at most ${BOUND} lines, got ${after}`);
      assert(viewer.querySelectorAll('.diff-comment-btn').length <= BOUND,
        'anchors are drawn for the window only');
    });

    await test('the two-column layout is windowed too', () => {
      const viewer = mount(true);
      viewer.setView('split');
      viewer.setPatch(bigPatch());
      assert(viewer.dataset.view === 'split', `expected two columns, got ${viewer.dataset.view}`);
      const rows = viewer.querySelectorAll('.diff-row').length;
      assert(rows > 0 && rows <= BOUND, `expected between 1 and ${BOUND} rows, got ${rows}`);
      scrollTo(viewer, viewer.scrollHeight / 2);
      const middle = viewer.querySelectorAll('.diff-row').length;
      assert(middle > 0 && middle <= BOUND, `scrolled, expected between 1 and ${BOUND} rows, got ${middle}`);
    });

    await test('a comment far down a windowed diff is drawn when its line is, and is not outdated', () => {
      const viewer = mount(false);
      viewer.setPatch(bigPatch(), [
        { id: 'far', side: 'new', startLine: 15000, endLine: 15000, body: 'down here', revision: 'r1' },
      ]);
      assert(!viewer.querySelector('diff-file-comments .stale'), 'a line not yet drawn is still in the diff');
      assert(!viewer.querySelector('.diff-comment[data-id="far"]'), 'a comment out of view is not drawn');
      scrollToNew(viewer, 15000);
      const holder = viewer.querySelector('.diff-line[data-new-line="15000"] + .diff-comments');
      assert(holder?.querySelector('.diff-comment[data-id="far"]'), 'expected the comment under its line once drawn');
    });

    await test('setAnnotations still re-renders on its own, and setPatch alone keeps the comments it had', () => {
      const viewer = mount(false);
      viewer.setPatch(bigPatch());
      viewer.setAnnotations([{ id: 'top', side: 'new', startLine: 2, endLine: 2, body: 'x', revision: 'r1' }]);
      assert(viewer.querySelector('.diff-comment[data-id="top"]'), 'expected the comment drawn by setAnnotations');
      viewer.setPatch(bigPatch());
      assert(viewer.querySelector('.diff-comment[data-id="top"]'), 'a patch given without comments keeps those it had');
    });

    await test('the review panel draws a patch and its comments in one render', async () => {
      /** @type {(patch: any) => void} */
      let answer = () => {};
      const patch = bigPatch();
      const container = document.createElement('div');
      container.style.cssText = 'position:absolute;left:-9999px;top:0;width:1200px;height:800px;';
      document.body.appendChild(container);
      mounted.push(container);
      const comments = [{ id: 'c', repo: '', path: 'big.txt', side: 'new', startLine: 3, endLine: 3, body: 'b', revision: 'r1', scope: '' }];
      const panel = createReviewPanel({
        scopeLabel: 'x',
        loadPatch: () => new Promise((resolve) => { answer = resolve; }),
        review: { draft: () => ({ comments }), onChange: () => () => {}, save: async () => {}, clear: async () => {}, compose: async () => {} },
      });
      container.appendChild(panel.element);
      panel.setManifest({ complete: true, warnings: [], groups: [{ key: '', files: [{ repo: '', path: 'big.txt', status: 'M' }] }] });
      await flush();
      const viewer = /** @type {any} */ (panel.element.querySelector('diff-viewer'));
      assert(viewer, 'expected a viewer waiting for its patch');
      let renders = 0;
      const render = viewer.render;
      viewer.render = function (/** @type {any[]} */ ...args) {
        renders++;
        return render.apply(this, args);
      };
      answer(patch);
      await flush();
      assert(viewer.querySelector('.diff-comment[data-id="c"]'), 'expected the comment drawn with the patch');
      assert(renders === 1, `a patch and its comments should cost one render, got ${renders}`);
      const lines = viewer.querySelectorAll('.diff-line').length;
      assert(lines <= BOUND, `the panel's viewer should be windowed too, got ${lines} lines`);
      panel.destroy();
    });
  } finally {
    while (mounted.length > 0) mounted.pop()?.remove();
  }

  return { passed, failed, errors };
}
