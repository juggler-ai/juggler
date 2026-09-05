//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Releasing a conversation the engine has no further reason to hold.
 *
 * The engine loads a conversation lazily — the first time a worker syncs one to
 * it — and used to keep it for the process lifetime: the Yjs document, its
 * observers and the worker entry, across project switches, including
 * conversations the user had deleted or binned long ago. That is unbounded
 * growth in the one realm that must stay responsive, and a WebView that has
 * exhausted its memory presents exactly like a wedged realm.
 *
 * Session.releaseConversation is the teardown; engine-app.js drives it from the
 * `deleted` / `binned` / `binned-deleted` ops of conversations-changed, which the
 * engine had ignored wholesale. All the risk is in the teardown — releasing a
 * conversation with work still in flight, or reaching past it into another
 * conversation's — so that is what these cover.
 *
 * The in-flight tool is a fixture item that parks on its abort signal rather than
 * a real read tool: what is under test is WHICH executions a release aborts, and
 * a fixture makes that exact instead of dependent on an op's timing.
 * @module unit-tests/conversation-release
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';
import ContextItem from 'juggler/context-item';
import contextItemRegistry from '../../js/registries/context-item-registry.js';
import actionExecutor from '../../js/services/action-executor.js';
import workerManager from '../../js/services/worker-manager.js';
import apiService from '../../js/services/api.js';
import { budgetFor } from '../utilities/test-deadline.js';

const PROBE_ID = 'conversation-release-probe';

/**
 * A tool that starts and never finishes on its own — it settles only when its
 * abort signal fires. Exactly the shape of execution a release has to deal with,
 * with none of a real tool's timing.
 */
class HangingProbeItem extends ContextItem {
  static MANIFEST = {
    id: PROBE_ID,
    name: 'Hanging Probe',
    version: '1.0.0',
    description: 'Fixture: an execution that settles only when cancelled.',
    author: 'Juggler Team',
    contextPosition: 'system'
  };

  /** @returns {boolean} Never seeded; the tests drive it through the executor. */
  static shouldAutoInstantiate() {
    return false;
  }

  /**
   * @param {Record<string, any>} toolInput - Tool params
   * @returns {{valid: true, params: Record<string, any>}} Always valid
   */
  prepare(toolInput) {
    return { valid: true, params: toolInput };
  }

  /** @returns {boolean} Never needs approval — the tests drive it directly. */
  requiresApproval() {
    return false;
  }

  /**
   * @param {{success?: boolean, error?: string}} outcome - Execution outcome
   * @returns {{summary: string, success: boolean}} Display summary
   */
  getSummary(outcome) {
    return {
      summary: outcome?.success ? 'probe done' : (outcome?.error || 'probe cancelled'),
      success: !!outcome?.success
    };
  }

  /**
   * @param {Record<string, any>} _params - Validated params (unused)
   * @returns {Promise<never>} Never resolves; rejects when the signal aborts
   */
  execute(_params) {
    return new Promise((_resolve, reject) => {
      const signal = /** @type {AbortSignal|undefined} */ (this.signal);
      const onAbort = () => reject(new DOMException('The operation was aborted.', 'AbortError'));
      if (!signal) return;
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    });
  }
}

/**
 * Put one hanging execution in flight for a conversation, and resolve once the
 * executor is tracking it. The tracking entry appears a few microtasks in —
 * ActionExecutor.execute awaits the registry module before registering — so the
 * caller has to wait for it rather than assume it.
 *
 * The execution comes back WRAPPED, and must: returning a promise from an async
 * function adopts it, so a bare `return run` would make this helper wait for the
 * very execution it exists to leave parked.
 * @param {any} session
 * @param {any} conversation
 * @param {string} toolUseId
 * @returns {Promise<{run: Promise<any>}>} The in-flight execution, wrapped
 */
async function startHangingTool(session, conversation, toolUseId) {
  const run = actionExecutor.execute(
    PROBE_ID, {},
    {
      session,
      conversation,
      messageThread: conversation.rootMessageThread,
      toolUseId,
      _approvalHandled: true
    }
  );
  // The probe parks until something aborts it, and a caller that gives up leaves
  // it rejecting with nobody attached. Claim it here so an abandoned probe can
  // never surface as an unhandled rejection in the lane.
  run.catch(() => {});
  const deadline = Date.now() + budgetFor(4000);
  while (actionExecutor.executingSetFor(conversation.id).every((e) => e.toolUseId !== toolUseId)) {
    if (Date.now() > deadline) throw new Error(`the probe for ${toolUseId} never reached the executor`);
    await new Promise((r) => { setTimeout(r, 5); });
  }
  return { run };
}

