//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * `<diff-viewer>` picking lines to stage.
 *
 * A viewer given a staging verb lets the reader pick changed lines and asks for
 * a hunk, or the picked part of one, to be staged. The request names lines by
 * their coordinates in the file — a removal by its old number, an addition by
 * its new one — and never by hunk index, because the viewer regroups the
 * server's hunks when its context is narrower than the patch's, so the hunk the
 * reader sees is not always one the server sent. These cases pin that, and that
 * the selection outlives everything that redraws the same diff.
 * @module unit-tests/diff-stage-select-test
 */

import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const { createDiffViewer, SPLIT_MIN_REM } = await import('../../js/components/diff-viewer.js');

  /** @type {HTMLElement[]} */
  const mounted = [];

  /**
   * @param {string} label - Case name
   * @param {() => (void|Promise<void>)} fn - Case body
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      while (mounted.length > 0) mounted.pop()?.remove();
    }
  };

  const threshold = SPLIT_MIN_REM * parseFloat(getComputedStyle(document.documentElement).fontSize);

  /**
   * A staging viewer in the document, at a context the patch was produced at so
   * nothing regroups unless a case asks it to.
   * @param {object} [options] - How to make it.
   * @param {boolean} [options.readOnly=true] - False to offer comment anchors too.
   * @param {boolean} [options.wide=false] - Wide enough for two columns.
   * @returns {any} The viewer.
   */
  const stagingViewer = ({ readOnly = true, wide = false } = {}) => {
    const host = document.createElement('div');
    host.style.width = `${Math.round(wide ? threshold * 1.5 : 600)}px`;
    host.style.position = 'absolute';
    host.style.left = '-9999px';
    const el = /** @type {any} */ (createDiffViewer({ readOnly, stage: { verb: 'stage' } }));
    host.appendChild(el);
    document.body.appendChild(host);
    mounted.push(host);
    el.setContextLines(3);
    return el;
  };

  /**
   * One hunk, produced at context 3, holding two changes seven unchanged lines
   * apart: one hunk as sent, two once the viewer narrows to one line of context.
   * @param {object} [over] - Fields to override.
   * @returns {any} The patch.
   */
  const patch = (over = {}) => {
    /** @type {any[]} */
    const lines = [];
    const context = (/** @type {number} */ n) => lines.push({ kind: 'context', oldLine: n, newLine: n, text: `ctx ${n}` });
    for (let n = 7; n <= 9; n++) context(n);
    lines.push({ kind: 'remove', oldLine: 10, text: 'old ten' });
    lines.push({ kind: 'add', newLine: 10, text: 'new ten' });
    lines.push({ kind: 'add', newLine: 11, text: 'new eleven' });
    // The insertion shifts the new side by one from here on.
    for (let n = 11; n <= 17; n++) lines.push({ kind: 'context', oldLine: n, newLine: n + 1, text: `ctx ${n}` });
    lines.push({ kind: 'remove', oldLine: 18, text: 'old eighteen' });
    lines.push({ kind: 'add', newLine: 19, text: 'new eighteen' });
    for (let n = 19; n <= 21; n++) lines.push({ kind: 'context', oldLine: n, newLine: n + 1, text: `ctx ${n}` });
    return {
      repo: '',
      path: 'src/a.js',
      status: 'modified',
      added: 3,
      removed: 2,
      revision: 'r1',
      context: 3,
      hunks: [{ oldStart: 7, oldLines: 15, newStart: 7, newLines: 16, lines }],
      ...over,
    };
  };

  /**
   * The changed line at a coordinate, in whichever layout is drawn.
   * @param {any} el - A viewer.
   * @param {'old'|'new'} side - Which file.
   * @param {number} line - Its number there.
   * @returns {HTMLElement} The line.
   */
  const lineAt = (el, side, line) => {
    const kind = side === 'old' ? 'remove' : 'add';
    const found = el.querySelector(`.diff-line.${kind}[data-${side}-line="${line}"]`);
    assert(found instanceof HTMLElement, `no ${kind} line at ${side} ${line}`);
    return /** @type {HTMLElement} */ (found);
  };

  /**
   * @param {Element} target - What to click.
   * @param {boolean} [shiftKey=false] - Hold shift.
   */
  const click = (target, shiftKey = false) => {
    target.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, shiftKey }));
  };

  /**
   * @param {Array<{old?: number, new?: number}>} coords - Coordinates.
   * @returns {string} Them, written compactly.
   */
  const show = (coords) => coords.map((c) => (c.old !== undefined ? `o${c.old}` : `n${c.new}`)).join(' ');

  /**
   * @param {any} el - A viewer.
   * @returns {string} What it says is picked.
   */
  const picked = (el) => show(el.getStageSelection());

  /**
   * @param {any} el - A viewer.
   * @returns {HTMLElement[]} Its hunk buttons, in order.
   */
  const buttons = (el) => [...el.querySelectorAll('diff-hunk-header .diff-stage-btn')]
    .map((b) => /** @type {HTMLElement} */ (b));

  /**
   * @param {any} el - A viewer
   * @param {string} type - Event name
   * @returns {any[]} The details of every such event, collected from now on.
   */
  const collect = (el, type) => {
    /** @type {any[]} */
    const seen = [];
    el.addEventListener(type, (/** @type {CustomEvent} */ e) => seen.push(e.detail));
    return seen;
  };

  await run('clicking a changed line picks it, and clicking again unpicks it', async () => {
    const el = stagingViewer();
    el.setPatch(patch());
    click(lineAt(el, 'old', 10));
    assert(picked(el) === 'o10', `picked: ${picked(el)}`);
    assert(lineAt(el, 'old', 10).getAttribute('aria-pressed') === 'true', 'picked line not pressed');
    assert(lineAt(el, 'new', 10).getAttribute('aria-pressed') === 'false', 'an unpicked changed line should read unpressed');
    click(lineAt(el, 'new', 11));
    assert(picked(el) === 'o10 n11', `picked: ${picked(el)}`);
    click(lineAt(el, 'old', 10));
    assert(picked(el) === 'n11', `after unpicking: ${picked(el)}`);
    assert(lineAt(el, 'old', 10).getAttribute('aria-pressed') === 'false', 'unpicked line still pressed');
    const context = el.querySelector('.diff-line.equal');
    click(context);
    assert(picked(el) === 'n11', `an unchanged line was picked: ${picked(el)}`);
    assert(!context.hasAttribute('aria-pressed'), 'an unchanged line offers itself as pickable');
  });

  await run('the hunk button counts what is picked in its hunk', async () => {
    const el = stagingViewer();
    el.setPatch(patch());
    assert(buttons(el).length === 1, `buttons: ${buttons(el).length}`);
    assert(buttons(el)[0]?.textContent === 'Stage hunk', `label: ${buttons(el)[0]?.textContent}`);
    click(lineAt(el, 'old', 10));
    assert(buttons(el)[0]?.textContent === 'Stage 1 line', `label: ${buttons(el)[0]?.textContent}`);
    click(lineAt(el, 'new', 19));
    assert(buttons(el)[0]?.textContent === 'Stage 2 lines', `label: ${buttons(el)[0]?.textContent}`);
  });

  await run('shift-click picks every changed line between, in file order', async () => {
    const el = stagingViewer();
    el.setPatch(patch());
    click(lineAt(el, 'new', 10));
    click(lineAt(el, 'old', 18), true);
    assert(picked(el) === 'n10 n11 o18', `picked: ${picked(el)}`);
    // Backwards works the same way, from the last line clicked.
    el.clearStageSelection();
    assert(picked(el) === '', `cleared: ${picked(el)}`);
    click(lineAt(el, 'new', 19));
    click(lineAt(el, 'new', 10), true);
    assert(picked(el) === 'n10 n11 o18 n19', `picked: ${picked(el)}`);
  });

  await run('a hunk button with nothing picked asks for the whole hunk', async () => {
    const el = stagingViewer();
    el.setPatch(patch());
    const seen = collect(document.body, 'diff-stage-request');
    click(/** @type {HTMLElement} */ (buttons(el)[0]));
    assert(seen.length === 1, `requests: ${seen.length}`);
    const detail = seen[0];
    assert(detail.verb === 'stage', `verb: ${detail.verb}`);
    assert(detail.revision === 'r1', `revision: ${detail.revision}`);
    assert(detail.context === 3, `context: ${detail.context}`);
    assert(show(detail.lines) === 'o10 n10 n11 o18 n19', `lines: ${show(detail.lines)}`);
    assert(detail.lines.every((/** @type {any} */ c) => Object.keys(c).length === 1),
      `each coordinate names one side: ${JSON.stringify(detail.lines)}`);
  });

  await run('a hunk button with lines picked asks for only those', async () => {
    const el = stagingViewer();
    el.setPatch(patch());
    const seen = collect(el, 'diff-stage-request');
    click(lineAt(el, 'new', 11));
    click(lineAt(el, 'old', 18));
    click(/** @type {HTMLElement} */ (buttons(el)[0]));
    assert(show(seen[0]?.lines ?? []) === 'n11 o18', `lines: ${show(seen[0]?.lines ?? [])}`);
  });

  await run('a narrower context splits the hunk, and each button names its own lines', async () => {
    const el = stagingViewer();
    el.setPatch(patch());
    click(lineAt(el, 'old', 18));
    el.setContextLines(1);
    const drawn = buttons(el);
    assert(drawn.length === 2, `expected two rendered hunks at context 1, got ${drawn.length}`);
    assert(drawn[0]?.textContent === 'Stage hunk', `first label: ${drawn[0]?.textContent}`);
    assert(drawn[1]?.textContent === 'Stage 1 line', `second label: ${drawn[1]?.textContent}`);
    assert(lineAt(el, 'old', 18).getAttribute('aria-pressed') === 'true', 'the pick did not survive the context change');

    const seen = collect(el, 'diff-stage-request');
    click(/** @type {HTMLElement} */ (drawn[0]));
    click(/** @type {HTMLElement} */ (drawn[1]));
    assert(show(seen[0]?.lines ?? []) === 'o10 n10 n11', `first hunk: ${show(seen[0]?.lines ?? [])}`);
    assert(seen[0]?.context === 3, `context is the patch's, not the view's: ${seen[0]?.context}`);
    assert(show(seen[1]?.lines ?? []) === 'o18', `second hunk: ${show(seen[1]?.lines ?? [])}`);
  });

  await run('the selection survives a redraw of the same revision and clears on a new one', async () => {
    const el = stagingViewer();
    el.setPatch(patch());
    click(lineAt(el, 'new', 11));
    el.setView('inline');
    el.setPatch(patch());
    assert(picked(el) === 'n11', `after same-revision setPatch: ${picked(el)}`);
    assert(lineAt(el, 'new', 11).getAttribute('aria-pressed') === 'true', 'not drawn as picked after setPatch');
    el.setPatch(patch({ revision: 'r2' }));
    assert(picked(el) === '', `after a new revision: ${picked(el)}`);
    assert(lineAt(el, 'new', 11).getAttribute('aria-pressed') === 'false', 'drawn as picked after a new revision');
  });

  await run('the split view picks and stages by the same coordinates', async () => {
    const el = stagingViewer({ wide: true });
    el.setView('split');
    el.setPatch(patch());
    assert(el.dataset.view === 'split', `expected split, got ${el.dataset.view}`);
    click(lineAt(el, 'old', 10));
    click(lineAt(el, 'new', 11), true);
    assert(picked(el) === 'o10 n10 n11', `picked: ${picked(el)}`);
    assert(lineAt(el, 'new', 10).getAttribute('aria-pressed') === 'true', 'split cell not pressed');
    const seen = collect(el, 'diff-stage-request');
    click(/** @type {HTMLElement} */ (buttons(el)[0]));
    assert(show(seen[0]?.lines ?? []) === 'o10 n10 n11', `lines: ${show(seen[0]?.lines ?? [])}`);
  });

  await run('Space on a focused changed line toggles it', async () => {
    const el = stagingViewer();
    el.setPatch(patch());
    const line = lineAt(el, 'new', 19);
    assert(line.tabIndex === 0, `a changed line should be focusable, tabIndex ${line.tabIndex}`);
    line.focus();
    const key = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true });
    line.dispatchEvent(key);
    assert(picked(el) === 'n19', `picked: ${picked(el)}`);
    assert(key.defaultPrevented, 'Space should not also scroll');
    assert(document.activeElement === line, 'the line lost focus on toggling');
  });

  await run('the comment anchor still asks for a comment and does not pick', async () => {
    const el = stagingViewer({ readOnly: false });
    el.setPatch(patch());
    const seen = collect(el, 'diff-comment-request');
    const anchor = lineAt(el, 'new', 11).querySelector('.diff-comment-btn');
    assert(anchor instanceof HTMLElement, 'no comment anchor on the line');
    click(/** @type {HTMLElement} */ (anchor));
    assert(seen.length === 1 && seen[0].side === 'new' && seen[0].startLine === 11,
      `comment request: ${JSON.stringify(seen)}`);
    assert(picked(el) === '', `the anchor picked its line: ${picked(el)}`);
  });

  await run('a viewer without a verb offers nothing to pick or stage', async () => {
    const el = /** @type {any} */ (createDiffViewer());
    el.setPatch(patch());
    assert(el.querySelectorAll('.diff-stage-btn').length === 0, 'a hunk button without a verb');
    assert(el.querySelectorAll('.diff-line[aria-pressed]').length === 0, 'pickable lines without a verb');
    assert(el.querySelectorAll('.diff-line[tabindex]').length === 0, 'focusable lines without a verb');
    click(/** @type {HTMLElement} */ (el.querySelector('.diff-line.remove')));
    assert(picked(el) === '', `picked without a verb: ${picked(el)}`);
  });

  await run('setStageable switches the verb and the labels with it', async () => {
    const el = stagingViewer();
    el.setPatch(patch());
    el.setStageable('unstage');
    assert(buttons(el)[0]?.textContent === 'Unstage hunk', `label: ${buttons(el)[0]?.textContent}`);
    click(lineAt(el, 'old', 10));
    el.setStageable('discard');
    assert(buttons(el)[0]?.textContent === 'Discard 1 line', `label: ${buttons(el)[0]?.textContent}`);
    el.setStageable(null);
    assert(buttons(el).length === 0, 'buttons stayed after turning staging off');
    assert(picked(el) === '', `selection kept after turning staging off: ${picked(el)}`);
  });

  return { passed, failed, errors };
}
