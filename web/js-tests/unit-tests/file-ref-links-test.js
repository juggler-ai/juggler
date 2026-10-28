//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * File-reference links: activating a file reference in a reply pins the file,
 * a modified click opens it with the OS, and a drag that selected text in it is
 * left to be the copy it was. The pin and open actions are stubbed, so nothing
 * here touches the Pinboard or the host.
 * @module unit-tests/file-ref-links-test
 */

import { assert } from '../utilities/test-helpers.js';

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

  const { installFileRefLinks } = await import('../../js/services/file-ref-links.js');

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

  /** @type {string[]} */
  const pinned = [];
  /** @type {string[]} */
  const opened = [];
  const uninstall = installFileRefLinks(document, {
    pin: (path) => { pinned.push(path); },
    open: (path) => { opened.push(path); },
  });

  const host = document.createElement('div');
  host.innerHTML = '<p>See <code class="markdown-file-ref" data-file-path="/r/a.js" role="link" tabindex="0">a.js</code>'
    + ' and <code>plain.js</code>.</p>';
  document.body.appendChild(host);
  const ref = /** @type {HTMLElement} */ (host.querySelector('code.markdown-file-ref'));
  const plain = /** @type {HTMLElement} */ (host.querySelector('code:not(.markdown-file-ref)'));

  const reset = () => {
    pinned.length = 0;
    opened.length = 0;
    window.getSelection()?.removeAllRanges();
  };

  /**
   * @param {Element} el - Click target.
   * @param {MouseEventInit} [init] - Extra event properties.
   * @returns {boolean} True when the click was claimed (preventDefault).
   */
  const click = (el, init = {}) => {
    const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...init });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  };

  try {
    run('a click on a reference pins its file', () => {
      reset();
      assert(click(ref), 'the click is claimed');
      assert(pinned.join() === '/r/a.js', `pinned ${JSON.stringify(pinned)}`);
      assert(opened.length === 0, 'nothing opened');
    });

    run('a Cmd/Ctrl click opens the file with the OS instead', () => {
      reset();
      const isMac = /Mac/i.test(navigator.platform);
      assert(click(ref, isMac ? { metaKey: true } : { ctrlKey: true }), 'the click is claimed');
      assert(opened.join() === '/r/a.js' && pinned.length === 0, `opened ${opened}, pinned ${pinned}`);
    });

    run('plain inline code is not a link', () => {
      reset();
      assert(!click(plain), 'the click is left alone');
      assert(pinned.length === 0 && opened.length === 0, 'nothing done');
    });

    run('a click that ends a selection inside the reference is left to the selection', () => {
      reset();
      const range = document.createRange();
      range.setStart(/** @type {Text} */ (ref.firstChild), 0);
      range.setEnd(/** @type {Text} */ (ref.firstChild), 2);
      window.getSelection()?.addRange(range);
      assert(!click(ref), 'the click is left alone');
      assert(pinned.length === 0, `pinned ${JSON.stringify(pinned)}`);
    });

    run('Enter and Space on a focused reference pin it', () => {
      reset();
      for (const key of ['Enter', ' ']) {
        const e = new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true });
        ref.dispatchEvent(e);
        assert(e.defaultPrevented, `${JSON.stringify(key)} is claimed`);
      }
      assert(pinned.length === 2, `pinned ${JSON.stringify(pinned)}`);
    });

    run('a right click is left to the context menu', () => {
      reset();
      const e = new MouseEvent('click', { bubbles: true, cancelable: true, button: 2 });
      ref.dispatchEvent(e);
      assert(!e.defaultPrevented && pinned.length === 0, 'left alone');
    });
  } finally {
    uninstall();
    host.remove();
    window.getSelection()?.removeAllRanges();
  }

  return { passed, failed, errors };
}
