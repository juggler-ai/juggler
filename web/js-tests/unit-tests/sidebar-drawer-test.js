//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Dismissal for the phone sidebar drawer (`_setupSidebarToggle` and
 * `_setupSidebarSwipe` in ui-event-manager.js) — every way an open drawer goes
 * away. Swiping:
 *
 *   1. A leftward drag past the threshold closes the drawer (`sidebar-open`
 *      comes off <body>) and leaves no inline transform behind.
 *   2. A short drag snaps back: still open, transform cleared.
 *   3. A vertical drag is the tab list scrolling — it never moves the drawer
 *      and never closes it, even if the finger drifts left afterwards.
 *   4. The click a swipe leaves behind is swallowed, so swiping off a tab does
 *      not also switch conversation. Later clicks get through.
 *   5. A mouse drag is not a swipe (inside the bar it means tab reorder).
 *   6. A swipe in flight cancels touchmove, so no browser scroll can start from
 *      it and steal the pointer — and if one is stolen anyway, a gesture already
 *      past the threshold still dismisses instead of springing back.
 *
 * And the popup-manager registration the Back button rides on:
 *
 *   7. An open drawer holds a popup token, so a Back press (popstate) dismisses
 *      it instead of navigating away from the conversation.
 *   8. Escape goes through that same registered handler.
 *   9. Closing it any other way releases the token, so the next Back press is
 *      the browser's own again.
 *
 * And its size:
 *
 *  10. However wide the stored sidebar width, the open drawer leaves a strip of
 *      the page beside it to show it is an overlay and to tap it away.
 *
 * Driven through the real handler against a stand-in drawer: the ids and the
 * `position: absolute` drawer-mode check are all it reads, and the media query
 * that produces that position headless can't be driven.
 * @module unit-tests/sidebar-drawer-test
 */

import { assert, styledProbeFrame } from '../utilities/test-helpers.js';
import UIEventManager from '../../js/services/ui-event-manager.js';
import {
  isAnyPopupOpen,
  __resetPopupManagerForTests,
  __settlePopupHistoryForTests,
  __setBackIntegrationForTests,
} from '../../js/utils/popup-manager.js';

/**
 * Build the drawer DOM the handler expects, with one tab in it.
 * @param {{open?: boolean}} [opts] - Whether to mount it already open (default true).
 * @returns {{manager: any, sidebar: HTMLElement, tab: HTMLElement, toggle: HTMLElement, teardown: () => void}} The wired manager, its drawer, tab and hamburger, and a teardown.
 */
function mountDrawer({ open = true } = {}) {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:0;width:360px;height:600px;';
  host.innerHTML = `
    <button id="sidebar-toggle-button" aria-expanded="${open}"></button>
    <div id="sidebar-backdrop"></div>
    <div id="conversation-bar" style="position:absolute;inset:0 auto 0 0;width:240px;">
      <div class="conversation-tab active"><span class="tab-title">A tab</span></div>
    </div>`;
  document.body.appendChild(host);

  const manager = /** @type {any} */ (
    new UIEventManager({ onSendMessage: () => {}, onContextItemAction: async () => {} })
  );
  manager._setupSidebarToggle();
  // Opened by hand rather than through the hamburger: the swipe cases want a
  // drawer that holds no popup token, so they never touch the History API.
  if (open) document.body.classList.add('sidebar-open');

  const sidebar = /** @type {HTMLElement} */ (host.querySelector('#conversation-bar'));
  const tab = /** @type {HTMLElement} */ (host.querySelector('.conversation-tab'));
  const toggle = /** @type {HTMLElement} */ (host.querySelector('#sidebar-toggle-button'));
  return {
    manager,
    sidebar,
    tab,
    toggle,
    teardown: () => {
      manager.destroy();
      document.body.classList.remove('sidebar-open');
      host.remove();
    },
  };
}

/**
 * @param {HTMLElement} target - Element to dispatch on.
 * @param {string} type - Pointer event type.
 * @param {{x: number, y: number, pointerType?: string}} at - Position and pointer kind.
 */
function pointer(target, type, { x, y, pointerType = 'touch' }) {
  target.dispatchEvent(new PointerEvent(type, {
    pointerId: 1, pointerType, clientX: x, clientY: y, bubbles: true, cancelable: true,
  }));
}

