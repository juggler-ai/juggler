//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tests that a tool-action's result is terminal on the engine side, and that
 * evaluating a tool is idempotent.
 *
 * The result is what the model is told about a call. Once one is written the
 * call is over, whatever `state` says — and the two can disagree: the worker
 * escalates a stuck tool by writing state=completed with an error result, and an
 * engine write of state=approved made concurrently can win the `state` key (Yjs
 * orders concurrent writes by client id, not by time). The engine must then
 * neither run the tool nor rule on it again, or a tool already reported to the
 * model as failed goes on to run.
 *
 * Contract under test:
 *   1. execute-tool for a call that carries a result claims nothing and runs
 *      nothing, and says why (execute-noact 'has-result'); claimRunning alone
 *      refuses it too.
 *   2. evaluate-tool for a call already past evaluation, or carrying a result,
 *      runs no hook and writes nothing, and says why (evaluate-noact
 *      'already-evaluated').
 *   3. A result that lands while an evaluation is in flight stands: the deny,
 *      approve and park writes that evaluation would have made are all dropped.
 * @module unit-tests/tool-result-terminal-test
 */

import {
  initializeRegistries,
  createTestSession,
  createGateTestConversation,
  assert,
  waitFor
} from '../utilities/test-helpers.js';
import { handleNewToolAction, claimRunning } from '../../js/model/conversation-tool-actions.js';
import { createToolActionMessage, TOOL_STATES } from '../../sdk/lib/message.js';
import { handleEvaluateTool, handleExecuteTool } from '../../js/services/worker-manager-protocols.js';
import actionExecutor from '../../js/services/action-executor.js';
import wsService from '../../js/services/websocket.js';
import hookRegistry from '../../js/registries/hook-registry.js';
import HookType from 'juggler/hook-type';
import * as Y from '../../js/vendor/yjs.mjs';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/** The error result an escalation writes. */
const ESCALATED = 'Couldn\'t run this tool: the engine never answered for it.';

/**
 * Insert a tool-action, optionally at a state and carrying a result.
 * @param {any} conversation - Test conversation
 * @param {string} toolUseId - Unique tool-use id
 * @param {{toolName?: string, toolInput?: Record<string, unknown>, state?: string, result?: boolean}} [opts]
 * @returns {any} The tool-action Y.Map
 */
function insertTool(conversation, toolUseId, { toolName = 'bash', toolInput = { command: 'echo hi' }, state = '', result = false } = {}) {
  const mt = conversation.rootMessageThread;
  mt.addEvent(createToolActionMessage({ toolUseId, toolName, toolInput }));
  const ymap = mt.getToolAction(toolUseId);
  conversation._doc.doc.transact(() => {
    if (state) ymap.set('state', state);
    if (result) writeEscalatedResult(ymap);
  });
  return ymap;
}

/**
 * Write the worker's escalation result onto a tool-action, leaving its state
 * alone — the shape a lost `state` write leaves behind.
 * @param {any} ymap - Tool-action Y.Map
 */
function writeEscalatedResult(ymap) {
  const r = new Y.Map();
  r.set('content', ESCALATED);
  r.set('isError', true);
  ymap.set('result', r);
}

/**
 * The result content a tool-action carries.
 * @param {any} ymap - Tool-action Y.Map
 * @returns {unknown} Its content
 */
function resultContent(ymap) {
  const r = ymap.get('result');
  return r?.get ? r.get('content') : r?.content;
}

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
  // Only traces are kept back; everything else reaches the server as normal,
  // since creating and loading a conversation goes through the same call.
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
 * Register hook classes for one test, run it, and put the registry back.
 * @param {Array<typeof HookType>} classes - Hooks to register
 * @param {() => Promise<void>} body - The test
 * @returns {Promise<void>}
 */
async function withHooks(classes, body) {
  await hookRegistry.init();
  for (const Cls of classes) {
    const outcome = hookRegistry.registerClass(Cls, { extensionId: 'tool-result-terminal-test', modulePath: `/test/${Cls.MANIFEST.id}.js` });
    assert(outcome.registered, `test hook ${Cls.MANIFEST.id} should register: ${outcome.reason}`);
  }
  try {
    await body();
  } finally {
    hookRegistry.reset();
    await hookRegistry.init();
  }
}

/**
 * A beforeTool hook that calls fn and answers with what it returns.
 * @param {string} id - Hook id
 * @param {(ctx: any) => any} fn - The hook body
 * @returns {typeof HookType} The class
 */
