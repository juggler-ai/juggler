//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The inbound worker protocol, and the seams of the WorkerManager split.
 *
 * Inbound messages are dispatched through one table
 * (`worker-manager-inbound.js`). These cases pin how the router behaves:
 * an unknown type is reported (a `debug-*` one is not), a type that names an
 * Object.prototype member is unknown rather than dispatched, and an async
 * handler's rejection is reported under its type instead of escaping.
 *
 * They also pin the bookkeeping the handlers drive through the manager's
 * public surface (`markReady`, `failPendingReady`, `settleThreadRequest`,
 * `settleAck`), each on a private manager with entries planted directly.
 *
 * Finally they pin the split itself: conversation building lives on
 * `workerManager.loader`, and the test-only messages live in
 * `js-tests/utilities/worker-test-hooks.js`, so the production class carries
 * neither.
 * @module unit-tests/worker-inbound-test
 */

import { assert } from '../utilities/test-helpers.js';
import { WorkerManager } from '../../js/services/worker-manager.js';
import { ConversationLoader } from '../../js/services/conversation-loader.js';
import { INBOUND_HANDLERS, routeWorkerMessage } from '../../js/services/worker-manager-inbound.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * Run `fn` with console.warn and console.error captured, keeping only lines
 * that mention `marker` (other lanes share the console).
 * @param {string} marker - Text identifying this test's lines
 * @param {() => Promise<void>|void} fn - The body
 * @returns {Promise<{warns: string[], errors: string[]}>} What was logged
 */
async function captureConsole(marker, fn) {
  /** @type {string[]} */
  const warns = [];
  /** @type {string[]} */
  const errors = [];
  const { warn, error } = console;
  const keep = (/** @type {string[]} */ sink) => (/** @type {any[]} */ ...args) => {
    const line = args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ');
    if (line.includes(marker)) sink.push(line);
  };
  console.warn = keep(warns);
  console.error = keep(errors);
  try {
    await fn();
  } finally {
    console.warn = warn;
    console.error = error;
  }
  return { warns, errors };
}

/**
 * A manager of its own with one planted worker entry.
 * @param {string} conversationId - Entry id
 * @param {{loadFromDisk?: boolean}} [opts] - How the entry was spawned
 * @returns {any} The manager
 */
function managerWithEntry(conversationId, { loadFromDisk = false } = {}) {
  const wm = /** @type {any} */ (new WorkerManager());
  wm._workers.set(conversationId, {
    conversationId,
    ready: false,
    readyCallbacks: [],
    readyRejectors: [],
    loadFromDisk,
    serialized: { loadFromDisk }
  });
  return wm;
}

/**
 * Settle-or-timeout for a promise that must already be settled or settle
 * within a few ticks.
 * @template T
 * @param {Promise<T>} promise - The promise
 * @param {string} what - What is being waited for
 * @returns {Promise<T>} Its value
 */
function soon(promise, what) {
  return Promise.race([
    promise,
    new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error(`${what} did not settle`)), 1000);
    })
  ]);
}

