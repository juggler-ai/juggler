//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The order and row shape of the composer's button-opened command list (the
 * `/` dropdown), which `command-manager-entry.js` owns.
 * @module unit-tests/command-menu-order-test
 */

import { assert } from '../utilities/test-helpers.js';
import { menuOrderedCommands, buildCommandRow, MANAGER_COMMAND_ID } from '../../js/services/command-manager-entry.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
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

  /**
   * @param {string} label
   * @param {() => Promise<void> | void} fn
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

  await run('the fixed lead comes first, the rest keep registration order', () => {
    const input = ['zeta', 'compact', MANAGER_COMMAND_ID, 'alpha', 'new', 'thread', 'duplicate', 'clear']
      .map((name) => ({ name }));
    const got = menuOrderedCommands(input).map((c) => c.name).join(',');
    const want = 'new,duplicate,thread,clear,compact,zeta,alpha';
    assert(got === want, `got ${got}, want ${want}`);
    assert(input[0].name === 'zeta', 'the caller\'s list must not be reordered in place');
  });

  await run('a row carries the command, its label, and the surface\'s classes', () => {
    const row = buildCommandRow({ name: 'clear', danger: true }, { extraClass: 'surface-item', labelClass: 'surface-label' });
    assert(row.className === 'menu-item surface-item danger', `className was ${row.className}`);
    assert(row.dataset.command === 'clear', `data-command was ${row.dataset.command}`);
    assert(row.querySelector('code')?.textContent === '/clear', 'the row must lead with /clear');
    const label = row.querySelector('.surface-label');
    assert(label?.textContent === 'Clear', `a label-less command shows its capitalised name, got ${label?.textContent}`);
  });

  await run('the dropdown row defaults to menu-item-desc and prefers the label', () => {
    const row = buildCommandRow({ name: 'new', label: 'New conversation' });
    assert(row.className === 'menu-item', `className was ${row.className}`);
    assert(row.querySelector('.menu-item-desc')?.textContent === 'New conversation', 'the label must be shown');
  });

  return { passed, failed, errors };
}
