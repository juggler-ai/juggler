//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The mouse's back and forward buttons do nothing in a desktop window.
 *
 * WebView2 navigates the window back or forward on those buttons unless the
 * page cancels them, and utils/window-history-buttons.js cancels them. These
 * tests install the guard directly — a lane is not a desktop window — and read
 * whether each press reached the browser's default.
 *
 *   1. Buttons 3 and 4 are cancelled on every mouse event a press raises, even
 *      when a handler below the window stops their propagation.
 *   2. The left, middle and right buttons are left alone.
 *   3. Removing the guard leaves the history buttons alone again.
 *   4. The guard belongs only on a desktop window outside runtime dev mode.
 * @module unit-tests/window-history-buttons-test
 */

import { assert } from '../utilities/test-helpers.js';
import { installHistoryButtonGuard, guardsHistoryButtons } from '../../js/utils/window-history-buttons.js';

const EVENTS = ['mousedown', 'mouseup', 'auxclick'];

/**
 * Run the history-button guard suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Counts of passed/failed checks and any error messages.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Case label.
   * @param {() => void} fn - Case body.
   */
  const run = (name, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(name + ': ' + (e instanceof Error ? e.message : String(e)));
    }
  };

  const target = document.createElement('div');
  document.body.appendChild(target);

  /**
   * Dispatch one mouse event at the target and report whether the guard took it.
   * The verdict is read off the event itself, not by a listener on the target,
   * which a handler that stops propagation would keep from running. A script-
   * dispatched event is untrusted and has no default action, so nothing here
   * can navigate the lane.
   * @param {string} type - The event type.
   * @param {number} button - The DOM button value.
   * @returns {boolean} True when the guard called preventDefault.
   */
  const pressed = (type, button) => {
    const e = new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, view: window, button });
    target.dispatchEvent(e);
    return e.defaultPrevented;
  };

  const uninstall = installHistoryButtonGuard(window);
  try {
    run('history-buttons-are-cancelled', () => {
      for (const button of [3, 4]) {
        for (const type of EVENTS) {
          assert(pressed(type, button), `${type} of button ${button} would navigate the window`);
        }
      }
    });

    run('cancelled-ahead-of-stopped-propagation', () => {
      /** @param {Event} e */
      const stop = (e) => { e.stopPropagation(); };
      document.body.addEventListener('mouseup', stop, true);
      try {
        assert(pressed('mouseup', 3), 'a handler that stops propagation must not let Back through');
      } finally {
        document.body.removeEventListener('mouseup', stop, true);
      }
    });

    run('other-buttons-are-left-alone', () => {
      for (const button of [0, 1, 2]) {
        for (const type of EVENTS) {
          assert(!pressed(type, button), `${type} of button ${button} must keep its default`);
        }
      }
    });
  } finally {
    uninstall();
  }

  run('uninstall-removes-the-guard', () => {
    assert(!pressed('mouseup', 3), 'a removed guard must leave Back alone');
  });

  target.remove();

  run('guarded-only-in-a-desktop-window-outside-dev-mode', () => {
    const root = document.documentElement;
    const w = /** @type {{JUGGLER_DEV_MODE?: boolean}} */ (/** @type {unknown} */ (window));
    const hadWindowMode = root.dataset.windowMode;
    const hadDevMode = w.JUGGLER_DEV_MODE;
    try {
      root.dataset.windowMode = '1';
      w.JUGGLER_DEV_MODE = false;
      assert(guardsHistoryButtons(), 'a desktop window outside dev mode must be guarded');
      w.JUGGLER_DEV_MODE = true;
      assert(!guardsHistoryButtons(), 'dev mode lets the WebView\'s own navigation through');
      delete root.dataset.windowMode;
      w.JUGGLER_DEV_MODE = false;
      assert(!guardsHistoryButtons(), 'a browser tab keeps its Back button');
    } finally {
      if (hadWindowMode === undefined) delete root.dataset.windowMode;
      else root.dataset.windowMode = hadWindowMode;
      if (hadDevMode === undefined) delete w.JUGGLER_DEV_MODE;
      else w.JUGGLER_DEV_MODE = hadDevMode;
    }
  });

  return { passed, failed, errors };
}