/**
 * Remove a conversation from the server. Used for conversations this test has
 * RELEASED: they are gone from the session map and so out of reach of
 * Session.deleteConversation, but the lane's leak check counts them regardless.
 * @param {string} id - Conversation to delete
 * @returns {Promise<void>} Resolves once the delete has been attempted
 */
async function deleteOnServer(id) {
  try {
    await apiService.deleteConversation(id, { reason: 'conversation-release:cleanup' });
  } catch (err) {
    console.warn(`[conversation-release] Couldn't delete ${id}:`, err);
  }
}

/**
 * Reject if a promise has not settled within `ms`, so a regression fails the
 * test rather than hanging the lane to its 60s budget.
 * @param {Promise<any>} p - The promise under test
 * @param {number} ms - Patience budget
 * @param {string} what - Message for the timeout
 * @returns {Promise<any>} p's settlement
 */
function within(p, ms, what) {
  return Promise.race([
    p,
    new Promise((_r, rej) => setTimeout(() => rej(new Error(what)), ms))
  ]);
}

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run all conversation-release tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results with pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();
  const registered = contextItemRegistry.registerClass(HangingProbeItem, { modulePath: '(test)' });
  assert(registered.registered === true, `fixture must register; got: ${registered.reason}`);

  // Test 1: releasing a held conversation drops it from the session map and
  // terminates its worker entry, so nothing keeps the document or its observers
  // alive. An id this realm does not hold is a no-op, not an error — the engine
  // is told about every conversation's removal and holds almost none of them.
  {
    /** @type {string|null} */
    let created = null;
    try {
      const conv = await createTestConversation(session);
      created = conv.id;
      assert(session.conversations.has(created), 'precondition: the session holds the conversation');
      assert(workerManager.hasWorker(created), 'precondition: the conversation has a worker entry');

      const released = await within(session.releaseConversation(created), 8000, 'releaseConversation never settled');
      assert(released === true, 'releasing a held conversation must report that it did');
      assert(!session.conversations.has(created),
        'a released conversation must leave the session map — otherwise the engine keeps every conversation it was ever synced');
      assert(!workerManager.hasWorker(created), 'a released conversation must leave no worker entry behind');

      const again = await session.releaseConversation(created);
      assert(again === false, 'releasing an id this realm does not hold must be a no-op');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`release drops the conversation: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (created) await deleteOnServer(created);
    }
  }

  // Test 2: release cancels the conversation's in-flight work, and touches no
  // other conversation's. The executor is engine-wide and spans every loaded
  // conversation, so a release that cancelled by tool id — or cancelled the lot —
  // would abort tools belonging to conversations the user is still using.
  {
    /** @type {string[]} */
    const created = [];
    try {
      const doomed = await createTestConversation(session);
      created.push(doomed.id);
      const survivor = await createTestConversation(session);
      created.push(survivor.id);

      const { run: doomedRun } = await startHangingTool(session, doomed, 'rel-doomed');
      const { run: survivorRun } = await startHangingTool(session, survivor, 'rel-survivor');
      assert(actionExecutor.executingSetFor(doomed.id).length === 1, 'precondition: the doomed conversation has work in flight');
      assert(actionExecutor.executingSetFor(survivor.id).length === 1, 'precondition: the survivor has work in flight');

      await within(session.releaseConversation(doomed.id), 8000, 'releaseConversation never settled');

      const doomedResult = await within(doomedRun, 4000,
        'the released conversation\'s tool never settled — it runs on into a destroyed document');
      assert(doomedResult.success === false, 'work abandoned with its conversation must settle as unsuccessful');
      assert(actionExecutor.executingSetFor(doomed.id).length === 0, 'the released conversation must have no work left in flight');

      assert(actionExecutor.executingSetFor(survivor.id).length === 1,
        'releasing one conversation must not disturb another conversation\'s in-flight tools');

      actionExecutor.cancelByToolUseId('rel-survivor', survivor.id);
      await within(survivorRun, 4000, 'the survivor\'s tool never settled after its own cancel');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`release cancels only its own in-flight work: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      actionExecutor.cancelAllActions();
      for (const id of created) await deleteOnServer(id);
    }
  }

  return { passed, failed, errors };
}
