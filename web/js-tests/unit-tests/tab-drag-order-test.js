//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A tab reorder lands where the user dropped it.
 *
 * Two things can move the tab strip: the user's drag, and the session — a bump
 * to the top when a turn comes to rest, a reorder from another viewer, a tab
 * created or binned somewhere else. While a drag is in progress the strip
 * belongs to the drag, so the bar holds every render until the gesture lets go,
 * from the press rather than from the slop threshold (a change landing in
 * between rearranges tabs under a finger that is already down). And what
 * lands is read from the strip as it stands at the drop, not from a list
 * captured at the press: an index into a stale list names the wrong neighbour.
 *
 * `_startDrag` is called directly and the markup is written by hand, as in
 * tab-drag-ghost-test: the geometry under test needs neither a session's worth
 * of chrome nor the bar's own tab building.
 * @module unit-tests/tab-drag-order-test
 */

import { assert } from '../utilities/test-helpers.js';
import '../../js/components/conversation-bar.js';

/**
 * @param {string} id - Conversation id for the tab
 * @returns {string} One tab's markup, matching what render() builds
 */
function tabMarkup(id) {
  return `
    <li class="conversation-tab" data-conversation-id="${id}">
      <span class="drag-grip" aria-hidden="true">⠿</span>
      <button class="conversation-tab-button"><span class="conversation-tab-name">${id}</span></button>
    </li>`;
}

/**
 * Mount a conversation-bar holding one tab per id, with a session stub that
 * records the reorder it is asked for.
 * @param {string[]} ids - Conversation ids, in strip order
 * @returns {{bar: any, tabs: HTMLElement[], calls: any[][], teardown: () => void}} The bar, its tabs, the recorded calls, and a teardown
 */
function mountBar(ids) {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:0;top:0;width:360px;height:600px;';
  document.body.appendChild(host);

  const bar = /** @type {any} */ (document.createElement('conversation-bar'));
  host.appendChild(bar);
  bar.style.cssText = 'position:absolute;inset:0 auto 0 0;width:240px;';
  bar.innerHTML = `
    <nav class="conversation-bar">
      <menu class="conversation-tabs">${ids.map(tabMarkup).join('')}</menu>
    </nav>`;

  /** @type {any[][]} */
  const calls = [];
  bar._session = {
    conversations: new Map(ids.map((id) => [id, { id }])),
    workspaces: [],
    /**
     * @param {{order: string[], places: Map<string, string>, moved?: string}} arrangement - The strip as the drop found it
     * @returns {boolean} Always accepted
     */
    applyStripArrangement({ order, moved }) {
      calls.push(['arrangement', order.join(','), moved ?? '']);
      return true;
    }
  };

  const tabs = /** @type {HTMLElement[]} */ (Array.from(bar.querySelectorAll('.conversation-tab')));
  for (const t of tabs) {
    t.setPointerCapture = () => {};
    t.releasePointerCapture = () => {};
  }
  return { bar, tabs, calls, teardown: () => host.remove() };
}

/**
 * @param {any} bar - The mounted bar
 * @returns {string} The strip's current order, for assertion messages
 */
function stripOrder(bar) {
  return Array.from(bar.querySelectorAll('.conversation-tab:not(.drag-ghost)'))
    .map((/** @type {any} */ t) => t.dataset.conversationId).join(',');
}

/**
 * @param {number} clientY - Where the pointer is
 * @returns {void}
 */
function movePointerTo(clientY) {
  document.dispatchEvent(new PointerEvent('pointermove', {
    pointerId: 1, buttons: 1, pointerType: 'touch', clientX: 100, clientY, bubbles: true
  }));
}

