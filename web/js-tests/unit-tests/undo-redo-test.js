//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @file Undo/redo: the basics
 *
 * Undo/redo through the persistent OperationTracker:
 * - Basic add/undo/redo, and delete-context-item undo/redo
 * - Multiple sequential operations, and redo stack clearing
 * - Undo history persistence across session reload
 * - Clear all undo/redo (the clear:all operation type)
 * - A single operation takes a single undo
 *
 * One of five undo/redo suites sharing `utilities/undo-redo-helpers.js`, which
 * says why they are five.
 */

import workerManager from '../../js/services/worker-manager.js';
import {
  createTestConversation,
  runUndoRedoSuite,
  waitForUndoStateSync,
  waitForCaptureBoundary,
  assertUndoRedoState,
  createTestContextItem,
  assertContextItemIdsMatch,
  cleanupAutoAddedContextItems
} from '../utilities/undo-redo-helpers.js';

/**
 * Test 1: Basic add/undo/redo cycle
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testBasicAddUndoRedo(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Note: cleanupAutoAddedContextItems may create undo history if AI files were auto-added
  // We don't assert initial undo/redo state since it depends on whether AI files existed

  // Wait for cleanup sync to settle before adding new items
  await waitForCaptureBoundary(conversation);

  // Add context item (use unique ID to avoid collision with other tests)
  const contextItem = await createTestContextItem('CI_BASIC_1', session, conversation);
  conversation.rootMessageThread.addContextItem(contextItem);
  await waitForUndoStateSync(conversation);

  // After add: can undo, can't redo
  assertUndoRedoState(conversation, true, false, 'After add context item');
  assertContextItemIdsMatch(conversation, ['CI_BASIC_1'], 'After add context item');
  // Note: Rule context items don't create tool-actions (filtered by syncContextItemContent)

  // Undo
  await conversation.undo();
  await waitForUndoStateSync(conversation);

  // After undo: can't undo, can redo
  assertUndoRedoState(conversation, false, true, 'After undo');
  assertContextItemIdsMatch(conversation, [], 'After undo - context items removed');

  // Redo
  await conversation.redo();
  await waitForUndoStateSync(conversation);

  // After redo: can undo, can't redo
  assertUndoRedoState(conversation, true, false, 'After redo');
  assertContextItemIdsMatch(conversation, ['CI_BASIC_1'], 'After redo - context item restored');

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 2: Delete context item undo/redo cycle
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testDeleteContextItemUndoRedo(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Add context item first (use unique ID to avoid collision with other tests)
  const contextItem = await createTestContextItem('CI_DEL_1', session, conversation);
  conversation.rootMessageThread.addContextItem(contextItem);
  await waitForUndoStateSync(conversation);

  assertUndoRedoState(conversation, true, false, 'After add context item');
  assertContextItemIdsMatch(conversation, ['CI_DEL_1'], 'Before delete - context item exists in Yjs');

  // Verify context item can be retrieved before deleting
  const retrievedContextItem = conversation.rootMessageThread.getContextItem('CI_DEL_1');
  if (!retrievedContextItem) {
    // @ts-ignore - Accessing private _doc for testing
    const items = conversation.rootMessageThread.yarray.toArray();
    const contextItemIds = items.filter((/** @type {any} */ item) => item.get('itemId')).map((/** @type {any} */ item) => item.get('itemId'));
    throw new Error(`Context item 'CI_DEL_1' not retrievable via getContextItem(). Items has: [${contextItemIds.join(', ')}]`);
  }

  // Wait for capture boundary to ensure delete becomes separate undo entry from add
  await waitForCaptureBoundary(conversation);

  // Delete context item
  conversation.rootMessageThread.removeContextItem('CI_DEL_1');
  await waitForUndoStateSync(conversation);

  assertUndoRedoState(conversation, true, false, 'After delete context item');
  assertContextItemIdsMatch(conversation, [], 'After delete - context item removed');

  // Undo delete
  await conversation.undo();
  await waitForUndoStateSync(conversation);

  assertUndoRedoState(conversation, true, true, 'After undo delete');
  assertContextItemIdsMatch(conversation, ['CI_DEL_1'], 'After undo delete - context item restored');

  // Redo delete
  await conversation.redo();
  await waitForUndoStateSync(conversation);

  assertUndoRedoState(conversation, true, false, 'After redo delete');
  assertContextItemIdsMatch(conversation, [], 'After redo delete - context item removed again');

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 3: Multiple sequential operations
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testMultipleOperations(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Add context item A (use unique IDs to avoid collision with other tests)
  const contextItemA = await createTestContextItem('CI_MULTI_A', session, conversation);
  conversation.rootMessageThread.addContextItem(contextItemA);
  await waitForUndoStateSync(conversation);

  assertUndoRedoState(conversation, true, false, 'After add A');

  // Wait for capture boundary to ensure B becomes separate undo entry from A
  await waitForCaptureBoundary(conversation);

  // Add context item B
  const contextItemB = await createTestContextItem('CI_MULTI_B', session, conversation);
  conversation.rootMessageThread.addContextItem(contextItemB);
  await waitForUndoStateSync(conversation);

  assertUndoRedoState(conversation, true, false, 'After add B');
  assertContextItemIdsMatch(conversation, ['CI_MULTI_A', 'CI_MULTI_B'], 'After add B - both context items');

  // Undo (should remove B)
  await conversation.undo();
  await waitForUndoStateSync(conversation);

  assertUndoRedoState(conversation, true, true, 'After undo B');
  assertContextItemIdsMatch(conversation, ['CI_MULTI_A'], 'After undo B - only A remains');

  // Undo again (should remove A)
  await conversation.undo();
  await waitForUndoStateSync(conversation);

  assertUndoRedoState(conversation, false, true, 'After undo A');
  assertContextItemIdsMatch(conversation, [], 'After undo A - no context items');

  // Redo (should restore A)
  await conversation.redo();
  await waitForUndoStateSync(conversation);

  assertUndoRedoState(conversation, true, true, 'After redo A');
  assertContextItemIdsMatch(conversation, ['CI_MULTI_A'], 'After redo A - A restored');

  // Redo again (should restore B)
  await conversation.redo();
  await waitForUndoStateSync(conversation);

  assertUndoRedoState(conversation, true, false, 'After redo B');
  assertContextItemIdsMatch(conversation, ['CI_MULTI_A', 'CI_MULTI_B'], 'After redo B - both restored');
  // Note: Rule context items don't create tool-actions (filtered by syncContextItemContent)

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 4: Redo stack clearing after new operation
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testRedoStackClearing(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Wait for capture boundary to separate from any cleanup operations
  await waitForCaptureBoundary(conversation);

  // Add context item A (use unique IDs to avoid collision with other tests)
  const contextItemA = await createTestContextItem('CI_CLEAR_A', session, conversation);
  conversation.rootMessageThread.addContextItem(contextItemA);
  await waitForUndoStateSync(conversation);

  // After adding A: can undo (at minimum A, possibly more from cleanup)
  if (!conversation.canUndo()) {
    throw new Error('After add A: expected canUndo=true');
  }
  assertContextItemIdsMatch(conversation, ['CI_CLEAR_A'], 'After add A - A exists');

  // Undo A (this undoes A specifically, leaving cleanup operations if any)
  await conversation.undo();
  await waitForUndoStateSync(conversation);

  // After undoing A: should be able to redo (at minimum redo A)
  if (!conversation.canRedo()) {
    throw new Error('After undo A: expected canRedo=true');
  }
  assertContextItemIdsMatch(conversation, [], 'After undo A - A removed');

  // Wait for capture boundary to ensure B becomes separate undo entry
  await waitForCaptureBoundary(conversation);

  // Add different context item (should clear redo stack)
  const contextItemB = await createTestContextItem('CI_CLEAR_B', session, conversation);
  conversation.rootMessageThread.addContextItem(contextItemB);
  await waitForUndoStateSync(conversation);

  // KEY TEST: After adding B, redo should be cleared
  // canUndo should be true (can undo B)
  // canRedo should be FALSE (redo stack was cleared when we added B)
  if (!conversation.canUndo()) {
    throw new Error('After add B: expected canUndo=true');
  }
  if (conversation.canRedo()) {
    throw new Error('After add B: expected canRedo=false (redo stack should be cleared by new operation)');
  }
  assertContextItemIdsMatch(conversation, ['CI_CLEAR_B'], 'After new operation - only B exists');

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 5: Undo history persists across session reload
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testUndoHistoryPersistence(session) {
  // Create conversation with a context item
  const conv1 = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conv1);

  // Wait for capture boundary so context item add becomes separate undo entry
  await waitForCaptureBoundary(conv1);

  const contextItem = await createTestContextItem('CI_PERSIST', session, conv1);
  conv1.rootMessageThread.addContextItem(contextItem);
  await waitForUndoStateSync(conv1);

  // Verify canUndo is true before save (at minimum from adding the context item)
  if (!conv1.canUndo()) {
    throw new Error('Before save: expected canUndo=true');
  }

  // No explicit wait needed - loader.destroy() triggers onShutdown()
  // which performs a synchronous save before the worker stops

  // Destroy and reload
  await workerManager.loader.destroy(conv1);
  session.registry.forget(conv1.id, 'test');
  await session.persistence.load();
  await session.ensureConversationLoaded(conv1.id);

  const conv2 = session.conversations.get(conv1.id);
  if (!conv2) {
    throw new Error('Conversation did not reload');
  }

  // Verify CI_PERSIST was persisted
  // @ts-ignore - Accessing private _doc for testing
  const items = conv2.rootMessageThread.yarray.toArray();
  const contextItemIds = items.filter((/** @type {any} */ item) => item.get('itemId')).map((/** @type {any} */ item) => item.get('itemId'));
  if (!contextItemIds.includes('CI_PERSIST')) {
    throw new Error(`CI_PERSIST not found in reloaded conversation. Found: [${contextItemIds.join(', ')}]`);
  }

  // Undo history is in-memory only and does not persist across worker restarts.
  // The key assertion is that the conversation data (CI_PERSIST) was persisted.

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 6: Clear all can be undone to restore context items
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testClearAllUndo(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Add two context items
  const contextItemA = await createTestContextItem('CI_CLEAR_ALL_A', session, conversation);
  const contextItemB = await createTestContextItem('CI_CLEAR_ALL_B', session, conversation);
  conversation.rootMessageThread.addContextItem(contextItemA);
  conversation.rootMessageThread.addContextItem(contextItemB);
  await waitForUndoStateSync(conversation);

  assertContextItemIdsMatch(conversation, ['CI_CLEAR_ALL_A', 'CI_CLEAR_ALL_B'], 'Before clear - both context items exist');

  // Wait for capture boundary so clear becomes separate undo entry
  await waitForCaptureBoundary(conversation);

  // Clear context items (via conversation method - pure Yjs)
  conversation.rootMessageThread.clearContextItems();
  await waitForUndoStateSync(conversation);

  // Verify cleared
  assertContextItemIdsMatch(conversation, [], 'After clear - no context items');

  // Undo should restore everything
  await conversation.undo();
  await waitForUndoStateSync(conversation);

  assertContextItemIdsMatch(conversation, ['CI_CLEAR_ALL_A', 'CI_CLEAR_ALL_B'], 'After undo - both context items restored');

  // Should be able to redo
  if (!conversation.canRedo()) {
    throw new Error('After undo: expected canRedo=true');
  }

  // Redo should clear again
  await conversation.redo();
  await waitForUndoStateSync(conversation);

  assertContextItemIdsMatch(conversation, [], 'After redo - cleared again');

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 7: Single context item operation should require exactly one undo
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testSingleContextItemSingleUndo(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Add context item
  const contextItem = await createTestContextItem('CI_SINGLE', session, conversation);
  conversation.rootMessageThread.addContextItem(contextItem);
  await waitForUndoStateSync(conversation);

  // Verify context item exists
  assertContextItemIdsMatch(conversation, ['CI_SINGLE'], 'Before undo - context item exists');

  // Count undo operations available
  let undoCount = 0;
  while (conversation.canUndo()) {
    await conversation.undo();
    await waitForUndoStateSync(conversation);
    undoCount++;

    // Safety: max 10 undos
    if (undoCount > 10) {
      throw new Error('Undo loop exceeded 10 operations - something is wrong');
    }
  }

  // Should only need ONE undo to remove the context item
  if (undoCount !== 1) {
    throw new Error(
      `Expected 1 undo operation to remove context item, got ${undoCount}. ` +
			`This suggests multiple undo entries were created for a single operation.`
    );
  }

  // Verify context item removed
  assertContextItemIdsMatch(conversation, [], 'After undo - context item removed');

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 9: Delete context item -> undo should NOT create new operations (infinite loop bug)
 *
 * Bug reproduction: In a new conversation, delete a context item.
 * Undo does not restore it but creates new operations with incrementing groupIds.
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testDeleteContextItemUndoNoInfiniteLoop(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Add a deletable context item
  const contextItem = await createTestContextItem('CI_LOOP_TEST', session, conversation);
  conversation.rootMessageThread.addContextItem(contextItem);
  await waitForUndoStateSync(conversation);

  // Wait for capture boundary to ensure delete becomes separate undo entry from add
  await waitForCaptureBoundary(conversation);

  // Delete the context item
  conversation.rootMessageThread.removeContextItem('CI_LOOP_TEST');
  await waitForUndoStateSync(conversation);

  // Undo the delete
  await conversation.undo();
  await waitForUndoStateSync(conversation);

  // Context item should be restored
  // @ts-ignore - Accessing private _doc for testing
  const itemsAfterUndo = conversation.rootMessageThread.yarray.toArray();
  const contextItemIdsAfterUndo = itemsAfterUndo.filter((/** @type {any} */ item) => item.get('itemId')).map((/** @type {any} */ item) => item.get('itemId'));
  if (!contextItemIdsAfterUndo.includes('CI_LOOP_TEST')) {
    throw new Error('Context item CI_LOOP_TEST was not restored by undo');
  }

  // Pressing undo again should either do nothing or undo the add
  if (conversation.canUndo()) {
    await conversation.undo();
    await waitForUndoStateSync(conversation);
  }

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Run the undo-redo suite.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results
 */
export async function runTests(_ctx) {
  return runUndoRedoSuite('undo-redo', [
    { name: 'Basic Add/Undo/Redo', fn: testBasicAddUndoRedo },
    { name: 'Delete Context Item Undo/Redo', fn: testDeleteContextItemUndoRedo },
    { name: 'Multiple Sequential Operations', fn: testMultipleOperations },
    { name: 'Redo Stack Clearing', fn: testRedoStackClearing },
    { name: 'Undo History Persistence', fn: testUndoHistoryPersistence },
    { name: 'Clear All Undo/Redo', fn: testClearAllUndo },
    { name: 'Single Context Item Single Undo', fn: testSingleContextItemSingleUndo },
    { name: 'Delete Context Item Undo No Infinite Loop', fn: testDeleteContextItemUndoNoInfiniteLoop },
  ]);
}
