//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * A rejected command must tell the model WHY it was rejected.
 *
 * The server's foot-gun filter refuses a command before running it and reports
 * the reason on the terminal stream chunk's `error` field. That reason used to
 * die on the way to the model: the streaming result carried it, the execute
 * result dropped it, and `getSummary` never looked for it — so a blocked
 * command reached the model as nothing but `(no output)` and `exit code: 1`.
 * Retrying is the only sane response to that, which is what a model did, for
 * an hour, before deciding `dd` itself was broken.
 *
 * These cases drive the real ExecuteContextItem against the real streaming
 * client, stubbing only the WebSocket boundary, and assert the reason survives
 * every hop to the text the model actually reads.
 * @module _tests/blocked-command-feedback-test
 */

import { assert, withTimeout } from '../../../js-tests/utilities/test-helpers.js';
import ExecuteContextItem from '../context-items/execute-context-item.js';

/** The exact string the server's foot-gun filter produces. */
const REASON = 'invalid command: command contains dangerous pattern: mkfs';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * The construction context for an ExecuteContextItem under test. The session,
 * conversation and thread are bare stand-ins: the streaming path these cases
 * drive reads none of their members.
 * @param {string} id - Item id
 * @returns {import('juggler/context-item').ItemContext} The context
 */
function itemContext(id) {
  return /** @type {import('juggler/context-item').ItemContext} */ ({
    id,
    session: {},
    conversation: { id: 'blocked-command-feedback-conv', session: {} },
    messageThread: {}
  });
}

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Case name
   * @param {() => (void | Promise<void>)} fn - Case body
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

  const wsService = (await import('../../../js/services/websocket.js')).default;
  const originalSendStart = wsService.sendShellStart;

  /**
   * Run a command through the real execute path, with the "server" answering
   * the shell-start frame with a single terminal chunk carrying `error` —
   * exactly what ops.ExecuteStreaming emits for a command it refuses to run.
   * @param {string} command - Command to submit
   * @returns {Promise<{result: Record<string, unknown>, summary: import('juggler/context-item').ItemSummary & {exitCode?: number}}>} The execute result and the summary built from it
   */
  const runBlocked = async (command) => {
    wsService.sendShellStart = (/** @type {string} */ shellId) => {
      // Reply on a later tick: the listener is registered by the promise
      // executor, which has not finished running when this is called.
      setTimeout(() => {
        // The refusal chunk ops.ExecuteStreaming emits, field for field. The
        // Go side of this contract is pinned by
        // TestExecuteStreaming_RefusalIsReportedAsBlocked.
        wsService.__emitForTests('shell-output', { shellId, done: true, error: REASON, blocked: true });
      }, 0);
      return true;
    };

    const item = new ExecuteContextItem(itemContext('blocked-command-feedback-test'));

    const result = /** @type {Record<string, unknown>} */ (await withTimeout(item.execute({ command }), 4000, 'the blocked command to settle'));

    // The shape action-executor.js builds for an action that resolved: the
    // action itself did not throw, so `success` is true and the command's own
    // verdict lives entirely inside `result`.
    const summary = item.getSummary({ success: true, result, prepared: { valid: true, params: { command } } });
    return { result, summary };
  };

  try {
    await run('the execute result keeps the rejection reason', async () => {
      const { result } = await runBlocked('mkfs.ext4 /dev/sdb1');
      assert(typeof result.error === 'string' && result.error.includes('mkfs'),
        `execute() must pass the reason on, got ${JSON.stringify(result.error)}`);
    });

    await run('the model-visible summary names the reason, not just an exit code', async () => {
      const { summary } = await runBlocked('mkfs.ext4 /dev/sdb1');
      const text = typeof summary.summary === 'string' ? summary.summary : '';
      assert(text.includes('dangerous pattern: mkfs'),
        `the tool_result the model reads must carry the reason, got ${JSON.stringify(text)}`);
      assert(!/^\(no output\)/.test(text),
        `a blocked command must not look like a silent failure, got ${JSON.stringify(text)}`);
    });

    await run('the reason says the command was blocked, not that it failed', async () => {
      const { summary } = await runBlocked('mkfs.ext4 /dev/sdb1');
      const text = typeof summary.summary === 'string' ? summary.summary : '';
      assert(/blocked/i.test(text),
        `the model must learn Juggler refused the command, got ${JSON.stringify(text)}`);
    });

    await run('the appended LLM feedback carries the reason too', async () => {
      const { summary } = await runBlocked('mkfs.ext4 /dev/sdb1');
      const feedback = summary.feedbackForLLM || '';
      assert(feedback.includes('dangerous pattern: mkfs'),
        `feedbackForLLM must steer away from a retry, got ${JSON.stringify(feedback)}`);
      assert(!/exit code 1$/.test(feedback),
        `bare "exit code 1" feedback invites the retry loop, got ${JSON.stringify(feedback)}`);
    });

    await run('a blocked command reports as unsuccessful', async () => {
      const { summary } = await runBlocked('mkfs.ext4 /dev/sdb1');
      assert(summary.success === false, 'a refused command is not a success');
      assert(summary.icon === '✗', `expected the failure icon, got ${JSON.stringify(summary.icon)}`);
    });

    await run('a timeout surfaces its reason without claiming it was blocked', async () => {
      // Same terminal-chunk shape, minus `blocked`: the command ran, produced
      // output, and was killed at the deadline. The reason must still reach the
      // model — an exit code of 1 says nothing about a deadline.
      wsService.sendShellStart = (/** @type {string} */ shellId) => {
        setTimeout(() => {
          wsService.__emitForTests('shell-output', { shellId, data: 'working\n' });
          wsService.__emitForTests('shell-output', { shellId, done: true, error: 'command timeout (exceeded 2m0s)' });
        }, 0);
        return true;
      };

      const item = new ExecuteContextItem(itemContext('blocked-command-feedback-test-timeout'));

      const result = /** @type {Record<string, unknown>} */ (await withTimeout(item.execute({ command: 'sleep 999' }), 4000, 'the timed-out command to settle'));

      const summary = item.getSummary({ success: true, result, prepared: { valid: true, params: { command: 'sleep 999' } } });
      const text = typeof summary.summary === 'string' ? summary.summary : '';
      assert(text.includes('command timeout (exceeded 2m0s)'),
        `the deadline must reach the model, got ${JSON.stringify(text)}`);
      assert(!/blocked/i.test(text),
        `a timeout is not a refusal, got ${JSON.stringify(text)}`);
      assert(text.includes('working'),
        `output produced before the kill must survive, got ${JSON.stringify(text)}`);
      assert(summary.success === false, 'a timed-out command is not a success');
    });

    await run('an ordinary non-zero exit still reads as a plain failure', async () => {
      // The reason-carrying path must not swallow the normal case: no `error`
      // on the chunk means the command ran and simply exited non-zero.
      wsService.sendShellStart = (/** @type {string} */ shellId) => {
        setTimeout(() => {
          wsService.__emitForTests('shell-output', { shellId, data: 'boom\n' });
          wsService.__emitForTests('shell-output', { shellId, done: true, exitCode: 2 });
        }, 0);
        return true;
      };

      const item = new ExecuteContextItem(itemContext('blocked-command-feedback-test-plain'));

      const result = /** @type {Record<string, unknown>} */ (await withTimeout(item.execute({ command: 'false' }), 4000, 'the failing command to settle'));

      const summary = item.getSummary({ success: true, result, prepared: { valid: true, params: { command: 'false' } } });
      const text = typeof summary.summary === 'string' ? summary.summary : '';
      assert(text.includes('boom'), `output must survive, got ${JSON.stringify(text)}`);
      assert(text.includes('exit code: 2'), `exit code must survive, got ${JSON.stringify(text)}`);
      assert(!/blocked/i.test(text), `a real failure must not claim it was blocked, got ${JSON.stringify(text)}`);
      assert(summary.success === false, 'exit 2 is not a success');
    });
  } finally {
    wsService.sendShellStart = originalSendStart;
  }

  return { passed, failed, errors };
}
