//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Every command handler class is in the registry.
 *
 * `COMMAND_HANDLERS` is a hand-kept list of classes, and a class left off it is
 * not an error anywhere else: the command it was written for just never
 * auto-approves. The classes are module-private, so this reads the module's own
 * source for every `static commandName = '…'` and checks each name resolves to a
 * handler that answers to it. Abstract bases name themselves `''` and are
 * skipped.
 * @module unit-tests/command-handlers-registry-test
 */

import { COMMAND_HANDLERS } from '../context-items/execute/command-handlers.js';

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Case under test, used to label a failure.
   * @param {boolean} ok - Whether the case held.
   * @param {string} detail - What was wrong, when it did not.
   */
  const check = (label, ok, detail) => {
    if (ok) passed++;
    else {
      failed++;
      errors.push(`${label}: ${detail}`);
    }
  };

  const url = new URL('../context-items/execute/command-handlers.js', import.meta.url);
  const response = await fetch(url);
  const source = await response.text();
  const declared = [...source.matchAll(/static commandName = '([^']+)'/g)].map((m) => m[1]);

  check('the scan finds the handler classes', response.ok && declared.length > 0,
    `read ${declared.length} names from ${url.pathname} (HTTP ${response.status})`);

  const missing = declared.filter((name) => !COMMAND_HANDLERS.has(name));
  check('every named handler is registered', missing.length === 0,
    `declared but not in COMMAND_HANDLERS: ${missing.join(', ')}`);

  const misfiled = [...COMMAND_HANDLERS].filter(([name, handler]) => handler.commandName !== name);
  check('each entry answers to its own name', misfiled.length === 0,
    misfiled.map(([name, handler]) => `"${name}" → ${handler.name} (${handler.commandName})`).join(', '));

  check('nothing is registered that the source does not declare',
    COMMAND_HANDLERS.size === new Set(declared).size,
    `${COMMAND_HANDLERS.size} registered, ${new Set(declared).size} declared`);

  return { passed, failed, errors };
}
