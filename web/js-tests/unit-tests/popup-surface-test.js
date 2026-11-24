//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for popup-surface's presentation lifecycle.
 *
 * The one hard invariant: a `close()` is honoured no matter when it lands. The
 * presentation spans two frames and a re-entrant stretch inside `presentPopup`
 * (which announces the popup, so any other open popup closes right there, and
 * a component reacting to that can close THIS one) — and a close falling in
 * that window used to be dropped, because there was no release to run yet. The
 * teardown it was supposed to do then belonged to nobody: surface and scrim sat
 * on `<body>` with no dismissal path (Escape, Back, scrim-tap and drag all run
 * through a handle the host had already released), and the popup's open-state
 * token leaked, which suppresses Escape app-wide for the rest of the session.
 *
 * Placement (`positionDropdown`, which this presents with) is covered here for
 * the same reason: what it does to the surface has to survive being done on
 * every content change, repeatedly, under the user's hands.
 *
 * `requestAnimationFrame` is shimmed onto macrotasks: the test window is hidden
 * and may never paint.
 * @module unit-tests/popup-surface-test
 */

import { presentInlineMenu, presentPopup } from '../../js/utils/popup-surface.js';
import { attachMenuTrigger } from '../../js/utils/menu-roles.js';
import { positionDropdown } from '../../sdk/lib/dropdown-positioning.js';
import {
  registerOpenPopup,
  isAnyPopupOpen,
  __resetPopupManagerForTests,
} from '../../js/utils/popup-manager.js';
import { nextTask } from '../utilities/test-helpers.js';

/**
 * Mount a host carrying the menu and trigger `presentInlineMenu` expects.
 * @returns {HTMLElement} The mounted host element.
 */
function mountHost() {
  const host = document.createElement('section');
  host.style.cssText = 'position:absolute;left:-9999px;top:-9999px;';
  host.innerHTML = '<button class="trigger">open</button>'
    + '<nav class="menu dropdown-menu is-open"><menu><li>item</li></menu></nav>';
  document.body.appendChild(host);
  return host;
}

/**
 * Mount a menu whose inner list scrolls only because the menu's height is
 * capped — the shape every anchored picker has.
 * @returns {{menu: HTMLElement, list: HTMLElement, button: HTMLElement}} The mounted parts.
 */
function mountScrollingMenu() {
  const button = document.createElement('button');
  button.style.cssText = 'position:fixed;left:10px;top:10px;width:80px;height:20px;';
  document.body.appendChild(button);

  const menu = document.createElement('nav');
  menu.className = 'dropdown-menu is-open';
  menu.style.cssText = 'display:flex;flex-direction:column;width:12rem;padding:0;';
  const list = document.createElement('div');
  list.style.cssText = 'flex:1 1 auto;min-height:0;overflow-y:auto;';
  list.innerHTML = '<div style="height:200rem"></div>';
  menu.appendChild(list);
  document.body.appendChild(menu);
  return { menu, list, button };
}

/**
 * Force sheet mode for the duration of `fn`. The breakpoint that produces it is
 * a media query, and the test window's width is not the test's to set.
 * @param {() => Promise<void>} fn - What to run with the breakpoint held.
 * @returns {Promise<void>} Resolves once matchMedia is back.
 */
async function asPhone(fn) {
  const real = window.matchMedia;
  window.matchMedia = (/** @type {string} */ query) => (
    query.includes('36rem')
      ? /** @type {any} */ ({
        matches: true, media: query, addEventListener: () => {}, removeEventListener: () => {},
      })
      : real.call(window, query)
  );
  try {
    await fn();
  } finally {
    window.matchMedia = real;
  }
}

/**
 * Drag a sheet down by its grabber, and let go.
 * @param {HTMLElement} grabber - The injected handle.
 * @param {number} dy - How far to drag, in px.
 */
function dragSheet(grabber, dy) {
  const step = (/** @type {string} */ type, /** @type {number} */ at) => {
    grabber.dispatchEvent(new PointerEvent(type, {
      pointerId: 1, pointerType: 'touch', buttons: 1, clientX: 100, clientY: 100 + at,
      bubbles: true, cancelable: true,
    }));
  };
  step('pointerdown', 0);
  step('pointermove', dy);
  step('pointerup', dy);
}

