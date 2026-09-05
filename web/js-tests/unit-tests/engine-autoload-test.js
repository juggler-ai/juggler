//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Engine auto-load retry policy.
 *
 * The engine realm loads a conversation it has never heard of when a yjs-sync
 * arrives for it. The first failure is usually a race — the worker's first-init
 * `ready` lands before it has processed our init — so the stub is dropped and
 * the next sync retries. That is right, and unbounded.
 *
 * The worker pushes state to the engine before every tool dispatch and every
 * redrive, so "the next sync" arrives continuously: a conversation that keeps
 * failing is retried at round-trip cadence for as long as anything is happening,
 * which is a self-feeding loop that runs hardest exactly when the machine is
 * already struggling.
 *
 * These cases pin the shape of the fix — back off, but never give up, because a
 * conversation that never loads is one whose tools can never run.
 * @module unit-tests/engine-autoload-test
 */

import { assert } from '../utilities/test-helpers.js';
import { WorkerManager } from '../../js/services/worker-manager.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * A manager of its own, never the shared singleton: suites in a lane share one
 * realm, and a test that mutates module state decides what the next suite sees.
 * @returns {{wm: any, attempts: () => number, fail: () => void, succeed: () => void}} The probe.
 */
function probeManager() {
  const wm = /** @type {any} */ (new WorkerManager());
  let attempts = 0;
  let shouldFail = true;
  wm._session = { conversations: new Map() };
  wm.loadExistingConversation = async () => {
    attempts++;
    if (shouldFail) throw new Error('worker not ready');
    return { handleYjsSyncMessage: () => {} };
  };
  return {
    wm,
    attempts: () => attempts,
    fail: () => { shouldFail = true; },
    succeed: () => { shouldFail = false; }
  };
}

/**
 * Drive one auto-load and wait for it to settle.
 * @param {any} wm - The manager under test.
 * @param {string} conversationId - Conversation to auto-load.
 * @returns {Promise<void>} Resolves once the attempt has finished.
 */
async function autoLoad(wm, conversationId) {
  wm._autoLoadConversation(conversationId);
  await wm._pendingAutoLoads.get(conversationId)?.promise;
}

/**
 * Run the auto-load retry tests.
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Case name.
   * @param {() => Promise<void>} fn - The case.
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

  await run('a conversation that will not load is not retried on every sync', async () => {
    const { wm, attempts } = probeManager();
    const convId = 'conv_autoload_probe';

    // Fifteen syncs back to back — what a worker pushing state ahead of every
    // tool dispatch produces while a tool is being redriven.
    for (let i = 0; i < 15; i++) await autoLoad(wm, convId);

    // Two: the load, and the immediate retry the first failure is entitled to
    // because it is usually the first-init race. Everything after that waits.
    assert(
      attempts() === 2,
      `a failing auto-load must back off, not retry on every sync; ${attempts()} of 15 syncs each started a load`
    );
  });

  await run('but it is retried once the backoff has elapsed', async () => {
    const { wm, attempts } = probeManager();
    const convId = 'conv_autoload_probe';

    // Past the free first retry and into the backed-off region.
    await autoLoad(wm, convId);
    await autoLoad(wm, convId);
    assert(attempts() === 2, `the load and its immediate first retry; got ${attempts()}`);

    const record = wm._autoLoadFailures.get(convId);
    assert(record, 'the failure must be recorded, or nothing can decide when to retry');
    assert(record.failures === 2, `both failures counted; got ${record.failures}`);

    // Stand where the backoff has run out, rather than sleeping through it.
    record.lastAttemptAt = 0;

    await autoLoad(wm, convId);
    assert(
      attempts() === 3,
      `giving up permanently would leave the conversation's tools unable to ever run; got ${attempts()} attempts`
    );
  });

  await run('the delay grows, so a conversation that never loads stops costing much', async () => {
    const { wm } = probeManager();
    const convId = 'conv_autoload_probe';

    /** @type {number[]} */
    const delays = [];
    for (let i = 0; i < 6; i++) {
      await autoLoad(wm, convId);
      const record = wm._autoLoadFailures.get(convId);
      delays.push(wm._autoLoadRetryDelayMs(record.failures));
      record.lastAttemptAt = 0; // let the next one through
    }

    assert(
      delays[delays.length - 1] > delays[0],
      `the retry delay must grow with repeated failure; got ${delays.join('ms, ')}ms`
    );
    for (let i = 1; i < delays.length; i++) {
      assert(delays[i] >= delays[i - 1], `the delay must never shrink; got ${delays.join('ms, ')}ms`);
    }
  });

  await run('a load that succeeds clears the record, so the next failure is fast again', async () => {
    const { wm, succeed } = probeManager();
    const convId = 'conv_autoload_probe';

    await autoLoad(wm, convId);
    assert(wm._autoLoadFailures.has(convId), 'the failure was recorded');

    succeed();
    wm._autoLoadFailures.get(convId).lastAttemptAt = 0;
    await autoLoad(wm, convId);

    assert(
      !wm._autoLoadFailures.has(convId),
      'a successful load must clear the backoff — the next unrelated blip deserves the fast first retry'
    );
  });

  return { passed, failed, errors };
}
