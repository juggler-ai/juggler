//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @file Integration test for context item persistence via worker sync
 *
 * This test verifies the REAL production pathway:
 * 1. User adds a context item on main thread
 * 2. YjsSyncProvider syncs it to worker
 * 3. Worker saves it to backend
 * 4. Reload conversation from backend
 * 5. Verify context item persisted
 *
 * This is the pathway that's currently broken.
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
 * Test: Context items added on main thread persist via worker sync
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results
 */
export async function runTests(_ctx) {
  try {
    return await _runTests();
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    logger.error(`[context-item-persistence-test] Uncaught: ${msg}`);
    return { passed: 0, failed: 1, errors: [`Uncaught exception: ${msg}`] };
  }
}

/** @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results */
async function _runTests() {
  await initializeRegistries();

  // CRITICAL: WorkerManager is a singleton - terminate ALL workers BEFORE session creation
  logger.info('[context-item-persistence-test] Terminating all workers from previous tests');
  workerManager.terminateAll();

  const session = await createTestSession();

  // Clear any conversations loaded from backend and terminate their workers
  // Do this synchronously to avoid race conditions
  const loadedConvIds = Array.from(session.conversations.keys());
  for (const convId of loadedConvIds) {
    logger.info(`[context-item-persistence-test] Terminating and clearing conversation: ${convId}`);
    workerManager.terminate(convId);  // Terminate FIRST
    session.conversations.delete(convId);  // Then remove from session
  }

  logger.info('[context-item-persistence-test] About to create new test conversation');
  const conversation = await createTestConversation(session);
  logger.info(`[context-item-persistence-test] Created new conversation: ${conversation.id}`);

  // Conversation is GUARANTEED ready - worker spawned, Yjs sync already activated by WorkerManager
  // No manual activation or waiting needed!
  logger.info('[context-item-persistence-test] Step 1: Conversation ready, adding context item');

  // Import context item registry to create a context item
  // @ts-ignore - Dynamic import in test
  const contextItemRegistry = (await import('../../js/registries/context-item-registry.js')).default;

  // Create a context item (file-content is the canonical user-addable item)
  const ruleContextItem = contextItemRegistry.createItem({
    id: 'CI_RULE_TEST',
    type: 'file-content',
    data: {
      path: 'README.md'
    }
  }, session, conversation, conversation.rootMessageThread);

  logger.info(`[context-item-persistence-test] Created context item: ${ruleContextItem.id}`);

  conversation.rootMessageThread.addContextItem(ruleContextItem);

  logger.info('[context-item-persistence-test] Context item added to conversation');

  // Verify context item is in conversation's message thread
  const contextItemInThread = conversation.rootMessageThread.contextItems.find(
    (/** @type {any} */ ci) => ci.id === 'CI_RULE_TEST'
  );
  assert(contextItemInThread !== undefined, 'Context item should be in conversation message thread');
  logger.info('[context-item-persistence-test] Context item is in Yjs doc on main thread');

  // Wait for worker to receive sync message and save
  logger.info('[context-item-persistence-test] Step 2: Waiting for worker to sync and save...');

  // Force the worker to persist now and wait for the write to complete —
  // deterministic, instead of sleeping past the 2s SaveDebounceTime (which
  // races the save→destroy on slow CI runners). The context-item mutation is
  // already on the ordered worker channel ahead of this call (Yjs fires its
  // update synchronously on the local write), so the flush saves it.
  logger.info('[context-item-persistence-test] Flushing worker persistence...');
  await workerManager.flushPersistence(conversation.id);

  // Step 3: Reload conversation from backend
  logger.info('[context-item-persistence-test] Step 3: Reloading conversation from backend');

  // Destroy conversation and terminate worker (atomic operation with enforced cleanup order)
  await workerManager.loader.destroy(conversation);
  session.conversations.delete(conversation.id);

  // Reload session (simulates page reload)
  await session.load();
  await session.ensureConversationLoaded(conversation.id);

  // Get the conversation back
  const reloadedConv = session.conversations.get(conversation.id);
  if (!reloadedConv) {
    return {
      passed: 0,
      failed: 1,
      errors: ['Conversation did not reload from backend']
    };
  }

  // Verify context item persisted
  const contextItems = reloadedConv.rootMessageThread.contextItems;
  logger.info(`[context-item-persistence-test] Reloaded conversation has ${contextItems.length} context items`);
  contextItems.forEach((/** @type {any} */ f) => {
    logger.info(`  - ${f.id} (${f.type})`);
  });

  const ruleContextItems = contextItems.filter((/** @type {any} */ f) => f.id === 'CI_RULE_TEST');

  if (ruleContextItems.length === 0) {
    return {
      passed: 0,
      failed: 1,
      errors: ['Context item was not persisted to backend - sync provider not working']
    };
  }

  logger.info('[context-item-persistence-test] Test PASSED - context item persisted via worker sync');
  return { passed: 1, failed: 0, errors: [] };
}