function beforeHook(id, fn) {
  return class extends HookType {
    static MANIFEST = { id, name: id, version: '1.0.0', description: `${id} test hook`, events: ['beforeTool'] };
    beforeTool(/** @type {any} */ ctx) {
      return fn(ctx);
    }
  };
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
    }
  };

  try {
    // 1. execute-tool never claims or runs a call that carries a result
    await test('execute refuses a call with a result', () => withTraces(async (traces) => {
      const conversation = await createGateTestConversation(session);
      const id = 'result-terminal-exec-1';
      // A read-only command, so the failure this guards against is harmless here.
      const ymap = insertTool(conversation, id, { state: TOOL_STATES.APPROVED, result: true, toolInput: { command: 'echo ran' } });

      const running = handleExecuteTool(engineWm(session, conversation), conversation.id, id, null);
      try {
        await waitFor(() => traces.some(t => t.toolUseId === id && (t.event === 'execute-noact' || t.event === 'execute-claim')),
          'execute-tool to answer', 4000);
        const answer = traces.find(t => t.toolUseId === id && (t.event === 'execute-noact' || t.event === 'execute-claim'));
        assert(answer.event === 'execute-noact' && answer.reason === 'has-result',
          `a call with a result must be declined as 'has-result', got ${JSON.stringify(answer)}`);
        assert(ymap.get('state') === TOOL_STATES.APPROVED, `the call must not be claimed, got state ${ymap.get('state')}`);
        assert(!ymap.get('runningEpoch'), 'the call must not have been given a run');
        assert(actionExecutor.executingSetFor(conversation.id).length === 0, 'nothing may be executing for the conversation');
        assert(resultContent(ymap) === ESCALATED, `the result the model was told must stand, got ${JSON.stringify(resultContent(ymap))}`);
      } finally {
        actionExecutor.cancelAllActions();
        await running.catch(() => {});
      }

      assert(claimRunning(conversation, ymap) === false, 'claimRunning must refuse a call with a result');
      assert(ymap.get('state') === TOOL_STATES.APPROVED, 'a refused claim writes nothing');
    }));

    // 2. evaluate-tool is idempotent: a call past evaluation, or with a result,
    //    runs no hook and has nothing written to it
    for (const [name, opts] of /** @type {Array<[string, {state: string, result: boolean}]>} */ ([
      ['already approved', { state: TOOL_STATES.APPROVED, result: false }],
      ['already completed', { state: TOOL_STATES.COMPLETED, result: true }],
      ['unevaluated but carrying a result', { state: '', result: true }],
      ['approved and carrying a result', { state: TOOL_STATES.APPROVED, result: true }]
    ])) {
      await test(`evaluate is a no-op for a call ${name}`, () => {
        let hookRuns = 0;
        return withHooks([beforeHook('count-runs', () => { hookRuns++; return { verdict: 'deny', reason: 'no' }; })],
          () => withTraces(async (traces) => {
            const conversation = await createGateTestConversation(session);
            const mt = conversation.rootMessageThread;
            /** @type {any} */ (mt).strategy = { getApprovalPolicy: () => 'approve' };
            const id = `result-terminal-eval-${name.replace(/\W+/g, '-')}`;
            const ymap = insertTool(conversation, id, opts);
            const before = JSON.stringify(ymap.toJSON());

            await handleEvaluateTool(engineWm(session, conversation), conversation.id, id);

            assert(hookRuns === 0, `no hook may run for a call already evaluated, ran ${hookRuns}`);
            assert(JSON.stringify(ymap.toJSON()) === before,
              `nothing may be written to it:\n  before ${before}\n  after  ${JSON.stringify(ymap.toJSON())}`);
            const noact = traces.find(t => t.toolUseId === id && t.event === 'evaluate-noact');
            assert(noact?.reason === 'already-evaluated',
              `the decline must be traced as 'already-evaluated', got ${JSON.stringify(traces.filter(t => t.toolUseId === id))}`);
            assert(!traces.some(t => t.toolUseId === id && t.event === 'evaluate-done'), 'a declined evaluate is not an evaluation');
          }));
      });
    }

    // 3. a result that lands while the evaluation awaits its hooks stands
    for (const verdict of ['deny', 'allow', 'ask']) {
      await test(`a result landing mid-evaluation stands (hook ${verdict})`, async () => {
        const conversation = await createGateTestConversation(session);
        const mt = conversation.rootMessageThread;
        /** @type {any} */ (mt).strategy = { getApprovalPolicy: () => 'default' };
        const id = `result-terminal-mid-${verdict}`;
        /** @type {any} */
        let ymap = null;
        await withHooks([beforeHook(`land-${verdict}`, () => {
          // The escalation's result arrives; its state write lost to nothing yet.
          conversation._doc.doc.transact(() => writeEscalatedResult(ymap));
          return { verdict, reason: 'test' };
        })], async () => {
          ymap = insertTool(conversation, id);
          await handleNewToolAction(mt, id, conversation);
        });
        assert(resultContent(ymap) === ESCALATED, `the landed result must not be overwritten, got ${JSON.stringify(resultContent(ymap))}`);
        assert((ymap.get('state') ?? '') === '', `the evaluation must not move a call with a result, got state ${ymap.get('state')}`);
        for (const key of ['approvalSource', 'approvalOptions', 'reviewStatus', 'hooks']) {
          assert(ymap.get(key) === undefined || ymap.get(key) === null, `the evaluation must not write ${key} onto a call with a result`);
        }
      });
    }
  } finally {
    /** @type {any} */ (globalThis).JUGGLER_ENGINE = prevEngine;
  }

  return { passed, failed, errors };
}
