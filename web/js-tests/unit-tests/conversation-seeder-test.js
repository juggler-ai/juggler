//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Where a conversation's seeding policy lives.
 *
 * Every seed a conversation is given before anyone writes in it — the
 * creation defaults and the always-present auto items — belongs to
 * `model/conversation-seeder.js`. Session keeps exactly one door to it,
 * `seedConversationAutoItems`, which initialisation, rebinding, `/clear` and
 * the Add Context Item menu all go through, and which tests stub to count
 * seeding passes. A seeding method grown back onto Session is a second home
 * for the policy, which is how the two copies of one rule drift.
 *
 * The seeds' behaviour is covered where it is observable: `unit:memory-seed`,
 * `integration:clear-*` and the thread-context-mode tests.
 * @module unit-tests/conversation-seeder-test
 */

import { assert, trackTestSession } from '../utilities/test-helpers.js';
import Session from '../../js/model/session.js';
import {
  AI_ASSISTANT_FILES,
  addAIAssistantFiles,
  seedAutoContextItems,
  seedConversationAutoItems,
  seedCreationDefaults
} from '../../js/model/conversation-seeder.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => Promise<void>|void} fn
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

  await run('Session carries no seeding policy of its own', () => {
    const proto = /** @type {any} */ (Session.prototype);
    const strays = [
      'addAIAssistantFiles',
      'seedAutoContextItems',
      '_seedDefaultSystemPrompt',
      '_seedDefaultFileEditing',
      '_seedDefaultStrategy'
    ].filter((name) => name in proto);
    assert(strays.length === 0, `seeding methods on Session: ${strays.join(', ')}`);
    assert(!('AI_ASSISTANT_FILES' in Session), 'Session.AI_ASSISTANT_FILES is a second list of assistant file names');
  });

  await run('the seeder exports the whole policy', () => {
    for (const [name, fn] of Object.entries({ addAIAssistantFiles, seedAutoContextItems, seedConversationAutoItems, seedCreationDefaults })) {
      assert(typeof fn === 'function', `${name} is not exported`);
    }
    assert(Array.isArray(AI_ASSISTANT_FILES) && AI_ASSISTANT_FILES.includes('CLAUDE.md') && AI_ASSISTANT_FILES.includes('AGENTS.md'),
      `AI_ASSISTANT_FILES = ${JSON.stringify(AI_ASSISTANT_FILES)}`);
  });

  await run('Session#seedConversationAutoItems is the door, and answers with both counts', async () => {
    const session = /** @type {any} */ (trackTestSession(new Session(/** @type {any} */ ({}))));
    // No conversation: both halves are best-effort no-ops, so the door's
    // answer is exactly the seeder's shape with nothing in it.
    const result = await session.seedConversationAutoItems(null);
    assert(result && result.assistantFiles === 0 && result.autoItems === 0,
      `got ${JSON.stringify(result)}, want {assistantFiles: 0, autoItems: 0}`);
  });

  return { passed, failed, errors };
}
