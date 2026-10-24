//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @file Undo/redo: adding and deleting context items
 *
 * Each takes exactly one undo, whichever path made the item — added in a case,
 * auto-added AI-assistant files, file-content items — including a conversation
 * created the way production creates one.
 *
 * One of five undo/redo suites sharing `utilities/undo-redo-helpers.js`, which
 * says why they are five.
 */

import { waitForWorkerReady } from '../utilities/test-helpers.js';
import workerManager from '../../js/services/worker-manager.js';
import logger from '../utilities/test-logger.js';
import {
  createTestConversation,
  runUndoRedoSuite,
  waitForUndoStateSync,
  waitForCaptureBoundary,
  getContextItemCount,
  cleanupAutoAddedContextItems
} from '../utilities/undo-redo-helpers.js';

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

  session.registry.select({ kind: 'conversation', id: convId });

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

  session.registry.select({ kind: 'conversation', id: convId });

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

/**
 * Run the undo-redo-context-items suite.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results
 */
export async function runTests(_ctx) {
  return runUndoRedoSuite('undo-redo-context-items', [
    { name: 'Context Item Addition Single Undo', fn: testContextItemAdditionSingleUndo },
    { name: 'Context Item Deletion Single Undo', fn: testContextItemDeletionSingleUndo },
    { name: 'Auto-Added Context Item Deletion Single Undo', fn: testAutoAddedContextItemDeletionSingleUndo },
    { name: 'File-Content Context Item Deletion Single Undo', fn: testFileContentContextItemDeletionSingleUndo },
    { name: 'PRODUCTION Path Context Item Deletion', fn: testProductionPathContextItemDeletion },
    { name: 'Delete Assistant File Single Undo', fn: testDeleteAssistantFileSingleUndo },
    { name: 'PRODUCTION BUG: Two Undos After Context Item Deletion', fn: testProductionBugTwoUndos },
  ]);
}
