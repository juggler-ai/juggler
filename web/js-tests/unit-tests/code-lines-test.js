//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Line-numbered code rendering tests.
 *
 * A short file renders every line. A long one renders only what its scroller
 * can show, between spacers standing in for the rest — the whole file is still
 * there to scroll through, and the last line is the last line.
 * @module unit-tests/code-lines-test
 */

import { createFileContentBlock } from '../../sdk/lib/context-item-utils.js';
import { EAGER_LINE_LIMIT } from '../../sdk/lib/code-lines.js';
import { assert, waitFor } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * A line that names its own number, except every seventh, which is blank: an
 * empty block would collapse to no height without `.ci-line`'s min-height, and
 * the row arithmetic would drift. Seven so it never coincides with a round line
 * count under test.
 * @param {number} number - 1-based line number
 * @returns {string} That line's text
 */
function lineText(number) {
  return number % 7 === 0 ? '' : `const line${number} = ${number};`;
}

/**
 * @param {number} lines - How many lines
 * @returns {string} Source whose every line names its own number
 */
function makeSource(lines) {
  /** @type {string[]} */
  const out = [];
  for (let i = 1; i <= lines; i++) out.push(lineText(i));
  return out.join('\n');
}

/**
 * @param {HTMLElement} el - Rendered block
 * @returns {number[]} Line numbers currently in the DOM
 */
