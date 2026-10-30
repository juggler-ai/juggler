//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tests the engine's repair of a worker that commands `execute-tool` for a tool
 * this engine has already moved past `approved`.
 *
 * Such a command means one of two things. The worker may simply be slow: the
 * engine's write is already queued at it, and the command was dispatched before
 * it got there. Or the worker may genuinely lack the write. Every tool command
 * carries the worker's state vector, which tells the two apart, and only the
 * second is repaired — with just the ops the worker lacks, never the whole
 * document, which on a large conversation is tens of megabytes the worker must
 * decode and save while it is already behind.
 *
 * Contract under test:
 *   1. A stale command — the worker's vector covers every op this engine holds —
 *      sends nothing, and says so (engine-trace 'stale-command').
 *   2. A divergent command sends one yjs-sync holding only the missing ops, far
 *      smaller than full state, that brings the worker up to date
 *      ('resync-diverged', with its size).
 *   3. Re-driven commands for that tool sent before the repair lands send
 *      nothing more; once the worker holds the repair, a fresh divergence is
 *      repaired again.
 * @module unit-tests/tool-command-resync-test
 */

import {
  initializeRegistries,
  createTestSession,
  createGateTestConversation,
  assert
} from '../utilities/test-helpers.js';
import { createToolActionMessage, TOOL_STATES } from '../../sdk/lib/message.js';
import { handleExecuteTool } from '../../js/services/worker-manager-protocols.js';
import actionExecutor from '../../js/services/action-executor.js';
import wsService from '../../js/services/websocket.js';
import * as Y from '../../js/vendor/yjs.mjs';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/** Bulk that makes full state expensive, as a long conversation's history is. */
const PADDING = 'x'.repeat(64 * 1024);

/**
 * A WorkerManager stand-in that resolves the one conversation under test.
 * @param {any} session - Test session
 * @param {any} conversation - The conversation
 * @returns {any} The stand-in
 */
function engineWm(session, conversation) {
  return {
    _session: session,
    loader: { pendingAutoLoad: () => null, loadExisting: async () => conversation },
    sendToWorker: () => {}
  };
}

/**
 * Capture the engine traces sent while body runs.
 * @param {(traces: any[]) => Promise<void>} body - The test, handed the live list
 * @returns {Promise<void>}
 */
async function withTraces(body) {
  const ws = /** @type {any} */ (wsService);
  const original = ws.sendWorkerMessage;
  /** @type {any[]} */
  const traces = [];
  ws.sendWorkerMessage = (/** @type {string} */ cid, /** @type {any} */ msg, /** @type {any[]} */ ...rest) => {
    if (msg?.type === 'engine-trace') {
      traces.push(msg);
      return undefined;
    }
    return original.call(ws, cid, msg, ...rest);
  };
  try {
    await body(traces);
  } finally {
    ws.sendWorkerMessage = original;
  }
}

/**
 * A conversation holding a bulky history and one tool-action at `approved`,
 * a worker replica that holds exactly that, and then the engine's claim of the
 * tool (`running`) written on the engine's side only. Every update the engine
 * sends its worker by broadcast — full state or a delta — is captured; the
 * doc's live per-edit forwarding is detached, since the test session's real
 * worker goes on writing to this conversation and those writes are not what is
 * under test.
 * @param {any} session - Test session
 * @param {string} toolUseId - The tool's id
 * @returns {Promise<{conversation: any, worker: Y.Doc, ymap: any, syncs: Uint8Array[]}>} The
 *   conversation, the worker replica, the tool-action, and the captured updates
 */
async function engineAheadOfWorker(session, toolUseId) {
  const conversation = await createGateTestConversation(session);
  /** @type {Uint8Array[]} */
  const syncs = [];
  conversation._doc.setOnSyncBroadcast((/** @type {Uint8Array} */ update) => { syncs.push(update); });
  const doc = conversation._doc.doc;
  doc.off('update', conversation._doc._syncManager._updateHandler);
  doc.getMap('test-padding').set('history', PADDING);
  const mt = conversation.rootMessageThread;
  mt.addEvent(createToolActionMessage({ toolUseId, toolName: 'bash', toolInput: { command: 'echo hi' } }));
  const ymap = /** @type {any} */ (mt.getToolAction(toolUseId));
  doc.transact(() => ymap.set('state', TOOL_STATES.APPROVED));
  const worker = new Y.Doc();
  Y.applyUpdate(worker, Y.encodeStateAsUpdate(doc));
  doc.transact(() => ymap.set('state', TOOL_STATES.RUNNING));
  syncs.length = 0;
  return { conversation, worker, ymap, syncs };
}

/**
 * Clock headroom given to clients other than the engine in a worker's vector.
 * Those are the test session's real worker, still writing to the conversation;
 * the real worker holds its own writes by definition, so its vector covers them
 * however many land while a command is being handled.
 */
const WORKER_OWN_HEADROOM = 1_000_000;

/**
 * The vector the worker would send with a command: the replica's, plus every
 * write by a client other than this engine.
 * @param {Y.Doc} worker - The replica
 * @param {any} conversation - The conversation the engine holds
 * @returns {Uint8Array} The encoded state vector
 */
