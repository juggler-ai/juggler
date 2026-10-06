//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Where the composer's "how did the last turn end" scan stops.
 *
 * Continue inserts no message, and neither does a reply made only of tool
 * calls, so a turn resumed after a Stop sits directly after the tool the Stop
 * cancelled. Bounded only by the last user message, that one cancellation read
 * as "Stopped." on every turn until the user typed something. The trailing turn
 * also ends at an item stamped by an earlier LLM round-trip.
 * @module unit-tests/trailing-turn-outcome-test
 */

import { trailingTurnOutcome } from '../../js/utils/composer-placeholders.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * @param {string} actual - The outcome trailingTurnOutcome returned
 * @param {string} expected - The outcome the case expects
 */
function expectOutcome(actual, expected) {
  assert(actual === expected, `expected outcome ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}

/**
 * A stand-in for an item's Y.Map: trailingTurnOutcome reads items only through
 * `get`, which a Map provides.
 * @param {Record<string, string>} fields - The item's fields
 * @returns {Map<string, string>} The item
 */
const item = (fields) => new Map(Object.entries(fields));

/**
 * @typedef {object} TestResult
 * @property {number} passed - Passing assertion count
 * @property {number} failed - Failing assertion count
 * @property {string[]} errors - Collected error messages
 */

/**
 * Run trailing-turn-outcome tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Case name
   * @param {() => void} fn - Assertions to run
   */
  function test(name, fn) {
    try { fn(); passed++; }
    catch (/** @type {any} */ e) { failed++; errors.push(`${name}: ${e.message}`); }
  }

  test('a tool cancelled in the trailing turn reads as cancelled', () => {
    const items = [
      item({ type: 'user' }),
      item({ type: 'assistant', transactionId: 'txn-1' }),
      item({ type: 'tool-action', state: 'cancelled', transactionId: 'txn-1' }),
    ];
    expectOutcome(trailingTurnOutcome(items), 'cancelled');
  });

  test('a turn resumed by Continue after a Stop is not still cancelled', () => {
    const items = [
      item({ type: 'user' }),
      item({ type: 'assistant', transactionId: 'txn-1' }),
      item({ type: 'tool-action', state: 'cancelled', transactionId: 'txn-1' }),
      item({ type: 'tool-action', state: 'completed', transactionId: 'txn-2' }),
    ];
    expectOutcome(trailingTurnOutcome(items), '');
  });

  test('an item with no transactionId draws no boundary', () => {
    const items = [
      item({ type: 'user' }),
      item({ type: 'tool-action', state: 'cancelled', transactionId: 'txn-1' }),
      item({ type: 'tool-action', state: 'completed' }),
    ];
    expectOutcome(trailingTurnOutcome(items), 'cancelled');
  });

  test('a receipt appended later draws no boundary', () => {
    const items = [
      item({ type: 'user' }),
      item({ type: 'tool-action', state: 'cancelled', transactionId: 'txn-1' }),
      item({ type: 'thread', aliasOf: 'thread-1', runItemId: 'run-1', transactionId: 'txn-9' }),
    ];
    expectOutcome(trailingTurnOutcome(items), 'cancelled');
  });

  test('an error in the trailing turn reads as error', () => {
    const items = [
      item({ type: 'user' }),
      item({ type: 'tool-action', state: 'cancelled', transactionId: 'txn-1' }),
      item({ type: 'error', transactionId: 'txn-2' }),
    ];
    expectOutcome(trailingTurnOutcome(items), 'error');
  });

  test('the user message still ends the scan', () => {
    const items = [
      item({ type: 'tool-action', state: 'cancelled' }),
      item({ type: 'user' }),
    ];
    expectOutcome(trailingTurnOutcome(items), '');
  });

  return { passed, failed, errors };
}