/**
 * Run the popup-surface test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

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

  /**
   * @param {boolean} cond
   * @param {string} msg
   */
  const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

  const realRaf = window.requestAnimationFrame;
  const realCancelRaf = window.cancelAnimationFrame;
  window.requestAnimationFrame = (/** @type {FrameRequestCallback} */ cb) =>
    /** @type {any} */ (setTimeout(() => cb(performance.now()), 0));
  window.cancelAnimationFrame = (/** @type {number} */ id) => clearTimeout(id);

  try {
    await run('a close landing mid-presentation still tears the popup down', async () => {
      __resetPopupManagerForTests();
      const host = mountHost();
      try {
        const handle = presentInlineMenu({
          host,
          surfaceSelector: '.menu',
          anchorSelector: '.trigger',
          onClose: () => {},
        });

        // A rival popup that closes ours the instant ours announces itself —
        // which happens INSIDE presentPopup, before it has returned a release.
        // (A popup that re-parents the host on closing does exactly this: the
        // host's disconnect closes its menu.)
        let closedDuringPresentation = false;
        const releaseRival = registerOpenPopup({
          id: 'rival',
          onClose: () => {
            closedDuringPresentation = true;
            handle.close();
          },
        });

        await nextTask(); // the deferred presentation runs, and is cancelled within itself
        await nextTask(); // any placement frame that survived would fire here

        assert(closedDuringPresentation, 'the rival popup must have closed ours during presentation');
        assert(!document.querySelector('.menu[data-section="true"]'),
          'the presented surface must not be left on <body>');
        assert(!document.querySelector('.popup-sheet-scrim'),
          'no scrim may outlive the presentation');
        assert(handle.surface === null, 'the handle must report no live surface');

        releaseRival();
        assert(!isAnyPopupOpen(),
          'the open-popup token must be released (a leak suppresses Escape app-wide)');
      } finally {
        host.remove();
        document.querySelectorAll('.menu[data-section="true"], .popup-sheet-scrim')
          .forEach((el) => el.remove());
        __resetPopupManagerForTests();
      }
    });

    await run('a modal sheet is dragged away by its grabber, and snaps back short of it', async () => {
      await asPhone(async () => {
        __resetPopupManagerForTests();
        const anchor = document.createElement('button');
        const surface = document.createElement('nav');
        document.body.append(anchor, surface);
        let closes = 0;
        const release = presentPopup({
          surface, anchor, id: 'sheet', onClose: () => { closes++; },
        });
        try {
          await nextTask();
          const grabber = /** @type {HTMLElement} */ (surface.querySelector('.popup-sheet-grabber'));
          assert(!!grabber, 'a modal sheet must offer the drag handle');

          dragSheet(grabber, 30);
          assert(closes === 0, 'a short drag is not a dismissal');
          assert(surface.style.transform === '',
            'and the sheet goes back to CSS to spring home');

          dragSheet(grabber, 140);
          assert(closes === 1, `a drag past the threshold dismisses, got ${closes}`);
        } finally {
          release();
          anchor.remove();
          surface.remove();
          document.querySelectorAll('.popup-sheet-scrim').forEach((el) => el.remove());
          __resetPopupManagerForTests();
        }
      });
    });

    // However tall its content, a sheet leaves a gap of page above it: the
    // scrim showing there is where a tap dismisses it, and the content scrolls
    // inside the sheet instead. The cap is the visible height, not `vh`, which
    // on a phone counts the browser bar's space even while the bar is showing,
    // and the keyboard's always. utils/viewport-fit publishes the visible
    // height; here it stands in for a phone's, well short of the test window.
    await run('a sheet of tall content leaves a gap above it and scrolls', async () => {
      await asPhone(async () => {
        __resetPopupManagerForTests();
        const visible = 400;
        document.documentElement.style.setProperty('--visual-viewport-height', `${visible}px`);
        const anchor = document.createElement('button');
        const surface = document.createElement('nav');
        surface.className = 'dropdown-menu permissions-popup is-open';
        // Content that cannot shrink, as rows of text cannot: the permissions
        // popup is a flex column, which would squeeze an empty block to nothing.
        surface.innerHTML = '<div style="height:200rem;flex-shrink:0"></div>';
        document.body.append(anchor);
        const release = presentPopup({ surface, anchor, id: 'tall-sheet', onClose: () => {} });
        try {
          await nextTask();
          assert(surface.classList.contains('popup-sheet'), 'the surface must be presented as a sheet');
          const rem = parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
          const height = surface.getBoundingClientRect().height;
          const room = visible - 3 * rem;
          assert(height <= room + 0.5,
            `a sheet must leave a 3rem gap above it (${Math.round(height)}px tall, ${visible}px visible)`);
          const cs = getComputedStyle(surface);
          assert(height > 0 && surface.scrollHeight > surface.clientHeight && cs.overflowY === 'auto',
            `what the sheet cannot show must scroll inside it (${surface.clientHeight}px showing of ${surface.scrollHeight}px, display ${cs.display}, overflow-y ${cs.overflowY}, max-height ${cs.maxHeight})`);
        } finally {
          document.documentElement.style.removeProperty('--visual-viewport-height');
          release();
          anchor.remove();
          document.querySelectorAll('.popup-sheet-scrim').forEach((el) => el.remove());
          __resetPopupManagerForTests();
        }
      });
    });

    await run('placing a menu leaves a long list where the user left it', () => {
      // Placement measures the menu at its natural height, which means clearing
      // the `max-height` that bounds it — and a scroller inside only has
      // somewhere to scroll BECAUSE of that bound. Repositioning happens on
      // every content change, so losing the offset here means a list that
      // snaps back to the top while the user is reading it.
      const { menu, list, button } = mountScrollingMenu();
      try {
        list.scrollTop = 300;
        assert(list.scrollTop === 300, 'the list must be scrollable for this to mean anything');
        positionDropdown(menu, button, 8);
        assert(list.scrollTop === 300,
          `placement must not scroll the list — landed at ${list.scrollTop}`);
      } finally {
        menu.remove();
        button.remove();
      }
    });

    await run('a menu placed mid-entrance lands where it will rest, growing from its anchor', () => {
      // Every anchored surface scales up into place as it opens, and placement
      // runs during that entrance (the first frame, and every content change
      // after). Measured through its transform the menu reads short, so one
      // opened above its button would overlap the button once it reached full
      // size.
      const button = document.createElement('button');
      button.style.cssText = 'position:fixed;left:40px;bottom:10px;width:80px;height:20px;';
      const menu = document.createElement('nav');
      menu.className = 'dropdown-menu is-open';
      menu.style.cssText = 'animation:none;transform:scale(0.5);width:12rem;height:300px;padding:0;';
      document.body.append(button, menu);
      try {
        positionDropdown(menu, button, 8);
        const top = parseFloat(menu.style.getPropertyValue('--dropdown-y'));
        const restingBottom = top + menu.offsetHeight;
        const buttonTop = button.getBoundingClientRect().top;
        assert(Math.abs(restingBottom - (buttonTop - 8)) < 1,
          `the menu's resting bottom must sit one gap above the button: ${restingBottom} vs ${buttonTop - 8}`);
        const origin = menu.style.getPropertyValue('--popup-origin');
        assert(/ bottom$/.test(origin),
          `a menu opened above its button grows up from its bottom edge, got "${origin}"`);
      } finally {
        menu.remove();
        button.remove();
      }
    });

    await run('a menu placed while its button springs back from a press is placed against the button at rest', () => {
      // Every button dips when pressed and springs back after
      // (utils/press-feedback.js): a Web Animation of `scale`, which no inline
      // style outranks. A menu placed during the spring and placed again once a
      // content change lands would step by the dip — a few px on a small button.
      const button = document.createElement('button');
      button.style.cssText = 'position:fixed;left:40px;top:40px;width:80px;height:20px;';
      const menu = document.createElement('nav');
      menu.className = 'dropdown-menu is-open';
      menu.style.cssText = 'animation:none;width:12rem;height:100px;padding:0;';
      document.body.append(button, menu);
      const rest = button.getBoundingClientRect();
      const dip = button.animate([{ scale: '1' }, { scale: '0.9' }], { duration: 1000, fill: 'forwards' });
      dip.pause();
      dip.currentTime = 1000;
      try {
        const scaled = button.getBoundingClientRect();
        assert(scaled.left > rest.left + 0.5, `the dip must shrink the button for this to mean anything: left ${scaled.left} at rest ${rest.left}`);
        positionDropdown(menu, button, 8);
        const x = parseFloat(menu.style.getPropertyValue('--dropdown-x'));
        const y = parseFloat(menu.style.getPropertyValue('--dropdown-y'));
        assert(Math.abs(x - rest.left) < 0.5 && Math.abs(y - (rest.bottom + 8)) < 0.5,
          `placed against the button at rest (${rest.left}, ${rest.bottom + 8}), got (${x}, ${y})`);
        assert(button.getBoundingClientRect().left === scaled.left, 'measuring must leave the dip as it was');
      } finally {
        dip.cancel();
        menu.remove();
        button.remove();
      }
    });

    await run('closing returns popup focus to the control used before opening', async () => {
      __resetPopupManagerForTests();
      const textarea = document.createElement('textarea');
      const anchor = document.createElement('button');
      const surface = document.createElement('nav');
      const item = document.createElement('button');
      surface.appendChild(item);
      document.body.append(textarea, anchor);
      textarea.focus();
      try {
        const release = presentPopup({
          surface,
          anchor,
          id: 'focus-return',
          onClose: () => {},
        });
        await nextTask();
        item.focus();
        assert(document.activeElement === item, 'the popup item must hold focus before closing');

        release();
        assert(document.activeElement === textarea,
          'closing must return focus to the control used before opening');
      } finally {
        surface.remove();
        textarea.remove();
        anchor.remove();
        document.querySelectorAll('.popup-sheet-scrim').forEach((el) => el.remove());
        __resetPopupManagerForTests();
      }
    });

    await run('closing does not steal focus from an outside control', () => {
      __resetPopupManagerForTests();
      const anchor = document.createElement('button');
      const outside = document.createElement('button');
      const surface = document.createElement('nav');
      document.body.append(anchor, outside);
      try {
        const release = presentPopup({
          surface,
          anchor,
          id: 'focus-outside',
          onClose: () => {},
        });
        outside.focus();
        assert(document.activeElement === outside, 'the outside control must hold focus before closing');

        release();
        assert(document.activeElement === outside, 'closing must preserve deliberately moved focus');
      } finally {
        surface.remove();
        anchor.remove();
        outside.remove();
        document.querySelectorAll('.popup-sheet-scrim').forEach((el) => el.remove());
        __resetPopupManagerForTests();
      }
    });

    // A click inside an iframe goes to the iframe's document, never to this
    // one: all this document sees is its window blurring as focus moves to the
    // <iframe>. That is a click outside the popup, and closes it — unless the
    // frame is inside the popup. A blur with focus going nowhere on the page
    // (to another app) is no click at all, and leaves it open. The blur is
    // dispatched here because the test window may not hold the OS's focus,
    // where focusing the frame moves the active element but fires none.
    await run('a click into an iframe outside the popup closes it', async () => {
      __resetPopupManagerForTests();
      const anchor = document.createElement('button');
      const frame = document.createElement('iframe');
      const surface = document.createElement('nav');
      surface.className = 'frame-test-surface';
      const innerFrame = document.createElement('iframe');
      surface.append(innerFrame);
      document.body.append(anchor, frame);
      let closes = 0;
      /** @type {(() => void)|null} */
      let release = null;
      const onClose = () => { closes++; release?.(); release = null; };
      /** @param {HTMLElement|null} target - What takes focus as the window blurs ('' for nothing on the page). */
      const blurTo = async (target) => {
        if (target) target.focus(); else /** @type {HTMLElement|null} */ (document.activeElement)?.blur();
        window.dispatchEvent(new Event('blur'));
        await nextTask();
        await nextTask();
      };
      try {
        release = presentPopup({ surface, anchor, id: 'frame-outside', onClose, insideSelectors: ['.frame-test-surface'] });
        await nextTask();

        await blurTo(null);
        assert(closes === 0, 'the window losing focus to another app closed the popup');
        await blurTo(innerFrame);
        assert(closes === 0, 'a click into an iframe inside the popup closed it');
        anchor.focus();
        await blurTo(frame);
        assert(closes === 1, `a click into an iframe outside the popup closed it ${closes} times, want 1`);
        assert(!surface.isConnected && !isAnyPopupOpen(), 'the popup the frame click closed is still up');
      } finally {
        release?.();
        surface.remove();
        anchor.remove();
        frame.remove();
        __resetPopupManagerForTests();
      }
    });

    await run('pressing the trigger again closes its popup rather than reopening it', async () => {
      __resetPopupManagerForTests();
      const button = document.createElement('button');
      const label = document.createElement('span');
      button.append(label);
      const region = document.createElement('div');
      const inRegion = document.createElement('button');
      region.append(inRegion);
      document.body.append(button, region);
      let opens = 0;
      /** @type {(() => void)|null} */
      let release = null;
      /** @type {{surface: HTMLElement|null}} */
      const shown = { surface: null };
      const close = () => { release?.(); release = null; };
      // A trigger that keeps no open flag of its own: it opens on every click.
      const open = (/** @type {HTMLElement} */ anchor) => {
        close();
        opens++;
        const surface = document.createElement('nav');
        surface.className = 'toggle-test-surface';
        shown.surface = surface;
        release = presentPopup({ surface, anchor, id: 'toggle-test', onClose: close, insideSelectors: ['.toggle-test-surface'] });
      };
      button.addEventListener('click', () => open(button));
      let regionClicks = 0;
      inRegion.addEventListener('click', () => { regionClicks++; });
      try {
        button.click();
        await nextTask();
        assert(opens === 1 && isAnyPopupOpen(), 'the first press opens it');

        label.click();
        await nextTask();
        assert(opens === 1, `the second press, on the trigger's label, opened it again (${opens} opens)`);
        assert(!release && !shown.surface?.isConnected && !isAnyPopupOpen(), 'the second press closes it');

        button.click();
        await nextTask();
        assert(opens === 2 && isAnyPopupOpen(), 'a third press opens it once more');

        // Hung off a region rather than a control, a click on a control inside
        // the region closes the popup and still does what it does.
        close();
        open(region);
        await nextTask();
        inRegion.click();
        assert(regionClicks === 1, 'a control inside a region anchor lost its click');
        assert(!isAnyPopupOpen(), 'the click in the region left the popup open');
      } finally {
        close();
        button.remove();
        region.remove();
        __resetPopupManagerForTests();
      }
    });

    await run('a popup opened from inside another nests in it, found by its anchor', async () => {
      __resetPopupManagerForTests();
      const trigger = document.createElement('button');
      document.body.append(trigger);
      const outer = document.createElement('div');
      const inner = document.createElement('button');
      outer.append(inner);
      const child = document.createElement('nav');
      const row = document.createElement('button');
      child.append(row);
      let outerClosed = 0;
      let childClosed = 0;
      /** @type {(() => void)|null} */
      let releaseOuter = null;
      /** @type {(() => void)|null} */
      let releaseChild = null;
      try {
        // Elements, not selectors: neither surface carries a class to find it by.
        releaseOuter = presentPopup({ surface: outer, anchor: trigger, id: 'nest-outer',
          onClose: () => { outerClosed++; releaseOuter?.(); releaseOuter = null; }, insideSelectors: [outer] });
        await nextTask();
        releaseChild = presentPopup({ surface: child, anchor: inner, id: 'nest-child', nested: 'auto',
          onClose: () => { childClosed++; releaseChild?.(); releaseChild = null; }, insideSelectors: [child] });
        await nextTask();
        assert(outerClosed === 0, 'opening the child closed the popup it was opened from');

        row.click();
        await nextTask();
        assert(outerClosed === 0, 'a press inside the child counted as outside the popup it nests in');
        assert(childClosed === 0, 'a press inside the child closed it');

        document.body.click();
        await nextTask();
        assert(childClosed === 1 && outerClosed === 1, `a press outside both closed child ${childClosed}, outer ${outerClosed}`);

        // Anchored outside every open popup, 'auto' is an ordinary popup and announces itself.
        releaseOuter = presentPopup({ surface: outer, anchor: trigger, id: 'nest-outer',
          onClose: () => { outerClosed++; releaseOuter?.(); releaseOuter = null; }, insideSelectors: [outer] });
        const lone = document.createElement('nav');
        const releaseLone = presentPopup({ surface: lone, anchor: trigger, id: 'nest-lone', nested: 'auto', onClose: () => {} });
        assert(outerClosed === 2, 'an un-nested popup did not close the one already open');
        releaseLone();
      } finally {
        releaseChild?.();
        releaseOuter?.();
        trigger.remove();
        __resetPopupManagerForTests();
      }
    });

    // A menu button works as a platform menu does under a mouse: press it and
    // the menu is up at once, drag to a row and let go to choose it. A plain
    // click still opens the menu and leaves it open, and the keyboard's click
    // opens it as it always did.
    await run('a menu trigger opens on the press and chooses the row the drag is released on', async () => {
      __resetPopupManagerForTests();
      const button = document.createElement('button');
      button.style.cssText = 'position:fixed;left:10px;top:10px;width:80px;height:20px;';
      document.body.append(button);
      let opens = 0;
      /** @type {string[]} */
      const chosen = [];
      /** @type {(() => void)|null} */
      let release = null;
      /** @type {HTMLElement|null} */
      let surface = null;
      const close = () => { release?.(); release = null; surface = null; };
      // Shaped as the Git pin's picker is: a click on the open button closes it.
      const open = () => {
        if (release) { close(); return; }
        opens++;
        const menu = document.createElement('menu');
        menu.className = 'dropdown-menu is-open trigger-test-menu';
        menu.setAttribute('role', 'menu');
        for (const value of ['a', 'b', 'off']) {
          const row = document.createElement('li');
          row.className = 'menu-item';
          row.setAttribute('role', 'menuitemradio');
          row.dataset.value = value;
          row.textContent = value;
          if (value === 'off') row.setAttribute('aria-disabled', 'true');
          row.addEventListener('click', () => { close(); if (value !== 'off') chosen.push(value); });
          menu.append(row);
        }
        surface = menu;
        release = presentPopup({ surface: menu, anchor: button, id: 'trigger-test', onClose: close, insideSelectors: [menu] });
      };
      const detach = attachMenuTrigger(button, open);
      /**
       * One press of the mouse: down on the button, through `path`, up on its
       * last element, and the click the browser then sends their common ancestor.
       * @param {(Element|(() => Element))[]} path - Where the pointer goes after the press.
       * @param {Element} clickOn - Where the browser's click lands.
       */
      const gesture = (path, clickOn) => {
        const at = (/** @type {string} */ type, /** @type {Element} */ el, /** @type {number} */ x) => {
          const Ctor = type.startsWith('pointer') ? PointerEvent : MouseEvent;
          el.dispatchEvent(new Ctor(type, {
            pointerId: 1, pointerType: 'mouse', button: 0, buttons: type.endsWith('up') ? 0 : 1,
            clientX: 20 + x, clientY: 20 + x, bubbles: true, cancelable: true,
          }));
        };
        at('pointerdown', button, 0);
        at('mousedown', button, 0);
        let last = /** @type {Element} */ (button);
        path.forEach((step, i) => {
          last = typeof step === 'function' ? step() : step;
          at('pointermove', last, 10 * (i + 1));
        });
        const x = 10 * path.length;
        at('pointerup', last, x);
        at('mouseup', last, x);
        at('click', clickOn, x);
      };
      const row = (/** @type {string} */ value) => /** @type {HTMLElement} */ (surface?.querySelector(`[data-value="${value}"]`));
      try {
        gesture([() => row('a'), () => row('b')], document.body);
        await nextTask();
        assert(opens === 1, `the press opens the menu once, got ${opens} opens`);
        assert(chosen.join() === 'b', `releasing on a row chooses it, got [${chosen}]`);
        assert(!release && !isAnyPopupOpen(), 'choosing a row closes the menu');

        gesture([], button);
        await nextTask();
        assert(opens === 2 && release !== null && isAnyPopupOpen(), 'a plain click opens the menu and leaves it open');
        gesture([], button);
        await nextTask();
        assert(opens === 2 && !release && !isAnyPopupOpen(), 'a click on the open menu\'s button closes it');

        gesture([() => row('off')], document.body);
        await nextTask();
        assert(chosen.join() === 'b' && release !== null, 'releasing on a disabled row chooses nothing and leaves the menu up');
        close();

        gesture([() => row('a'), document.body], document.body);
        await nextTask();
        assert(chosen.join() === 'b' && !release && !isAnyPopupOpen(), 'dragging off the menu and letting go closes it, choosing nothing');

        button.click();
        await nextTask();
        assert(opens === 5 && release !== null, 'the keyboard\'s click, with no press before it, still opens the menu');
      } finally {
        close();
        detach();
        button.remove();
        __resetPopupManagerForTests();
      }
    });

    await run('an ordinary open then close leaves nothing behind', async () => {
      __resetPopupManagerForTests();
      const host = mountHost();
      try {
        const handle = presentInlineMenu({
          host,
          surfaceSelector: '.menu',
          anchorSelector: '.trigger',
          onClose: () => {},
        });
        await nextTask();

        assert(!!handle.surface, 'the menu is presented');
        assert(handle.surface?.parentElement === document.body, 'the menu is hosted on <body>');
        assert(isAnyPopupOpen(), 'the presented menu counts as an open popup');

        handle.close();
        assert(!document.querySelector('.menu[data-section="true"]'), 'closing removes the surface');
        assert(handle.surface === null, 'closing clears the handle');
        assert(!isAnyPopupOpen(), 'closing releases the open-popup token');
      } finally {
        host.remove();
        document.querySelectorAll('.menu[data-section="true"], .popup-sheet-scrim')
          .forEach((el) => el.remove());
        __resetPopupManagerForTests();
      }
    });
  } finally {
    window.requestAnimationFrame = realRaf;
    window.cancelAnimationFrame = realCancelRaf;
  }

  return { passed, failed, errors };
}