function workerVector(worker, conversation) {
  const doc = conversation._doc.doc;
  const vector = Y.decodeStateVector(Y.encodeStateVector(worker));
  for (const [client, clock] of Y.decodeStateVector(Y.encodeStateVector(doc))) {
    if (client !== doc.clientID) vector.set(client, Math.max(vector.get(client) ?? 0, clock + WORKER_OWN_HEADROOM));
  }
  return Y.encodeStateVector(vector);
}

/**
 * How many of this engine's own ops the worker replica still lacks — 0 when
 * it holds every struct the engine wrote.
 * @param {Y.Doc} worker - The replica
 * @param {any} conversation - The conversation the engine holds
 * @returns {number} Missing ops
 */
function workerLacks(worker, conversation) {
  const doc = conversation._doc.doc;
  const engineClock = Y.decodeStateVector(Y.encodeStateVector(doc)).get(doc.clientID) ?? 0;
  const held = Y.decodeStateVector(Y.encodeStateVector(worker)).get(doc.clientID) ?? 0;
  return Math.max(0, engineClock - held);
}

/**
 * Run all tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();

  const prevEngine = /** @type {any} */ (globalThis).JUGGLER_ENGINE;
  /** @type {any} */ (globalThis).JUGGLER_ENGINE = true;

  /**
   * @param {string} name
   * @param {() => Promise<void>} fn
   */
  const test = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      actionExecutor.cancelAllActions();
    }
  };

  try {
    // 1. a stale command: the worker already holds the claim
    await test('a stale execute-tool sends nothing', () => withTraces(async (traces) => {
      const id = 'resync-stale-1';
      const { conversation, worker, ymap, syncs } = await engineAheadOfWorker(session, id);
      // The engine's write is already at the worker; the command predates it.
      Y.applyUpdate(worker, Y.encodeStateAsUpdate(conversation._doc.doc));

      await handleExecuteTool(engineWm(session, conversation), conversation.id, id, workerVector(worker, conversation));

      assert(syncs.length === 0,
        `a worker that already holds everything must be sent nothing, sent ${syncs.length} update(s) of ${syncs.map(s => s.length).join(', ')} bytes`);
      assert(traces.some(t => t.toolUseId === id && t.event === 'stale-command'),
        `the stale command must be traced, got ${JSON.stringify(traces.filter(t => t.toolUseId === id).map(t => t.event))}`);
      assert(ymap.get('state') === TOOL_STATES.RUNNING, 'the tool is left as the engine had it');
    }));

    // 2 + 3. a divergent command: one small delta, not repeated while in transit
    await test('a divergent execute-tool sends one delta, once', () => withTraces(async (traces) => {
      const id = 'resync-diverged-1';
      const { conversation, worker, syncs } = await engineAheadOfWorker(session, id);
      const fullState = Y.encodeStateAsUpdate(conversation._doc.doc).length;
      const vector = workerVector(worker, conversation);
      const wm = engineWm(session, conversation);

      // The worker re-drives on its own clock, carrying the same vector each
      // time until the repair reaches it.
      for (let i = 0; i < 3; i++) {
        await handleExecuteTool(wm, conversation.id, id, vector);
      }

      const repair = syncs[0];
      if (syncs.length !== 1 || !repair) {
        throw new Error(`re-driven commands before the repair lands must send exactly one repair, sent ${syncs.length} of ${syncs.map(s => s.length).join(', ')} bytes`);
      }
      assert(repair.length * 10 < fullState,
        `the repair must be a delta, not the document: ${repair.length} bytes against ${fullState} of full state`);
      Y.applyUpdate(worker, repair);
      assert(workerLacks(worker, conversation) === 0,
        `the repair must bring the worker every op it lacked, still missing ${workerLacks(worker, conversation)} op(s)`);
      const repaired = traces.find(t => t.toolUseId === id && t.event === 'resync-diverged');
      assert(repaired?.bytes === repair.length,
        `the repair must be traced with its size, got ${JSON.stringify(repaired)}`);

      // The worker holds the repair. A fresh divergence — an engine write that
      // missed it — is repaired in its turn, with that write alone.
      const ymap = /** @type {any} */ (conversation.rootMessageThread.getToolAction(id));
      conversation._doc.doc.transact(() => ymap.set('state', TOOL_STATES.COMPLETED));
      await handleExecuteTool(wm, conversation.id, id, workerVector(worker, conversation));
      const second = syncs[1];
      const total = /** @type {number} */ (syncs.length);
      if (total !== 2 || !second) {
        throw new Error(`a new divergence after the repair landed must be repaired, sent ${total} in all`);
      }
      assert(second.length * 10 < fullState, `the second repair must be a delta too, ${second.length} bytes`);
      Y.applyUpdate(worker, second);
      assert(workerLacks(worker, conversation) === 0,
        `the second repair must carry the later write, still missing ${workerLacks(worker, conversation)} op(s)`);
    }));
  } finally {
    /** @type {any} */ (globalThis).JUGGLER_ENGINE = prevEngine;
  }

  return { passed, failed, errors };
}
