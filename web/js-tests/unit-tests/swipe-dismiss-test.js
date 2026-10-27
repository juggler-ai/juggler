//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The shared swipe-to-dismiss gesture (`attachSwipeDismiss` in
 * js/utils/swipe-dismiss.js) — what every surface a phone puts over the page
 * inherits. The drawer, the pinboard panel and the bottom sheet each pin their
 * own wiring; this pins the gesture they share:
 *
 *   1. Each direction dismisses when released past the threshold, and the
 *      surface tracks the finger while it is down.
 *   2. Short of the threshold it snaps back, leaving no inline style behind.
 *   3. A drag the wrong way never moves the surface at all.
 *   4. The cross-axis drag is someone else's — a scroll — and dropping it is
 *      final: a finger that turns and swipes on will not be reconsidered.
 *   5. A mouse is not a finger, unless the surface is a dedicated handle that
 *      asks for one (`allowMouse`, which the sheet grabber does).
 *   6. `isActive` and `exclude` keep the gesture off surfaces and descendants
 *      that are not swipeable — `isActive` asked at the press and again when
 *      the swipe would claim its axis.
 *   7. `yieldToScroll` concedes a press over something with room to scroll the
 *      way the finger is going, and takes it back at the end of that room —
 *      the rule that lets the pinboard sit over a code block wider than the
 *      screen. Off by default.
 *   8. A swipe cancels touchmove once it owns the gesture, so no scroll can
 *      start from it; and if one is stolen anyway, a gesture already past the
 *      threshold still dismisses rather than springing back.
 *   9. The click a swipe leaves behind is swallowed; a later one is not.
 *  10. Detaching mid-drag leaves neither a listener nor an inline transform.
 * @module unit-tests/swipe-dismiss-test
 */

import { assert } from '../utilities/test-helpers.js';
import { attachSwipeDismiss } from '../../js/utils/swipe-dismiss.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/** Where every drag in this suite starts, well inside the surface. */
const START = { x: 200, y: 200 };

/**
 * A surface to swipe, off-screen but genuinely laid out — the scroll cases need
 * real overflow. The inner scroll box is wider than it is, and holds a child
 * wider again, so it has somewhere to scroll in both horizontal directions.
 * @returns {{host: HTMLElement, surface: HTMLElement, scroller: HTMLElement, inner: HTMLElement, teardown: () => void}} The mounted surface.
 */
function mountSurface() {
  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:0;width:400px;height:400px;';
  host.innerHTML = `
    <div class="swipe-surface" style="width:400px;height:400px;">
      <div class="handle" style="width:60px;height:20px;"></div>
      <div class="scroller" style="width:200px;height:100px;overflow-x:auto;">
        <div class="inner" style="width:2000px;height:40px;"></div>
      </div>
    </div>`;
  document.body.appendChild(host);
  return {
    host,
    surface: /** @type {HTMLElement} */ (host.querySelector('.swipe-surface')),
    scroller: /** @type {HTMLElement} */ (host.querySelector('.scroller')),
    inner: /** @type {HTMLElement} */ (host.querySelector('.inner')),
    teardown: () => host.remove(),
  };
}

/**
 * @param {HTMLElement} target - Element to dispatch on.
 * @param {string} type - Pointer event type.
 * @param {{x: number, y: number, pointerType?: string}} at - Position and pointer kind.
 */
function pointer(target, type, { x, y, pointerType = 'touch' }) {
  target.dispatchEvent(new PointerEvent(type, {
    pointerId: 1, pointerType, buttons: 1, clientX: x, clientY: y, bubbles: true, cancelable: true,
  }));
}

/**
 * Press, move through the given offsets, and release.
 * @param {HTMLElement} target - Element the drag starts on.
 * @param {Array<[number, number]>} steps - Cumulative [dx, dy] offsets to move through.
 * @param {{pointerType?: string, end?: 'up'|'cancel'|'none'}} [opts] - Pointer kind, and how the gesture ends.
 */
