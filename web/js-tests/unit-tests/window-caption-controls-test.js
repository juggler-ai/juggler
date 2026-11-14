//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests for `<window-caption-controls>`
 * (`js/components/window-caption-controls.js`): the caption buttons' labels and
 * tooltips — minimise, maximise, restore, close — follow the UI language on
 * both platforms that draw them.
 *
 * The page is made to look like a frameless Windows/Linux window by setting the
 * root's dataset for the duration, and each element's `_control` is stubbed so
 * no native window is ever driven.
 * @module unit-tests/window-caption-controls-test
 */

import '../../js/components/window-caption-controls.js';
import { assert } from '../utilities/test-helpers.js';
import { underPseudoLocale, assertPseudoLocalized } from '../utilities/pseudo-locale.js';

/**
 * Run the window-caption-controls test suite.
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  /** @type {string[]} */
  const errors = [];
  let passed = 0;
  let failed = 0;

  /**
   * @param {string} name
   * @param {() => Promise<void>} fn
   */
  const run = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await run('caption button labels follow the UI language under en-XA', async () => {
    const root = document.documentElement;
    const { windowMode, windowPlatform } = root.dataset;
    /** @type {string[]} */
    const failures = [];
    try {
      await underPseudoLocale('window-caption-controls-test', async () => {
        for (const platform of ['windows', 'linux']) {
          root.dataset.windowMode = '1';
          root.dataset.windowPlatform = platform;
          const el = /** @type {any} */ (document.createElement('window-caption-controls'));
          /** @type {string[]} */
          const actions = [];
          el._control = (/** @type {string} */ action) => { actions.push(action); };
          document.body.appendChild(el);
          try {
            assert(el.querySelectorAll('button').length === 3, `${platform}: expected 3 caption buttons`);
            for (const [where, draw] of /** @type {const} */ ([
              ['initial', null], ['maximised', true], ['restored', false],
            ])) {
              if (draw !== null) el._renderMaxGlyph(draw);
              try {
                // An aria-label and a title on each of the three buttons.
                assertPseudoLocalized(el, { atLeast: 6, where: `${platform}, ${where}` });
              } catch (e) {
                failures.push(e instanceof Error ? e.message : String(e));
              }
            }
            assert(actions.join() === 'state', `${platform}: only the state read is asked for, got ${actions.join()}`);
          } finally {
            el.remove();
          }
        }
      });
    } finally {
      if (windowMode === undefined) delete root.dataset.windowMode; else root.dataset.windowMode = windowMode;
      if (windowPlatform === undefined) delete root.dataset.windowPlatform; else root.dataset.windowPlatform = windowPlatform;
    }
    assert(failures.length === 0, failures.join(' | '));
  });

  // The frameless windows have no native caption, so the platform's
  // "double-click the title bar to maximise" is ours to supply — only on the
  // drag region, never on a no-drag control inside it.
  await run('double-clicking the drag region toggles maximise', async () => {
    const root = document.documentElement;
    const { windowMode, windowPlatform } = root.dataset;
    const header = document.createElement('div');
    header.style.setProperty('--wails-draggable', 'drag');
    const button = document.createElement('button');
    button.style.setProperty('--wails-draggable', 'no-drag');
    header.appendChild(button);
    document.body.appendChild(header);
    try {
      for (const platform of ['windows', 'linux']) {
        root.dataset.windowMode = '1';
        root.dataset.windowPlatform = platform;
        const el = /** @type {any} */ (document.createElement('window-caption-controls'));
        /** @type {string[]} */
        const actions = [];
        el._control = (/** @type {string} */ action) => { actions.push(action); };
        header.appendChild(el);
        try {
          button.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          header.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
          assert(actions.join() === 'state,maximise',
            `${platform}: expected one maximise from the drag region only, got ${actions.join()}`);
        } finally {
          el.remove();
        }
      }
    } finally {
      header.remove();
      if (windowMode === undefined) delete root.dataset.windowMode; else root.dataset.windowMode = windowMode;
      if (windowPlatform === undefined) delete root.dataset.windowPlatform; else root.dataset.windowPlatform = windowPlatform;
    }
  });

  return { passed, failed, errors };
}
