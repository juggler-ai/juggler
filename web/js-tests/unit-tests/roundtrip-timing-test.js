//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Round-trip timing tests for the worker's context/tools requests.
 *
 * The worker waits on the engine to answer `render-context-items-request` and
 * `request-tools` together, for as long as that engine stays attached. Which
 * of the three stages spent the time — delivery to the engine, the engine's own work, or the
 * reply's trip back — is not something the worker can see on its own, so the
 * engine stamps the reply: it echoes the `sentAt` it was given and adds the
 * moment it picked the request up and the moment it answered. Both realms sit
 * on one machine and one wall clock, so the worker can subtract them directly.
 *
 * Without the stamps a slow round-trip leaves no trace at all, which is why a
 * reproducible field report of this timeout could only ever be guessed at.
 * @module unit-tests/roundtrip-timing-test
 */

import {
  handleRequestTools,
  sendToolsResult,
  sendRenderContextItemsResponse,
  beginRoundTrip,
  sendRequestWorkingTraces,
} from '../../js/services/worker-manager-protocols.js';
import wsService from '../../js/services/websocket.js';
import { assert, waitFor } from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Build a stand-in WorkerManager that records what it would send to the worker.
 * @returns {{sent: any[], sendToWorker: (c: string, m: any) => void, _roundTripStamps: Map<string, any>, _onToolsRequest: any}} Fake manager
 */
function fakeWorkerManager() {
  /** @type {any[]} */
  const sent = [];
  return {
    sent,
    _roundTripStamps: new Map(),
    _onToolsRequest: null,
    sendToWorker(_conversationId, message) {
      sent.push(message);
    },
  };
}

/**
 * Run round-trip timing tests.
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

  await test('a tools reply carries the three stamps the worker needs', async () => {
    const wm = fakeWorkerManager();
    const sentAt = Date.now() - 1234;
    wm._onToolsRequest = (/** @type {any} */ req) => {
      sendToolsResult(wm, 'conv-1', req.requestId, []);
    };

    // Answering the broadcast is the engine's job (see unit:worker-broadcast),
    // so the handler only reaches the callback in that role.
    const g = /** @type {any} */ (globalThis);
    const had = Object.prototype.hasOwnProperty.call(g, 'JUGGLER_ENGINE');
    const previous = g.JUGGLER_ENGINE;
    g.JUGGLER_ENGINE = true;
    try {
      await handleRequestTools(wm, 'conv-1', { requestId: 'req-1', sentAt });
    } finally {
      if (had) g.JUGGLER_ENGINE = previous;
      else delete g.JUGGLER_ENGINE;
    }

    assert(wm.sent.length === 1, `expected one reply, got ${wm.sent.length}`);
    const reply = wm.sent[0];
    assert(reply.type === 'tools-result', `expected tools-result, got ${reply.type}`);
    assert(reply.sentAt === sentAt, `reply must echo sentAt ${sentAt}, got ${reply.sentAt}`);
    assert(
      typeof reply.receivedAt === 'number' && reply.receivedAt >= sentAt,
      `receivedAt must be a stamp at or after sentAt, got ${reply.receivedAt}`
    );
    assert(
      typeof reply.repliedAt === 'number' && reply.repliedAt >= reply.receivedAt,
      `repliedAt must be at or after receivedAt, got ${reply.repliedAt}`
    );
  });

  await test('a context reply carries the stamps taken when the request arrived', async () => {
    const wm = fakeWorkerManager();
    const sentAt = Date.now() - 50;

    // The context handler stamps on arrival, then does its (async) work before
    // replying — so the stamp must survive the gap rather than be taken at send.
    beginRoundTrip(wm, { requestId: 'req-2', sentAt });
    const receivedAt = wm._roundTripStamps.get('req-2')?.receivedAt;
    // The gap the stamp must survive: the clock moves on before the reply.
    await waitFor(() => Date.now() > (receivedAt ?? Infinity), 'the clock to move past the arrival stamp');
    sendRenderContextItemsResponse(wm, 'conv-1', 'req-2', [], 'prompt');

    const reply = wm.sent[0];
    assert(reply.type === 'render-context-items-response', `expected render-context-items-response, got ${reply.type}`);
    assert(reply.sentAt === sentAt, `reply must echo sentAt ${sentAt}, got ${reply.sentAt}`);
    assert(
      reply.receivedAt === receivedAt,
      `receivedAt must be the arrival stamp ${receivedAt}, not one taken at reply time, got ${reply.receivedAt}`
    );
    assert(
      reply.repliedAt > reply.receivedAt,
      `repliedAt must be later than receivedAt across the await, got ${reply.repliedAt} vs ${reply.receivedAt}`
    );
  });

  await test('answering releases the stamp, so a long run does not accumulate them', async () => {
    const wm = fakeWorkerManager();
    beginRoundTrip(wm, { requestId: 'req-3', sentAt: Date.now() });
    assert(wm._roundTripStamps.size === 1, `expected the stamp to be held, got ${wm._roundTripStamps.size}`);
    sendToolsResult(wm, 'conv-1', 'req-3', []);
    assert(wm._roundTripStamps.size === 0, `expected the stamp to be released on reply, got ${wm._roundTripStamps.size}`);
  });

  // Inside the engine a request can wait on a load, a flush and every other
  // conversation's requests, and none of it is visible until the reply — long
  // enough, on a slow core, to look like a wedge. So the engine says when it
  // picked a request up and, while it holds it, that it is still working on
  // it; once answered, nothing more.
  await test('a request in flight is reported picked up and still being worked on, and an answered one is not', async () => {
    const wm = fakeWorkerManager();
    /** @type {Array<{conversationId: string, message: any}>} */
    const traces = [];
    const real = wsService.sendWorkerMessage;
    wsService.sendWorkerMessage = /** @type {any} */ ((/** @type {string} */ conversationId, /** @type {any} */ message) => {
      if (message?.type === 'engine-trace') traces.push({ conversationId, message });
    });
    try {
      beginRoundTrip(wm, { requestId: 'req-w', sentAt: Date.now() }, 'conv-w');
      assert(traces.length === 1 && traces[0].message.event === 'request-recv' && traces[0].conversationId === 'conv-w',
        `picking a request up is reported to its conversation; got ${JSON.stringify(traces)}`);
      sendRequestWorkingTraces(wm);
      assert(traces.length === 2 && traces[1].message.event === 'request-working' && traces[1].message.requestId === 'req-w',
        `a tick while it is held says it is still being worked on; got ${JSON.stringify(traces)}`);
      sendToolsResult(wm, 'conv-w', 'req-w', []);
      sendRequestWorkingTraces(wm);
      assert(traces.length === 2, `an answered request is not reported again; got ${JSON.stringify(traces)}`);
    } finally {
      wsService.sendWorkerMessage = real;
    }
  });

  await test('a reply nobody stamped is sent plainly rather than with junk stamps', async () => {
    const wm = fakeWorkerManager();
    sendToolsResult(wm, 'conv-1', 'never-seen', []);
    const reply = wm.sent[0];
    assert(reply.requestId === 'never-seen', `expected the reply to still be sent, got ${JSON.stringify(reply)}`);
    assert(
      reply.sentAt === undefined && reply.receivedAt === undefined && reply.repliedAt === undefined,
      `an unstamped reply must carry no timing fields, got ${JSON.stringify(reply)}`
    );
  });

  return { passed, failed, errors };
}
