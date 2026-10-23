//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Tests for `decideToolCall` (model/conversation-tool-actions.js): the approval
 * decision for one call, made without a tool-action item and without writing
 * anything. It is the same decision the engine's evaluate path writes into the
 * doc, so a caller that runs a tool outside the transcript (a program tool's
 * sub-call) is gated exactly as the call would be if the model made it.
 *
 * Contract under test, under YOLO's real approval policy:
 *   1. An ordinary write is approved.
 *   2. An elicitation (AskUserQuestion) parks: no strategy answers for the user.
 *   3. A non-auto-approvable call (plan submit) parks.
 *   4. A beforeTool hook that asks parks the call, naming the hook.
 *   5. A beforeTool hook that denies denies, with the hook's reason.
 *   6. An unknown tool and an invalid input are 'invalid', with the text the
 *      evaluate path would store.
 *   7. Nothing is written: the thread holds no new item afterwards.
 * @module unit-tests/tool-call-decision-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  assert
} from '../utilities/test-helpers.js';
import { decideToolCall } from '../../js/model/conversation-tool-actions.js';
import hookRegistry from '../../js/registries/hook-registry.js';
import HookType from 'juggler/hook-type';
import YoloStrategyType from '../../extensions/juggler-core/strategies/yolo-strategy-type.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Register hook classes for one test, run it, and put the registry back.
 * @param {Array<typeof HookType>} classes - Hooks to register
 * @param {() => Promise<void>} body - The test
 * @returns {Promise<void>}
 */
async function withHooks(classes, body) {
  await hookRegistry.init();
  for (const Cls of classes) {
    const outcome = hookRegistry.registerClass(Cls, { extensionId: 'tool-call-decision-test', modulePath: `/test/${Cls.MANIFEST.id}.js` });
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
 * A beforeTool hook answering every bash call with a fixed outcome.
 * @param {string} id - Hook id
 * @param {any} outcome - What beforeTool returns
 * @returns {typeof HookType} The class
 */
function bashHook(id, outcome) {
  return class extends HookType {
    static MANIFEST = { id, name: id, version: '1.0.0', description: `${id} test hook`, events: ['beforeTool'], match: { tools: ['bash'] } };
    beforeTool() { return outcome; }
  };
}

/**
 * Run all tool-call decision tests.
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

  /**
   * A conversation whose root thread runs YOLO's real approval policy.
   * @returns {Promise<{conversation: any, mt: any}>} The conversation and its root thread
   */
  const yoloConversation = async () => {
    const conversation = await createApprovalTestConversation(session);
    const mt = conversation.rootMessageThread;
    mt.strategy = { getApprovalPolicy: YoloStrategyType.prototype.getApprovalPolicy };
    return { conversation, mt };
  };

  /**
   * @param {any} conversation
   * @param {any} mt
   * @param {string} toolName
   * @param {Record<string, unknown>} toolInput
   * @returns {Promise<any>} The decision
   */
  const decide = (conversation, mt, toolName, toolInput) =>
    decideToolCall({ messageThread: mt, conversation, toolName, toolInput, toolUseId: `decide-${toolName}-${Math.random()}` });

  try {
    await test('an ordinary write is approved under YOLO', async () => {
      const { conversation, mt } = await yoloConversation();
      const before = mt.items.length;
      const d = await decide(conversation, mt, 'bash', { command: 'echo hi' });
      assert(d.verdict === 'approve', `expected approve, got ${d.verdict} (${d.reason})`);
      assert(mt.items.length === before, 'deciding must not write to the thread');
    });

    await test('an elicitation parks under YOLO', async () => {
      const { conversation, mt } = await yoloConversation();
      const d = await decide(conversation, mt, 'AskUserQuestion', {
        questions: [{ question: 'Which?', header: 'Pick', multiSelect: false,
          options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }]
      });
      assert(d.verdict === 'park', `expected park, got ${d.verdict} (${d.reason})`);
    });

    await test('a non-auto-approvable call parks under YOLO', async () => {
      const { conversation, mt } = await yoloConversation();
      const d = await decide(conversation, mt, 'plan', {
        action: 'submit', title: 'T', items: [{ content: 'step one' }]
      });
      assert(d.verdict === 'park', `expected park, got ${d.verdict} (${d.reason})`);
    });

    // An unattended run (juggler run) has nobody to answer, so a call that would
    // park is refused instead — the model gets an error result and carries on,
    // the way Claude Code -p denies one and codex exec rejects one — rather than
    // the run ending on a wait nobody will answer.
    await test('with nobody there an elicitation is refused, not parked', async () => {
      const { conversation, mt } = await yoloConversation();
      conversation.setUnattended(true);
      const d = await decide(conversation, mt, 'AskUserQuestion', {
        questions: [{ question: 'Which?', header: 'Pick', multiSelect: false,
          options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }]
      });
      assert(d.verdict === 'deny', `expected deny, got ${d.verdict} (${d.reason})`);
      assert(/nobody/i.test(String(d.reason)), `the reason should say nobody is there to answer, got ${d.reason}`);
    });

    await test('with nobody there a checkpoint is refused, not parked', async () => {
      const { conversation, mt } = await yoloConversation();
      conversation.setUnattended(true);
      const d = await decide(conversation, mt, 'plan', {
        action: 'submit', title: 'T', items: [{ content: 'step one' }]
      });
      assert(d.verdict === 'deny', `expected deny, got ${d.verdict} (${d.reason})`);
    });

    await test('with nobody there an ordinary write is still approved', async () => {
      const { conversation, mt } = await yoloConversation();
      conversation.setUnattended(true);
      const d = await decide(conversation, mt, 'bash', { command: 'echo hi' });
      assert(d.verdict === 'approve', `expected approve, got ${d.verdict} (${d.reason})`);
    });

    await test('a hook that asks parks the call and is named', () => withHooks([
      bashHook('asker', { verdict: 'ask', reason: 'look first' })
    ], async () => {
      const { conversation, mt } = await yoloConversation();
      const d = await decide(conversation, mt, 'bash', { command: 'echo hi' });
      assert(d.verdict === 'park', `expected park, got ${d.verdict}`);
      assert(String(d.reason).includes('asker'), `the reason should name the hook, got ${d.reason}`);
    }));

    await test('a hook that denies denies with its reason', () => withHooks([
      bashHook('denier', { verdict: 'deny', reason: 'not today' })
    ], async () => {
      const { conversation, mt } = await yoloConversation();
      const d = await decide(conversation, mt, 'bash', { command: 'echo hi' });
      assert(d.verdict === 'deny', `expected deny, got ${d.verdict}`);
      assert(d.reason === 'Blocked by hook "denier": not today', `unexpected reason: ${d.reason}`);
    }));

    await test('an unknown tool and an invalid input are invalid', async () => {
      const { conversation, mt } = await yoloConversation();
      const unknown = await decide(conversation, mt, 'no_such_tool', {});
      assert(unknown.verdict === 'invalid' && unknown.reason === 'Unknown tool: no_such_tool',
        `unknown tool: ${unknown.verdict} ${unknown.reason}`);
      const bad = await decide(conversation, mt, 'AskUserQuestion', {});
      assert(bad.verdict === 'invalid' && bad.reason === 'Missing required parameter: questions',
        `invalid input: ${bad.verdict} ${bad.reason}`);
    });
  } finally {
    /** @type {any} */ (globalThis).JUGGLER_ENGINE = prevEngine;
  }

  return { passed, failed, errors };
}
