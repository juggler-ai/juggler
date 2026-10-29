//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The <path-input> completion menu is a popup like every other: presented
 * through `presentPopup`, so it is placed, dismissed and counted as open the
 * way the rest are — while staying a list the field drives, and without
 * closing the popup the field itself sits in.
 *
 * `requestAnimationFrame` is shimmed onto macrotasks and the phone breakpoint
 * held off: the test window is hidden and may never paint, and its width is not
 * the test's to set.
 * @module unit-tests/path-input-menu-test
 */

import { assert, nextTask } from '../utilities/test-helpers.js';
import {
  registerOpenPopup,
  isAnyPopupOpen,
  closePopupById,
  __resetPopupManagerForTests,
} from '../../js/utils/popup-manager.js';
import '../../js/components/path-input.js';

/**
 * Mount a <path-input> inside a scrolling box, the shape the permissions popup
 * gives it.
 * @returns {{scroller: HTMLElement, host: any, input: HTMLInputElement, teardown: () => void}} The parts.
 */
function mount() {
  const scroller = document.createElement('div');
  scroller.style.cssText = 'position:fixed;left:20px;top:20px;width:300px;height:200px;overflow-y:auto;';
  const pad = document.createElement('div');
  pad.style.cssText = 'height:40px;';
  const host = /** @type {any} */ (document.createElement('path-input'));
  const tail = document.createElement('div');
  tail.style.cssText = 'height:1000px;';
  scroller.append(pad, host, tail);
  document.body.appendChild(scroller);
  const input = /** @type {HTMLInputElement} */ (host.querySelector('input'));
  return {
    scroller,
    host,
    input,
    teardown: () => {
      host._closeMenu?.();
      scroller.remove();
      document.querySelectorAll('.path-input-menu, .popup-sheet-scrim').forEach((el) => el.remove());
    },
  };
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
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
    __resetPopupManagerForTests();
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      __resetPopupManagerForTests();
    }
  };

  const realRaf = window.requestAnimationFrame;
  const realCancelRaf = window.cancelAnimationFrame;
  const realMatchMedia = window.matchMedia;
  window.requestAnimationFrame = (/** @type {FrameRequestCallback} */ cb) =>
    /** @type {any} */ (setTimeout(() => cb(performance.now()), 0));
  window.cancelAnimationFrame = (/** @type {number} */ id) => clearTimeout(id);
  window.matchMedia = (/** @type {string} */ query) => (
    query.includes('36rem')
      ? /** @type {any} */ ({
        matches: false, media: query, addEventListener: () => {}, removeEventListener: () => {},
      })
      : realMatchMedia.call(window, query)
  );

  try {
    await run('an open menu is an open popup, and closes as one', async () => {
      const { host, teardown } = mount();
      try {
        host._openMenu(['/one/', '/two']);
        assert(isAnyPopupOpen(),
          'an open completion menu must count as an open popup, so an Escape over it is taken for the menu');
        assert(closePopupById('path-input'), 'the menu must be closable through the popup registry');
        assert(!document.querySelector('.path-input-menu'), 'closing it that way must take it off the page');
        assert(!isAnyPopupOpen(), 'and release its open-state');
      } finally {
        teardown();
      }
    });

    await run('opening the menu leaves the popup the field sits in open', async () => {
      const { host, teardown } = mount();
      let hostClosed = 0;
      const releaseHost = registerOpenPopup({ id: 'project-picker', onClose: () => { hostClosed++; } });
      try {
        host._openMenu(['/one/', '/two']);
        assert(hostClosed === 0,
          `completing a path inside the project picker must not close the picker, closed ${hostClosed}×`);
        host._closeMenu();
        assert(hostClosed === 0, 'nor may closing the menu');
        assert(isAnyPopupOpen(), 'the picker is still open');
      } finally {
        releaseHost();
        teardown();
      }
    });

    await run('the menu is placed against the field, and follows it when its box scrolls', async () => {
      const { scroller, host, input, teardown } = mount();
      try {
        host._openMenu(['/one/', '/two']);
        await nextTask();
        const menu = /** @type {HTMLElement} */ (document.querySelector('.path-input-menu'));
        assert(!!menu, 'the menu must be on the page');
        assert(menu.style.visibility !== 'hidden', 'placed, it must be revealed');
        const firstY = parseFloat(menu.style.getPropertyValue('--dropdown-y'));
        assert(Number.isFinite(firstY), `the menu must be placed by the shared positioning, got "${menu.style.cssText}"`);
        const fieldBottom = input.getBoundingClientRect().bottom;
        assert(firstY >= fieldBottom, `the menu opens below the field: ${firstY} vs ${fieldBottom}`);

        scroller.scrollTop = 30;
        scroller.dispatchEvent(new Event('scroll'));
        const movedY = parseFloat(menu.style.getPropertyValue('--dropdown-y'));
        assert(Math.abs((firstY - movedY) - 30) < 1,
          `scrolling the field's box must carry the menu with it: ${firstY} → ${movedY}`);
      } finally {
        teardown();
      }
    });

    await run('the field still drives the menu from the keyboard', async () => {
      const { host, input, teardown } = mount();
      try {
        host._openMenu(['/one', '/two']);
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
        input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true }));
        const enter = new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true });
        input.dispatchEvent(enter);
        assert(enter.defaultPrevented, 'an Enter that takes a completion is consumed by the field');
        assert(host.value === '/two', `↓↓ Enter must take the second path, got ${JSON.stringify(host.value)}`);
        assert(!document.querySelector('.path-input-menu'), 'taking a file closes the menu');
        assert(!isAnyPopupOpen(), 'and releases it');

        host._openMenu(['/one', '/two']);
        const esc = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
        input.dispatchEvent(esc);
        assert(!document.querySelector('.path-input-menu'), 'Escape closes the menu');
      } finally {
        teardown();
      }
    });

    await run('a menu closed after the field lost focus does not pull focus back', async () => {
      const { host, input, teardown } = mount();
      try {
        input.focus();
        host._openMenu(['/one/', '/two']);
        await nextTask();
        input.blur();
        assert(document.activeElement !== input, 'precondition: the field has let go of focus');
        host._closeMenu();
        assert(document.activeElement !== input,
          'the field was left on purpose; refocusing it would reopen the menu it just closed');
      } finally {
        teardown();
      }
    });
  } finally {
    window.requestAnimationFrame = realRaf;
    window.cancelAnimationFrame = realCancelRaf;
    window.matchMedia = realMatchMedia;
  }

  return { passed, failed, errors };
}
