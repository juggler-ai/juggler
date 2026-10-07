//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @file Integration test for conversation name persistence across reload
 *
 * This test verifies that conversation names survive a save/reload cycle:
 * 1. Create a conversation with a specific name
 * 2. Wait for worker to save to backend
 * 3. Destroy and reload conversation
 * 4. Verify name persisted (not falling back to 'Conversation')
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';
import workerManager from '../../js/services/worker-manager.js';
import logger from '../utilities/test-logger.js';

/**
 * Test: Conversation name persists across save/reload cycle
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results
 */
export async function runTests(_ctx) {
  await initializeRegistries();

  // Terminate all workers from previous tests
  logger.info('[conversation-name-persistence-test] Terminating all workers from previous tests');
  workerManager.terminateAll();

  const session = await createTestSession();

  // Clear any conversations loaded from backend and terminate their workers
  const loadedConvIds = Array.from(session.conversations.keys());
  for (const convId of loadedConvIds) {
    logger.info(`[conversation-name-persistence-test] Terminating and clearing conversation: ${convId}`);
    workerManager.terminate(convId);
    session.conversations.delete(convId);
  }

  logger.info('[conversation-name-persistence-test] About to create new test conversation');
  const conversation = await createTestConversation(session);
  const convId = conversation.id;
  const originalName = conversation.name;
  logger.info(`[conversation-name-persistence-test] Created conversation: ${convId}, name: "${originalName}"`);

  assert(Boolean(originalName) && originalName !== 'Conversation',
    `Expected a meaningful conversation name, got: "${originalName}"`);

  // Force the worker to persist now and wait for the write to complete, instead
  // of sleeping past the 2s SaveDebounceTime (a zero-margin sleep that was racy
  // on slow CI runners).
  logger.info('[conversation-name-persistence-test] Flushing worker persistence...');
  await workerManager.flushPersistence(convId);

  // Destroy conversation and terminate worker
  logger.info('[conversation-name-persistence-test] Destroying conversation and worker');
  await workerManager.loader.destroy(conversation);
  session.conversations.delete(convId);

  // Reload session (simulates page reload)
  logger.info('[conversation-name-persistence-test] Reloading session from backend');
  await session.load();

  // Get the reloaded conversation
  const reloadedConv = session.conversations.get(convId);
  if (!reloadedConv) {
    return {
      passed: 0,
      failed: 1,
      errors: ['Conversation did not reload from backend']
    };
  }

  // Deterministically load the reloaded conversation's doc from disk (which
  // carries the persisted name) instead of a fixed 500ms worker-init sleep.
  await session.ensureConversationLoaded(convId);

  logger.info(`[conversation-name-persistence-test] Reloaded conversation name: "${reloadedConv.name}"`);

  if (reloadedConv.name !== originalName) {
    return {
      passed: 0,
      failed: 1,
      errors: [`Conversation name not persisted. Expected "${originalName}", got "${reloadedConv.name}"`]
    };
  }

  logger.info('[conversation-name-persistence-test] Test PASSED - conversation name persisted across reload');
  return { passed: 1, failed: 0, errors: [] };
}
