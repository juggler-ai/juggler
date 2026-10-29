//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE
// SPDX-License-Identifier: AGPL-3.0-or-later

/**
 * Selection containment.
 *
 * The two rules `services/selection-containment.js` exists to enforce: a drag
 * begun on chrome starts no selection, and a drag begun inside a column cannot
 * select past that column. Both are held here because neither is visible in the
 * markup — the first is a WebKit divergence the app papers over, the second has
 * no CSS to read it off.
 *
 * The harness cannot perform a real mouse drag (the browser lanes barely paint
 * and deliver no frames), so the gesture is assembled from its parts: a
 * `pointerdown` to arm, a selection built with `setBaseAndExtent`, and a
 * `selectionchange` to drive the clamp — which is exactly the sequence a real
 * drag produces. The root used is `modal-panel`, chosen because it is in the
 * containment list yet is an inert tag, so the test needs no live component.
 * @module unit-tests/selection-containment-test
 */

import { assert, nextTask } from '../utilities/test-helpers.js';

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

  const { installSelectionContainment, SELECTION_ROOTS } =
    await import('../../js/services/selection-containment.js');

  /**
   * @param {string} label
   * @param {() => void|Promise<void>} fn
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-10000px;top:0;width:30rem;';
  host.innerHTML = `
    <modal-panel class="sc-root">
      <p class="sc-chrome" style="-webkit-user-select:none;user-select:none;">chrome label</p>
      <p class="sc-inside">text inside the surface</p>
    </modal-panel>
    <properties-panel-empty class="sc-empty">Select an item to view details</properties-panel-empty>
    <p class="sc-outside">text outside every surface</p>`;
  document.body.appendChild(host);

  const root = /** @type {HTMLElement} */ (host.querySelector('.sc-root'));
  const chrome = /** @type {HTMLElement} */ (host.querySelector('.sc-chrome'));
  const inside = /** @type {HTMLElement} */ (host.querySelector('.sc-inside'));
  const empty = /** @type {HTMLElement} */ (host.querySelector('.sc-empty'));
  const outside = /** @type {HTMLElement} */ (host.querySelector('.sc-outside'));
  const insideText = /** @type {Text} */ (inside.firstChild);
  const outsideText = /** @type {Text} */ (outside.firstChild);

  /** @param {HTMLElement} el */
  const pointerDownOn = (el) => {
    el.dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, composed: true, button: 0, isPrimary: true,
    }));
  };

  /** Ends the gesture the way a real one ends, then lets the disarm land. */
  const releasePointer = async () => {
    document.dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, composed: true, button: 0, isPrimary: true,
    }));
    await nextTask();
  };

  /**
   * @param {HTMLElement} el - Element the drag starts on
   * @returns {boolean} Whether the engine was told not to start a selection
   */
  const selectStartFrom = (el) => {
    const e = new Event('selectstart', { bubbles: true, cancelable: true });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  };

  /**
   * Builds the selection a drag from `from` to `to` would have produced, then
   * fires the event the engine fires for it.
   * @param {Text} from
   * @param {Text} to
   * @returns {Selection} The live selection, after any clamp
   */
  const dragSelect = (from, to) => {
    const selection = /** @type {Selection} */ (window.getSelection());
    selection.setBaseAndExtent(from, 0, to, to.length);
    document.dispatchEvent(new Event('selectionchange'));
    return selection;
  };

  /**
   * @param {Element} el
   * @returns {string} The engine's resolved `user-select`, prefixed form first
   */
  const userSelectOf = (el) => {
    const style = getComputedStyle(el);
    return style.webkitUserSelect || style.userSelect;
  };

  const uninstall = installSelectionContainment(document);

  try {
    await run('every column and panel is a containment root', () => {
      for (const tag of ['conversation-area', 'properties-panel', 'workspace-panel',
        'pinboard-panel', 'settings-panel', 'modal-panel']) {
        assert(SELECTION_ROOTS.includes(tag), `${tag} should be a containment root`);
      }
    });

    await run('a drag begun on chrome starts no selection', async () => {
      pointerDownOn(chrome);
      assert(selectStartFrom(chrome),
        'selectstart should be cancelled for a drag begun on a user-select:none element');
      await releasePointer();
    });

    await run('a drag begun on text is left alone', async () => {
      pointerDownOn(inside);
      assert(!selectStartFrom(inside), 'selectstart should stand for a drag begun on content');
      await releasePointer();
    });

    await run('a selection cannot leave the surface it began in', async () => {
      pointerDownOn(inside);
      const selection = dragSelect(insideText, outsideText);
      assert(root.contains(/** @type {Node} */ (selection.focusNode)),
        `focus should be clamped inside the surface, it is in ${/** @type {Node} */ (selection.focusNode).nodeName}`);
      assert(selection.anchorNode === insideText, 'the anchor the drag started from should be untouched');
      assert(!selection.isCollapsed, 'clamping should keep the selection made so far, not discard it');
      await releasePointer();
    });

    await run('a selection within one surface is untouched', async () => {
      pointerDownOn(inside);
      const selection = /** @type {Selection} */ (window.getSelection());
      selection.setBaseAndExtent(insideText, 0, insideText, 4);
      document.dispatchEvent(new Event('selectionchange'));
      assert(selection.focusNode === insideText && selection.focusOffset === 4,
        `a contained selection should be left exactly as it was, got offset ${selection.focusOffset}`);
      await releasePointer();
    });

    await run('a keyboard selection is not contained', async () => {
      // Nothing is armed: no pointer is down, so this is shift+arrows or
      // select-all, which reach as far as they were asked to.
      const selection = dragSelect(insideText, outsideText);
      assert(selection.focusNode === outsideText,
        'a selection made with no pointer down should not be clamped');
    });

    await run("the properties panel's empty state is chrome", () => {
      // The large dead area a first-time user swipes across. It is pure chrome —
      // an icon and a label — so a drag over it has nothing worth selecting.
      assert(userSelectOf(empty) === 'none',
        `properties-panel-empty should be unselectable, computed ${userSelectOf(empty)}`);
    });
  } finally {
    uninstall();
    host.remove();
    window.getSelection()?.removeAllRanges();
  }

  return { passed, failed, errors };
}
