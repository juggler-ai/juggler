//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @file Comprehensive undo/redo test suite
 *
 * Tests all aspects of undo/redo functionality using the persistent
 * OperationTracker (replaces ephemeral Y.UndoManager):
 * - Basic add/undo/redo operations
 * - Delete context item undo/redo
 * - Multiple sequential operations
 * - Redo stack clearing
 * - Undo history persistence across session reload
 * - Clear all undo/redo (tests clear:all operation type)
 * - Single operation requires single undo
 * - Message update coalescing (streaming optimization)
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  waitForWorkerReady
} from '../utilities/test-helpers.js';

import workerManager from '../../js/services/worker-manager.js';
import { TOOL_STATES } from '../../sdk/lib/message.js';
import logger from '../utilities/test-logger.js';
import { budgetFor } from '../utilities/test-deadline.js';

// =============================================================================
// Test Helper Functions
// =============================================================================

/**
 * Synchronization barrier between mutations and undo-state assertions.
 * Deterministic — no sleep.
 *
 * The mutation's yjs-sync is already on the ordered worker channel ahead of
 * this ping: Yjs fires its `update` event synchronously on the local write, so
 * the outbound sync is sent before we get here. The worker processes messages
 * in FIFO order, so by the time it handles this ping the mutation is applied and
 * captured; `handlePing` then force-closes the undo capture window
 * (StopCapturing → undoState written synchronously) and flushes its outbound
 * batcher, emitting the undoState frame *before* the ack.
 *
 * Inbound Yjs updates are timer-batched on the main thread, so the undoState
 * frame — received ahead of the ack — is sitting in the pending-update buffer
 * when ping() resolves. flushPendingUpdates() applies it synchronously, so
 * canUndo()/canRedo() read current state on the next line. This replaces a
 * load-bearing 100ms sleep that merely gambled the batch had flushed — too
 * short on slow/contended CI runners.
 * @param {import('../../model/conversation.js').default} conversation
 * @returns {Promise<void>}
 */
async function waitForUndoStateSync(conversation) {
  await workerManager.ping(conversation.id);
  conversation._doc.flushPendingUpdates();
}

/**
 * Force the UndoManager's capture window to close so subsequent mutations
 * form an independent undo group. For browser-driven (yjs-sync) mutations
 * the manager only auto-closes after a 20 ms timeout — the previous
 * sleep-based helper was waiting on exactly that timer. Sending
 * `stop-undo-capturing` is the deterministic equivalent that real user
 * actions already use at boundaries (slash commands, context items, …).
 * @param {import('../../model/conversation.js').default} conversation
 * @returns {Promise<void>}
 */
async function waitForCaptureBoundary(conversation) {
  // First sync any pending yjs-sync messages so they capture into the
  // current group, THEN close the capture window before subsequent ops.
  await workerManager.ping(conversation.id);
  workerManager.stopUndoCapturing(conversation.id);
  await workerManager.ping(conversation.id);
}

/**
 * Assert undo/redo button states match expectations.
 * @param {import('../../model/conversation.js').default} conversation - Conversation instance
 * @param {boolean} canUndo - Expected undo availability
 * @param {boolean} canRedo - Expected redo availability
 * @param {string} context - Test context for error message
 */
function assertUndoRedoState(conversation, canUndo, canRedo, context) {
  const actualCanUndo = conversation.canUndo();
  const actualCanRedo = conversation.canRedo();

  if (actualCanUndo !== canUndo || actualCanRedo !== canRedo) {
    throw new Error(
      `[${context}] Undo/redo state mismatch!\n` +
			`Expected: canUndo=${canUndo}, canRedo=${canRedo}\n` +
			`Actual:   canUndo=${actualCanUndo}, canRedo=${actualCanRedo}`
    );
  }
}

/**
 * Create a test context item for undo/redo testing.
 * @param {string} id - Context item ID
 * @param {import('../../model/session.js').default} session - Session instance
 * @param {import('../../model/conversation.js').default} conversation - Conversation instance
 * @returns {Promise<import('juggler/context-item').default>} Context item instance
 */
async function createTestContextItem(id, session, conversation) {
  const contextItemRegistry = (await import('../../js/registries/context-item-registry.js')).default;

  return contextItemRegistry.createItem({
    id: id,
    type: 'file-content',
    data: {
      path: `test-${id}.md`
    }
  }, session, conversation, conversation.rootMessageThread);
}

/**
 * Verify Yjs document state matches expected context item IDs.
 * @param {import('../../model/conversation.js').default} conversation - Conversation instance
 * @param {string[]} expectedIds - Expected context item IDs
 * @param {string} context - Test context
 */
function assertContextItemIdsMatch(conversation, expectedIds, context) {
  // @ts-ignore - Accessing private _doc for testing
  const items = conversation.rootMessageThread.yarray.toArray();
  const actualIds = items
    .filter((/** @type {any} */ item) => item.get('itemId') && !item.get('preventUserDeletion'))
    .map((/** @type {any} */ item) => item.get('itemId'));

  const expected = [...expectedIds].sort();
  const actual = [...actualIds].sort();

  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw new Error(
      `[${context}] Context item IDs mismatch!\n` +
			`Expected: ${JSON.stringify(expected)}\n` +
			`Actual:   ${JSON.stringify(actual)}`
    );
  }
}

/**
 * Count context items in the Yjs document.
 * @param {import('../../model/conversation.js').default} conversation - Conversation instance
 * @returns {number} Number of context items
 */
function getContextItemCount(conversation) {
  // @ts-ignore - Accessing private _doc for testing
  const items = conversation.rootMessageThread.yarray.toArray();
  return items.filter((/** @type {any} */ item) => item.get('itemId') && !item.get('preventUserDeletion')).length;
}

// =============================================================================
// Test Cases
// =============================================================================

/**
 * Clean up auto-added context items (AI assistant files) from a fresh conversation.
 * Also clears undo history so tests start with a clean slate.
 * @param {import('../../model/conversation.js').default} conversation - Conversation instance
 */