function renderedNumbers(el) {
  return [...el.querySelectorAll('.ci-line')]
    .map((line) => Number(/** @type {HTMLElement} */ (line).dataset.line));
}

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Case name
   * @param {() => Promise<void>} fn - Case body
   * @returns {Promise<void>} Resolves once the case has been recorded
   */
  const test = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e?.message ?? e}`);
    }
  };

  const scroller = document.createElement('div');
  scroller.style.cssText = 'position:absolute;left:-9999px;top:0;width:60rem;height:25rem;overflow:auto;';
  document.body.appendChild(scroller);

  /**
   * Scroll the enclosing box and let the block react to it.
   *
   * Assigning `scrollTop` moves the scroller at once, but the scroll event it
   * owes is fired in the rendering update step, which a hidden page defers for
   * as long as it likes — so the event is announced here rather than waited
   * for. It is the listener's response that is under test, not the browser's
   * bookkeeping about when to run it. The block listens for it on the window,
   * in the capture phase, and redraws inside the dispatch, so it has redrawn by
   * the time this returns.
   * @param {number} top - Offset to scroll to
   */
  const scrollTo = (top) => {
    scroller.scrollTop = top;
    // Named separately from what the block did with it, so a fixture that
    // cannot scroll never reads as a window that failed to move.
    const want = Math.max(0, Math.min(top, scroller.scrollHeight - scroller.clientHeight));
    assert(Math.abs(scroller.scrollTop - want) < 2,
      `the scroller would not move: asked for ${top}, sits at ${scroller.scrollTop}, want ${want}`);
    scroller.dispatchEvent(new Event('scroll'));
  };

  /** @type {Array<() => void>} */
  const cleanups = [];

  /**
   * @param {number} lines - Line count
   * @returns {Promise<HTMLElement>} The attached, settled block
   */
  const mount = async (lines) => {
    const block = createFileContentBlock({
      content: makeSource(lines),
      language: 'javascript',
      lineNumberStart: 1,
    });
    scroller.replaceChildren(block);
    scroller.scrollTop = 0;
    const destroy = /** @type {any} */ (block).destroy;
    if (typeof destroy === 'function') {
      cleanups.push(destroy);
      // A windowed block draws a provisional window, then measures a row once it
      // has landed and redraws to fit the scroller, setting the spacer below the
      // window to stand in for the rest of the file. That spacer taking a height
      // is the measurement having happened.
      await waitFor(() => [...block.querySelectorAll('.ci-line-spacer')]
        .some((spacer) => parseFloat(/** @type {HTMLElement} */ (spacer).style.height) > 0),
      'the windowed block to measure a row and size its spacers');
    }
    return block;
  };

  try {
    await test('a short file renders every line', async () => {
      const lines = 200;
      const block = await mount(lines);
      const numbers = renderedNumbers(block);
      assert(numbers.length === lines, `rendered ${numbers.length} of ${lines} lines`);
      assert(numbers[0] === 1 && numbers[lines - 1] === lines,
        `numbered ${numbers[0]}..${numbers[lines - 1]}, want 1..${lines}`);
      assert(!/** @type {any} */ (block).destroy,
        'a fully rendered block should not carry a teardown');
    });

    await test('a file at the eager limit is still rendered whole', async () => {
      const block = await mount(EAGER_LINE_LIMIT);
      assert(renderedNumbers(block).length === EAGER_LINE_LIMIT,
        `rendered ${renderedNumbers(block).length} of ${EAGER_LINE_LIMIT}`);
    });

    await test('a long file renders only a window', async () => {
      const lines = 10000;
      const block = await mount(lines);
      const numbers = renderedNumbers(block);
      assert(numbers.length > 0, 'rendered nothing at all');
      assert(numbers.length < lines / 10,
        `rendered ${numbers.length} of ${lines} lines — that is not a window`);
      assert(numbers[0] === 1, `window starts at ${numbers[0]}, want line 1`);
      // Contiguous, so nothing is silently missing from what is on screen.
      const gap = numbers.findIndex((n, i) => i > 0 && n !== (numbers[i - 1] ?? 0) + 1);
      assert(gap === -1, `window is not contiguous at index ${gap} (${numbers[gap]})`);
    });

    await test('the scrollbar describes the whole file, not the window', async () => {
      const lines = 10000;
      const block = await mount(lines);
      const rowHeight = block.querySelector('.ci-line')?.getBoundingClientRect().height ?? 0;
      assert(rowHeight > 0, 'could not measure a row');
      const want = lines * rowHeight;
      // Padding on the enclosing boxes adds a little; the window itself must not.
      const drift = Math.abs(scroller.scrollHeight - want);
      assert(drift < rowHeight * 2,
        `scrollHeight ${scroller.scrollHeight} vs ${want} for ${lines} rows — drift ${drift.toFixed(1)}px`);
    });

    await test('a scroller the provisional window exactly fills still sizes the spacers', async () => {
      const lines = 10000;
      // Measure the fixture: a row, how far the code sits below the scroller's
      // top, how many rows a block draws beyond the visible ones, and how many it
      // draws before it has measured anything.
      const probe = await mount(lines);
      const rowHeight = probe.querySelector('.ci-line')?.getBoundingClientRect().height ?? 0;
      assert(rowHeight > 0, 'could not measure a row');
      const codeTop = /** @type {HTMLElement} */ (probe.querySelector('.ci-code-lines')).getBoundingClientRect().top
        - scroller.getBoundingClientRect().top;
      const overscan = renderedNumbers(probe).length - Math.ceil((scroller.clientHeight - codeTop) / rowHeight);
      const detached = createFileContentBlock({ content: makeSource(lines), language: 'javascript', lineNumberStart: 1 });
      const provisional = renderedNumbers(detached).length;
      /** @type {any} */ (detached).destroy?.();

      // A scroller whose measured window is exactly the provisional one.
      const height = scroller.style.height;
      scroller.style.height = `${(provisional - overscan - 0.5) * rowHeight + codeTop}px`;
      try {
        const block = await mount(lines);
        const numbers = renderedNumbers(block);
        assert(numbers.length === provisional,
          `test setup: the measured window should be the provisional ${provisional} rows, got ${numbers.length}`);
        const drift = Math.abs(scroller.scrollHeight - lines * rowHeight);
        assert(drift < rowHeight * 2,
          `scrollHeight ${scroller.scrollHeight} vs ${lines * rowHeight} for ${lines} rows — drift ${drift.toFixed(1)}px`);
      } finally {
        scroller.style.height = height;
      }
    });

    await test('scrolling to the end shows the last line', async () => {
      const lines = 10000;
      const block = await mount(lines);
      scrollTo(scroller.scrollHeight);
      const numbers = renderedNumbers(block);
      assert(numbers[numbers.length - 1] === lines,
        `last rendered line is ${numbers[numbers.length - 1]}, want ${lines}`);
      assert(numbers.length < lines / 10,
        `rendered ${numbers.length} lines at the end — the window should not have grown`);
      const last = block.querySelectorAll('.ci-line')[numbers.length - 1];
      assert(last?.textContent === lineText(lines),
        `last line reads ${JSON.stringify(last?.textContent)}, want ${JSON.stringify(lineText(lines))}`);
    });

    await test('scrolling to the middle shows the middle', async () => {
      const lines = 10000;
      const block = await mount(lines);
      scrollTo(Math.floor(scroller.scrollHeight / 2));
      const numbers = renderedNumbers(block);
      const middle = lines / 2;
      assert(numbers[0] !== undefined && Math.abs(numbers[0] - middle) < lines / 20,
        `window starts at ${numbers[0]}, expected near ${middle}`);
      const first = block.querySelector('.ci-line');
      assert(first?.textContent === lineText(numbers[0] ?? 0),
        `line ${numbers[0]} reads ${JSON.stringify(first?.textContent)}, want ${JSON.stringify(lineText(numbers[0] ?? 0))}`);
    });

    await test('a rendered line sits exactly where its number says', async () => {
      const lines = 10000;
      const block = await mount(lines);
      scrollTo(Math.floor(scroller.scrollHeight / 2));

      const code = /** @type {HTMLElement} */ (block.querySelector('.ci-code-lines'));
      const rowHeight = block.querySelector('.ci-line')?.getBoundingClientRect().height ?? 0;
      const codeTop = code.getBoundingClientRect().top;

      // The spacer standing in for the lines above the window has to be exactly
      // as tall as those lines would have been, or every rendered line is drawn
      // at the wrong offset and the scrollbar lies about where you are.
      for (const el of [...block.querySelectorAll('.ci-line')].slice(0, 3)) {
        const number = Number(/** @type {HTMLElement} */ (el).dataset.line);
        const want = (number - 1) * rowHeight;
        const got = el.getBoundingClientRect().top - codeTop;
        assert(Math.abs(got - want) < 1,
          `line ${number} is ${got.toFixed(1)}px down the block, want ${want.toFixed(1)}px`);
      }
    });

    await test('teardown empties the block and stops redrawing it', async () => {
      const block = await mount(10000);
      const destroy = /** @type {any} */ (block).destroy;
      assert(typeof destroy === 'function', 'a windowed block must carry a teardown');
      destroy();
      assert(block.querySelectorAll('.ci-line').length === 0,
        'teardown left lines behind');
      scrollTo(scroller.scrollHeight);
      assert(block.querySelectorAll('.ci-line').length === 0,
        'a torn-down block redrew itself on scroll');
    });
  } finally {
    for (const destroy of cleanups) {
      try {
        destroy();
      } catch {
        // A case may already have torn its own block down.
      }
    }
    scroller.remove();
  }

  return { passed, failed, errors };
}
