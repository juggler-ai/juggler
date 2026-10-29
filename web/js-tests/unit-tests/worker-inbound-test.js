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

import { assert, nextTask, waitFor, withTimeout } from '../utilities/test-helpers.js';
import { underPseudoLocale } from '../utilities/pseudo-locale.js';
import { isPseudoLocalized } from '../../sdk/lib/i18n.js';
import { WorkerManager } from '../../js/services/worker-manager.js';
import { ConversationLoader } from '../../js/services/conversation-loader.js';
import { INBOUND_HANDLERS, routeWorkerMessage } from '../../js/services/worker-manager-inbound.js';
import wsService from '../../js/services/websocket.js';
import { WS_CHUNK_HEADER_SIZE } from '../../js/utils/ws-chunk.js';

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
 * Settle-or-timeout for a promise that must already be settled, or settle
 * within a few ticks or on a short timer of the manager's own. Rides the
 * test's deadline, so a slow core is waited out and a wedge still fails.
 * @template T
 * @param {Promise<T>} promise - The promise
 * @param {string} what - What is being waited for
 * @returns {Promise<T>} Its value
 */
function soon(promise, what) {
  return withTimeout(promise, 1000, `${what} to settle`);
}

/**
 * A clock of the test's own. Code run through `run` sees its time in
 * `Date.now` and has its timers held here rather than scheduled; `advanceTo`
 * fires the held timers in due order, each at its due time. Nothing is stubbed
 * outside those synchronous calls, so the other lanes sharing this page never
 * see it.
 * @returns {{now: () => number, run: <T>(fn: () => T) => T, advanceTo: (at: number) => void}} The clock
 */
function fakeClock() {
  let now = Date.now();
  /** @type {Array<{at: number, cb: () => void, id: object}>} */
  const due = [];
  /**
   * @template T
   * @param {() => T} fn - What to run on this clock
   * @returns {T} Its value
   */
  const run = (fn) => {
    const realNow = Date.now;
    const realSet = window.setTimeout;
    const realClear = window.clearTimeout;
    Date.now = () => now;
    // An object id: one that escapes and reaches the real clearTimeout is a no-op there.
    window.setTimeout = /** @type {any} */ ((/** @type {() => void} */ cb, /** @type {number} */ ms = 0) => {
      const id = {};
      due.push({ at: now + ms, cb, id });
      return id;
    });
    window.clearTimeout = /** @type {any} */ ((/** @type {unknown} */ id) => {
      const i = due.findIndex((d) => d.id === id);
      if (i >= 0) due.splice(i, 1);
    });
    try { return fn(); } finally {
      Date.now = realNow;
      window.setTimeout = realSet;
      window.clearTimeout = realClear;
    }
  };
  const start = now;
  return {
    now: () => now,
    run,
    advanceTo(at) {
      run(() => {
        for (;;) {
          due.sort((a, b) => a.at - b.at);
          const next = due[0];
          if (!next || next.at > start + at) break;
          due.shift();
          now = next.at;
          next.cb();
        }
        now = start + at;
      });
    }
  };
}

/**
 * Split a text message into the binary chunk frames a WebSocket carries it as
 * (utils/ws-chunk.js), under a run id no server connection uses.
 * @param {number} id - Low word of the run id
 * @param {string} text - The message
 * @param {number} total - How many frames
 * @returns {ArrayBuffer[]} The frames
 */
function wsChunkFrames(id, text, total) {
  const bytes = new TextEncoder().encode(text);
  const size = Math.ceil(bytes.length / total);
  return Array.from({ length: total }, (_, index) => {
    const data = bytes.subarray(index * size, (index + 1) * size);
    const buf = new ArrayBuffer(WS_CHUNK_HEADER_SIZE + data.length);
    const view = new DataView(buf);
    new Uint8Array(buf).set([0x4a, 0x47, 0x43, 0x31]);
    view.setUint8(4, 0);
    view.setUint32(5, 0xfeedface);
    view.setUint32(9, id);
    view.setUint32(13, index);
    view.setUint32(17, total);
    new Uint8Array(buf).set(data, WS_CHUNK_HEADER_SIZE);
    return buf;
  });
}

