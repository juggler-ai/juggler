//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: a single click on a recent entry in the path picker opens it,
 * through the same confirm action as the primary button, once the path checks
 * out — and does not open one that does not.
 * @module unit-tests/project-picker-recents-test
 */

import { assert } from '../utilities/test-helpers.js';
import { buildPickerPanel } from '../../js/components/project-picker.js';

/**
 * Wait for a promise to settle, or report that it never did.
 * @template T
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T|'pending'>} The settled value, or 'pending'
 */
function settleWithin(promise, ms) {
  return Promise.race([promise, new Promise((r) => setTimeout(() => r('pending'), ms))]);
}

/**
 * @param {HTMLElement} panel
 * @param {string} path
 * @returns {void}
 */
function clickRecent(panel, path) {
  const item = [...panel.querySelectorAll('.pp-recent-item')].find((b) => b.textContent === path);
  assert(!!item, `no recent entry for ${path}`);
  /** @type {HTMLElement} */ (item).click();
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
   * @param {string} name
   * @param {() => Promise<void>} fn
   */
  const run = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (error) {
      failed++;
      errors.push(`${name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  await run('a click on a valid recent opens it', async () => {
    const { element, promise, cancel } = buildPickerPanel({
      recents: ['/work/alpha'],
      validate: async (p) => ({ valid: true, path: p }),
    });
    document.body.appendChild(element);
    try {
      clickRecent(element, '/work/alpha');
      const got = await settleWithin(promise, 1000);
      assert(got === '/work/alpha', `picker resolved ${JSON.stringify(got)}, want "/work/alpha"`);
    } finally {
      cancel();
      element.remove();
    }
  });

  await run('a click on an invalid recent stays open and says why', async () => {
    const { element, promise, cancel } = buildPickerPanel({
      recents: ['/work/gone'],
      validate: async () => ({ valid: false, error: 'No such folder' }),
    });
    document.body.appendChild(element);
    try {
      clickRecent(element, '/work/gone');
      const got = await settleWithin(promise, 300);
      assert(got === 'pending', `picker resolved ${JSON.stringify(got)} for an invalid path`);
      const status = element.querySelector('.pp-status')?.textContent || '';
      assert(status.includes('No such folder'), `status was "${status}"`);
    } finally {
      cancel();
      element.remove();
    }
  });

  await run('a click opens without a validator too', async () => {
    const { element, promise, cancel } = buildPickerPanel({ recents: ['/work/beta'] });
    document.body.appendChild(element);
    try {
      clickRecent(element, '/work/beta');
      const got = await settleWithin(promise, 1000);
      assert(got === '/work/beta', `picker resolved ${JSON.stringify(got)}, want "/work/beta"`);
    } finally {
      cancel();
      element.remove();
    }
  });

  return { passed, failed, errors };
}
