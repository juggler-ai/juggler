//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Strategy guidance-injection tests.
 *
 * Strategies no longer author system-prompt text; they steer the model by
 * injecting durable system-reminder messages into the conversation. These tests
 * pin that mechanism end-to-end against a real Yjs-backed message thread:
 *
 *  1. StrategyType.injectGuidance writes a system-reminder item (sourced from
 *     the strategy id) that lands in the thread's messages.
 *  2. Read-only's onActivate injects the read-only notice.
 *  3. What onActivate injects is the class's declared `static GUIDANCE`, byte
 *     for byte — the property the Extensions pane relies on when it shows a
 *     strategy's guidance to the user as what the model was sent.
 *  4. An activation run the way the worker asks for it (handleRunStrategyHook)
 *     that leaves a strategy which declared guidance tells the model that
 *     guidance has lapsed — else Chat's "you cannot read the project" outlives
 *     a switch back to Default.
 *
 * The worker-path delivery of these items to the LLM is pinned separately by
 * the Go tests TestInjectedSystemReminderReachesMessages / ...Guidance.
 * @module unit-tests/strategy-injection-test
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';
import strategyRegistry from '../../js/registries/strategy-registry.js';
import { handleRunStrategyHook } from '../../js/services/worker-manager-protocols.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Collect the system-reminder messages on a message thread.
 * @param {any} messageThread - The thread to inspect
 * @returns {Array<{content: string, source: string|undefined}>} System-reminder messages
 */
function systemReminders(messageThread) {
  return messageThread.getMessages()
    .filter((/** @type {any} */ m) => m.get('type') === 'system-reminder')
    .map((/** @type {any} */ m) => ({ content: m.get('content'), source: m.get('source') }));
}

/**
 * Run a root-thread onActivate the way the worker asks for one, in the engine
 * realm the handler demands, and return the guidance the engine sent back.
 * @param {any} conversation - The conversation to activate on
 * @param {string} strategyId - The strategy being switched to
 * @param {string} previousStrategyId - The strategy last activated
 * @returns {Promise<Array<{content: string, source?: string}>>} The guidance sent to the worker
 */
async function runActivateAsEngine(conversation, strategyId, previousStrategyId) {
  /** @type {Array<{content: string, source?: string}>} */
  let sent = [];
  const wm = {
    _session: conversation.session,
    sendToWorker: (/** @type {string} */ _id, /** @type {any} */ msg) => { sent = msg.guidance; }
  };
  const g = /** @type {any} */ (globalThis);
  const had = Object.prototype.hasOwnProperty.call(g, 'JUGGLER_ENGINE');
  const saved = g.JUGGLER_ENGINE;
  g.JUGGLER_ENGINE = true;
  try {
    await handleRunStrategyHook(wm, conversation.id, {
      hook: 'onActivate', strategyId, threadItemId: '', requestId: 'probe', previousStrategyId
    });
  } finally {
    if (had) g.JUGGLER_ENGINE = saved; else delete g.JUGGLER_ENGINE;
  }
  return sent;
}

/**
 * Run strategy-injection tests.
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

  await initializeRegistries();
  const session = await createTestSession();

  await test('injectGuidance writes a system-reminder sourced from the strategy id', async () => {
    const conversation = await createTestConversation(session);
    const mt = conversation.rootMessageThread;
    const strategy = strategyRegistry.createStrategy('default', mt);
    strategy.injectGuidance('PROBE-GUIDANCE-TEXT');

    const reminders = systemReminders(mt);
    const probe = reminders.find(r => r.content === 'PROBE-GUIDANCE-TEXT');
    assert(!!probe, `injected system-reminder should be present; reminders=${JSON.stringify(reminders)}`);
    assert(probe.source === 'default', `source should default to the strategy id 'default', got '${probe.source}'`);
  });

  await test('injectGuidance honours an explicit source', async () => {
    const conversation = await createTestConversation(session);
    const mt = conversation.rootMessageThread;
    const strategy = strategyRegistry.createStrategy('default', mt);
    strategy.injectGuidance('SOURCED', { source: 'custom-src' });

    const probe = systemReminders(mt).find(r => r.content === 'SOURCED');
    assert(!!probe, 'sourced reminder should be present');
    assert(probe.source === 'custom-src', `explicit source should win, got '${probe.source}'`);
  });

  await test('read-only onActivate injects the read-only notice', async () => {
    const conversation = await createTestConversation(session);
    const mt = conversation.rootMessageThread;
    const strategy = strategyRegistry.createStrategy('read-only', mt);
    strategy.onActivate('default');

    const reminders = systemReminders(mt);
    const notice = reminders.find(r => /READ-ONLY MODE/.test(r.content) && /read-only/.test(r.content));
    assert(!!notice, `read-only notice should be injected; reminders=${JSON.stringify(reminders)}`);
    assert(notice.source === 'read-only', `notice source should be 'read-only', got '${notice.source}'`);
  });

  await test('onActivate injects the declared GUIDANCE verbatim', async () => {
    const conversation = await createTestConversation(session);
    const mt = conversation.rootMessageThread;
    const declared = /** @type {any} */ (strategyRegistry.get('read-only')).GUIDANCE;
    strategyRegistry.createStrategy('read-only', mt).onActivate('default');

    const contents = systemReminders(mt).map(r => r.content);
    assert(contents.includes(declared),
      `injected text must be the declared GUIDANCE byte for byte (the Extensions pane shows that `
      + `string as what the model was sent); declared=${JSON.stringify(declared)} injected=${JSON.stringify(contents)}`);
  });

  await test('a strategy declaring no guidance injects nothing', async () => {
    const conversation = await createTestConversation(session);
    const mt = conversation.rootMessageThread;
    assert(!(/** @type {any} */ (strategyRegistry.get('default')).GUIDANCE),
      'default must declare no guidance — the pane says so, so it has to be true');
    strategyRegistry.createStrategy('default', mt).onActivate('read-only');
    assert(systemReminders(mt).length === 0, 'default strategy onActivate must inject nothing');
  });

  await test('leaving a strategy that declared guidance tells the model it no longer applies', async () => {
    const conversation = await createTestConversation(session);
    const sent = await runActivateAsEngine(conversation, 'default', 'read-only');
    assert(sent.length === 1, `one notice expected for read-only → default, got ${JSON.stringify(sent)}`);
    assert(/Read-only/.test(sent[0].content) && /no longer appl/.test(sent[0].content),
      `the notice must name the strategy left and say its instructions lapse; got ${JSON.stringify(sent[0].content)}`);
    assert(/Default/.test(sent[0].content), `the notice must name the strategy now active; got ${JSON.stringify(sent[0].content)}`);
  });

  await test('entering from a strategy that declared nothing sends only the new guidance', async () => {
    const conversation = await createTestConversation(session);
    const declared = /** @type {any} */ (strategyRegistry.get('read-only')).GUIDANCE;
    const sent = await runActivateAsEngine(conversation, 'read-only', 'default');
    assert(sent.length === 1 && sent[0].content === declared,
      `default → read-only must send read-only's GUIDANCE alone; got ${JSON.stringify(sent)}`);
  });

  return { passed, failed, errors };
}