/**
 * Drag from (100, 300) by the given deltas, one move per step, then release.
 * @param {HTMLElement} target - Element the drag starts on.
 * @param {Array<[number, number]>} steps - Cumulative [dx, dy] offsets to move through.
 * @param {{pointerType?: string}} [opts] - Pointer kind for the whole drag.
 */
function drag(target, steps, opts = {}) {
  const startX = 100;
  const startY = 300;
  pointer(target, 'pointerdown', { x: startX, y: startY, ...opts });
  for (const [dx, dy] of steps) {
    pointer(target, 'pointermove', { x: startX + dx, y: startY + dy, ...opts });
  }
  const [lastX, lastY] = steps[steps.length - 1] ?? [0, 0];
  pointer(target, 'pointerup', { x: startX + lastX, y: startY + lastY, ...opts });
}

/** @returns {boolean} Whether the drawer is open. */
function isOpen() {
  return document.body.classList.contains('sidebar-open');
}

/**
 * Dispatch a cancelable touchmove, as the browser does alongside the pointer
 * events, and report whether the swipe blocked it. A bare Event stands in for a
 * TouchEvent: the handler reads nothing off it, and the constructor is missing
 * on the desktop WebKit the suite runs in.
 * @param {HTMLElement} target - Element the touch is on.
 * @returns {boolean} Whether the swipe called preventDefault (blocking a scroll).
 */
function touchMove(target) {
  const event = new Event('touchmove', { cancelable: true, bubbles: true });
  target.dispatchEvent(event);
  return event.defaultPrevented;
}

/**
 * Run `fn` with the History API stubbed out, counting the calls popup-manager
 * makes. The sentinel entry an open drawer pushes must never really navigate:
 * a genuine `history.back()` at the test page's base entry unloads it. The
 * stubs stay up one macrotask past `fn`, since the sentinel's retraction is
 * deferred that far.
 *
 * The Back integration is switched on for the same span: this lane is an iframe,
 * where it stands down (the session history there belongs to the embedder), and
 * these cases are about what a top-level context does with it.
 * @param {(counts: {push: number, back: number}) => (void | Promise<void>)} fn - Test body.
 * @returns {Promise<void>} Resolves once the real History API is back.
 */
async function withStubbedHistory(fn) {
  const backIntegrationWas = __setBackIntegrationForTests(true);
  const realPush = window.history.pushState;
  const realBack = window.history.back;
  const counts = { push: 0, back: 0 };
  window.history.pushState = function () { counts.push++; };
  // The stub answers with a popstate, as the real API does a task later: a
  // `back()` that never answers leaves popup-manager owed a pop for the rest of
  // the realm's life, and the next Back press is spent settling that debt.
  window.history.back = function () {
    counts.back++;
    window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
  };
  try {
    await fn(counts);
  } finally {
    await new Promise((resolve) => setTimeout(resolve, 0));
    window.history.pushState = realPush;
    window.history.back = realBack;
    __setBackIntegrationForTests(backIntegrationWas);
  }
}

