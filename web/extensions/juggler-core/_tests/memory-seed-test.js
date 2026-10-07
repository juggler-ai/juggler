//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Auto-instantiate capability + memory seeding tests.
 *
 * Covers the `autoInstantiate` manifest capability and `seedAutoContextItems` (`js/model/conversation-seeder.js`):
 *  - the SDK normalizes `autoInstantiate` (default false);
 *  - memory's static `shouldAutoInstantiate()` gates on file existence;
 *  - a fresh conversation gains NO memory item when the file is absent — the
 *    property that keeps every full-document golden untouched (memory only
 *    appears once a project actually has memory).
 *
 * The "file present → seeded" symmetric case writes the real `.juggler/MEMORY.md`
 * at the project root, so it lives in an integration test (needsExclusiveRun),
 * not here.
 * @module unit-tests/memory-seed-test
 */

import MemoryContextItem from '../context-items/memory-context-item.js';
import GlobContextItem from '../context-items/glob-context-item.js';
import { writeFileOp } from '../../../js/services/ops-api.js';
import { seedAutoContextItems } from '../../../js/model/conversation-seeder.js';
import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../../../js-tests/utilities/test-helpers.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * Run auto-instantiate / seeding tests.
 * @param {{fixtureDir: string}} ctx - Test context with fixtureDir
 * @returns {Promise<TestResult>} Test results
 */
export async function runTests(ctx) {
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
  const conversation = await createTestConversation(session);

  /**
   * @param {any} ItemClass
   * @returns {any} A constructed instance bound to the test conversation
   */
  function instOf(ItemClass) {
    return new ItemClass({
      id: 'probe',
      session,
      conversation,
      messageThread: conversation.rootMessageThread
    });
  }

  await test('SDK normalizes autoInstantiate (true for memory, false otherwise)', () => {
    assert(instOf(MemoryContextItem).getManifest().autoInstantiate === true, 'memory should declare autoInstantiate');
    assert(instOf(GlobContextItem).getManifest().autoInstantiate === false, 'glob should default autoInstantiate to false');
  });

  await test('shouldAutoInstantiate is false when the memory file is absent', async () => {
    const absent = `${ctx.fixtureDir}/_memory_seed/does-not-exist/MEMORY.md`;
    assert((await MemoryContextItem.shouldAutoInstantiate(absent)) === false, 'absent file → no auto-instantiate');
  });

  await test('shouldAutoInstantiate is true once the memory file exists', async () => {
    const present = `${ctx.fixtureDir}/_memory_seed/present/MEMORY.md`;
    await writeFileOp({ path: present, content: '# Memory\n\n- [2026-06-14] seeded fact\n' });
    assert((await MemoryContextItem.shouldAutoInstantiate(present)) === true, 'present file → auto-instantiate');
  });

  await test('a fresh conversation has NO memory item when the project has no memory file', () => {
    // createTestConversation routes through session.createConversation, which
    // seeds the auto items. With the default .juggler/MEMORY.md absent,
    // gating must keep memory out — this is what protects every full-document
    // golden from gaining a phantom item.
    const memItems = conversation.rootMessageThread.contextItems.filter((/** @type {any} */ i) => i.type === 'memory');
    assert(memItems.length === 0, `expected no memory item, found ${memItems.length}`);
  });

  await test('seedAutoContextItems is a no-op (adds nothing) when gating fails', async () => {
    const before = conversation.rootMessageThread.contextItems.length;
    await seedAutoContextItems(conversation);
    await seedAutoContextItems(conversation);
    const after = conversation.rootMessageThread.contextItems.length;
    assert(before === after, `seeding should add nothing when gated out (before=${before}, after=${after})`);
  });

  return { passed, failed, errors };
}
