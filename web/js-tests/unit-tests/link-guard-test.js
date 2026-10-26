//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Link-guard test.
 *
 * The guard must consume every click that would otherwise navigate the app's
 * window: plain, modified (a native window has no new tab or new window to put
 * a shift/meta/ctrl/alt click in) and middle. Anything it declines becomes a
 * same-window navigation onto a page the app cannot come back from.
 *
 * All cases use a same-origin relative href, so the action taken is the
 * OS-open op against a path no fixture provides — a no-op. External links are
 * never dispatched here: opening one would put a real browser window on
 * screen. Which href is which is pinned by unit-tests/external-link-test.js.
 * @module unit-tests/link-guard-test
 */

import { assert } from '../utilities/test-helpers.js';

/** A path no fixture provides, so the OS-open op is a no-op. */
const LINK_TARGET = 'no-such-file-link-guard-test.md';

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

  const { installLinkGuard } = await import('../../js/services/link-guard.js');

  /**
   * @param {string} label
   * @param {() => void} fn
   */
  const run = (label, fn) => {
    try {
      fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  const host = document.createElement('div');
  host.style.display = 'none';
  document.body.appendChild(host);
  const uninstall = installLinkGuard(document);

  /**
   * Dispatch an event at a fresh anchor and report whether the guard took it.
   * @param {string} href
   * @param {string} type - 'click' or 'auxclick'
   * @param {MouseEventInit} [init] - Extra event properties (modifier keys, button)
   * @returns {boolean} True when the guard called preventDefault.
   */
  const dispatch = (href, type, init) => {
    host.innerHTML = '';
    const anchor = document.createElement('a');
    anchor.setAttribute('href', href);
    anchor.textContent = 'notes';
    host.appendChild(anchor);
    const e = new MouseEvent(type, {
      bubbles: true, cancelable: true, composed: true, view: window, ...init
    });
    anchor.dispatchEvent(e);
    return e.defaultPrevented;
  };

  try {
    run('plain click on a project-file link is consumed', () => {
      assert(dispatch(LINK_TARGET, 'click'), 'plain click must not reach the browser default');
    });

    /** @type {Array<[string, MouseEventInit]>} */
    const modifiers = [
      ['shift', { shiftKey: true }],
      ['meta', { metaKey: true }],
      ['ctrl', { ctrlKey: true }],
      ['alt', { altKey: true }]
    ];
    for (const [label, init] of modifiers) {
      run(`${label}-click is consumed (no new window to open it in)`, () => {
        assert(dispatch(LINK_TARGET, 'click', init),
          `${label}-click would navigate the app's own window`);
      });
    }

    run('middle click is consumed', () => {
      assert(dispatch(LINK_TARGET, 'auxclick', { button: 1 }),
        'middle click would navigate the app\'s own window');
    });

    run('right click is left alone', () => {
      assert(!dispatch(LINK_TARGET, 'auxclick', { button: 2 }),
        'right click opens the context menu — the guard must not touch it');
    });

    run('in-page hash anchor is left alone', () => {
      assert(!dispatch('#section', 'click'), 'hash anchor must keep its default behaviour');
    });

    run('download link is left alone', () => {
      host.innerHTML = '';
      const anchor = document.createElement('a');
      anchor.setAttribute('href', LINK_TARGET);
      anchor.setAttribute('download', '');
      host.appendChild(anchor);
      // The guard listens on the document, so a listener on the window hears the
      // click after it: it reads the guard's verdict there, then cancels the
      // click itself. Left to the browser, the click would start a real
      // download, and WebView2 would open its downloads flyout in the pool's
      // hidden window, where it stays for the rest of the run.
      let leftAlone = false;
      /** @param {Event} ev */
      const verdict = (ev) => {
        leftAlone = !ev.defaultPrevented;
        ev.preventDefault();
      };
      window.addEventListener('click', verdict);
      try {
        anchor.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
      } finally {
        window.removeEventListener('click', verdict);
      }
      assert(leftAlone, 'a download link must be left to the browser');
    });
  } finally {
    uninstall();
    host.remove();
  }

  return { passed, failed, errors };
}
