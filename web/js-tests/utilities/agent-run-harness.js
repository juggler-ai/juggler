//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What the agent-run suites share: a scripted model, run names no other run
 * has, `runAgent` bounded by the test's deadline rather than by a fixed span
 * ({@link run}) — so a run on a slow core is waited for and a stuck one is not —
 * and the case loop around a carrier conversation.
 *
 * Each run's model is scripted through the carrier's worker
 * (`queue-mocks-for-name`): the run's worker adopts the queue at init by its
 * exact conversation name, so every run is given a name of its own.
 * @module js-tests/utilities/agent-run-harness
 */

import { runAgent } from '../../sdk/ops.js';
import { budgetFor, deadlineTimer, noteCaseFinished, noteProgress } from './test-deadline.js';
import workerManager from '../../js/services/worker-manager.js';
import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  releaseTestConversation
} from './test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * What a suite's body is handed.
 * @typedef {object} AgentRunSuite
 * @property {(name: string, fn: () => Promise<void>) => Promise<void>} test - Run one case, counting it finished whichever way it ends
 * @property {(name: string, responses: object[]) => Promise<void>} script - Script the model of the run that will be named `name`
 * @property {import('../../js/model/session.js').default} session - This realm's session
 */

/** The scripted model every run uses. */
export const MODEL = { provider: 'test-provider', model: 'test-model' };

/**
 * A run's nominal wait. Only its share of the test's deadline is meant: the
 * wait follows that deadline as the runner moves it for a suite still making
 * progress, so a slow core is waited for and a stuck run is not.
 */
const RUN_NOMINAL_MS = 30000;

let nameCounter = 0;

/**
 * A conversation name no other run, here or in another lane, has.
 * @param {string} label - What the run is for
 * @returns {string} The name
 */
export function uniqueName(label) {
  nameCounter++;
  return `agent run ${label} ${Date.now().toString(36)} ${nameCounter}`;
}

/**
 * A scripted reply that only speaks.
 * @param {string} text - What it says
 * @param {{pause?: boolean}} [opts] - `pause` holds the reply after streaming it
 * @returns {object} The mock response
 */
export function textReply(text, { pause = false } = {}) {
  return { blocks: [{ type: 'text', content: text }], stopReason: 'end_turn', ...(pause ? { pauseBeforeReturn: true } : {}) };
}

/**
 * A scripted reply that calls tools.
 * @param {Array<{id: string, name: string, input: object}>} calls - The calls
 * @param {string} [text] - What it says first
 * @returns {object} The mock response
 */
export function toolReply(calls, text = '') {
  return {
    blocks: [
      ...(text ? [{ type: 'text', content: text }] : []),
      ...calls.map((c) => ({ type: 'tool_use', toolUseId: c.id, toolName: c.name, toolInput: c.input }))
    ],
    stopReason: 'tool_use'
  };
}

/**
 * `runAgent`, bounded by the test's deadline rather than by a run deadline of
 * its own: the run is cancelled, and the case fails saying so, only once the
 * deadline has passed without moving. Each progress line the run reports is
 * progress of the test.
 * @param {Parameters<typeof runAgent>[0]} options - The run, as `runAgent` takes it
 * @param {AbortSignal} [signal] - The case's own cancel
 * @returns {Promise<Awaited<ReturnType<typeof runAgent>>>} The run's result
 */
export async function run(options, signal) {
  const controller = new AbortController();
  const forward = () => controller.abort();
  if (signal?.aborted) controller.abort();
  signal?.addEventListener('abort', forward, { once: true });
  let expired = false;
  const cancelTimer = deadlineTimer(() => { expired = true; controller.abort(); }, budgetFor(RUN_NOMINAL_MS));
  try {
    const result = await runAgent({
      ...options,
      onProgress: (line) => {
        noteProgress();
        options.onProgress?.(line);
      }
    }, controller.signal);
    if (expired) throw new Error(`the run ${options.name} had not ended by the test's deadline (it then ended ${result.status})`);
    return result;
  } finally {
    cancelTimer();
    signal?.removeEventListener('abort', forward);
  }
}

/**
 * Run a suite of agent-run cases around a carrier conversation of its own,
 * released however the suite ends.
 * @param {string} label - The suite, for the carrier's release reason
 * @param {(suite: AgentRunSuite) => Promise<void>} body - The cases
 * @returns {Promise<TestResult>} Test results
 */
export async function runAgentRunSuite(label, body) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} name - Test name
   * @param {() => Promise<void>} fn - Test body
   */
  const test = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (/** @type {any} */ e) {
      failed++;
      errors.push(`${name}: ${e.message}`);
    }
    noteCaseFinished();
  };

  await initializeRegistries();
  const session = await createTestSession();
  const carrier = await createTestConversation(session);

  /**
   * @param {string} name - The run's conversation name
   * @param {object[]} responses - Its model's replies, in order
   */
  const script = async (name, responses) => {
    await workerManager.sendWithAck(carrier.id, { type: 'queue-mocks-for-name', name, responses }, undefined, { idempotent: true });
  };

  try {
    await body({ test, script, session });
  } finally {
    await releaseTestConversation(session, carrier.id, label);
  }

  return { passed, failed, errors };
}