/** Release the drag so its document listeners and ghost don't outlive the test. */
function release() {
  document.dispatchEvent(new PointerEvent('pointerup', {
    pointerId: 1, pointerType: 'touch', clientX: 100, clientY: 0, bubbles: true
  }));
}

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run the tab drag ordering suite.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results with pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  // A render with no session wipes the bar down to its empty message, which
  // makes it obvious whether one ran: the tabs are either still there or gone.

  // Test 1: a render arriving mid-drag is held, and drawn on release.
  {
    const { bar, tabs, teardown } = mountBar(['a', 'b', 'c']);
    try {
      const grab = /** @type {HTMLElement} */ (tabs[0]).getBoundingClientRect();
      bar._startDrag({ clientX: 100, clientY: grab.top + grab.height / 2, pointerId: 1 }, tabs[0]);
      movePointerTo(grab.top + grab.height / 2 + 60);

      // The drag has already shifted the strip to show where the drop would
      // land; what must survive is the strip itself, not a particular order.
      const arrangedByDrag = stripOrder(bar);
      bar._session = null;
      bar.render();
      assert(stripOrder(bar) === arrangedByDrag,
        `a render mid-drag redrew the strip under the pointer (was ${arrangedByDrag}, now ${stripOrder(bar) || 'empty'})`);
      assert(bar._renderDeferred === true, 'the held render must be owed for the release');

      release();
      assert(bar.querySelectorAll('.conversation-tab').length === 0,
        'the render held during the drag must be drawn when it lets go');
      passed++;
    } catch (e) {
      failed++;
      errors.push(`a render mid-drag is held then drawn: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      release();
      teardown();
    }
  }

  // Test 2: the strip is claimed from the press, not from the slop threshold.
  // A bump landing in the moment between the two would otherwise rearrange the
  // tabs under a finger that is already down.
  {
    const { bar, tabs, teardown } = mountBar(['a', 'b', 'c']);
    try {
      const grab = /** @type {HTMLElement} */ (tabs[0]).getBoundingClientRect();
      // Press only — no movement, so the gesture is still below its threshold.
      bar._startDrag({ clientX: 100, clientY: grab.top + grab.height / 2, pointerId: 1 }, tabs[0]);

      bar._session = null;
      bar.render();
      assert(stripOrder(bar) === 'a,b,c',
        `a render between the press and the drag threshold moved the strip (now ${stripOrder(bar) || 'empty'})`);
      passed++;
    } catch (e) {
      failed++;
      errors.push(`the press claims the strip: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      release();
      teardown();
    }
  }

  // Test 3: the drop commits the arrangement the strip was showing, and a tab
  // that joins the strip mid-gesture does not move it. What is committed is the
  // whole strip, read off the DOM at the drop, so a newcomer is carried along
  // in the place it arrived in. Resolved by counting into a list captured at
  // the press instead, the newcomer would shift every index after it and the
  // drop would name a neighbour the user was never shown sitting next to.
  {
    const { bar, tabs, calls, teardown } = mountBar(['a', 'b', 'c']);
    try {
      const aBox = /** @type {HTMLElement} */ (tabs[0]).getBoundingClientRect();
      const bBox = /** @type {HTMLElement} */ (tabs[1]).getBoundingClientRect();
      const cBox = /** @type {HTMLElement} */ (tabs[2]).getBoundingClientRect();

      bar._startDrag({ clientX: 100, clientY: aBox.top + aBox.height / 2, pointerId: 1 }, tabs[0]);
      // Past b's midpoint but short of c's, so the tab comes to rest between
      // them and the strip shows it sitting in front of c.
      movePointerTo((bBox.bottom + cBox.top) / 2);

      // A tab joins at the head while the gesture is in flight.
      const menu = /** @type {HTMLElement} */ (bar.querySelector('.conversation-tabs'));
      menu.insertAdjacentHTML('afterbegin', tabMarkup('new'));
      bar._session.conversations.set('new', { id: 'new' });

      release();

      assert(calls.length === 1, `expected one commit, got ${JSON.stringify(calls)}`);
      // The strip reads [new, b, a, c] at the drop, and that is what is
      // written: a in front of c, where it is drawn, with the newcomer at the
      // head where it arrived. Counting into the list captured at the press
      // would have put a in front of b, one place further up than anything the
      // strip ever showed.
      assert(calls[0][1] === 'new,b,a,c',
        `the drop wrote an order the strip never showed: ${JSON.stringify(calls[0][1])}, drawn as ${stripOrder(bar)}`);
      assert(calls[0][2] === 'a', `and must name the tab the gesture moved, got ${JSON.stringify(calls[0][2])}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push(`the drop reads the live strip: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      release();
      teardown();
    }
  }

  // Test 4: the drop is read from the middle of the tab being carried, not from
  // the pointer. A tab picked up by its top edge rides below the pointer, so it
  // has passed a neighbour's midpoint while the pointer is still short of it.
  {
    const { bar, tabs, calls, teardown } = mountBar(['a', 'b', 'c']);
    try {
      const aBox = /** @type {HTMLElement} */ (tabs[0]).getBoundingClientRect();
      const bBox = /** @type {HTMLElement} */ (tabs[1]).getBoundingClientRect();
      const grabY = aBox.top + 2;
      const below = aBox.height / 2 - 2;
      bar._startDrag({ clientX: 100, clientY: grabY, pointerId: 1 }, tabs[0]);
      const pointerY = bBox.top + bBox.height / 2 - below + 2;
      assert(pointerY < bBox.top + bBox.height / 2, 'the pointer must stay short of b\'s midpoint for this to test anything');
      movePointerTo(pointerY);
      release();
      assert(calls.length === 1 && calls[0][1] === 'b,a,c',
        `a tab whose middle passed b's must land after it: ${JSON.stringify(calls)}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push(`the drop reads the carried tab's middle (passing): ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      release();
      teardown();
    }
  }

  // Test 5: and the other way — picked up by its bottom edge, the pointer passes
  // a neighbour's midpoint first, and that alone moves nothing.
  {
    const { bar, tabs, calls, teardown } = mountBar(['a', 'b', 'c']);
    try {
      const aBox = /** @type {HTMLElement} */ (tabs[0]).getBoundingClientRect();
      const bBox = /** @type {HTMLElement} */ (tabs[1]).getBoundingClientRect();
      bar._startDrag({ clientX: 100, clientY: aBox.bottom - 2, pointerId: 1 }, tabs[0]);
      movePointerTo(bBox.top + bBox.height / 2 + 2);
      release();
      assert(calls.length === 0,
        `a tab whose middle is short of b's must stay put: ${JSON.stringify(calls)}, drawn as ${stripOrder(bar)}`);
      passed++;
    } catch (e) {
      failed++;
      errors.push(`the drop reads the carried tab's middle (short): ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      release();
      teardown();
    }
  }

  return { passed, failed, errors };
}