function drag(target, steps, opts = {}) {
  const { end = 'up', ...kind } = opts;
  pointer(target, 'pointerdown', { ...START, ...kind });
  for (const [dx, dy] of steps) {
    pointer(target, 'pointermove', { x: START.x + dx, y: START.y + dy, ...kind });
  }
  if (end === 'none') return;
  const [lastX, lastY] = steps[steps.length - 1] ?? [0, 0];
  const type = end === 'cancel' ? 'pointercancel' : 'pointerup';
  pointer(target, type, { x: START.x + lastX, y: START.y + lastY, ...kind });
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
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Aggregated results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
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

  await run('a leftward drag past the threshold dismisses, and leaves no inline style', () => {
    const { surface, teardown } = mountSurface();
    let dismissed = 0;
    const detach = attachSwipeDismiss(surface, {
      direction: 'left', thresholdPx: 60, onDismiss: () => { dismissed++; },
    });
    try {
      drag(surface, [[-20, 0], [-80, 0]]);
      assert(dismissed === 1, `a 80px leftward swipe dismisses, got ${dismissed}`);
      assert(surface.style.transform === '', 'the transform goes back to the stylesheet');
      assert(surface.style.transition === '', 'and so does the transition');
    } finally {
      detach();
      teardown();
    }
  });

  await run('the surface tracks the finger while the drag is live', () => {
    const { surface, teardown } = mountSurface();
    const detach = attachSwipeDismiss(surface, {
      direction: 'left', thresholdPx: 60, onDismiss: () => {},
    });
    try {
      drag(surface, [[-20, 0], [-45, 0]], { end: 'none' });
      assert(surface.style.transform === 'translateX(-45px)',
        `the surface follows the finger, got ${surface.style.transform || '(none)'}`);
      assert(surface.style.transition === 'none', 'with no transition to lag behind it');
    } finally {
      detach();
      teardown();
    }
  });

  await run('a drag short of the threshold snaps back', () => {
    const { surface, teardown } = mountSurface();
    let dismissed = 0;
    const detach = attachSwipeDismiss(surface, {
      direction: 'left', thresholdPx: 60, onDismiss: () => { dismissed++; },
    });
    try {
      drag(surface, [[-20, 0], [-40, 0]]);
      assert(dismissed === 0, 'a 40px swipe is not a dismissal');
      assert(surface.style.transform === '', 'and the surface is handed back to CSS to spring home');
    } finally {
      detach();
      teardown();
    }
  });

  await run('a rightward surface goes away to the right, and never to the left', () => {
    const { surface, teardown } = mountSurface();
    let dismissed = 0;
    const detach = attachSwipeDismiss(surface, {
      direction: 'right', thresholdPx: 60, onDismiss: () => { dismissed++; },
    });
    try {
      drag(surface, [[-20, 0], [-120, 0]]);
      assert(dismissed === 0, 'dragging into the screen is not a dismissal');
      assert(surface.style.transform === '', 'and never moves the surface');
      drag(surface, [[20, 0], [90, 0]]);
      assert(dismissed === 1, `dragging off the right edge is, got ${dismissed}`);
    } finally {
      detach();
      teardown();
    }
  });

  await run('a handle drags a surface it is not, downward, and claims immediately', () => {
    const { surface, teardown } = mountSurface();
    const handle = /** @type {HTMLElement} */ (surface.querySelector('.handle'));
    let dismissed = 0;
    const detach = attachSwipeDismiss(handle, {
      direction: 'down', surface, thresholdPx: 90, claim: 'immediate', onDismiss: () => { dismissed++; },
    });
    try {
      drag(handle, [[0, 4]], { end: 'none' });
      assert(surface.style.transform === 'translateY(4px)',
        `a handle claims the first movement, got ${surface.style.transform || '(none)'}`);
      pointer(handle, 'pointerup', { x: START.x, y: START.y + 4 });
      assert(dismissed === 0, '4px is not a dismissal');
      drag(handle, [[0, 120]]);
      assert(dismissed === 1, `120px down is, got ${dismissed}`);
    } finally {
      detach();
      teardown();
    }
  });

  await run('a cross-axis drag is a scroll, and dropping it is final', () => {
    const { surface, teardown } = mountSurface();
    let dismissed = 0;
    const detach = attachSwipeDismiss(surface, {
      direction: 'left', thresholdPx: 60, onDismiss: () => { dismissed++; },
    });
    try {
      // Down first, then hard left in the same gesture.
      drag(surface, [[-4, 30], [-200, 40]]);
      assert(dismissed === 0, 'a drag that began as a scroll never becomes a swipe');
      assert(surface.style.transform === '', 'and never moves the surface');
    } finally {
      detach();
      teardown();
    }
  });

  await run('a mouse is not a finger, unless the surface asks for one', () => {
    const { surface, teardown } = mountSurface();
    let dismissed = 0;
    const detach = attachSwipeDismiss(surface, {
      direction: 'left', thresholdPx: 60, onDismiss: () => { dismissed++; },
    });
    try {
      drag(surface, [[-20, 0], [-120, 0]], { pointerType: 'mouse' });
      assert(dismissed === 0, 'a mouse drag on a surface means selecting, not dismissing');
      drag(surface, [[-20, 0], [-120, 0]], { pointerType: 'pen' });
      assert(dismissed === 1, `a pen is a finger, got ${dismissed}`);
    } finally {
      detach();
      teardown();
    }

    const second = mountSurface();
    let handleDismissed = 0;
    const detachHandle = attachSwipeDismiss(second.surface, {
      direction: 'left', thresholdPx: 60, allowMouse: true, onDismiss: () => { handleDismissed++; },
    });
    try {
      drag(second.surface, [[-20, 0], [-120, 0]], { pointerType: 'mouse' });
      assert(handleDismissed === 1, `allowMouse takes the mouse drag, got ${handleDismissed}`);
    } finally {
      detachHandle();
      second.teardown();
    }
  });

  await run('an inactive surface and an excluded descendant are both inert', () => {
    const { surface, teardown } = mountSurface();
    const handle = /** @type {HTMLElement} */ (surface.querySelector('.handle'));
    let active = false;
    let dismissed = 0;
    const detach = attachSwipeDismiss(surface, {
      direction: 'left',
      thresholdPx: 60,
      isActive: () => active,
      exclude: '.handle',
      onDismiss: () => { dismissed++; },
    });
    try {
      drag(surface, [[-20, 0], [-120, 0]]);
      assert(dismissed === 0, 'a closed surface has nothing to dismiss');
      active = true;
      drag(handle, [[-20, 0], [-120, 0]]);
      assert(dismissed === 0, 'a drag from the handle belongs to the handle');
      drag(surface, [[-20, 0], [-120, 0]]);
      assert(dismissed === 1, `and the surface itself still swipes, got ${dismissed}`);
    } finally {
      detach();
      teardown();
    }
  });

  await run('isActive is asked again when the swipe would claim its axis', () => {
    // A press can start dismissible and stop being so before the finger moves:
    // the drawer's rows lift for a reorder on a hold, and a row being dragged
    // leftwards must not take the drawer with it.
    const { surface, teardown } = mountSurface();
    let active = true;
    let dismissed = 0;
    const detach = attachSwipeDismiss(surface, {
      direction: 'left',
      thresholdPx: 60,
      isActive: () => active,
      onDismiss: () => { dismissed++; },
    });
    try {
      pointer(surface, 'pointerdown', START);
      active = false;
      pointer(surface, 'pointermove', { x: START.x - 20, y: START.y });
      pointer(surface, 'pointermove', { x: START.x - 120, y: START.y });
      assert(surface.style.transform === '', `the surface must not follow, got "${surface.style.transform}"`);
      pointer(surface, 'pointerup', { x: START.x - 120, y: START.y });
      assert(dismissed === 0, 'and must not dismiss');
    } finally {
      detach();
      teardown();
    }
  });

  await run('yieldToScroll concedes a reader with somewhere left to scroll', () => {
    const { surface, scroller, inner, teardown } = mountSurface();
    let dismissed = 0;
    const detach = attachSwipeDismiss(surface, {
      direction: 'right',
      thresholdPx: 60,
      yieldToScroll: true,
      onDismiss: () => { dismissed++; },
    });
    try {
      assert(scroller.scrollWidth > scroller.clientWidth + 4,
        'the fixture must really overflow, or this proves nothing');

      scroller.scrollLeft = 400;
      assert(scroller.scrollLeft > 4, 'the scroll box takes a scroll position');
      drag(inner, [[20, 0], [120, 0]]);
      assert(dismissed === 0,
        'a rightward drag over content scrolled off its start is the reader coming back');

      // Back at the left margin there is nowhere further to go, and the gesture
      // is the surface's — the same handoff a nested scroller gets natively.
      scroller.scrollLeft = 0;
      drag(inner, [[20, 0], [120, 0]]);
      assert(dismissed === 1, `at the margin the swipe takes over, got ${dismissed}`);

      // The other way round, the scroller has all its room and keeps it.
      drag(surface, [[20, 0], [120, 0]]);
      assert(dismissed === 2, 'and a drag outside the scroll box was never in question');
    } finally {
      detach();
      teardown();
    }
  });

  await run('without yieldToScroll a scroll box is not consulted', () => {
    const { surface, scroller, inner, teardown } = mountSurface();
    let dismissed = 0;
    const detach = attachSwipeDismiss(surface, {
      direction: 'right', thresholdPx: 60, onDismiss: () => { dismissed++; },
    });
    try {
      scroller.scrollLeft = 400;
      drag(inner, [[20, 0], [120, 0]]);
      assert(dismissed === 1,
        `a surface whose touch-action already forbids panning claims it anyway, got ${dismissed}`);
    } finally {
      detach();
      teardown();
    }
  });

  await run('a live swipe cancels touchmove, and a stolen gesture past the threshold still dismisses', () => {
    const { surface, teardown } = mountSurface();
    let dismissed = 0;
    const detach = attachSwipeDismiss(surface, {
      direction: 'left', thresholdPx: 60, onDismiss: () => { dismissed++; },
    });
    try {
      assert(!touchMove(surface), 'no gesture, nothing to block');
      pointer(surface, 'pointerdown', START);
      assert(!touchMove(surface), 'a press that has not moved is still a tap or a scroll');
      pointer(surface, 'pointermove', { x: START.x - 30, y: START.y });
      assert(touchMove(surface), 'once the swipe owns the gesture, no scroll may start from it');

      // Something upstream takes the touch anyway, past the threshold.
      pointer(surface, 'pointermove', { x: START.x - 90, y: START.y });
      pointer(surface, 'pointercancel', { x: START.x - 90, y: START.y });
      assert(dismissed === 1, `a cancelled swipe past the threshold is honoured, got ${dismissed}`);

      // Short of it, a cancellation is just a gesture that went nowhere.
      drag(surface, [[-20, 0], [-30, 0]], { end: 'cancel' });
      assert(dismissed === 1, 'a cancelled swipe short of the threshold springs back');
    } finally {
      detach();
      teardown();
    }
  });

  await run('the click a swipe leaves behind is swallowed, and the next one is not', async () => {
    const { surface, teardown } = mountSurface();
    const handle = /** @type {HTMLElement} */ (surface.querySelector('.handle'));
    let clicks = 0;
    handle.addEventListener('click', () => { clicks++; });
    const detach = attachSwipeDismiss(surface, {
      direction: 'left', thresholdPx: 60, onDismiss: () => {},
    });
    try {
      drag(handle, [[-20, 0], [-120, 0]]);
      handle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      assert(clicks === 0, 'swiping off a control does not also press it');

      // eslint-disable-next-line juggler/no-private-test-wait -- the hold must outlast CLICK_SWALLOW_MS (100ms), the guard this case is about
      await new Promise((resolve) => { setTimeout(resolve, 150); });
      handle.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
      assert(clicks === 1, `a later click is the user's own, got ${clicks}`);
    } finally {
      detach();
      teardown();
    }
  });

  await run('detaching mid-drag leaves nothing behind', () => {
    const { surface, teardown } = mountSurface();
    let dismissed = 0;
    const detach = attachSwipeDismiss(surface, {
      direction: 'left', thresholdPx: 60, onDismiss: () => { dismissed++; },
    });
    try {
      drag(surface, [[-20, 0], [-120, 0]], { end: 'none' });
      detach();
      assert(surface.style.transform === '', 'the surface is handed back to CSS');
      pointer(surface, 'pointerup', { x: START.x - 120, y: START.y });
      assert(dismissed === 0, 'and the release it never saw the start of does nothing');

      drag(surface, [[-20, 0], [-120, 0]]);
      assert(dismissed === 0, 'a detached surface has no gesture at all');
    } finally {
      detach();
      teardown();
    }
  });

  return { passed, failed, errors };
}