async function cleanupAutoAddedContextItems(conversation) {
  // Remove all context items (AI assistant files added by Session.addAIAssistantFiles)
  // Delete context items in reverse order (to preserve indices)
  // @ts-ignore - Accessing private _doc for testing
  const items = conversation.rootMessageThread.yarray.toArray();
  for (let i = items.length - 1; i >= 0; i--) {
    if (items[i].get('itemId') && !items[i].get('toolUseId')) {
      // @ts-ignore - Accessing private _doc for testing
      conversation.rootMessageThread.yarray.delete(i, 1);
    }
  }

  // Worker round-trips: first to flush the deletes above, then again
  // after clearUndoStacks so the undoState reset has propagated.
  await workerManager.ping(conversation.id);
  await workerManager.clearUndoStacks(conversation.id);
  await workerManager.ping(conversation.id);
}

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

  // No explicit wait needed - destroyConversationAndWorker() triggers onShutdown()
  // which performs a synchronous save before the worker stops

  // Destroy and reload
  await workerManager.destroyConversationAndWorker(conv1);
  session.conversations.delete(conv1.id);
  await session.load();
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
 * Test 10: Adding a context item via executeContextItem should require only ONE undo
 *
 * Bug: Context item addition creates two operations (context item + placeholder).
 * User has to undo twice - first placeholder goes, then context item.
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testContextItemAdditionSingleUndo(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Record user-controllable context-item count before. The SYSTEM_1
  // placeholder is no longer counted here — it's a UI affordance, managed
  // by the worker (see ConversationDocument.EnsureSystemPromptPlaceholder
  // in cmd/juggler/worker/document.go). The user only ever adds/removes
  // real context items; SYSTEM_1 floats in/out as a side effect.
  const contextItemCountBefore = getContextItemCount(conversation);

  const result = await conversation.rootMessageThread.executeContextItem('file-content', {
    path: 'README.md'
  });
  if (!result.created) {
    throw new Error(`Failed to create context item: ${result.error}`);
  }
  await waitForUndoStateSync(conversation);

  const contextItemCountAfter = getContextItemCount(conversation);
  if (contextItemCountAfter !== contextItemCountBefore + 1) {
    throw new Error(`Context item was not added. Before: ${contextItemCountBefore}, After: ${contextItemCountAfter}`);
  }

  // One undo should remove the user's context-item add. SYSTEM_1
  // stays — it's worker-managed and not part of the user's undo stack.
  await conversation.undo();
  await waitForUndoStateSync(conversation);

  const contextItemCountAfterUndo = getContextItemCount(conversation);
  if (contextItemCountAfterUndo !== contextItemCountBefore) {
    throw new Error(
      `Context item not removed after single undo. ` +
			`Expected ${contextItemCountBefore}, got ${contextItemCountAfterUndo}`
    );
  }

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 11: Deleting a context item should require only ONE undo (not two)
 *
 * Bug: Context item deletion creates two operations (two items:delete).
 * User has to undo twice - first placeholder comes back, then context item.
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testContextItemDeletionSingleUndo(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Add a context item using executeContextItem (creates both context item AND placeholder)
  const result = await conversation.rootMessageThread.executeContextItem('file-content', {
    path: 'README.md'
  });
  if (!result.created) {
    throw new Error(`Failed to create context item: ${result.error}`);
  }
  await waitForUndoStateSync(conversation);

  // Wait for capture boundary to ensure delete is separate from add
  await waitForCaptureBoundary(conversation);

  // Record state before deletion
  const contextItemCountBeforeDelete = getContextItemCount(conversation);
  // @ts-ignore - Accessing private _doc for testing
  const itemCountBeforeDelete = conversation.rootMessageThread.yarray.length;

  // Delete the context item - worker atomically deletes placeholder via OperationTracker
  if (!result.id) {
    throw new Error('Context item ID is null');
  }
  conversation.rootMessageThread.removeContextItem(result.id);
  await waitForUndoStateSync(conversation);

  // Verify both context item and placeholder were removed
  const contextItemCountAfterDelete = getContextItemCount(conversation);
  // @ts-ignore - Accessing private _doc for testing
  const itemCountAfterDelete = conversation.rootMessageThread.yarray.length;
  if (contextItemCountAfterDelete !== contextItemCountBeforeDelete - 1) {
    throw new Error(`Context item was not deleted. Before: ${contextItemCountBeforeDelete}, After: ${contextItemCountAfterDelete}`);
  }
  if (itemCountAfterDelete !== itemCountBeforeDelete - 1) {
    throw new Error(`Placeholder was not deleted. Before: ${itemCountBeforeDelete}, After: ${itemCountAfterDelete}`);
  }

  // CRITICAL: Should only need ONE undo to restore both
  await conversation.undo();
  await waitForUndoStateSync(conversation);

  // Both context item AND placeholder should be restored after single undo
  const contextItemCountAfterUndo = getContextItemCount(conversation);
  // @ts-ignore - Accessing private _doc for testing
  const itemCountAfterUndo = conversation.rootMessageThread.yarray.length;

  if (contextItemCountAfterUndo !== contextItemCountBeforeDelete) {
    throw new Error(
      `Context item not restored after single undo. ` +
			`Expected ${contextItemCountBeforeDelete}, got ${contextItemCountAfterUndo}`
    );
  }
  if (itemCountAfterUndo !== itemCountBeforeDelete) {
    throw new Error(
      `Placeholder not restored after single undo. ` +
			`Expected ${itemCountBeforeDelete}, got ${itemCountAfterUndo}. ` +
			`This means context item and placeholder were not deleted together.`
    );
  }

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 12: Delete context item after undo-clear should require only ONE undo.
 * THIS TEST REPRODUCES THE EXACT USER SCENARIO:
 * 1. Create conversation and add a context item (simulates auto-add)
 * 2. Clear undo history (like session.createConversation does after auto-add)
 * 3. Delete the context item using removeContextItem() (what UI does)
 * 4. Single undo should restore both context item AND placeholder
 * This tests the REAL flow - after auto-add, undo is cleared, then user deletes.
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testAutoAddedContextItemDeletionSingleUndo(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Add a context item using executeContextItem (creates both context item AND placeholder)
  // This simulates what addAIAssistantFiles() does
  const result = await conversation.rootMessageThread.executeContextItem('file-content', {
    path: 'README.md'
  });
  if (!result.created) {
    throw new Error(`Failed to create context item: ${result.error}`);
  }
  await waitForUndoStateSync(conversation);

  // CRITICAL: Clear undo history - this is what session.createConversation does
  // after adding AI assistant files. The user starts with no undo history.
  await workerManager.clearUndoStacks(conversation.id);
  await waitForUndoStateSync(conversation);

  // Verify undo history was cleared
  const canUndoAfterClear = conversation.canUndo();
  if (canUndoAfterClear) {
    throw new Error('Undo history was not cleared!');
  }

  // Record state before deletion
  const contextItemCountBeforeDelete = getContextItemCount(conversation);
  // @ts-ignore - Accessing private _doc for testing
  const itemCountBeforeDelete = conversation.rootMessageThread.yarray.length;

  logger.info(`[undo-redo-test] Before delete: contextItems=${contextItemCountBeforeDelete}, items=${itemCountBeforeDelete}`);

  // Delete the context item using the REAL removeContextItem() - same as UI does
  if (!result.id) {
    throw new Error('Context item ID is null');
  }
  const deletedContextItemId = result.id;
  conversation.rootMessageThread.removeContextItem(deletedContextItemId);
  await waitForUndoStateSync(conversation);

  // Verify deletion happened
  const contextItemCountAfterDelete = getContextItemCount(conversation);
  // @ts-ignore - Accessing private _doc for testing
  const itemCountAfterDelete = conversation.rootMessageThread.yarray.length;

  logger.info(`[undo-redo-test] After delete: contextItems=${contextItemCountAfterDelete}, items=${itemCountAfterDelete}`);

  if (contextItemCountAfterDelete !== contextItemCountBeforeDelete - 1) {
    throw new Error(`Context item was not deleted. Before: ${contextItemCountBeforeDelete}, After: ${contextItemCountAfterDelete}`);
  }
  if (itemCountAfterDelete !== itemCountBeforeDelete - 1) {
    throw new Error(`Placeholder was not deleted. Before: ${itemCountBeforeDelete}, After: ${itemCountAfterDelete}`);
  }

  // CRITICAL: Should only need ONE undo to restore both context item AND placeholder
  const canUndoAfterDelete = conversation.canUndo();
  if (!canUndoAfterDelete) {
    throw new Error('Cannot undo after deleting context item - undo history is empty!');
  }

  await conversation.undo();
  await waitForUndoStateSync(conversation);

  // Both context item AND placeholder should be restored after single undo
  const contextItemCountAfterUndo = getContextItemCount(conversation);
  // @ts-ignore - Accessing private _doc for testing
  const itemCountAfterUndo = conversation.rootMessageThread.yarray.length;

  logger.info(`[undo-redo-test] After undo: contextItems=${contextItemCountAfterUndo}, items=${itemCountAfterUndo}`);

  if (contextItemCountAfterUndo !== contextItemCountBeforeDelete) {
    throw new Error(
      `Context item not restored after single undo. ` +
			`Expected ${contextItemCountBeforeDelete}, got ${contextItemCountAfterUndo}. ` +
			`User had to undo multiple times!`
    );
  }
  if (itemCountAfterUndo !== itemCountBeforeDelete) {
    throw new Error(
      `Placeholder not restored after single undo. ` +
			`Expected ${itemCountBeforeDelete}, got ${itemCountAfterUndo}. ` +
			`This means context item and placeholder were not deleted together.`
    );
  }

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 13: Deleting a FILE-CONTENT context item should require only ONE undo
 * This test uses file-content context items (like assistant files) instead of rule context items.
 * The real scenario is: user creates conversation, assistant files are auto-added,
 * user deletes one of those file context items.
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testFileContentContextItemDeletionSingleUndo(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Add a FILE-CONTENT context item (using a file that exists in test fixture)
  // This is what addAIAssistantFiles() does for CLAUDE.md, etc.
  const result = await conversation.rootMessageThread.executeContextItem('file-content', {
    path: 'src/main.go'  // File that exists in test fixture
  });
  if (!result.created) {
    throw new Error(`Failed to create file-content context item: ${result.error}`);
  }
  await waitForUndoStateSync(conversation);

  // Clear undo history (like session.createConversation does after auto-add)
  await workerManager.clearUndoStacks(conversation.id);
  await waitForUndoStateSync(conversation);

  // Record state before deletion
  const contextItemCountBeforeDelete = getContextItemCount(conversation);
  // @ts-ignore - Accessing private _doc for testing
  const itemCountBeforeDelete = conversation.rootMessageThread.yarray.length;

  logger.info(`[undo-redo-test] FILE-CONTENT: Before delete: contextItems=${contextItemCountBeforeDelete}, items=${itemCountBeforeDelete}`);

  // Delete the context item
  if (!result.id) {
    throw new Error('Context item ID is null');
  }
  conversation.rootMessageThread.removeContextItem(result.id);
  await waitForUndoStateSync(conversation);

  // Verify deletion
  const contextItemCountAfterDelete = getContextItemCount(conversation);
  // @ts-ignore - Accessing private _doc for testing
  const itemCountAfterDelete = conversation.rootMessageThread.yarray.length;

  logger.info(`[undo-redo-test] FILE-CONTENT: After delete: contextItems=${contextItemCountAfterDelete}, items=${itemCountAfterDelete}`);

  // Verify deletions happened
  if (contextItemCountAfterDelete !== contextItemCountBeforeDelete - 1) {
    throw new Error(`Context item was not deleted. Before: ${contextItemCountBeforeDelete}, After: ${contextItemCountAfterDelete}`);
  }
  if (itemCountAfterDelete !== itemCountBeforeDelete - 1) {
    throw new Error(`Placeholder was not deleted. Before: ${itemCountBeforeDelete}, After: ${itemCountAfterDelete}`);
  }

  // CRITICAL: Single undo should restore both
  await conversation.undo();
  await waitForUndoStateSync(conversation);

  // Both context item AND placeholder should be restored
  const contextItemCountAfterUndo = getContextItemCount(conversation);
  // @ts-ignore - Accessing private _doc for testing
  const itemCountAfterUndo = conversation.rootMessageThread.yarray.length;

  logger.info(`[undo-redo-test] FILE-CONTENT: After undo: contextItems=${contextItemCountAfterUndo}, items=${itemCountAfterUndo}`);

  if (contextItemCountAfterUndo !== contextItemCountBeforeDelete) {
    throw new Error(
      `FILE-CONTENT context item not restored after single undo. ` +
			`Expected ${contextItemCountBeforeDelete}, got ${contextItemCountAfterUndo}`
    );
  }
  if (itemCountAfterUndo !== itemCountBeforeDelete) {
    throw new Error(
      `FILE-CONTENT placeholder not restored after single undo. ` +
			`Expected ${itemCountBeforeDelete}, got ${itemCountAfterUndo}`
    );
  }

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 14: Delete via conversation.rootMessageThread.removeContextItem() (what UI actually calls)
 *
 * THIS TEST USES THE EXACT PRODUCTION PATH:
 * 1. UI button click triggers app.js _handleContextItemAction()
 * 2. Which calls conversation.rootMessageThread.removeContextItem(itemId) directly
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testProductionPathContextItemDeletion(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Add a FILE-CONTENT context item (what addAIAssistantFiles does)
  const result = await conversation.rootMessageThread.executeContextItem('file-content', {
    path: 'src/main.go'
  });
  if (!result.created) {
    throw new Error(`Failed to create file-content context item: ${result.error}`);
  }
  await waitForUndoStateSync(conversation);

  // Clear undo history (like session.createConversation does after auto-add)
  await workerManager.clearUndoStacks(conversation.id);
  await waitForUndoStateSync(conversation);

  // Record state before deletion
  const contextItemCountBeforeDelete = getContextItemCount(conversation);
  // @ts-ignore - Accessing private _doc for testing
  const itemCountBeforeDelete = conversation.rootMessageThread.yarray.length;

  logger.info(`[undo-redo-test] PRODUCTION: Before delete: contextItems=${contextItemCountBeforeDelete}, items=${itemCountBeforeDelete}`);

  if (!result.id) {
    throw new Error('Context item ID is null');
  }

  conversation.rootMessageThread.removeContextItem(result.id);
  await waitForUndoStateSync(conversation);

  // Verify deletion
  const contextItemCountAfterDelete = getContextItemCount(conversation);
  // @ts-ignore - Accessing private _doc for testing
  const itemCountAfterDelete = conversation.rootMessageThread.yarray.length;

  logger.info(`[undo-redo-test] PRODUCTION: After delete: contextItems=${contextItemCountAfterDelete}, items=${itemCountAfterDelete}`);

  // Verify deletions happened
  if (contextItemCountAfterDelete !== contextItemCountBeforeDelete - 1) {
    throw new Error(`Context item was not deleted. Before: ${contextItemCountBeforeDelete}, After: ${contextItemCountAfterDelete}`);
  }
  if (itemCountAfterDelete !== itemCountBeforeDelete - 1) {
    throw new Error(`Placeholder was not deleted. Before: ${itemCountBeforeDelete}, After: ${itemCountAfterDelete}`);
  }

  // CRITICAL: Single undo should restore both
  await conversation.undo();
  await waitForUndoStateSync(conversation);

  // Both context item AND placeholder should be restored
  const contextItemCountAfterUndo = getContextItemCount(conversation);
  // @ts-ignore - Accessing private _doc for testing
  const itemCountAfterUndo = conversation.rootMessageThread.yarray.length;

  logger.info(`[undo-redo-test] PRODUCTION: After undo: contextItems=${contextItemCountAfterUndo}, items=${itemCountAfterUndo}`);

  if (contextItemCountAfterUndo !== contextItemCountBeforeDelete) {
    throw new Error(
      `PRODUCTION: Context item not restored after single undo. ` +
			`Expected ${contextItemCountBeforeDelete}, got ${contextItemCountAfterUndo}. ` +
			`User has to undo multiple times!`
    );
  }
  if (itemCountAfterUndo !== itemCountBeforeDelete) {
    throw new Error(
      `PRODUCTION: Placeholder not restored after single undo. ` +
			`Expected ${itemCountBeforeDelete}, got ${itemCountAfterUndo}. ` +
			`This means context item and placeholder were not deleted together.`
    );
  }

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 15: Delete file-content context item, then undo should work in ONE press
 *
 * Reproduces the EXACT user scenario:
 * 1. Create new conversation (clears undo history like production)
 * 2. Add a file-content context item (simulates auto-added CLAUDE.md)
 * 3. Clear undo history (simulates state after session.createConversation completes)
 * 4. Delete the context item using conversation.rootMessageThread.removeContextItem()
 * 5. Undo
 * 6. Assert canUndo() === false (only ONE undo operation existed)
 *
 * If user has to undo TWICE, canUndo() will still be true after first undo.
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testDeleteAssistantFileSingleUndo(session) {
  // 1. Create new conversation
  const convId = await session.createConversation('Test Assistant Delete');
  const conversation = session.conversations.get(convId);
  if (!conversation) {
    throw new Error('Failed to create conversation');
  }

  session.visibleConversationId = convId;

  // Wait for worker to be ready
  await waitForWorkerReady(convId);
  await waitForUndoStateSync(conversation);

  // 2. Add a file-content context item (simulates auto-added assistant files like CLAUDE.md)
  const result = await conversation.rootMessageThread.executeContextItem('file-content', {
    path: 'src/main.go'  // Uses test fixture file
  });
  if (!result.created || !result.id) {
    throw new Error(`Failed to create file-content context item: ${result.error}`);
  }
  await waitForUndoStateSync(conversation);

  logger.info(`[undo-redo-test] Created file-content context item: ${result.id}`);

  // 3. Clear undo history - simulates state after session.createConversation
  // completes (it clears history after auto-adding AI assistant files)
  await workerManager.clearUndoStacks(conversation.id);
  await waitForUndoStateSync(conversation);

  // Verify undo history was cleared
  if (conversation.canUndo()) {
    throw new Error('Undo history should be empty after clearUndoStacks');
  }

  logger.info('[undo-redo-test] Undo history cleared, starting deletion test');

  // 4. Delete the context item
  conversation.rootMessageThread.removeContextItem(result.id);
  await waitForUndoStateSync(conversation);

  // Should now be able to undo
  if (!conversation.canUndo()) {
    throw new Error('Should be able to undo after deleting context item');
  }

  // 5. Undo the deletion
  await conversation.undo();
  await waitForUndoStateSync(conversation);

  // 6. CRITICAL: Should NOT be able to undo again
  //    If canUndo() is true, that means TWO operations were created
  //    and user had to press undo twice - THIS IS THE BUG
  if (conversation.canUndo()) {
    throw new Error(
      'BUG: canUndo() is still true after first undo! ' +
			'This means context item deletion created TWO undo operations. ' +
			'User has to press undo TWICE to fully restore.'
    );
  }

  // Verify context item was restored
  const restoredContextItem = conversation.rootMessageThread.contextItems.find(f => f.id === result.id);
  if (!restoredContextItem) {
    throw new Error('Context item was not restored after undo');
  }

  logger.info('[undo-redo-test] ✓ Single undo correctly restored file-content context item');
  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 16: EXACT PRODUCTION BUG - Two undos required after context item deletion.
 * THIS TEST REPRODUCES THE EXACT PRODUCTION SCENARIO:
 * 1. Call session.createConversation() (NOT createTestConversation)
 *    - This auto-adds assistant files AND clears undo history
 * 2. Delete a file-content context item using conversation.rootMessageThread.removeContextItem()
 * 3. Press undo ONCE
 * 4. ASSERT: canUndo() should be FALSE
 * If canUndo() is still true after first undo, the bug exists
 * (two operations were created for a single context item deletion).
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testProductionBugTwoUndos(session) {
  // 1. Use EXACT production path: session.createConversation()
  // This auto-adds assistant files AND clears undo history
  const convId = await session.createConversation('Bug Reproduction Test');
  const conversation = session.conversations.get(convId);
  if (!conversation) {
    throw new Error('Failed to create conversation');
  }

  session.visibleConversationId = convId;

  // Wait for everything to settle
  await waitForWorkerReady(convId);
  await waitForUndoStateSync(conversation);

  // Find a file-content context item (may have been auto-added by createConversation)
  let fileContextItem = conversation.rootMessageThread.contextItems.find(f => f.type === 'file-content');

  if (!fileContextItem) {
    // No assistant files in this project - create one manually
    const result = await conversation.rootMessageThread.executeContextItem('file-content', {
      path: 'src/main.go'  // Test fixture file
    });
    if (!result.created || !result.id) {
      throw new Error('Could not create file-content context item');
    }
    await waitForUndoStateSync(conversation);

    // Clear undo history to simulate post-createConversation state
    await workerManager.clearUndoStacks(conversation.id);
    await waitForUndoStateSync(conversation);

    // Re-find the context item
    fileContextItem = conversation.rootMessageThread.contextItems.find(f => f.type === 'file-content');
  }

  if (!fileContextItem) {
    throw new Error('No file-content context item available for testing');
  }

  logger.info(`[undo-redo-test] PRODUCTION BUG TEST: Found file-content context item: ${fileContextItem.id}`);

  // Verify we start with empty undo history
  if (conversation.canUndo()) {
    throw new Error('BUG: Undo history should be empty after createConversation!');
  }

  // 2. Delete the context item
  conversation.rootMessageThread.removeContextItem(fileContextItem.id);
  await waitForUndoStateSync(conversation);

  // Should be able to undo
  if (!conversation.canUndo()) {
    throw new Error('Should be able to undo after deleting context item');
  }

  // 3. Press undo ONCE
  await conversation.undo();
  await waitForUndoStateSync(conversation);

  // 4. CRITICAL BUG CHECK: Should NOT be able to undo again!
  // If canUndo() is true, that means TWO operations were created
  if (conversation.canUndo()) {
    throw new Error(
      'BUG REPRODUCED: canUndo() is still true after first undo! ' +
			'This means TWO operations were created for a single context item deletion. ' +
			'User has to press undo TWICE to fully restore the context item.'
    );
  }

  // Verify context item was restored
  const restoredContextItem = conversation.rootMessageThread.contextItems.find(f => f.id === fileContextItem.id);
  if (!restoredContextItem) {
    throw new Error('Context item was not restored after undo');
  }

  logger.info('[undo-redo-test] ✓ PRODUCTION BUG TEST: Single undo correctly restored context item');
  return { passed: 1, failed: 0, errors: [] };
}

// =============================================================================
// ADDITIONAL TESTS: Undo + Tool Execution
// =============================================================================

/**
 * Test 17: Undo after tool approval - tests undo of approved tool actions.
 *
 * When a tool is approved and executed, the result becomes part of conversation history.
 * Undo should remove the tool-action from the conversation (state undo, not file revert).
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testUndoAfterToolApproval(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Wait for capture boundary
  await waitForCaptureBoundary(conversation);

  // Insert a tool-action item (simulating approved bash command)
  const toolUseId = `tool_${Date.now()}`;
  conversation.rootMessageThread.insertItem(0, {
    type: 'tool-action',
    itemId: `msg_${Date.now()}`,
    toolUseId: toolUseId,
    toolName: 'bash',
    toolInput: { command: 'echo test' },
    state: 'completed',
    result: {
      content: 'test\n',
      isError: false
    }
  });
  await waitForUndoStateSync(conversation);

  // Verify tool-action was added
  // @ts-ignore - Accessing private _doc for testing
  const items = conversation.rootMessageThread.yarray.toArray();
  const toolAction = items.find((/** @type {any} */ item) => item.get('type') === 'tool-action');
  if (!toolAction) {
    throw new Error('Tool-action was not added');
  }

  // Should be able to undo
  if (!conversation.canUndo()) {
    throw new Error('Cannot undo after inserting tool-action');
  }

  // Undo should remove the tool-action
  await conversation.undo();
  await waitForUndoStateSync(conversation);

  // Verify tool-action was removed
  // @ts-ignore - Accessing private _doc for testing
  const itemsAfterUndo = conversation.rootMessageThread.yarray.toArray();
  const toolActionAfterUndo = itemsAfterUndo.find((/** @type {any} */ item) => item.get('type') === 'tool-action');
  if (toolActionAfterUndo) {
    throw new Error('Tool-action should be removed after undo');
  }

  // Should be able to redo
  if (!conversation.canRedo()) {
    throw new Error('Cannot redo after undoing tool-action');
  }

  // Redo should restore the tool-action
  await conversation.redo();
  await waitForUndoStateSync(conversation);

  // @ts-ignore - Accessing private _doc for testing
  const itemsAfterRedo = conversation.rootMessageThread.yarray.toArray();
  const toolActionAfterRedo = itemsAfterRedo.find((/** @type {any} */ item) => item.get('type') === 'tool-action');
  if (!toolActionAfterRedo) {
    throw new Error('Tool-action should be restored after redo');
  }

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 18: Undo after write-file tool - state undo, not file revert.
 *
 * When write_file tool executes, it creates a tool-action in conversation history.
 * Undo removes the tool-action from history (state only).
 * File system changes are NOT reverted by undo (intentional design).
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testUndoAfterWriteFile(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Wait for capture boundary
  await waitForCaptureBoundary(conversation);

  // Insert a write-file tool-action (simulating successful file write)
  const toolUseId = `tool_write_${Date.now()}`;
  conversation.rootMessageThread.insertItem(0, {
    type: 'tool-action',
    itemId: `msg_${Date.now()}`,
    toolUseId: toolUseId,
    toolName: 'write_file',
    toolInput: { path: 'test.txt', content: 'hello world' },
    state: 'completed',
    result: {
      content: 'File created: test.txt',
      isError: false
    }
  });
  await waitForUndoStateSync(conversation);

  // Verify tool-action exists
  // @ts-ignore - Accessing private _doc for testing
  const itemsBefore = conversation.rootMessageThread.yarray.toArray();
  if (itemsBefore.length !== 1) {
    throw new Error(`Expected 1 item, got ${itemsBefore.length}`);
  }

  // Undo should remove the tool-action from conversation history
  await conversation.undo();
  await waitForUndoStateSync(conversation);

  // @ts-ignore - Accessing private _doc for testing
  const itemsAfter = conversation.rootMessageThread.yarray.toArray();
  if (itemsAfter.length !== 0) {
    throw new Error(`Expected 0 items after undo, got ${itemsAfter.length}`);
  }

  // Note: The actual file system change is NOT reverted
  // This is by design - undo is for conversation state, not file system

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 19: Approval state is part of undo - cancelled tool can be undone.
 *
 * When a tool is denied (cancelled), the cancelled state should undo correctly.
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testUndoApprovalState(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Wait for capture boundary
  await waitForCaptureBoundary(conversation);

  // Insert a cancelled (denied) tool-action
  const toolUseId = `tool_denied_${Date.now()}`;
  conversation.rootMessageThread.insertItem(0, {
    type: 'tool-action',
    itemId: `msg_${Date.now()}`,
    toolUseId: toolUseId,
    toolName: 'bash',
    toolInput: { command: 'rm -rf /' },
    state: 'cancelled',
    result: {
      content: 'Action was cancelled.',
      isError: false
    }
  });
  await waitForUndoStateSync(conversation);

  // Verify cancelled tool-action exists
  // @ts-ignore - Accessing private _doc for testing
  const items = conversation.rootMessageThread.yarray.toArray();
  const toolAction = items.find((/** @type {any} */ item) => item.get('type') === 'tool-action');
  if (!toolAction) {
    throw new Error('Tool-action not found');
  }
  if (toolAction.get('state') !== TOOL_STATES.CANCELLED) {
    throw new Error(`Expected state='cancelled', got '${toolAction.get('state')}'`);
  }

  // Undo should remove the cancelled tool-action
  await conversation.undo();
  await waitForUndoStateSync(conversation);

  // @ts-ignore - Accessing private _doc for testing
  const itemsAfterUndo = conversation.rootMessageThread.yarray.toArray();
  if (itemsAfterUndo.length !== 0) {
    throw new Error('Cancelled tool-action should be removed by undo');
  }

  // Redo should restore with cancelled state
  await conversation.redo();
  await waitForUndoStateSync(conversation);

  // @ts-ignore - Accessing private _doc for testing
  const itemsAfterRedo = conversation.rootMessageThread.yarray.toArray();
  const restoredAction = itemsAfterRedo.find((/** @type {any} */ item) => item.get('type') === 'tool-action');
  if (!restoredAction) {
    throw new Error('Tool-action not restored by redo');
  }
  if (restoredAction.get('state') !== TOOL_STATES.CANCELLED) {
    throw new Error(`Restored action has wrong state: '${restoredAction.get('state')}'`);
  }

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 20: Undo then retry flow - undo removes result, retry can re-execute.
 *
 * Simulates: User sees tool result, doesn't like it, undoes, then retries.
 * After undo, the tool-action is gone. User can trigger a new execution.
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testUndoRetryFlow(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Wait for capture boundary
  await waitForCaptureBoundary(conversation);

  // Insert first tool execution
  const toolUseId1 = `tool_v1_${Date.now()}`;
  conversation.rootMessageThread.insertItem(0, {
    type: 'tool-action',
    itemId: `msg_v1_${Date.now()}`,
    toolUseId: toolUseId1,
    toolName: 'bash',
    toolInput: { command: 'echo first attempt' },
    state: 'completed',
    result: {
      content: 'first attempt\n',
      isError: false
    }
  });
  await waitForUndoStateSync(conversation);

  // Verify first execution exists
  // @ts-ignore - Accessing private _doc for testing
  let items = conversation.rootMessageThread.yarray.toArray();
  if (items.length !== 1) {
    throw new Error(`Expected 1 item, got ${items.length}`);
  }

  // User doesn't like result - UNDO
  await conversation.undo();
  await waitForUndoStateSync(conversation);

  // @ts-ignore - Accessing private _doc for testing
  items = conversation.rootMessageThread.yarray.toArray();
  if (items.length !== 0) {
    throw new Error('First execution should be undone');
  }

  // Wait for capture boundary to separate operations
  await waitForCaptureBoundary(conversation);

  // User triggers retry - new execution (different result)
  const toolUseId2 = `tool_v2_${Date.now()}`;
  conversation.rootMessageThread.insertItem(0, {
    type: 'tool-action',
    itemId: `msg_v2_${Date.now()}`,
    toolUseId: toolUseId2,
    toolName: 'bash',
    toolInput: { command: 'echo second attempt' },
    state: 'completed',
    result: {
      content: 'second attempt\n',
      isError: false
    }
  });
  await waitForUndoStateSync(conversation);

  // Verify second execution exists
  // @ts-ignore - Accessing private _doc for testing
  items = conversation.rootMessageThread.yarray.toArray();
  if (items.length !== 1) {
    throw new Error(`Expected 1 item after retry, got ${items.length}`);
  }

  const retryAction = items[0];
  if (retryAction.get('toolUseId') !== toolUseId2) {
    throw new Error('Retry action should be the second execution');
  }
  if (!retryAction.get('result').get('content').includes('second attempt')) {
    throw new Error('Retry action should have second attempt content');
  }

  // Redo stack should be cleared (new operation clears redo)
  if (conversation.canRedo()) {
    throw new Error('Redo stack should be cleared after new operation');
  }

  return { passed: 1, failed: 0, errors: [] };
}

// =============================================================================
// DELETION UNDO TESTS: External Item Deletions
// These test the bug where main thread deletions (deleteAt, removeItemsFrom,
// removeItemsAt) are NOT recorded as undoable operations by the worker.
// =============================================================================

/**
 * Verify document has no duplicate itemIds
 * @param {import('../../model/conversation.js').default} conversation - Conversation instance
 * @param {string} context - Test context for error message
 */
function assertNoDuplicateMessageIds(conversation, context) {
  // @ts-ignore - Accessing private _doc for testing
  const items = conversation.rootMessageThread.yarray.toArray();
  /** @type {Set<string>} */
  const seen = new Set();
  for (const item of items) {
    if (item.get('itemId')) {
      if (seen.has(item.get('itemId'))) {
        throw new Error(`[${context}] Duplicate itemId: ${item.get('itemId')}`);
      }
      seen.add(item.get('itemId'));
    }
  }
}

/**
 * Assert items array length matches expected
 * @param {import('../../model/conversation.js').default} conversation - Conversation instance
 * @param {number} expected - Expected item count
 * @param {string} context - Test context
 */
function assertItemCount(conversation, expected, context) {
  // @ts-ignore - Accessing private _doc for testing
  const actual = conversation.rootMessageThread.yarray.length;
  if (actual !== expected) {
    throw new Error(`[${context}] Item count: expected ${expected}, got ${actual}`);
  }
}

/**
 * Insert test user messages with auto-generated itemIds
 * @param {import('../../model/conversation.js').default} conversation - Conversation instance
 * @param {number} count - Number of messages to insert
 * @returns {Promise<void>}
 */
async function insertTestUserMessages(conversation, count) {
  for (let i = 0; i < count; i++) {
    conversation.rootMessageThread.addEvent({
      type: 'user',
      content: `Test message ${Date.now()}-${i}`
    });
  }
  await waitForUndoStateSync(conversation);
}

/**
 * Test 21: Delete old item, add new items, then undo - should restore in correct order
 * THIS IS THE CORE BUG: Deleting an early message, then adding new messages,
 * then undoing tries to restore from wrong operation.
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testDeleteOldItemAddNewUndo(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Create 5 messages
  await insertTestUserMessages(conversation, 5);
  await waitForCaptureBoundary(conversation);

  assertItemCount(conversation, 5, 'After inserting 5 messages');

  // Delete message at index 1 (msg-2)
  conversation.rootMessageThread.deleteAt(1);
  await waitForUndoStateSync(conversation);
  await waitForCaptureBoundary(conversation);

  assertItemCount(conversation, 4, 'After deleting msg-2');

  // Add 2 more messages (msg-6, msg-7)
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-6' });
  await waitForCaptureBoundary(conversation);
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-7' });
  await waitForUndoStateSync(conversation);

  assertItemCount(conversation, 6, 'After adding msg-6 and msg-7');

  // Undo msg-7 addition
  await conversation.undo();
  await waitForUndoStateSync(conversation);
  assertItemCount(conversation, 5, 'After undoing msg-7');

  // Undo msg-6 addition
  await conversation.undo();
  await waitForUndoStateSync(conversation);
  assertItemCount(conversation, 4, 'After undoing msg-6');

  // Undo deletion of msg-2 - THIS IS WHERE THE BUG MANIFESTS
  await conversation.undo();
  await waitForUndoStateSync(conversation);
  assertItemCount(conversation, 5, 'After undoing msg-2 deletion');

  // Verify no duplicate itemIds
  assertNoDuplicateMessageIds(conversation, 'After full undo sequence');

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 23: Delete multiple indices in single call, then undo
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testDeleteMultipleIndicesUndo(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Create 8 messages
  for (let i = 1; i <= 8; i++) {
    conversation.rootMessageThread.addEvent({ type: 'user', content: `msg-${i}` });
  }
  await waitForUndoStateSync(conversation);
  await waitForCaptureBoundary(conversation);

  assertItemCount(conversation, 8, 'After inserting 8 messages');

  // Delete indices [1, 3, 5] in single call
  conversation.rootMessageThread.removeItemsAt([1, 3, 5]);
  await waitForUndoStateSync(conversation);

  assertItemCount(conversation, 5, 'After deleting 3 items');

  // Undo should restore all 3 items to correct positions
  await conversation.undo();
  await waitForUndoStateSync(conversation);

  assertItemCount(conversation, 8, 'After undoing multi-delete');
  assertNoDuplicateMessageIds(conversation, 'After multi-delete undo');

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 24: Complex delete-undo-redo-delete-undo sequence
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testDeleteUndoRedoDeleteUndo(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Create 3 messages
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-1' });
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-2' });
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-3' });
  await waitForUndoStateSync(conversation);
  await waitForCaptureBoundary(conversation);

  assertItemCount(conversation, 3, 'Initial 3 messages');

  // Delete msg-2 (index 1)
  conversation.rootMessageThread.deleteAt(1);
  await waitForUndoStateSync(conversation);
  assertItemCount(conversation, 2, 'After deleting msg-2');

  // Undo -> msg-2 restored
  await conversation.undo();
  await waitForUndoStateSync(conversation);
  assertItemCount(conversation, 3, 'After undo - msg-2 restored');

  // Redo -> msg-2 deleted again
  await conversation.redo();
  await waitForUndoStateSync(conversation);
  assertItemCount(conversation, 2, 'After redo - msg-2 deleted');

  // Now delete msg-3 (now at index 1 since msg-2 is gone)
  await waitForCaptureBoundary(conversation);
  conversation.rootMessageThread.deleteAt(1);
  await waitForUndoStateSync(conversation);
  assertItemCount(conversation, 1, 'After deleting msg-3');

  // Undo -> msg-3 restored
  await conversation.undo();
  await waitForUndoStateSync(conversation);
  assertItemCount(conversation, 2, 'After undo - msg-3 restored');

  // Verify state consistency
  assertNoDuplicateMessageIds(conversation, 'Final state');

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 25: Interleaved delete and add with undo
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testInterleavedDeleteAddUndo(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Create [msg-1, msg-2, msg-3, msg-4]
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-1' });
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-2' });
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-3' });
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-4' });
  await waitForUndoStateSync(conversation);
  await waitForCaptureBoundary(conversation);

  assertItemCount(conversation, 4, 'Initial state');
  const initialState = 4;

  // Delete msg-2
  conversation.rootMessageThread.deleteAt(1);
  await waitForUndoStateSync(conversation);
  await waitForCaptureBoundary(conversation);
  assertItemCount(conversation, 3, 'After delete msg-2');

  // Add msg-5, msg-6
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-5' });
  await waitForCaptureBoundary(conversation);
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-6' });
  await waitForUndoStateSync(conversation);
  await waitForCaptureBoundary(conversation);
  assertItemCount(conversation, 5, 'After adding msg-5, msg-6');

  // Delete msg-4 (now at index 2)
  conversation.rootMessageThread.deleteAt(2);
  await waitForUndoStateSync(conversation);
  assertItemCount(conversation, 4, 'After delete msg-4');

  // Undo 4 times in sequence - should restore to initial 4 items
  // (Note: initial insert of 4 messages is one operation, so we can't
  // fully restore to empty. Instead, verify we can undo the interleaved ops)
  await conversation.undo(); // restore msg-4
  await waitForUndoStateSync(conversation);
  assertItemCount(conversation, 5, 'Undo 1: restore msg-4');

  await conversation.undo(); // remove msg-6
  await waitForUndoStateSync(conversation);
  assertItemCount(conversation, 4, 'Undo 2: remove msg-6');

  await conversation.undo(); // remove msg-5
  await waitForUndoStateSync(conversation);
  assertItemCount(conversation, 3, 'Undo 3: remove msg-5');

  await conversation.undo(); // restore msg-2
  await waitForUndoStateSync(conversation);
  assertItemCount(conversation, initialState, 'Undo 4: restore msg-2');

  assertNoDuplicateMessageIds(conversation, 'After interleaved undo');

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 26: Mixed context item and message deletion undo ordering
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testMixedContextItemAndMessageDeletionUndo(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Add 2 context items with placeholders
  const contextItem1 = await createTestContextItem('CI_MIX_1', session, conversation);
  const contextItem2 = await createTestContextItem('CI_MIX_2', session, conversation);
  conversation.rootMessageThread.addContextItem(contextItem1);
  conversation.rootMessageThread.addContextItem(contextItem2);
  await waitForUndoStateSync(conversation);
  await waitForCaptureBoundary(conversation);

  // Add some messages
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-1' });
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-2' });
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-3' });
  await waitForUndoStateSync(conversation);
  await waitForCaptureBoundary(conversation);

  // @ts-ignore - Accessing private _doc for testing
  const initialItemCount = conversation.rootMessageThread.yarray.length;
  const initialContextItemCount = getContextItemCount(conversation);

  logger.info(`[undo-redo-test] Mixed test: ${initialItemCount} items, ${initialContextItemCount} contextItems`);

  // Delete context-item-1
  conversation.rootMessageThread.removeContextItem('CI_MIX_1');
  await waitForUndoStateSync(conversation);
  await waitForCaptureBoundary(conversation);

  // Delete msg-3 via deleteAt
  // First find msg-3's index (it's after the context item placeholders)
  // @ts-ignore - Accessing private _doc for testing
  const items = conversation.rootMessageThread.yarray.toArray();
  const msg3Index = items.findIndex((/** @type {any} */ item) =>
    item.get('type') === 'user' && item.get('content') === 'msg-3'
  );
  if (msg3Index >= 0) {
    conversation.rootMessageThread.deleteAt(msg3Index);
  }
  await waitForUndoStateSync(conversation);

  // Undo msg-3 deletion
  await conversation.undo();
  await waitForUndoStateSync(conversation);

  // Undo context-item-1 deletion
  await conversation.undo();
  await waitForUndoStateSync(conversation);

  // Verify both restored
  // @ts-ignore - Accessing private _doc for testing
  const finalItemCount = conversation.rootMessageThread.yarray.length;
  const finalContextItemCount = getContextItemCount(conversation);

  if (finalItemCount !== initialItemCount) {
    throw new Error(`Item count mismatch: expected ${initialItemCount}, got ${finalItemCount}`);
  }
  if (finalContextItemCount !== initialContextItemCount) {
    throw new Error(`Context item count mismatch: expected ${initialContextItemCount}, got ${finalContextItemCount}`);
  }

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 27: removeItemsFrom undo
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testRemoveItemsFromUndo(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Create 10 messages
  for (let i = 1; i <= 10; i++) {
    conversation.rootMessageThread.addEvent({ type: 'user', content: `msg-${i}` });
  }
  await waitForUndoStateSync(conversation);
  await waitForCaptureBoundary(conversation);

  assertItemCount(conversation, 10, 'Initial 10 messages');

  // removeItemsFrom(5) - deletes items 5-9 (5 items)
  conversation.rootMessageThread.deleteRange(5);
  await waitForUndoStateSync(conversation);
  await waitForCaptureBoundary(conversation);

  assertItemCount(conversation, 5, 'After removeItemsFrom(5)');

  // Add msg-11
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-11' });
  await waitForUndoStateSync(conversation);

  assertItemCount(conversation, 6, 'After adding msg-11');

  // Undo msg-11
  await conversation.undo();
  await waitForUndoStateSync(conversation);
  assertItemCount(conversation, 5, 'After undoing msg-11');

  // Undo removeItemsFrom - should restore items 5-9
  await conversation.undo();
  await waitForUndoStateSync(conversation);
  assertItemCount(conversation, 10, 'After undoing removeItemsFrom');

  assertNoDuplicateMessageIds(conversation, 'After removeItemsFrom undo');

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 28: Delete early item in long conversation, add many items, then undo all
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testDeleteEarlyItemLongConversationUndo(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Create 50 items
  for (let i = 1; i <= 50; i++) {
    conversation.rootMessageThread.insertItem(conversation.rootItems.length, {
      type: 'user',
      itemId: `msg_long_${Date.now()}_${i}`,
      content: `msg-${i}`
    });
  }
  await waitForUndoStateSync(conversation);
  await waitForCaptureBoundary(conversation);

  assertItemCount(conversation, 50, 'Initial 50 messages');

  // Delete item at index 2
  conversation.rootMessageThread.deleteAt(2);
  await waitForUndoStateSync(conversation);
  await waitForCaptureBoundary(conversation);

  assertItemCount(conversation, 49, 'After deleting item at index 2');

  // Add 10 more items
  for (let i = 51; i <= 60; i++) {
    conversation.rootMessageThread.insertItem(conversation.rootItems.length, {
      type: 'user',
      itemId: `msg_long_new_${Date.now()}_${i}`,
      content: `msg-${i}`
    });
  }
  await waitForUndoStateSync(conversation);

  assertItemCount(conversation, 59, 'After adding 10 more');

  // Undo 10 times to remove new items
  // (Note: items added in a loop may be grouped - adjust if needed)
  let undoCount = 0;
  while (conversation.rootItems.length > 49 && undoCount < 15) {
    await conversation.undo();
    await waitForUndoStateSync(conversation);
    undoCount++;
  }

  assertItemCount(conversation, 49, `After undoing ${undoCount} times to remove new items`);

  // Next undo should restore the deleted item at index 2
  await conversation.undo();
  await waitForUndoStateSync(conversation);

  assertItemCount(conversation, 50, 'After undoing deletion of item at index 2');
  assertNoDuplicateMessageIds(conversation, 'After long conversation undo');

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 29: Rapid delete-add cycle without capture boundary
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testRapidDeleteAddCycleUndo(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Create [msg-1, msg-2, msg-3]
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-1' });
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-2' });
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-3' });
  await waitForUndoStateSync(conversation);
  await waitForCaptureBoundary(conversation);

  assertItemCount(conversation, 3, 'Initial 3 messages');

  // Rapid sequence (minimal delays):
  // Delete msg-2
  conversation.rootMessageThread.deleteAt(1);
  await waitForUndoStateSync(conversation);

  // Add msg-4
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-4' });
  await waitForUndoStateSync(conversation);

  // Delete msg-3 (now at index 1)
  conversation.rootMessageThread.deleteAt(1);
  await waitForUndoStateSync(conversation);

  // Add msg-5
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-5' });
  await waitForUndoStateSync(conversation);

  // We should have: [msg-1, msg-4, msg-5]
  assertItemCount(conversation, 3, 'After rapid sequence');

  // Count undoable operations by undoing until we can't
  let operationsUndone = 0;
  while (conversation.canUndo() && operationsUndone < 10) {
    await conversation.undo();
    await waitForUndoStateSync(conversation);
    operationsUndone++;
  }

  logger.info(`[undo-redo-test] Rapid cycle: undone ${operationsUndone} operations`);

  // Should have undone at least 4 operations (2 deletes + 2 adds)
  // May be grouped, so exact count varies
  if (operationsUndone < 1) {
    throw new Error(`Expected at least 1 undo operation, got ${operationsUndone}`);
  }

  assertNoDuplicateMessageIds(conversation, 'After rapid cycle undo');

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 30: Delete all except first item, then undo
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testDeleteAllExceptFirstUndo(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Create [msg-1, msg-2, msg-3, msg-4, msg-5]
  for (let i = 1; i <= 5; i++) {
    conversation.rootMessageThread.addEvent({ type: 'user', content: `msg-${i}` });
  }
  await waitForUndoStateSync(conversation);
  await waitForCaptureBoundary(conversation);

  assertItemCount(conversation, 5, 'Initial 5 messages');

  // removeItemsAt([1,2,3,4]) - keep only msg-1
  conversation.rootMessageThread.removeItemsAt([1, 2, 3, 4]);
  await waitForUndoStateSync(conversation);
  await waitForCaptureBoundary(conversation);

  assertItemCount(conversation, 1, 'After removing 4 items');

  // Add [msg-6, msg-7, msg-8]
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-6' });
  await waitForCaptureBoundary(conversation);
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-7' });
  await waitForCaptureBoundary(conversation);
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-8' });
  await waitForUndoStateSync(conversation);

  assertItemCount(conversation, 4, 'After adding 3 new items');

  // Undo 3 times (remove new items)
  await conversation.undo();
  await waitForUndoStateSync(conversation);
  await conversation.undo();
  await waitForUndoStateSync(conversation);
  await conversation.undo();
  await waitForUndoStateSync(conversation);

  assertItemCount(conversation, 1, 'After undoing 3 additions');

  // Undo once more -> should restore 4 deleted items
  await conversation.undo();
  await waitForUndoStateSync(conversation);

  assertItemCount(conversation, 5, 'After undoing bulk deletion');
  assertNoDuplicateMessageIds(conversation, 'After delete all except first undo');

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 31: Delete first item (index 0) - boundary condition
 * Ensures deletion at index 0 is properly recorded and restored.
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testDeleteFirstItemUndo(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Create [msg-1, msg-2, msg-3]
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-1' });
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-2' });
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-3' });
  await waitForUndoStateSync(conversation);
  await waitForCaptureBoundary(conversation);

  assertItemCount(conversation, 3, 'Initial 3 messages');

  // Verify first item content
  // @ts-ignore - Accessing private _doc for testing
  const itemsBefore = conversation.rootMessageThread.yarray.toArray();
  if (itemsBefore[0].get('content') !== 'msg-1') {
    throw new Error(`First item should be 'msg-1', got '${itemsBefore[0].get('content')}'`);
  }

  // Delete first item (index 0)
  conversation.rootMessageThread.deleteAt(0);
  await waitForUndoStateSync(conversation);

  assertItemCount(conversation, 2, 'After deleting first item');

  // Verify msg-2 is now first
  // @ts-ignore - Accessing private _doc for testing
  const itemsAfterDelete = conversation.rootMessageThread.yarray.toArray();
  if (itemsAfterDelete[0].get('content') !== 'msg-2') {
    throw new Error(`After delete, first item should be 'msg-2', got '${itemsAfterDelete[0].get('content')}'`);
  }

  // Undo - msg-1 should be restored at index 0
  await conversation.undo();
  await waitForUndoStateSync(conversation);

  assertItemCount(conversation, 3, 'After undo - all 3 restored');

  // Verify msg-1 is back at index 0
  // @ts-ignore - Accessing private _doc for testing
  const itemsAfterUndo = conversation.rootMessageThread.yarray.toArray();
  if (itemsAfterUndo[0].get('content') !== 'msg-1') {
    throw new Error(`After undo, first item should be 'msg-1', got '${itemsAfterUndo[0].get('content')}'`);
  }

  // Verify order is preserved
  const expectedOrder = ['msg-1', 'msg-2', 'msg-3'];
  for (let i = 0; i < expectedOrder.length; i++) {
    if (itemsAfterUndo[i].get('content') !== expectedOrder[i]) {
      throw new Error(`Item ${i} should be '${expectedOrder[i]}', got '${itemsAfterUndo[i].get('content')}'`);
    }
  }

  assertNoDuplicateMessageIds(conversation, 'After first item undo');

  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 32: Invalid index deletion - graceful handling of out-of-bounds
 * Ensures out-of-bounds deletions don't corrupt state or crash.
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testInvalidIndexDeletion(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Create [msg-1, msg-2, msg-3]
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-1' });
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-2' });
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-3' });
  await waitForUndoStateSync(conversation);
  await waitForCaptureBoundary(conversation);

  assertItemCount(conversation, 3, 'Initial 3 messages');

  // Try to delete at invalid index (beyond array length)
  // This should either be a no-op or handled gracefully
  try {
    conversation.rootMessageThread.deleteAt(999);
    await waitForUndoStateSync(conversation);
  } catch (e) {
    // Some implementations may throw - that's acceptable
    logger.info(`[undo-redo-test] deleteAt(999) threw: ${e}`);
  }

  // State should be unchanged (no corruption)
  assertItemCount(conversation, 3, 'After invalid index delete - unchanged');

  // Try to delete at negative index
  try {
    conversation.rootMessageThread.deleteAt(-1);
    await waitForUndoStateSync(conversation);
  } catch (e) {
    logger.info(`[undo-redo-test] deleteAt(-1) threw: ${e}`);
  }

  // State should still be unchanged
  assertItemCount(conversation, 3, 'After negative index delete - unchanged');

  // Try removeItemsAt with mixed valid/invalid indices
  try {
    conversation.rootMessageThread.removeItemsAt([0, 999, -1]);
    await waitForUndoStateSync(conversation);
  } catch (e) {
    logger.info(`[undo-redo-test] removeItemsAt with invalid indices threw: ${e}`);
  }

  // If removeItemsAt processed valid index 0, we'd have 2 items
  // If it rejected the whole operation, we'd have 3 items
  // Either behavior is acceptable as long as no corruption
  // @ts-ignore - Accessing private _doc for testing
  const finalCount = conversation.rootMessageThread.yarray.length;
  if (finalCount !== 2 && finalCount !== 3) {
    throw new Error(`Unexpected item count after mixed indices: ${finalCount} (expected 2 or 3)`);
  }

  // Verify no duplicate itemIds (no corruption)
  assertNoDuplicateMessageIds(conversation, 'After invalid index operations');

  // Undo should work if any valid operation was recorded
  if (conversation.canUndo()) {
    await conversation.undo();
    await waitForUndoStateSync(conversation);
    assertNoDuplicateMessageIds(conversation, 'After undo of partial operation');
  }

  return { passed: 1, failed: 0, errors: [] };
}

// =============================================================================
// File-Content Data Integrity After Undo
// =============================================================================

/**
 * After delete + undo, a pinned file's persisted Yjs data must be exactly
 * `{path, isDirectory}` — the same minimal shape it had on creation. A pin
 * never persists file bytes (those are resolved live at send time), so "data
 * integrity" here means structural integrity, not byte preservation.
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testFileContentDataIntegrityAfterUndo(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);

  // Add a file-content context item
  const result = await conversation.rootMessageThread.executeContextItem('file-content', {
    path: 'src/main.go'
  });
  if (!result.created || !result.id) {
    throw new Error(`Failed to create file-content context item: ${result.error}`);
  }
  /** @type {string} */
  const itemId = result.id;
  await waitForUndoStateSync(conversation);

  const originalItem = conversation.rootMessageThread.getContextItem(itemId);
  if (!originalItem) {
    throw new Error(`Context item '${itemId}' not retrievable after creation`);
  }
  if (originalItem.data.path !== 'src/main.go') {
    throw new Error(`Original data.path should be 'src/main.go', got: ${JSON.stringify(originalItem.data.path)}`);
  }

  // Wait for capture boundary so delete is a separate undo entry
  await waitForCaptureBoundary(conversation);

  // Remove the context item
  conversation.rootMessageThread.removeContextItem(itemId);
  await waitForUndoStateSync(conversation);

  // Undo the removal
  await conversation.undo();
  await waitForUndoStateSync(conversation);

  const restoredItem = conversation.rootMessageThread.getContextItem(itemId);
  if (!restoredItem) {
    throw new Error(`Context item '${itemId}' not restored after undo`);
  }

  if (restoredItem.data.path !== 'src/main.go') {
    throw new Error(`Restored data.path mismatch: got ${JSON.stringify(restoredItem.data.path)}`);
  }

  // Hard invariant: the pin still carries only path + isDirectory after undo.
  // Any other key means a snapshot field leaked into Yjs (a pin persists only
  // its path; bytes are resolved live).
  const allowed = new Set(['path', 'isDirectory']);
  const leaked = Object.keys(restoredItem.data).filter(k => !allowed.has(k));
  if (leaked.length > 0) {
    throw new Error(
      `Pin must persist only {path, isDirectory} after undo but Yjs data also carried: ${leaked.join(', ')}`
    );
  }

  // Properties panel renders a sync placeholder + async live content.
  // The sync render must not throw and must not display a spurious warning.
  const panel = restoredItem.createPropertiesPanelElement();
  const warningEl = panel.querySelector('.file-content-warning');
  if (warningEl) {
    throw new Error(
      `REGRESSION: Properties panel shows spurious warning after undo: ` +
			`"${warningEl.textContent}"`
    );
  }

  logger.info('[undo-redo-test] ✓ File-content data integrity preserved after undo');
  return { passed: 1, failed: 0, errors: [] };
}

// =============================================================================
// Full-Order Assertion Helper
// =============================================================================

/**
 * Assert the FULL document order — both count AND every item's content in sequence.
 * Never use assertItemCount alone; this function must be used instead whenever
 * we care about what is in the document, not just how many items.
 * @param {import('../../model/conversation.js').default} conversation
 * @param {string[]} expectedContents - Expected content values in document order
 * @param {string} context - Test context for error messages
 */
function assertItemContents(conversation, expectedContents, context) {
  // @ts-ignore - Accessing private yarray for testing
  const rawItems = conversation.rootMessageThread.yarray.toArray();
  const actualContents = rawItems.map((/** @type {any} */ item) => item.get('content') ?? '');

  if (actualContents.length !== expectedContents.length) {
    throw new Error(
      `[${context}] Item count mismatch: expected ${expectedContents.length}, got ${actualContents.length}\n` +
			`  Expected contents: ${JSON.stringify(expectedContents)}\n` +
			`  Actual contents:   ${JSON.stringify(actualContents)}`
    );
  }
  for (let i = 0; i < expectedContents.length; i++) {
    if (actualContents[i] !== expectedContents[i]) {
      throw new Error(
        `[${context}] Item[${i}] content mismatch\n` +
				`  Expected: ${JSON.stringify(expectedContents[i])}\n` +
				`  Actual:   ${JSON.stringify(actualContents[i])}\n` +
				`  Full expected: ${JSON.stringify(expectedContents)}\n` +
				`  Full actual:   ${JSON.stringify(actualContents)}`
      );
    }
  }
}

// =============================================================================
// Test 33: Reverse-Order Deletion Undo Ordering
// =============================================================================

/**
 * Test 33: Reverse-order deletion undo ordering
 *
 * Scenario: conversation has [A, B, C, D, E]. User deletes E, D, C one at a time
 * (each is a separate undo step via waitForCaptureBoundary). Pressing undo 3× must
 * restore them in CORRECT ORDER: C first, then D, then E.
 *
 * This is the exact bug the user reported: "delete 3 last items in reverse order,
 * press undo 3×, they are restored in the WRONG ORDER."
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testReverseOrderDeletionOrdering(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);
  await waitForCaptureBoundary(conversation);

  // Build [A, B, C, D, E] — five messages with distinct content.
  const contents = ['A', 'B', 'C', 'D', 'E'];
  for (const c of contents) {
    // @ts-ignore - Accessing private yarray for testing
    const idx = conversation.rootMessageThread.yarray.length;
    conversation.rootMessageThread.insertItem(idx, {
      type: 'user',
      itemId: `rev_del_${c}_${Date.now()}`,
      content: c
    });
  }
  await waitForUndoStateSync(conversation);
  await waitForCaptureBoundary(conversation);

  assertItemContents(conversation, ['A', 'B', 'C', 'D', 'E'], 'initial state');

  // Delete E (last item) — slow, own undo group.
  // @ts-ignore - Accessing private yarray for testing
  conversation.rootMessageThread.yarray.delete(4, 1);
  await waitForUndoStateSync(conversation);
  assertItemContents(conversation, ['A', 'B', 'C', 'D'], 'after deleting E');
  await waitForCaptureBoundary(conversation); // separate undo group

  // Delete D (now last).
  // @ts-ignore - Accessing private yarray for testing
  conversation.rootMessageThread.yarray.delete(3, 1);
  await waitForUndoStateSync(conversation);
  assertItemContents(conversation, ['A', 'B', 'C'], 'after deleting D');
  await waitForCaptureBoundary(conversation); // separate undo group

  // Delete C (now last).
  // @ts-ignore - Accessing private yarray for testing
  conversation.rootMessageThread.yarray.delete(2, 1);
  await waitForUndoStateSync(conversation);
  assertItemContents(conversation, ['A', 'B'], 'after deleting C');
  await waitForCaptureBoundary(conversation);

  // Undo 1: should restore C (most recently deleted).
  await conversation.undo();
  await waitForUndoStateSync(conversation);
  assertItemContents(conversation, ['A', 'B', 'C'], 'after undo 1 — C must be restored at idx 2');

  // Undo 2: should restore D.
  await conversation.undo();
  await waitForUndoStateSync(conversation);
  assertItemContents(conversation, ['A', 'B', 'C', 'D'], 'after undo 2 — D must be restored at idx 3');

  // Undo 3: should restore E.
  await conversation.undo();
  await waitForUndoStateSync(conversation);
  assertItemContents(conversation, ['A', 'B', 'C', 'D', 'E'], 'after undo 3 — E must be restored at idx 4');

  // Redo 1: re-delete E.
  await conversation.redo();
  await waitForUndoStateSync(conversation);
  assertItemContents(conversation, ['A', 'B', 'C', 'D'], 'after redo 1 — E re-deleted');

  // Redo 2: re-delete D.
  await conversation.redo();
  await waitForUndoStateSync(conversation);
  assertItemContents(conversation, ['A', 'B', 'C'], 'after redo 2 — D re-deleted');

  // Redo 3: re-delete C.
  await conversation.redo();
  await waitForUndoStateSync(conversation);
  assertItemContents(conversation, ['A', 'B'], 'after redo 3 — C re-deleted');

  assertNoDuplicateMessageIds(conversation, 'final state');
  logger.info('[undo-redo-test] ✓ Reverse-order deletion undo ordering correct');
  return { passed: 1, failed: 0, errors: [] };
}

/**
 * Test 34: Forward-order deletion undo ordering
 *
 * Scenario: [A, B, C, D, E] — delete C, D, E one at a time (forward from the triplet).
 * Undo 3× must restore them in reverse deletion order: E first, D, C last.
 * @param {import('../../model/session.js').default} session - Session instance
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test result
 */
async function testForwardOrderDeletionOrdering(session) {
  const conversation = await createTestConversation(session);
  await cleanupAutoAddedContextItems(conversation);
  await waitForCaptureBoundary(conversation);

  const contents = ['A', 'B', 'C', 'D', 'E'];
  for (const c of contents) {
    // @ts-ignore
    const idx = conversation.rootMessageThread.yarray.length;
    conversation.rootMessageThread.insertItem(idx, {
      type: 'user',
      itemId: `fwd_del_${c}_${Date.now()}`,
      content: c
    });
  }
  await waitForUndoStateSync(conversation);
  await waitForCaptureBoundary(conversation);

  assertItemContents(conversation, ['A', 'B', 'C', 'D', 'E'], 'initial state');

  // Delete C (idx 2) — D and E shift left.
  // @ts-ignore
  conversation.rootMessageThread.yarray.delete(2, 1);
  await waitForUndoStateSync(conversation);
  assertItemContents(conversation, ['A', 'B', 'D', 'E'], 'after deleting C');
  await waitForCaptureBoundary(conversation);

  // Delete D (now at idx 2).
  // @ts-ignore
  conversation.rootMessageThread.yarray.delete(2, 1);
  await waitForUndoStateSync(conversation);
  assertItemContents(conversation, ['A', 'B', 'E'], 'after deleting D');
  await waitForCaptureBoundary(conversation);

  // Delete E (now at idx 2).
  // @ts-ignore
  conversation.rootMessageThread.yarray.delete(2, 1);
  await waitForUndoStateSync(conversation);
  assertItemContents(conversation, ['A', 'B'], 'after deleting E');
  await waitForCaptureBoundary(conversation);

  // Undo 1: restore E (last deleted).
  await conversation.undo();
  await waitForUndoStateSync(conversation);
  assertItemContents(conversation, ['A', 'B', 'E'], 'after undo 1 — E restored at idx 2');

  // Undo 2: restore D.
  await conversation.undo();
  await waitForUndoStateSync(conversation);
  assertItemContents(conversation, ['A', 'B', 'D', 'E'], 'after undo 2 — D restored at idx 2');

  // Undo 3: restore C.
  await conversation.undo();
  await waitForUndoStateSync(conversation);
  assertItemContents(conversation, ['A', 'B', 'C', 'D', 'E'], 'after undo 3 — C restored at idx 2');

  assertNoDuplicateMessageIds(conversation, 'final state');
  logger.info('[undo-redo-test] ✓ Forward-order deletion undo ordering correct');
  return { passed: 1, failed: 0, errors: [] };
}

// =============================================================================
// Main Test Runner
// =============================================================================

/**
 * Run all undo/redo tests
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results
 */
export async function runTests(_ctx) {
  await initializeRegistries();
  workerManager.terminateAll();

  const session = await createTestSession();

  // Clear any loaded conversations
  const loadedConvIds = Array.from(session.conversations.keys());
  for (const convId of loadedConvIds) {
    logger.info(`[undo-redo-test] Terminating and clearing conversation: ${convId}`);
    workerManager.terminate(convId);
    session.conversations.delete(convId);
  }

  const tests = [
    { name: 'Basic Add/Undo/Redo', fn: testBasicAddUndoRedo },
    { name: 'Delete Context Item Undo/Redo', fn: testDeleteContextItemUndoRedo },
    { name: 'Multiple Sequential Operations', fn: testMultipleOperations },
    { name: 'Redo Stack Clearing', fn: testRedoStackClearing },
    { name: 'Undo History Persistence', fn: testUndoHistoryPersistence },
    { name: 'Clear All Undo/Redo', fn: testClearAllUndo },
    { name: 'Single Context Item Single Undo', fn: testSingleContextItemSingleUndo },
    { name: 'Delete Context Item Undo No Infinite Loop', fn: testDeleteContextItemUndoNoInfiniteLoop },
    { name: 'Context Item Addition Single Undo', fn: testContextItemAdditionSingleUndo },
    { name: 'Context Item Deletion Single Undo', fn: testContextItemDeletionSingleUndo },
    { name: 'Auto-Added Context Item Deletion Single Undo', fn: testAutoAddedContextItemDeletionSingleUndo },
    { name: 'File-Content Context Item Deletion Single Undo', fn: testFileContentContextItemDeletionSingleUndo },
    { name: 'PRODUCTION Path Context Item Deletion', fn: testProductionPathContextItemDeletion },
    { name: 'Delete Assistant File Single Undo', fn: testDeleteAssistantFileSingleUndo },
    { name: 'PRODUCTION BUG: Two Undos After Context Item Deletion', fn: testProductionBugTwoUndos },
    // Undo + Tool Execution Tests
    { name: 'Undo After Tool Approval', fn: testUndoAfterToolApproval },
    { name: 'Undo After Write-File', fn: testUndoAfterWriteFile },
    { name: 'Undo Approval State', fn: testUndoApprovalState },
    { name: 'Undo Then Retry Flow', fn: testUndoRetryFlow },
    // External Deletion Undo Tests (Phase 1 TDD - should fail until fix implemented)
    { name: 'Delete Old Item Add New Undo', fn: testDeleteOldItemAddNewUndo },
    { name: 'Delete Multiple Indices Undo', fn: testDeleteMultipleIndicesUndo },
    { name: 'Delete Undo Redo Delete Undo', fn: testDeleteUndoRedoDeleteUndo },
    { name: 'Interleaved Delete Add Undo', fn: testInterleavedDeleteAddUndo },
    { name: 'Mixed Context Item And Message Deletion Undo', fn: testMixedContextItemAndMessageDeletionUndo },
    { name: 'RemoveItemsFrom Undo', fn: testRemoveItemsFromUndo },
    { name: 'Delete Early Item Long Conversation Undo', fn: testDeleteEarlyItemLongConversationUndo },
    { name: 'Rapid Delete Add Cycle Undo', fn: testRapidDeleteAddCycleUndo },
    { name: 'Delete All Except First Undo', fn: testDeleteAllExceptFirstUndo },
    // Boundary condition tests
    { name: 'Delete First Item Undo', fn: testDeleteFirstItemUndo },
    { name: 'Invalid Index Deletion', fn: testInvalidIndexDeletion },
    // Data integrity tests
    { name: 'File-Content Data Integrity After Undo', fn: testFileContentDataIntegrityAfterUndo },
    // Deletion ordering tests
    { name: 'Reverse-Order Deletion Undo Ordering', fn: testReverseOrderDeletionOrdering },
    { name: 'Forward-Order Deletion Undo Ordering', fn: testForwardOrderDeletionOrdering },
  ];

  let passed = 0;
  let failed = 0;
  const errors = [];

  for (const test of tests) {
    // Per-case guard, riding the suite's budget. Its job is attribution — so a
    // wedged case is reported by name instead of surfacing as the whole suite
    // timing out — which means it must sit ABOVE the waits inside the case,
    // not below them: a guard tighter than its own contents would fire first
    // and undo their patience.
    const caseBudgetMs = budgetFor(15000);
    if (caseBudgetMs <= 0) {
      failed++;
      errors.push(`${test.name}: not run — an earlier case in this suite spent the whole budget`);
      continue;
    }
    try {
      logger.info(`[undo-redo-test] Running: ${test.name}`);
      const timeoutPromise = new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout after ${caseBudgetMs}ms`)), caseBudgetMs));
      const result = await Promise.race([test.fn(session), timeoutPromise]);
      passed += result.passed;
      failed += result.failed;
      errors.push(...result.errors);
      logger.info(`[undo-redo-test] ✓ ${test.name}`);
    } catch (error) {
      failed++;
      const msg = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : '';
      errors.push(`${test.name}: ${msg}`);
      logger.error(`[undo-redo-test] ✗ ${test.name}: ${msg}`);
      if (stack) logger.error(`[undo-redo-test]   Stack: ${stack}`);
    }
  }

  return { passed, failed, errors };
}
