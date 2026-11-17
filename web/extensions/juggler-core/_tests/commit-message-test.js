//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Commit message tests — the hard wrap the commit box applies to a body as it
 * commits, and nothing else: the summary is the user's to keep long.
 * @module _tests/commit-message-test
 */

import { wrapBody, summaryOf } from '../lib/commit-message.js';
import { assert } from '../../../js-tests/utilities/test-helpers.js';

/**
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Test label.
   * @param {() => Promise<void>|void} fn - Test body.
   */
  async function test(name, fn) {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
  }

  const words = (/** @type {number} */ n) => Array.from({ length: n }, (_, i) => `word${i}`).join(' ');

  await test('a long body line wraps at 72, and the summary does not', () => {
    const summary = `Summary ${'x'.repeat(80)}`;
    const body = words(40);
    const out = wrapBody(`${summary}\n\n${body}`, 72);
    const lines = out.split('\n');
    assert(lines[0] === summary, `the summary is left as typed: ${JSON.stringify(lines[0])}`);
    assert(lines[1] === '', 'the blank line after it stays');
    const wrapped = lines.slice(2);
    assert(wrapped.length > 1, `the body should wrap: ${JSON.stringify(wrapped)}`);
    assert(wrapped.every((/** @type {string} */ l) => l.length <= 72), `every body line fits: ${JSON.stringify(wrapped)}`);
    assert(wrapped.join(' ') === body, 'wrapping moves line breaks and loses no words');
  });

  await test('short lines, blank lines and a summary alone are unchanged', () => {
    assert(wrapBody('Fix it', 72) === 'Fix it', 'a summary alone');
    const msg = 'Fix it\n\nOne short line.\n\nAnother paragraph.\nKept as typed.';
    assert(wrapBody(msg, 72) === msg, `short lines stay: ${JSON.stringify(wrapBody(msg, 72))}`);
  });

  await test('indented lines and list items are left alone', () => {
    const long = words(20);
    const msg = `Fix it\n\n    ${long}\n- ${long}\n* ${long}\n1. ${long}`;
    assert(wrapBody(msg, 72) === msg, `got ${JSON.stringify(wrapBody(msg, 72))}`);
  });

  await test('a URL longer than the width stays whole on its own line', () => {
    const url = `https://example.com/${'a'.repeat(90)}`;
    const out = wrapBody(`Fix it\n\nSee ${url} for the details of it`, 72);
    const lines = out.split('\n').slice(2);
    assert(lines.includes(url), `the URL is unbroken and alone: ${JSON.stringify(lines)}`);
    assert(lines[0] === 'See', `got ${JSON.stringify(lines)}`);
  });

  await test('fenced code and trailers are not wrapped', () => {
    const long = words(20);
    const msg = `Fix it\n\n\`\`\`\n${long}\n\`\`\`\nCo-authored-by: ${long}`;
    assert(wrapBody(msg, 72) === msg, `got ${JSON.stringify(wrapBody(msg, 72))}`);
  });

  await test('the width is the one asked for', () => {
    const out = wrapBody(`S\n\n${words(10)}`, 20).split('\n').slice(2);
    assert(out.length > 1 && out.every((/** @type {string} */ l) => l.length <= 20), `got ${JSON.stringify(out)}`);
  });

  await test('the summary is the first line', () => {
    assert(summaryOf('One\n\nTwo') === 'One', 'first line');
    assert(summaryOf('') === '', 'empty');
  });

  return { passed, failed, errors };
}
