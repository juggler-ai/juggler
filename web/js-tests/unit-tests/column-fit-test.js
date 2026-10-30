//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A conversation and the properties panel beside it, sharing a window.
 *
 * The panel has a floor it cannot be squeezed below, and a conversation column
 * holds a width in rem that came from somewhere else entirely — a drag on a
 * wider window, a window since made smaller, a zoom level that made every rem
 * bigger. When the two do not fit, one of them has to give.
 *
 * The conversation gives up only the width it has above a kept width
 * (`COLUMN_KEPT_WIDTH_REM`); up to that, the width the user chose wins and the
 * panel spills into the sideways scroll `column-container` already has. These
 * pin both halves of that rule against the real stylesheet, that a deeper chain
 * scrolls rather than squeezing, and that the CSS floors still agree with the
 * numbers `utils/column-resize.js` states them as.
 *
 * Widths are applied through `styleColumnWidth`, the one place the app writes
 * them, and containers are sized in rem, so every expectation holds at any zoom.
 * @module unit-tests/column-fit-test
 */

import { assert } from '../utilities/test-helpers.js';
import {
  COL_MIN_WIDTH_REM,
  COLUMN_KEPT_WIDTH_REM,
  PROPERTIES_MIN_REM,
  columnFitFloorRem,
  rootFontSizePx,
  styleColumnWidth,
} from '../../js/utils/column-resize.js';

/**
 * A column container of a known width, holding the columns named. Absolutely
 * positioned off to one side: this measures layout, so it needs a real box in
 * the real stylesheet, but not a place on screen.
 *
 * Mounted as the app mounts it, because the app's arrangement is the only one
 * whose answer counts. Two parts of it are load-bearing and neither is obvious:
 *
 * The width goes on a flex PARENT, and column-container takes its size from
 * `flex: 1` — never an inline width on the container itself, which would hand it
 * a definite size the real one does not have.
 *
 * And the whole thing hangs inside a `conversation-tab`, because the cascade
 * reaching these columns depends on it: `conversation-tab conversation-area` and
 * `column-container conversation-area` are specificity-identical, so which one
 * wins is decided by source order, and a column with no tab above it is read by
 * a different rule than every column in the app.
 * @param {number} widthRem - How much room the columns have between them.
 * @param {string[]} tags - Column element names, in order.
 * @returns {{container: HTMLElement, columns: HTMLElement[], teardown: () => void}}
 *   The container, its columns in the order named, and the removal of both.
 */
function mountColumns(widthRem, tags) {
  const parent = document.createElement('div');
  parent.setAttribute(
    'style',
    `position:absolute;left:0;top:0;width:${widthRem}rem;height:37.5rem;display:flex;`,
  );
  const tab = document.createElement('conversation-tab');
  tab.setAttribute('style', 'display:flex;flex:1;min-width:0;');
  parent.appendChild(tab);
  document.body.appendChild(parent);
  // The tab builds its own column-container on connect and would replace any we
  // put there, so the columns go into that one — which is the container the app
  // lays out, rather than a replica of it.
  const container = /** @type {HTMLElement} */ (tab.querySelector('column-container'));
  const columns = tags.map((tag) => {
    const column = document.createElement(tag);
    container.appendChild(column);
    return /** @type {HTMLElement} */ (column);
  });
  return { container, columns, teardown: () => parent.remove() };
}

/**
 * An element's rendered width, in rem.
 * @param {Element} element
 * @returns {number} The width, in rem.
 */
function widthRem(element) {
  return element.getBoundingClientRect().width / rootFontSizePx();
}

/**
 * Whether two widths in rem are the same once rendered — within a pixel, which
 * is all layout rounding can account for.
 * @param {number} a
 * @param {number} b
 * @returns {boolean} True when they are within a pixel of each other.
 */
