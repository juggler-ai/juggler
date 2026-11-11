//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A chain of columns wider than the window says so.
 *
 * Two halves of one affordance. A column cut off by an edge of the container is
 * indistinguishable from a column that ends there — macOS draws its scrollbar as
 * an overlay that fades out at rest, so nothing else is saying it. The container
 * fades the edges it is hiding columns behind, and a column-level scroll leaves
 * a sliver of whatever it moved past rather than parking a boundary flush.
 *
 * Both are only worth having if they are keyed to the truth: a fade on a chain
 * that fits is a false cue, and a peek that moves a view the user was already
 * reading is worse than none. That is what these pin.
 *
 * The fade is drawn by column-viewport, the box that holds the scroller, and
 * never by column-container, the scroller itself. WebKitGTK composites a masked
 * scroll container wrongly: mid-scroll it paints the mask and clip at a stale
 * offset, so faded copies of columns flash up across the window, even over the
 * header and sidebar.
 * @module unit-tests/column-edge-test
 */

import { assert } from '../utilities/test-helpers.js';
import { columnScrollDelta } from '../../js/utils/column-resize.js';
import '../../js/components/conversation-tab.js';

/** The viewport, for the CSS half. 1000px of room, 600 tall, off to one side. */
const VIEWPORT_STYLE = 'position:absolute;left:0;top:0;width:1000px;height:600px;';

/**
 * A mounted viewport and column container, to read computed style off the real
 * stylesheet.
 * @param {string[]} classes - Classes to put on both, so a rule keyed to either
 *   element is given its chance to apply.
 * @returns {{viewport: HTMLElement, container: HTMLElement, teardown: () => void}} The two elements and the removal of them.
 */
function mountViewport(classes) {
  const viewport = document.createElement('column-viewport');
  viewport.setAttribute('style', VIEWPORT_STYLE);
  const container = document.createElement('column-container');
  for (const el of [viewport, container]) el.classList.add(...classes);
  container.appendChild(document.createElement('conversation-area'));
  viewport.appendChild(container);
  document.body.appendChild(viewport);
  return { viewport, container, teardown: () => viewport.remove() };
}

/** A container occupying 0…1000 in client coordinates. */
const CONTAINER = { left: 0, right: 1000 };

