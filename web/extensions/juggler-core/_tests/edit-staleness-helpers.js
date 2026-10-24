//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * The harness the read-before-mutate freshness suites share.
 *
 * The guard's cases are two suites, not one: every case creates its own
 * conversation, and thirty of them in one suite cost ten seconds alone and
 * twice that in a full run, which a 45s suite budget does not survive on a busy
 * machine. `edit-staleness-guard` holds what counts as having seen a file;
 * `edit-staleness-guard-writes` holds the write tool's exemption and what
 * happens when writes to one file land in the same turn.
 *
 * Freshness is derived entirely from the durable conversation transcript
 * (context-items/read-history.js), so these cases seed that transcript directly
 * rather than executing reads in-process — which is also the point: a read
 * persisted by a PRIOR app session or ANOTHER client is honoured identically,
 * with no per-process record to lose on relaunch.
 * @module unit-tests/edit-staleness-helpers
 */

import {
  initializeRegistries,
  createTestSession,
  assert
} from '../../../js-tests/utilities/test-helpers.js';
import contextItemRegistry from '../../../js/registries/context-item-registry.js';

/** A syntactically valid SHA-256 that matches no real file. */
export const BOGUS_HASH = '0000000000000000000000000000000000000000000000000000000000000000';

/** Monotonic counter so every seeded tool-action gets a unique toolUseId. */
let seedCounter = 0;

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * @typedef {object} GuardHarness
 * @property {any} session - The suite's test session
 * @property {any} EditClass - The registered edit action
 * @property {any} WriteClass - The registered write action
 * @property {(Cls: any, conversation: any, toolUseId?: string) => any} mkItem - An item of `Cls` bound to a conversation, optionally running under a sub-call id
 * @property {(conversation: any, toolName: string, toolInput: object, payload?: object) => void} seedAction - Seed a completed, successful tool-action into the transcript
 * @property {(conversation: any, toolName: string, path: string, contentHash?: string) => void} seedSeen - Seed a seen-record for `path`, hash-less unless one is given
 * @property {(name: string, fn: () => Promise<void>) => Promise<void>} test - Run one case, recording its outcome
 * @property {() => TestResult} results - The tally so far
 */

/**
 * Set up the registries and a session, and return the helpers every case uses.
 * @returns {Promise<GuardHarness>} The harness for one suite.
 */
export async function makeGuardHarness() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();

  const EditClass = /** @type {any} */ (contextItemRegistry.getByToolName('edit'));
  assert(EditClass, 'edit action should be registered');
  const WriteClass = /** @type {any} */ (contextItemRegistry.getByToolName('write'));
  assert(WriteClass, 'write action should be registered');

  /**
   * Build an item of the given class bound to a conversation.
   * @param {any} Cls - Context-item class
   * @param {any} conversation - Conversation instance
   * @param {string} [toolUseId] - The id a program's sub-call runs under
   * @returns {any} Item instance
   */
  const mkItem = (Cls, conversation, toolUseId) => new Cls({
    id: Cls.MANIFEST.id,
    session,
    conversation,
    messageThread: conversation.rootMessageThread,
    ...(toolUseId ? { toolUseId } : {})
  });

  /**
   * Seed a COMPLETED, successful tool-action into the conversation transcript
   * — the durable "the model has seen this file" record a real tool call (or a
   * prior session / another client) would leave behind. `payload` is stored
   * nested at `fullResult.result`, matching how the action pipeline persists
   * the backend's ops result.
   * @param {any} conversation - Conversation instance
   * @param {string} toolName - 'read' | 'write' | 'edit' | 'batch_read'
   * @param {object} toolInput - Tool input to record
   * @param {object} [payload] - Backend ops result to record (carries contentHash)
   * @returns {void}
   */
  const seedAction = (conversation, toolName, toolInput, payload) => {
    conversation.rootMessageThread.appendToolAction({
      toolUseId: `seed_${toolName}_${++seedCounter}`,
      toolName,
      toolInput,
      state: 'completed',
      result: {
        content: `${toolName} ok`,
        isError: false,
        ...(payload ? { fullResult: { state: 'completed', success: true, result: payload } } : {})
      }
    });
  };

  /**
   * Seed a seen-record for `path` (hash-less unless given).
   * @param {any} conversation - Conversation instance
   * @param {string} toolName - Seen-tool name
   * @param {string} path - File path the action targeted
   * @param {string} [contentHash] - Hash to record with the result
   * @returns {void}
   */
  const seedSeen = (conversation, toolName, path, contentHash) =>
    seedAction(conversation, toolName, { file_path: path },
      contentHash ? { contentHash } : undefined);

  /**
   * Run one test case.
   * @param {string} name - Test label for error reporting
   * @param {() => Promise<void>} fn - Test body (throws on failure)
   * @returns {Promise<void>}
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

  return {
    session,
    EditClass,
    WriteClass,
    mkItem,
    seedAction,
    seedSeen,
    test,
    results: () => ({ passed, failed, errors })
  };
}