function sameWidth(a, b) {
  return Math.abs(a - b) * rootFontSizePx() <= 1;
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => void} fn
   */
  const check = (label, fn) => {
    try { fn(); passed++; }
    catch (e) { failed++; errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`); }
  };

  /**
   * Mount a conversation and a properties panel, give the conversation a width,
   * and hand the pair to `fn`.
   * @param {number} containerRem
   * @param {number} chosenRem - The width the conversation column carries.
   * @param {(container: HTMLElement, area: HTMLElement, panel: HTMLElement) => void} fn
   */
  const withPair = (containerRem, chosenRem, fn) => {
    const { container, columns, teardown } = mountColumns(containerRem, ['conversation-area', 'properties-panel']);
    const [area, panel] = columns;
    try {
      styleColumnWidth(area, chosenRem);
      fn(container, area, panel);
    } finally {
      teardown();
    }
  };

  check('the kept width is the most a conversation keeps against the panel', () => {
    assert(columnFitFloorRem(COLUMN_KEPT_WIDTH_REM + 20) === COLUMN_KEPT_WIDTH_REM,
      `a wider column gives up what it has above the kept width, got ${columnFitFloorRem(COLUMN_KEPT_WIDTH_REM + 20)}`);
    assert(columnFitFloorRem(20) === 20,
      `and a narrower one keeps all of it, got ${columnFitFloorRem(20)}`);
  });

  check('a window with room for both fits the pair', () => {
    // 90rem was chosen on a wider window. This one has room for the kept width
    // and the panel, so the conversation gives up the rest and nothing scrolls.
    withPair(100, 90, (container, area, panel) => {
      assert(sameWidth(widthRem(area), 100 - PROPERTIES_MIN_REM),
        `the conversation takes what the panel leaves, got ${widthRem(area).toFixed(2)}rem`);
      assert(sameWidth(widthRem(panel), PROPERTIES_MIN_REM),
        `the panel keeps its floor, got ${widthRem(panel).toFixed(2)}rem`);
      assert(container.scrollWidth <= container.clientWidth,
        `and there is nothing to scroll to, got ${container.scrollWidth}px of columns in ${container.clientWidth}px`);
    });
  });

  check('a width up to the kept width wins over the panel', () => {
    // The reported case: a user widening a cramped conversation on a smaller
    // window. The panel gives way by spilling into the scroll, not the drag.
    withPair(56, 36, (container, area) => {
      assert(sameWidth(widthRem(area), 36),
        `the conversation keeps the 36rem it was given, got ${widthRem(area).toFixed(2)}rem`);
      assert(container.scrollWidth > container.clientWidth,
        'and the panel spills past the edge, to be reached by scrolling');
    });
  });

  check('a wider width gives up exactly what it has above the kept width', () => {
    withPair(56, 70, (container, area) => {
      assert(sameWidth(widthRem(area), COLUMN_KEPT_WIDTH_REM),
        `the conversation stops at the kept ${COLUMN_KEPT_WIDTH_REM}rem, got ${widthRem(area).toFixed(2)}rem`);
      assert(container.scrollWidth > container.clientWidth, 'and the panel spills');
    });
  });

  check('a narrow chosen width is not raised by the fit', () => {
    // The fit only ever takes width away. Its floor is the chosen width when
    // that is below the kept width, so a column dragged narrow stays narrow.
    withPair(90, 15, (container, area) => {
      assert(sameWidth(widthRem(area), 15),
        `the conversation keeps the 15rem it was given, got ${widthRem(area).toFixed(2)}rem`);
      void container;
    });
  });

  check('the kept width holds even when it is wider than the window', () => {
    // A floor that gave way to the window would only move the squeeze to a
    // smaller window. The row overspills and the container scrolls.
    withPair(22.5, 70, (container, area) => {
      assert(sameWidth(widthRem(area), COLUMN_KEPT_WIDTH_REM),
        `the conversation keeps the kept width, got ${widthRem(area).toFixed(2)}rem`);
      assert(container.scrollWidth > container.clientWidth, 'and the row overspills, to be read by scrolling');
    });
  });

  check('a deeper chain still scrolls rather than squeezing every column', () => {
    // Miller columns: depth is read by scrolling, and a chain that squeezed
    // instead would make every column in it narrower the further you drilled.
    // Only the pair at the end of a two-column chain is made to fit.
    const { container, columns, teardown } = mountColumns(
      62.5,
      ['conversation-area', 'conversation-area', 'properties-panel'],
    );
    const [first, second] = columns;
    try {
      styleColumnWidth(first, 40);
      styleColumnWidth(second, 40);
      assert(sameWidth(widthRem(first), 40),
        `the first column keeps the width it was given, got ${widthRem(first).toFixed(2)}rem`);
      assert(container.scrollWidth > container.clientWidth,
        'and the chain scrolls, which is how a chain longer than the window is read');
    } finally {
      teardown();
    }
  });

  check('the stylesheet floors are the numbers column-resize.js states', () => {
    // The CSS cannot import a constant, so it repeats them. This is where a
    // drift between the two is caught.
    const { columns, teardown } = mountColumns(
      62.5,
      ['conversation-area', 'conversation-area', 'properties-panel'],
    );
    const [first, , panel] = columns;
    try {
      styleColumnWidth(first, 40);
      const remPx = rootFontSizePx();
      const panelMin = parseFloat(window.getComputedStyle(panel).minWidth);
      assert(sameWidth(panelMin / remPx, PROPERTIES_MIN_REM),
        `the last properties panel's min-width is PROPERTIES_MIN_REM (${PROPERTIES_MIN_REM}rem), got ${panelMin}px`);
      const columnMin = parseFloat(window.getComputedStyle(first).minWidth);
      assert(sameWidth(columnMin / remPx, COL_MIN_WIDTH_REM),
        `a column outside the fit has COL_MIN_WIDTH_REM (${COL_MIN_WIDTH_REM}rem) as its floor, got ${columnMin}px`);
    } finally {
      teardown();
    }
  });

  return { passed, failed, errors };
}