/**
 * Split a text message into the `__juggler_dc_chunk` envelopes a DataChannel
 * carries it as, each as the raw frame text the server marshals (`type` first).
 * @param {string} id - The run id
 * @param {string} text - The message
 * @param {number} total - How many envelopes
 * @returns {string[]} The frames
 */
function dcChunkFrames(id, text, total) {
  const size = Math.ceil(text.length / total);
  return Array.from({ length: total }, (_, index) => JSON.stringify({
    type: '__juggler_dc_chunk', id, index, total, data: text.slice(index * size, (index + 1) * size)
  }));
}

/** A message both transports may carry and this client ignores. */
const IGNORED_MESSAGE = '{"type":"heartbeat"}';

/**
 * A manager whose spawns go nowhere: it counts the inits it would have sent.
 * @returns {{wm: any, inits: () => number}} The manager and its init count
 */
function managerSendingNothing() {
  const wm = /** @type {any} */ (new WorkerManager());
  wm._config = {};
  let inits = 0;
  wm._sendInit = () => { inits++; return true; };
  return { wm, inits: () => inits };
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
    const original = handlers.get('cancel-strategy-execution');
    handlers.set('cancel-strategy-execution', async () => { throw new Error(`boom ${conv}`); });
    try {
      const { errors: logged } = await captureConsole(conv, async () => {
        routeWorkerMessage(wm, conv, /** @type {any} */ ({ type: 'cancel-strategy-execution' }));
        await new Promise((r) => setTimeout(r, 0));
      });
      assert(logged.length === 1, `expected one reported failure, got ${logged.length}`);
      assert(logged[0].includes('cancel-strategy-execution failed'), `the report must name the message type; got: ${logged[0]}`);
    } finally {
      handlers.set('cancel-strategy-execution', original);
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

  await run('closing a conversation while its worker starts fails the spawn and its waiters at once; a new spawn starts afresh', async () => {
    // Left alone, the closed spawn is answered by nothing: its entry is gone,
    // so neither a ready nor an error can find it, and it waits out the full
    // ready timeout — with a re-spawn of the same id joining it.
    const conv = 'conv_inbound_close_starting';
    const wm = /** @type {any} */ (new WorkerManager());
    wm._config = {};
    let inits = 0;
    wm._sendInit = () => { inits++; return true; };
    await captureConsole(conv, async () => {
      const spawning = wm.spawnWorker(conv, { loadFromDisk: true }).then(() => null, (/** @type {Error} */ e) => e);
      const waiting = wm.waitForWorkerReady(conv).then(() => null, (/** @type {Error} */ e) => e);
      wm.terminate(conv);
      const again = wm.spawnWorker(conv, { loadFromDisk: true });

      const spawnErr = await soon(spawning, 'the closed spawn');
      assert(spawnErr instanceof Error && spawnErr.message.includes('closed'), `the spawn must fail as closed; got ${spawnErr && spawnErr.message}`);
      const waitErr = await soon(waiting, 'the closed spawn\'s ready wait');
      assert(waitErr instanceof Error && waitErr.message.includes('closed'), `its ready wait must fail as closed; got ${waitErr && waitErr.message}`);

      assert(inits === 2, `a spawn after the close must send its own init, not join the closed one; got ${inits} init(s)`);
      assert(wm.workerState(conv) === 'starting', 'the closed spawn\'s cleanup must leave the new spawn\'s entry alone');
      wm.markReady(conv, { created: '2026-10-26T00:00:00Z' });
      await soon(again, 'the new spawn');
    });
  });

  await run('en-XA: an error before ready that carries a message fails the waiters translated', async () => {
    const conv = 'conv_inbound_error_xa';
    const wm = managerWithEntry(conv);
    const english = 'Couldn\'t open this conversation: the server no longer has it.';
    // The error is what must fail the waiter, so its own timeout is set past
    // anything the pseudo-locale's catalogue load below can take on a slow core.
    const waiting = wm.waitForWorkerReady(conv, 10 * 60_000).then(() => null, (/** @type {Error} */ e) => e);
    await underPseudoLocale('worker-inbound-test', async () => {
      await captureConsole(conv, () => {
        routeWorkerMessage(wm, conv, /** @type {any} */ ({ type: 'error', message: english, text: { key: english } }));
      });
    });
    const outcome = await soon(waiting, 'the failed ready wait');
    assert(outcome instanceof Error && isPseudoLocalized(outcome.message),
      `plain English under en-XA: ${outcome instanceof Error ? outcome.message : String(outcome)}`);
  });

  await run('a validation-error status event reaches the conversation as a notice; other statuses do not', async () => {
    const conv = 'conv_inbound_validation';
    const wm = managerWithEntry(conv);
    /** @type {any[]} */
    const notices = [];
    let flushes = 0;
    const conversation = {
      flushPendingSyncs: () => { flushes++; },
      handleValidationNotice: (/** @type {any} */ n) => { notices.push(n); },
    };
    wm._session = { conversations: new Map([[conv, conversation]]) };
    routeWorkerMessage(wm, conv, /** @type {any} */ ({ type: 'status', status: 'streaming', message: '' }));
    routeWorkerMessage(wm, conv, /** @type {any} */ ({
      type: 'status', status: 'validation-error', message: 'refused', code: 'no-model', threadItemId: 'msg_a',
    }));
    assert(flushes === 2, `every status event applies the pending sync batch; got ${flushes}`);
    assert(notices.length === 1 && notices[0].code === 'no-model' && notices[0].threadItemId === 'msg_a',
      `exactly the validation-error must reach the conversation, with its code and thread; got ${JSON.stringify(notices)}`);
  });

  await run('create-thread-response settles its request, a refused one with the worker\'s reason; the caller\'s abort as an AbortError', async () => {
    const conv = 'conv_inbound_thread';
    const wm = managerWithEntry(conv);
    /** @type {any[]} */
    const sent = [];
    wm.sendToWorker = (/** @type {string} */ _id, /** @type {any} */ msg) => { sent.push(msg); return Promise.resolve(); };

    const ok = wm.createThread(conv, { goal: 'g', prompt: 'p' });
    const refused = wm.createThread(conv, { goal: 'g', prompt: 'p' }).then(() => null, (/** @type {Error} */ e) => e);
    const controller = new AbortController();
    const aborted = wm.createThread(conv, { goal: 'g', prompt: 'p' }, controller.signal).then(() => null, (/** @type {Error} */ e) => e);
    assert(sent.length === 3, `expected three create-thread messages, got ${sent.length}`);

    routeWorkerMessage(wm, conv, { type: 'create-thread-response', requestId: sent[0].requestId, threadItemId: 'T1', result: 'done' });
    routeWorkerMessage(wm, conv, { type: 'create-thread-response', requestId: sent[1].requestId, error: 'no such parent' });
    controller.abort();
    // The worker's answer to an aborted request comes too late to matter.
    routeWorkerMessage(wm, conv, { type: 'create-thread-response', requestId: sent[2].requestId, threadItemId: 'T3', result: 'late' });

    const value = await soon(ok, 'the answered thread');
    assert(value.threadItemId === 'T1' && value.result === 'done', `unexpected thread result ${JSON.stringify(value)}`);
    const err = await soon(refused, 'the refused thread');
    assert(err instanceof Error && err.name === 'Error' && err.message === 'no such parent',
      `a refused thread must reject with the worker's reason; got ${err && `${err.name}: ${err.message}`}`);
    const abortErr = await soon(aborted, 'the aborted thread');
    assert(abortErr instanceof Error && abortErr.name === 'AbortError', `an aborted thread must reject as AbortError; got ${abortErr && abortErr.name}`);
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

  // The ack's bound is the worker's silence, not the request's age: an undo
  // still queued behind a slow worker's other work must not be rejected while
  // the worker goes on to perform it. The timer is captured and fired by hand,
  // so the case says what the bound does at its expiry rather than measuring
  // how fast this core runs a timer.
  await run('an ack waits while the worker keeps talking, and fails on its silence', async () => {
    const conv = 'conv_inbound_talking';
    const wm = managerWithEntry(conv);
    /** @type {any[]} */
    const sent = [];
    wm.sendToWorker = (/** @type {string} */ _id, /** @type {any} */ msg) => { sent.push(msg); return Promise.resolve(); };
    /** @type {Array<() => void>} */
    const timers = [];
    const realSetTimeout = window.setTimeout;
    /**
     * Run `fn` with timers captured rather than scheduled.
     * @template T
     * @param {() => T} fn - What to run.
     * @returns {T} Its value.
     */
    const capturing = (fn) => {
      window.setTimeout = /** @type {any} */ ((/** @type {() => void} */ cb) => { timers.push(cb); return 0; });
      try { return fn(); } finally { window.setTimeout = realSetTimeout; }
    };
    /** @type {unknown} */
    let outcome = null;
    const pending = capturing(() => wm.sendWithAck(conv, { type: 'undo' }, 10000));
    pending.then(() => { outcome = 'resolved'; }, (/** @type {unknown} */ e) => { outcome = e; });
    assert(timers.length === 1, `the request arms one timer; got ${timers.length}`);
    // The window ends with the worker heard from just now.
    wm._lastHeardAt.set(conv, Date.now());
    capturing(() => /** @type {() => void} */ (timers.shift())());
    await Promise.resolve();
    assert(outcome === null, `a request to a worker still talking was settled at its window: ${String(outcome)}`);
    assert(timers.length === 1, `and it waits on, re-armed; got ${timers.length} timer(s)`);
    routeWorkerMessage(wm, conv, /** @type {any} */ ({ type: 'ack', ackId: sent[0].ackId, result: { ok: 1 } }));
    const result = await soon(pending, 'the request answered after its first window');
    assert(result?.ok === 1, `the late ack still reaches the caller; got ${JSON.stringify(result)}`);

    // Silent for its whole window: it fails, and says so.
    timers.length = 0;
    wm._lastHeardAt.delete(conv);
    const silent = capturing(() => wm.sendWithAck(conv, { type: 'redo' }, 1));
    // Measured from after the call, which is no earlier than the window's own
    // start inside it: from before, a stall between the two leaves the window
    // unspent when the captured check runs, and it re-arms into `timers`.
    const startedAt = Date.now();
    await waitFor(() => Date.now() - startedAt >= 2, 'the silent request\'s 1ms window to pass');
    capturing(() => /** @type {() => void} */ (timers.shift())());
    const err = await soon(silent.then(() => null, (/** @type {Error} */ e) => e), 'the silent request');
    assert(err instanceof Error && err.message.includes('Ack timeout') && err.message.includes('said nothing'),
      `a worker silent for the whole window fails the request, saying so; got ${err && err.message}`);
    assert(wm._pendingAcks.size === 0, 'and leaves no pending ack behind');
  });

  await run('an ack\'d request that never left fails at once with why, not as an ack timeout', async () => {
    // Left to the ack timeout, each of these would report "Ack timeout" —
    // which reads as a worker that never answered, when the worker was never
    // asked.
    const timeout = 60000;
    const conv = 'conv_inbound_unsent';

    const noWorker = /** @type {any} */ (new WorkerManager());
    const { warns } = await captureConsole(conv, async () => {
      const err = await soon(noWorker.sendWithAck(conv, { type: 'clear-undo-stacks' }, timeout).then(() => null, (/** @type {Error} */ e) => e),
        'a request to a conversation with no worker');
      assert(err instanceof Error && err.message.includes('not sent') && err.message.includes('no worker'),
        `expected a not-sent rejection naming the missing worker; got ${err && err.message}`);
    });
    assert(warns.length === 1, `the missing worker is still logged once; got ${warns.length}`);

    const refused = managerWithEntry(conv);
    refused.sendToWorker = () => Promise.resolve(false);
    const refusedErr = await soon(refused.sendWithAck(conv, { type: 'clear-undo-stacks' }, timeout).then(() => null, (/** @type {Error} */ e) => e),
      'a request the transport refused');
    assert(refusedErr instanceof Error && refusedErr.message.includes('not sent') && refusedErr.message.includes('clear-undo-stacks'),
      `expected a not-sent rejection naming the message; got ${refusedErr && refusedErr.message}`);

    const neverReady = managerWithEntry(conv);
    neverReady.sendToWorker = () => Promise.reject(new Error('Worker initialization timeout'));
    const readyErr = await soon(neverReady.sendWithAck(conv, { type: 'clear-undo-stacks' }, timeout).then(() => null, (/** @type {Error} */ e) => e),
      'a request to a worker that never became ready');
    assert(readyErr instanceof Error && readyErr.message.includes('Worker initialization timeout'),
      `expected the ready failure's reason; got ${readyErr && readyErr.message}`);

    for (const wm of [noWorker, refused, neverReady]) {
      assert(wm._pendingAcks.size === 0, 'a request that failed must leave no pending ack behind');
    }
  });

  // A starting worker's ready is queued behind its sync on this client's link,
  // so on a slow link the wait for it is as long as the transfer. Its bound is
  // the link's silence: chunk frames of a split message, on either transport,
  // and the worker's own messages are progress. Time is the test's own clock,
  // so the cases say what the bound does rather than how fast this core runs.
  await run('a starting worker waits out a slow transfer, frame by frame, past the ready timeout', async () => {
    const conv = 'conv_inbound_ready_slow_link';
    const { wm } = managerSendingNothing();
    const clock = fakeClock();
    await captureConsole(conv, async () => {
      /** @type {unknown} */
      let outcome = 'pending';
      const spawning = clock.run(() => wm.spawnWorker(conv, { loadFromDisk: true }));
      spawning.then(() => { outcome = 'resolved'; }, (/** @type {unknown} */ e) => { outcome = e; });
      const ws = wsChunkFrames(1, IGNORED_MESSAGE, 3);
      const dc = dcChunkFrames(`ready-slow-${conv}`, IGNORED_MESSAGE, 3);
      // Each gap is under the minute; the whole wait is four of them.
      /** @type {Array<[number, () => void]>} */
      const arrivals = [
        [40_000, () => wsService._handleBinaryMessage(ws[0])],
        [80_000, () => wsService._handleBinaryMessage(ws[1])],
        [120_000, () => wsService._observeStudioFrame(dc[0])],
        [160_000, () => wsService._observeStudioFrame(dc[1])],
        [210_000, () => wm._handleWorkerMessage(conv, { type: 'debug-sync-progress' })],
      ];
      for (const [at, arrive] of arrivals) {
        clock.advanceTo(at);
        await nextTask();
        assert(outcome === 'pending', `the wait must still be open at ${at / 1000}s, with progress at every step; got ${outcome}`);
        clock.run(arrive);
      }
      clock.advanceTo(260_000);
      await nextTask();
      assert(outcome === 'pending', `the wait must still be open 50s after the worker last spoke; got ${outcome}`);
      clock.run(() => wm.markReady(conv, { created: '2026-10-29T00:00:00Z' }));
      await soon(spawning, 'the spawn whose ready arrived');
      // Finish the WebSocket run, so it is not left part-way in the shared
      // service's reassembler; studio frames are only counted, never held.
      wsService._handleBinaryMessage(ws[2]);
    });
  });

  // A binary message crosses a studio link as binary pieces ("JDB1", in
  // cmd/juggler/tunnel/peer/chunk.go), each one progress like a chunk envelope.
  await run('a studio link\'s binary pieces are chunk progress, as its chunk envelopes are', async () => {
    const before = wsService.receiveProgress.chunks;
    wsService._observeStudioFrame(new ArrayBuffer(16 + 8));
    assert(wsService.receiveProgress.chunks === before + 1,
      `a binary piece must count as a chunk frame; ${wsService.receiveProgress.chunks - before} counted`);
    wsService._observeStudioFrame(IGNORED_MESSAGE);
    assert(wsService.receiveProgress.chunks === before + 1, 'a whole text frame is not a chunk frame');
  });

  await run('a starting worker\'s link silent for the ready timeout fails the spawn, saying what it waited and received', async () => {
    const conv = 'conv_inbound_ready_silent';
    const { wm } = managerSendingNothing();
    const clock = fakeClock();
    await captureConsole(conv, async () => {
      /** @type {unknown} */
      let outcome = 'pending';
      const spawning = clock.run(() => wm.spawnWorker(conv, { loadFromDisk: true }));
      spawning.then(() => { outcome = 'resolved'; }, (/** @type {unknown} */ e) => { outcome = e; });
      const ws = wsChunkFrames(2, IGNORED_MESSAGE, 2);
      clock.advanceTo(10_000);
      clock.run(() => wsService._handleBinaryMessage(ws[0]));
      // A server beat proves the link alive, not that anything for this
      // client is moving, so it does not hold the wait open.
      clock.advanceTo(40_000);
      const inboundAt = wsService._lastInboundAt;
      clock.run(() => wsService._handleMessageData(IGNORED_MESSAGE));
      wsService._lastInboundAt = inboundAt;
      clock.advanceTo(69_000);
      await nextTask();
      assert(outcome === 'pending', `59s after the last frame the wait must still be open; got ${outcome}`);
      clock.advanceTo(71_000);
      await nextTask();
      assert(outcome instanceof Error, `a minute of silence must fail the spawn; got ${outcome}`);
      const message = /** @type {Error} */ (outcome).message;
      assert(message.includes('Worker initialization timeout'), `the failure must still name the ready timeout; got: ${message}`);
      assert(/waited 7[01]s/.test(message), `the failure must say how long it waited in all; got: ${message}`);
      assert(/1 chunk frame/.test(message) && /received/.test(message), `the failure must say what arrived meanwhile; got: ${message}`);
      assert(wm.workerState(conv) !== 'starting', 'the failed spawn must leave no entry behind');
      wsService._handleBinaryMessage(ws[1]);
    });
  });

  await run('re-sending a starting worker\'s init on reconnect restarts its silence clock', async () => {
    // The init the dead link carried may never have arrived, and the worker
    // answers the re-sent one from scratch: time spent before it is no measure
    // of the worker.
    const conv = 'conv_inbound_ready_reinit';
    const { wm, inits } = managerSendingNothing();
    const clock = fakeClock();
    await captureConsole(conv, async () => {
      /** @type {unknown} */
      let outcome = 'pending';
      const spawning = clock.run(() => wm.spawnWorker(conv, { loadFromDisk: true }));
      spawning.then(() => { outcome = 'resolved'; }, (/** @type {unknown} */ e) => { outcome = e; });
      clock.advanceTo(50_000);
      clock.run(() => wm.reinitPendingConversations());
      assert(inits() === 2, `the reconnect must re-send the init; got ${inits()} init(s)`);
      clock.advanceTo(109_000);
      await nextTask();
      assert(outcome === 'pending', `59s after the re-sent init the wait must still be open; got ${outcome}`);
      clock.advanceTo(111_000);
      await nextTask();
      assert(outcome instanceof Error && outcome.message.includes('Worker initialization timeout'),
        `a minute of silence after the re-sent init must fail the spawn; got ${outcome}`);
    });
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