/**
 * Run the inbound router tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Case name
   * @param {() => Promise<void>} fn - The case
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

  await run('unknown types are reported, debug types and prototype names are not dispatched', async () => {
    const wm = /** @type {any} */ (new WorkerManager());
    const conv = 'conv_inbound_unknown';
    const { warns } = await captureConsole(conv, () => {
      routeWorkerMessage(wm, conv, /** @type {any} */ ({ type: 'no-such-type' }));
      routeWorkerMessage(wm, conv, /** @type {any} */ ({ type: 'debug-init-received' }));
      // A plain object table would find these on Object.prototype and call them.
      routeWorkerMessage(wm, conv, /** @type {any} */ ({ type: 'constructor' }));
      routeWorkerMessage(wm, conv, /** @type {any} */ ({ type: 'toString' }));
    });
    assert(warns.length === 3,
      `expected three unknown-type warnings (no-such-type, constructor, toString), got ${warns.length}: ${warns.join(' | ')}`);
    assert(!warns.some((w) => w.includes('debug-init-received')), 'a debug-* message must be ignored silently');
  });

  await run('an async handler\'s rejection is reported under its type', async () => {
    const wm = /** @type {any} */ (new WorkerManager());
    const conv = 'conv_inbound_reject';
    const handlers = /** @type {Map<string, any>} */ (INBOUND_HANDLERS);
    const original = handlers.get('save-error');
    handlers.set('save-error', async () => { throw new Error(`boom ${conv}`); });
    try {
      const { errors: logged } = await captureConsole(conv, async () => {
        routeWorkerMessage(wm, conv, /** @type {any} */ ({ type: 'save-error' }));
        await new Promise((r) => setTimeout(r, 0));
      });
      assert(logged.length === 1, `expected one reported failure, got ${logged.length}`);
      assert(logged[0].includes('save-error failed'), `the report must name the message type; got: ${logged[0]}`);
    } finally {
      handlers.set('save-error', original);
    }
  });

  await run('a load-from-disk entry waits for the ready that carries metadata', async () => {
    const conv = 'conv_inbound_ready';
    const wm = managerWithEntry(conv, { loadFromDisk: true });
    const waiting = wm.waitForWorkerReady(conv, 1000);

    routeWorkerMessage(wm, conv, /** @type {any} */ ({ type: 'ready' }));
    assert(wm.workerState(conv) === 'starting',
      'a metadata-less ready is another client\'s, and must not mark a load-from-disk entry ready');

    const metadata = { created: '2026-10-07T00:00:00Z' };
    routeWorkerMessage(wm, conv, /** @type {any} */ ({ type: 'ready', metadata }));
    assert(wm.workerState(conv) === 'ready', 'the metadata-bearing ready must mark the entry ready');
    const got = await soon(waiting, 'the ready wait');
    assert(got === metadata, 'the waiter must receive the ready\'s metadata');
  });

  await run('an error before ready fails the waiters with the worker\'s reason', async () => {
    const conv = 'conv_inbound_error';
    const wm = managerWithEntry(conv);
    const waiting = wm.waitForWorkerReady(conv, 60000).then(() => null, (/** @type {Error} */ e) => e);
    await captureConsole(conv, () => {
      routeWorkerMessage(wm, conv, /** @type {any} */ ({ type: 'error', message: `server no longer has ${conv}` }));
    });
    const outcome = await soon(waiting, 'the failed ready wait');
    assert(outcome instanceof Error, 'the wait must reject, not wait out its timeout');
    assert(outcome.message.includes('no longer has'), `the rejection must carry the worker's words; got: ${outcome.message}`);
  });

  await run('create-thread-response settles its request, a cancelled one as an AbortError', async () => {
    const conv = 'conv_inbound_thread';
    const wm = managerWithEntry(conv);
    /** @type {any[]} */
    const sent = [];
    wm.sendToWorker = (/** @type {string} */ _id, /** @type {any} */ msg) => { sent.push(msg); return Promise.resolve(); };

    const ok = wm.createThread(conv, { goal: 'g', prompt: 'p' });
    const cancelled = wm.createThread(conv, { goal: 'g', prompt: 'p' }).then(() => null, (/** @type {Error} */ e) => e);
    assert(sent.length === 2, `expected two create-thread messages, got ${sent.length}`);

    routeWorkerMessage(wm, conv, /** @type {any} */ ({ type: 'create-thread-response', requestId: sent[0].requestId, threadItemId: 'T1', result: 'done' }));
    routeWorkerMessage(wm, conv, /** @type {any} */ ({ type: 'create-thread-response', requestId: sent[1].requestId, error: 'stopped', cancelled: true }));

    const value = await soon(ok, 'the answered thread');
    assert(value.threadItemId === 'T1' && value.result === 'done', `unexpected thread result ${JSON.stringify(value)}`);
    const err = await soon(cancelled, 'the cancelled thread');
    assert(err instanceof Error && err.name === 'AbortError', `a cancelled thread must reject as AbortError; got ${err && err.name}`);
  });

  await run('an ack settles its request with the worker\'s result', async () => {
    const conv = 'conv_inbound_ack';
    const wm = managerWithEntry(conv);
    /** @type {any[]} */
    const sent = [];
    wm.sendToWorker = (/** @type {string} */ _id, /** @type {any} */ msg) => { sent.push(msg); return Promise.resolve(); };

    const pending = wm.sendWithAck(conv, { type: 'get-transaction', transactionId: 'x' }, 1000);
    routeWorkerMessage(wm, conv, /** @type {any} */ ({ type: 'ack', ackId: sent[0].ackId, result: { blob: 1 } }));
    const result = await soon(pending, 'the ack\'d request');
    assert(result && result.blob === 1, `the ack's result must reach the caller; got ${JSON.stringify(result)}`);
  });

  await run('the manager is a transport: the loader builds conversations, tests send their own messages', async () => {
    const wm = new WorkerManager();
    assert(wm.loader instanceof ConversationLoader, 'workerManager.loader must be a ConversationLoader');
    for (const method of ['createNew', 'loadExisting', 'destroy', 'autoLoad', 'pendingAutoLoad']) {
      assert(typeof (/** @type {any} */ (ConversationLoader.prototype))[method] === 'function',
        `ConversationLoader must provide ${method}`);
    }
    const moved = [
      'createNewConversation', 'loadExistingConversation', 'destroyConversationAndWorker', '_autoLoadConversation',
      'ping', 'setMockResponses', 'releaseMock', 'simulateDisconnect', 'reconnect', 'whenReady', 'hasWorker'
    ];
    const still = moved.filter((m) => m in WorkerManager.prototype);
    assert(still.length === 0, `WorkerManager still carries ${still.join(', ')}`);
  });

  return { passed, failed, errors };
}