/**
 * Run the sidebar drawer dismissal suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  // A lane's tests share one JS realm, and a pop popup-manager is still owed
  // from an earlier one is consumed rather than read as a Back press — which is
  // what it is for, and would swallow the synthetic Back press below.
  await __settlePopupHistoryForTests();

  /**
   * @param {string} label - Test label.
   * @param {(ctx: {sidebar: HTMLElement, tab: HTMLElement, toggle: HTMLElement}) => (void | Promise<void>)} fn - Test body.
   * @param {{open?: boolean}} [mountOpts] - Passed through to mountDrawer.
   */
  const run = async (label, fn, mountOpts) => {
    const { sidebar, tab, toggle, teardown } = mountDrawer(mountOpts);
    try {
      await fn({ sidebar, tab, toggle });
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      teardown();
    }
  };

  await run('a long leftward swipe dismisses the drawer', ({ sidebar, tab }) => {
    drag(tab, [[-20, 0], [-50, 2], [-90, 4]]);
    assert(!isOpen(), 'a swipe past the threshold must close the drawer');
    assert(sidebar.style.transform === '', 'the inline transform must be handed back to CSS on release');
    assert(sidebar.style.transition === '', 'the inline transition must be handed back to CSS on release');
  });

  await run('a short swipe snaps back', ({ sidebar, tab }) => {
    drag(tab, [[-20, 0], [-35, 0]]);
    assert(isOpen(), 'a swipe short of the threshold must leave the drawer open');
    assert(sidebar.style.transform === '', 'the snap-back must clear the inline transform');
  });

  await run('the drawer tracks the finger mid-swipe', ({ sidebar, tab }) => {
    pointer(tab, 'pointerdown', { x: 100, y: 300 });
    pointer(tab, 'pointermove', { x: 60, y: 302 });
    assert(sidebar.style.transform === 'translateX(-40px)',
      `the drawer must follow the finger 1:1, got ${JSON.stringify(sidebar.style.transform)}`);
    assert(sidebar.style.transition === 'none', 'the transition must be pinned off while dragging');
    // A rightward move past the start doesn't drag the drawer off its hinge.
    pointer(tab, 'pointermove', { x: 160, y: 302 });
    assert(sidebar.style.transform === 'translateX(0px)', 'the drawer must not travel right of open');
    pointer(tab, 'pointerup', { x: 160, y: 302 });
    assert(isOpen(), 'a swipe that returns to the start must leave the drawer open');
  });

  await run('a vertical drag scrolls instead of swiping', ({ sidebar, tab }) => {
    // Vertical first, then a long drift left: the axis is already lost.
    drag(tab, [[-2, 30], [-80, 60], [-140, 70]]);
    assert(isOpen(), 'a vertical drag must never close the drawer');
    assert(sidebar.style.transform === '', 'a vertical drag must never move the drawer');
  });

  await run('the click a swipe leaves behind is swallowed', async ({ tab }) => {
    let clicks = 0;
    tab.addEventListener('click', () => clicks++);
    drag(tab, [[-20, 0], [-100, 0]]);
    tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    assert(clicks === 0, `the click after a swipe must not reach the tab, got ${clicks}`);

    // Only that one: the guard lapses, it doesn't deafen the drawer.
    // eslint-disable-next-line juggler/no-private-test-wait -- the hold must outlast swipe-dismiss.js's CLICK_SWALLOW_MS guard (100ms), which is the subject
    await new Promise((resolve) => setTimeout(resolve, 150));
    tab.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    assert(clicks === 1, `a later click must reach the tab, got ${clicks}`);
  });

  await run('a mouse drag is not a swipe', ({ sidebar, tab }) => {
    drag(tab, [[-40, 0], [-120, 0]], { pointerType: 'mouse' });
    assert(isOpen(), 'a mouse drag must not close the drawer');
    assert(sidebar.style.transform === '', 'a mouse drag must not move the drawer');
  });

  await run('a swipe in flight blocks the scroll that would steal it', ({ tab }) => {
    assert(!touchMove(tab), 'an untouched drawer must leave touchmove alone, so the tab list scrolls');
    pointer(tab, 'pointerdown', { x: 100, y: 300 });
    pointer(tab, 'pointermove', { x: 70, y: 305 });
    assert(touchMove(tab),
      'a swipe in flight must cancel touchmove, or the browser scrolls and cancels the pointer');
    pointer(tab, 'pointerup', { x: 70, y: 305 });
    assert(!touchMove(tab), 'the block must lift with the finger');
  });

  await run('a stolen gesture past the threshold still dismisses', ({ sidebar, tab }) => {
    pointer(tab, 'pointerdown', { x: 100, y: 300 });
    pointer(tab, 'pointermove', { x: 60, y: 300 });
    pointer(tab, 'pointermove', { x: 10, y: 306 });
    pointer(tab, 'pointercancel', { x: 10, y: 306 });
    assert(!isOpen(), 'a cancel past the threshold must honour the swipe, not spring back');
    assert(sidebar.style.transform === '', 'the cancel must clear the inline transform');
  });

  await run('a stolen gesture short of the threshold snaps back', ({ tab }) => {
    pointer(tab, 'pointerdown', { x: 100, y: 300 });
    pointer(tab, 'pointermove', { x: 75, y: 300 });
    pointer(tab, 'pointercancel', { x: 75, y: 300 });
    assert(isOpen(), 'a cancel short of the threshold must leave the drawer open');
  });

  await run('the resize grip keeps its own drag', ({ sidebar }) => {
    const grip = document.createElement('col-resize-handle');
    sidebar.appendChild(grip);
    drag(/** @type {HTMLElement} */ (grip), [[-40, 0], [-120, 0]]);
    assert(isOpen(), 'dragging the resize grip must not close the drawer');
    assert(sidebar.style.transform === '', 'dragging the resize grip must not move the drawer');
  });

  // The dismissal wiring below opens through the hamburger, the only path that
  // takes a popup token. `__resetPopupManagerForTests()` first because the pool
  // shares one JS realm across a lane's tests and the sentinel push is gated on
  // a clean 0 → 1 transition; each case closes the drawer again, so it leaks
  // nothing onward.
  await run('the Back button dismisses the drawer', async ({ toggle }) => {
    await withStubbedHistory(async (counts) => {
      __resetPopupManagerForTests();
      toggle.click();
      assert(isOpen(), 'the hamburger must open the drawer');
      assert(counts.push === 1,
        `the open drawer must push exactly one sentinel history entry, got ${counts.push}`);

      window.dispatchEvent(new PopStateEvent('popstate', { state: null }));
      assert(!isOpen(), 'a Back press must dismiss the drawer, not navigate away');
      assert(!isAnyPopupOpen(), 'the dismissed drawer must release its popup token');
      assert(counts.back === 0,
        'a Back press must not go back again — the browser already popped the entry');
    });
  }, { open: false });

  await run('Escape dismisses the drawer', async ({ toggle }) => {
    await withStubbedHistory(async () => {
      __resetPopupManagerForTests();
      toggle.click();
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
      assert(!isOpen(), 'Escape must dismiss the drawer');
      assert(!isAnyPopupOpen(), 'the dismissed drawer must release its popup token');
    });
  }, { open: false });

  await run('closing the drawer hands Back to the browser again', async ({ toggle }) => {
    await withStubbedHistory(async (counts) => {
      __resetPopupManagerForTests();
      toggle.click();
      assert(isAnyPopupOpen(), 'the open drawer must count as an overlay');

      toggle.click();
      assert(!isOpen(), 'a second tap of the hamburger must close the drawer');
      assert(!isAnyPopupOpen(), 'the closed drawer must release its popup token');
      assert(toggle.getAttribute('aria-expanded') === 'false',
        'aria-expanded must follow the drawer shut');
      await new Promise((resolve) => setTimeout(resolve, 0));
      assert(counts.back === 1,
        `closing must retract the sentinel entry exactly once, got ${counts.back}`);
      assert(counts.push === 1,
        `closing must push nothing further, got ${counts.push} pushes in all`);
    });
  }, { open: false });

  // An open drawer must never cover the whole screen. The resize grip stores
  // one sidebar width for every layout, so a sidebar widened on the desktop
  // arrives on a phone as an inline width far wider than the viewport, and an
  // inline width beats the drawer's own default. What must be left is a strip
  // of scrim beside it: the only sign that the drawer is over something, and
  // the tap target that dismisses it. 44px is the smallest target a finger is
  // expected to hit.
  //
  // The drawer rules sit behind `@media (width <= 36rem)`, which a lane is too
  // wide to match, so they are rendered in a phone-sized probe frame against
  // plain elements wearing the drawer's tag — a child document never upgrades
  // the custom element, and the rules select on the tag alone.
  {
    const label = 'an open drawer leaves a tappable strip of the page beside it';
    const { doc, frame } = await styledProbeFrame(360, 480);
    try {
      doc.body.classList.add('sidebar-open');
      const main = doc.createElement('div');
      main.className = 'app-main';
      main.style.cssText = 'position:relative;width:360px;height:480px';
      doc.body.appendChild(main);

      // The stylesheet default, then a width stored from a wide desktop sidebar.
      for (const stored of ['', '30rem']) {
        main.innerHTML = '<conversation-bar></conversation-bar>';
        const bar = /** @type {HTMLElement} */ (main.firstElementChild);
        bar.style.width = stored;
        const strip = 360 - bar.getBoundingClientRect().right;
        assert(strip >= 44,
          `with ${stored ? `a stored width of ${stored}` : 'the default width'} the open drawer must leave at least 44px of the page beside it, left ${Math.round(strip)}px`);
      }
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      frame.remove();
    }
  }

  return { passed, failed, errors };
}
