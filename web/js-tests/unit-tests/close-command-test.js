//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * /close command tests.
 *
 * `close-command-type.js` closes the current sub-thread by delegating to
 * `MessageThread.close(summaryText)` — the same path the "Close with generated
 * summary" footer button takes, except the user's typed message is forwarded as
 * the summary steer. This covers the command's own logic: the root guard, the
 * arg→summaryText join, and the empty-args auto-summary case. `close()` itself
 * (forcing return_result, preempting an in-flight turn) is covered by the thread
 * integration suite.
 * @module unit-tests/close-command-test
 */

import CloseCommandType from '../../extensions/juggler-core/commands/close-command-type.js';
import { assert } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Build a fake message thread that records close() calls.
 * @param {string|null} threadItemId - Thread id (null => root conversation)
 * @returns {{thread: any, calls: string[]}} Fake thread and captured summary args
 */
function makeFakeThread(threadItemId) {
  /** @type {string[]} */
  const calls = [];
  const thread = {
    threadItemId,
    close: (/** @type {string} */ summaryText) => {
      calls.push(summaryText);
      return Promise.resolve();
    }
  };
  return { thread, calls };
}

/**
 * Run /close command tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name
   * @param {() => Promise<void>|void} fn
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

  await test('MANIFEST declares an argsHint so the caret stays for a message', () => {
    const m = /** @type {any} */ (CloseCommandType).MANIFEST;
    assert(m.id === 'close', `id=${m.id}`);
    assert(typeof m.argsHint === 'string' && m.argsHint.length > 0, `argsHint=${m.argsHint}`);
  });

  await test('root conversation (no threadItemId) is a graceful error, not a close', async () => {
    const { thread, calls } = makeFakeThread(null);
    const cmd = new CloseCommandType({ messageThread: thread });
    const res = await cmd.execute(['some', 'note']);
    assert(res.handled === true && res.error === true, 'handled error result');
    assert(calls.length === 0, `close must not be called on root (calls=${calls.length})`);
  });

  await test('missing message thread is a graceful error, not a throw', async () => {
    const cmd = new CloseCommandType({ messageThread: undefined });
    const res = await cmd.execute([]);
    assert(res.handled === true && res.error === true, 'handled error result');
  });

  await test('no args closes with an empty steer (auto-summary, like the button)', async () => {
    const { thread, calls } = makeFakeThread('thr-1');
    const cmd = new CloseCommandType({ messageThread: thread });
    const res = await cmd.execute([]);
    assert(res.handled === true && !res.error, 'handled, no error');
    assert(calls.length === 1 && calls[0] === '', `close('') expected, got ${JSON.stringify(calls)}`);
  });

  await test('args are joined into the summary steer forwarded to close()', async () => {
    const { thread, calls } = makeFakeThread('thr-1');
    const cmd = new CloseCommandType({ messageThread: thread });
    const res = await cmd.execute(['user', 'says', 'already', 'checked']);
    assert(res.handled === true && !res.error, 'handled, no error');
    assert(calls.length === 1 && calls[0] === 'user says already checked',
      `steer join expected, got ${JSON.stringify(calls)}`);
  });

  return { passed, failed, errors };
}