/** The peek every case below is measured against. */
const PEEK = 24;

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

  check('a column already in view is left exactly where it is', () => {
    // Including one resting flush against the right edge. The peek shapes a
    // movement that was happening anyway — it is never a reason to start one,
    // because the view the user is reading is a view they chose.
    assert(columnScrollDelta({ left: 100, right: 600 }, CONTAINER, PEEK) === 0,
      'a column in the middle of the container does not move');
    assert(columnScrollDelta({ left: 500, right: 1000 }, CONTAINER, PEEK) === 0,
      'nor does one already flush against the right edge');
    assert(columnScrollDelta({ left: 0, right: 500 }, CONTAINER, PEEK) === 0,
      'nor one flush against the left');
  });

  check('a column off the right edge lands short of it, showing the next column', () => {
    // 1200 is 200px past the right edge. Scrolling by exactly 200 would park
    // this column's right edge on the container's, which is the one arrangement
    // that cannot be read: a chain that continues looks like a chain that ends.
    const delta = columnScrollDelta({ left: 700, right: 1200 }, CONTAINER, PEEK);
    assert(delta === 200 + PEEK,
      `it scrolls past the column by a peek, got ${delta} rather than ${200 + PEEK}`);
    const restingRight = 1200 - delta;
    assert(restingRight === CONTAINER.right - PEEK,
      `leaving a peek of the column beyond it showing, got ${CONTAINER.right - restingRight}px`);
  });

  check('a column off the left edge lands short of it too', () => {
    const delta = columnScrollDelta({ left: -300, right: 200 }, CONTAINER, PEEK);
    assert(delta === -300 - PEEK,
      `it scrolls back past the column by a peek, got ${delta} rather than ${-300 - PEEK}`);
    const restingLeft = -300 - delta;
    assert(restingLeft === CONTAINER.left + PEEK,
      `leaving a peek of the column before it showing, got ${restingLeft}px`);
  });

  check('a column too wide to fit lands a peek in from its left edge', () => {
    // Wider than the container, so it can never be fully in view. It anchors
    // where its content starts rather than chasing a right edge it cannot reach.
    const delta = columnScrollDelta({ left: 400, right: 1900 }, CONTAINER, PEEK);
    const restingLeft = 400 - delta;
    assert(restingLeft === CONTAINER.left + PEEK,
      `it anchors a peek in from the left, got ${restingLeft}px`);
    assert(delta < 1900 - CONTAINER.right,
      'rather than scrolling its left edge out of view chasing the right one');
  });

  check('and the peek never scrolls the view backwards to get it', () => {
    // A column overflowing the right edge whose left edge is already inside the
    // peek. Subtracting a peek it does not have would make the delta negative —
    // scrolling left, away from the column it was asked to reveal.
    const delta = columnScrollDelta({ left: 10, right: 1400 }, CONTAINER, PEEK);
    assert(delta >= 0, `the delta never goes backwards, got ${delta}`);
  });

  check('a chain that fits is not faded', () => {
    // No classes, because _updateColumnOverflow sets neither when there is
    // nothing past either edge. A fade that is always there says nothing.
    const { viewport, teardown } = mountViewport([]);
    try {
      const mask = window.getComputedStyle(viewport).maskImage;
      assert(mask === 'none',
        `an unmarked viewport carries no mask at all, got ${mask}`);
    } finally {
      teardown();
    }
  });

  check('a chain with columns past an edge fades that edge, and only that edge', () => {
    const { viewport, teardown } = mountViewport(['overflow-end']);
    try {
      const style = window.getComputedStyle(viewport);
      const mask = style.maskImage;
      assert(mask !== 'none' && mask.includes('gradient'),
        `the marked viewport masks its edge, got ${mask}`);
      assert(style.getPropertyValue('--column-fade-end').trim() !== '',
        'the end stop is opened up');
      assert(style.getPropertyValue('--column-fade-start').trim() === '',
        'while the start stop, with nothing hidden behind it, is left closed');
    } finally {
      teardown();
    }
  });

  check('scrolled to the end, the start edge stays faded on its own', () => {
    // The end stop is closed by its var() fallback, which sits inside a calc()
    // against 100%. A unitless fallback there is invalid at computed-value time,
    // and the whole mask-image falls back to none: the start fade vanished at
    // exactly the scroll position where it is the only one wanted.
    const { viewport, teardown } = mountViewport(['overflow-start']);
    try {
      const style = window.getComputedStyle(viewport);
      const mask = style.maskImage;
      assert(mask !== 'none' && mask.includes('gradient'),
        `a viewport marked only at the start still masks, got ${mask}`);
      assert(style.getPropertyValue('--column-fade-start').trim() !== '',
        'the start stop is opened up');
      assert(style.getPropertyValue('--column-fade-end').trim() === '',
        'while the end stop is left closed');
    } finally {
      teardown();
    }
  });

  check('the scroller itself is never masked', () => {
    const { container, teardown } = mountViewport(['overflow-start', 'overflow-end']);
    try {
      const mask = window.getComputedStyle(container).maskImage;
      assert(mask === 'none',
        `column-container scrolls, so it must not carry the fade, got ${mask}`);
    } finally {
      teardown();
    }
  });

  check('a tab marks the edges on its viewport, from its scroller\'s position', () => {
    const host = document.createElement('div');
    host.setAttribute('style', 'position:absolute;left:-9999px;top:0;width:1000px;height:600px;display:flex;');
    document.body.appendChild(host);
    try {
      const tab = /** @type {any} */ (document.createElement('conversation-tab'));
      tab.classList.add('is-active');
      host.appendChild(tab);
      const viewport = /** @type {HTMLElement|null} */ (tab.querySelector('column-viewport'));
      const container = /** @type {HTMLElement|null} */ (tab.querySelector('column-viewport > column-container'));
      assert(!!viewport && !!container, 'the tab renders its scroller inside a column-viewport');
      if (!viewport || !container) return;
      // Snapping is the phone layout's; pin the desktop row so the scroll
      // positions below are taken as written whatever width the window has.
      container.style.scrollSnapType = 'none';
      // And the app's smooth scrolling would animate the jump to the end
      // rather than land it before the next line reads it back.
      container.style.scrollBehavior = 'auto';
      const wide = document.createElement('div');
      wide.style.cssText = 'flex:0 0 3000px;height:10px;';
      container.appendChild(wide);

      tab._updateColumnOverflow();
      assert(viewport.classList.contains('overflow-end') && !viewport.classList.contains('overflow-start'),
        `at the start, only the end is marked, got "${viewport.className}"`);

      container.scrollLeft = container.scrollWidth;
      tab._updateColumnOverflow();
      assert(viewport.classList.contains('overflow-start') && !viewport.classList.contains('overflow-end'),
        `at the end, only the start is marked, got "${viewport.className}"`);

      assert(!container.classList.contains('overflow-start') && !container.classList.contains('overflow-end'),
        `and the scroller carries neither, got "${container.className}"`);
    } finally {
      host.remove();
    }
  });

  return { passed, failed, errors };
}
