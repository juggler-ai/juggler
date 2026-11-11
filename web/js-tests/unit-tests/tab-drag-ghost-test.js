//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The drag ghost stays under the finger (`_startDrag` in conversation-bar.js).
 *
 * The ghost is a `position: fixed` clone parked on the bar itself. `left`/`top`
 * on a fixed element resolve against the viewport only while nothing on the
 * ancestor path establishes a containing block for fixed positioning — and in
 * phone drawer mode the bar does exactly that, sliding in under a `transform`.
 * Feeding it viewport coordinates there re-anchors the ghost to the drawer's
 * own box, dropping it a header's height below the finger. The invariants:
 *
 *   1. On a plain (fixed-sidebar) bar, the ghost tracks the pointer 1:1.
 *   2. On a transformed (drawer) bar, it tracks the pointer 1:1 too.
 *
 * Both are asserted on the ghost's centre, which the lift (a box grown evenly
 * round it) leaves where it is. And the ghost carries no transform and no
 * translucency, either of which makes WebKit draw it as a blurred layer. `_startDrag` is called directly: the real pointerdown listener
 * lives on tabs the bar builds from a session, and the geometry under test
 * needs neither. The drawer's `transform` is applied inline for the same reason
 * sidebar-drawer-test stands its drawer up by hand — the media query that
 * produces it can't be driven headless.
 * @module unit-tests/tab-drag-ghost-test
 */

import { assert } from '../utilities/test-helpers.js';
import '../../js/components/conversation-bar.js';

/** How far down the pointer travels during the test drag. */
const DRAG_DY = 40;

/**
 * Mount a conversation-bar holding three stand-in tabs, offset well down the
 * page so a ghost anchored to the bar instead of the viewport lands visibly
 * wrong rather than coincidentally right.
 * @param {{transformed: boolean}} opts - Whether to stand the bar up as a phone drawer.
 * @returns {{bar: any, tabs: HTMLElement[], teardown: () => void}} The bar, its tabs, and a teardown.
 */
function mountBar({ transformed }) {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:0;top:180px;width:360px;height:400px;';
  document.body.appendChild(host);

  const bar = /** @type {any} */ (document.createElement('conversation-bar'));
  host.appendChild(bar);
  bar.style.cssText = 'position:absolute;inset:0 auto 0 0;width:240px;';
  if (transformed) bar.style.transform = 'translateX(0)';

  // Stand in for render()'s output: the scroll container and the tab markup
  // _startDrag reads (.conversation-tabs, .conversation-bar-tab, the id dataset).
  bar.innerHTML = `
    <nav class="conversation-bar">
      <menu class="conversation-tabs">
        <li class="conversation-bar-tab" data-conversation-id="a">
          <span class="drag-grip" aria-hidden="true">⠿</span>
          <button class="conversation-bar-tab-button"><span class="conversation-bar-tab-name">A</span></button>
        </li>
        <li class="conversation-bar-tab" data-conversation-id="b">
          <span class="drag-grip" aria-hidden="true">⠿</span>
          <button class="conversation-bar-tab-button"><span class="conversation-bar-tab-name">B</span></button>
        </li>
        <li class="conversation-bar-tab" data-conversation-id="c">
          <span class="drag-grip" aria-hidden="true">⠿</span>
          <button class="conversation-bar-tab-button"><span class="conversation-bar-tab-name">C</span></button>
        </li>
      </menu>
    </nav>`;

  const tabs = /** @type {HTMLElement[]} */ (Array.from(bar.querySelectorAll('.conversation-bar-tab')));
  return { bar, tabs, teardown: () => host.remove() };
}

/**
 * Rects are compared through their centres throughout: the ghost is lifted by
 * growing its box, which pushes every edge out by a fraction of the tab's size
 * but leaves the centre where it is.
 * @param {DOMRect} rect - A rect to take the vertical centre of.
 * @returns {number} Its centre in viewport coordinates.
 */
function centreY(rect) {
  return rect.top + rect.height / 2;
}

/**
 * @param {DOMRect} rect - A rect to take the horizontal centre of.
 * @returns {number} Its centre in viewport coordinates.
 */
function centreX(rect) {
  return rect.left + rect.width / 2;
}

/**
 * Drag a tab down by DRAG_DY through the real handler and report where the
 * ghost ended up against where the finger is.
 * @param {any} bar - The mounted conversation-bar.
 * @param {HTMLElement} tab - The tab to grab.
 * @returns {{ghost: DOMRect, expectedCentreY: number, expectedCentreX: number}} The ghost's rect and where its centre should be.
 */
function dragBy(bar, tab) {
  // Synthetic pointers don't exist as far as pointer capture is concerned, so
  // the real calls would throw NotFoundError mid-drag.
  tab.setPointerCapture = () => {};
  tab.releasePointerCapture = () => {};

  const rest = tab.getBoundingClientRect();
  const grabY = centreY(rest);

  bar._startDrag(
    /** @type {any} */ ({ clientY: grabY, pointerId: 1 }),
    tab
  );
  document.dispatchEvent(new PointerEvent('pointermove', {
    pointerId: 1, buttons: 1, pointerType: 'touch', clientX: 100, clientY: grabY + DRAG_DY, bubbles: true,
  }));

  const ghostEl = /** @type {HTMLElement|null} */ (bar.querySelector('.drag-ghost'));
  assert(!!ghostEl, 'a drag past the slop threshold must create a ghost');
  return {
    ghost: /** @type {HTMLElement} */ (ghostEl).getBoundingClientRect(),
    expectedCentreY: grabY + DRAG_DY,
    expectedCentreX: centreX(rest),
  };
}

/** Release the drag so its document listeners and ghost don't outlive the test. */
function release() {
  document.dispatchEvent(new PointerEvent('pointerup', {
    pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 0, bubbles: true,
  }));
}

/**
 * Run the drag-ghost placement suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {boolean} transformed - Whether to mount the bar as a phone drawer.
   */
  const run = (label, transformed) => {
    const { bar, tabs, teardown } = mountBar({ transformed });
    const tab = /** @type {HTMLElement} */ (tabs[1]);
    try {
      const { ghost, expectedCentreY, expectedCentreX } = dragBy(bar, tab);
      const dy = centreY(ghost) - expectedCentreY;
      assert(Math.abs(dy) <= 1,
        `the ghost must sit under the finger, not ${dy.toFixed(1)}px off it`);
      const dx = centreX(ghost) - expectedCentreX;
      assert(Math.abs(dx) <= 1,
        `the ghost must keep the tab's column, not ${dx.toFixed(1)}px off it`);
      // Nothing on the ghost may give WebKit a reason to draw it as a layer of
      // its own — a transform or a translucency — because WebKit draws that
      // layer blurred. It moves by left/top and lifts by a bigger box.
      const ghostEl = /** @type {HTMLElement} */ (bar.querySelector('.drag-ghost'));
      const ghostStyle = getComputedStyle(ghostEl);
      assert(ghostStyle.transform === 'none',
        `the ghost must not be transformed, but has ${ghostStyle.transform}`);
      assert(ghostStyle.opacity === '1',
        `the ghost must be opaque, but has opacity ${ghostStyle.opacity}`);
      assert(ghost.width > tab.getBoundingClientRect().width,
        'the ghost must be drawn larger than the tab it lifts');
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      release();
      teardown();
    }
  };

  run('the ghost tracks the pointer on a fixed sidebar', false);
  run('the ghost tracks the pointer in a transformed drawer', true);

  return { passed, failed, errors };
}
