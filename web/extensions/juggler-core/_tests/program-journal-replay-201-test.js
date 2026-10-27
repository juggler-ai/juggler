//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The program journal against random programs, seeds 201–300. What is
 * under test, and why the seeds are split, is in
 * `program-journal-replay-helpers.js`.
 * @module _tests/program-journal-replay-201-test
 */

import { runReplaySeeds } from './program-journal-replay-helpers.js';

/**
 * Run this range's journal replay cases.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<import('./program-journal-replay-helpers.js').TestResult>} Pass/fail counts
 */
export async function runTests(_ctx) {
  return runReplaySeeds(201, 300);
}
