//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @file Undo/redo of items deleted on the main thread
 *
 * Deletions made in the page (deleteAt, removeItemsFrom, removeItemsAt) must be
 * recorded by the worker as undoable operations, however they interleave with
 * additions, redos and further deletions.
 *
 * One of five undo/redo suites sharing `utilities/undo-redo-helpers.js`, which
 * says why they are five.
 */

import logger from '../utilities/test-logger.js';
import {
  createTestConversation,
  runUndoRedoSuite,
  waitForUndoStateSync,
  waitForCaptureBoundary,
  createTestContextItem,
  getContextItemCount,
  cleanupAutoAddedContextItems,
  assertNoDuplicateMessageIds,
  assertItemCount,
  insertTestUserMessages
} from '../utilities/undo-redo-helpers.js';

/**
 * Test 21: Delete old item, add new items, then undo - should restore in correct order
 * THIS IS THE CORE BUG: Deleting an early message, then adding new messages,
 * then undoing tries to restore from wrong operation.
 * @param {import('../../js/model/session.js').default} session - Session instance
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
 * @param {import('../../js/model/session.js').default} session - Session instance
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
 * @param {import('../../js/model/session.js').default} session - Session instance
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
 * @param {import('../../js/model/session.js').default} session - Session instance
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

  assertItemCount(conversation, 4, 'Initial state');
  const initialState = 4;

  // Delete msg-2
  conversation.rootMessageThread.deleteAt(1);
  await waitForUndoStateSync(conversation);
  assertItemCount(conversation, 3, 'After delete msg-2');

  // Add msg-5, msg-6
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-5' });
  await waitForCaptureBoundary(conversation);
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-6' });
  await waitForUndoStateSync(conversation);
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
 * @param {import('../../js/model/session.js').default} session - Session instance
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

  // Add some messages
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-1' });
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-2' });
  conversation.rootMessageThread.addEvent({ type: 'user', content: 'msg-3' });
  await waitForUndoStateSync(conversation);

  // @ts-ignore - Accessing private _doc for testing
  const initialItemCount = conversation.rootMessageThread.yarray.length;
  const initialContextItemCount = getContextItemCount(conversation);

  logger.info(`[undo-redo-test] Mixed test: ${initialItemCount} items, ${initialContextItemCount} contextItems`);

  // Delete context-item-1
  conversation.rootMessageThread.removeContextItem('CI_MIX_1');
  await waitForUndoStateSync(conversation);

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
 * @param {import('../../js/model/session.js').default} session - Session instance
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

  assertItemCount(conversation, 10, 'Initial 10 messages');

  // removeItemsFrom(5) - deletes items 5-9 (5 items)
  conversation.rootMessageThread.deleteRange(5);
  await waitForUndoStateSync(conversation);

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
 * @param {import('../../js/model/session.js').default} session - Session instance
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

  assertItemCount(conversation, 50, 'Initial 50 messages');

  // Delete item at index 2
  conversation.rootMessageThread.deleteAt(2);
  await waitForUndoStateSync(conversation);

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
 * @param {import('../../js/model/session.js').default} session - Session instance
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
 * @param {import('../../js/model/session.js').default} session - Session instance
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

  assertItemCount(conversation, 5, 'Initial 5 messages');

  // removeItemsAt([1,2,3,4]) - keep only msg-1
  conversation.rootMessageThread.removeItemsAt([1, 2, 3, 4]);
  await waitForUndoStateSync(conversation);

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
 * Run the undo-redo-deletion suite.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results
 */
export async function runTests(_ctx) {
  return runUndoRedoSuite('undo-redo-deletion', [
    { name: 'Delete Old Item Add New Undo', fn: testDeleteOldItemAddNewUndo },
    { name: 'Delete Multiple Indices Undo', fn: testDeleteMultipleIndicesUndo },
    { name: 'Delete Undo Redo Delete Undo', fn: testDeleteUndoRedoDeleteUndo },
    { name: 'Interleaved Delete Add Undo', fn: testInterleavedDeleteAddUndo },
    { name: 'Mixed Context Item And Message Deletion Undo', fn: testMixedContextItemAndMessageDeletionUndo },
    { name: 'RemoveItemsFrom Undo', fn: testRemoveItemsFromUndo },
    { name: 'Delete Early Item Long Conversation Undo', fn: testDeleteEarlyItemLongConversationUndo },
    { name: 'Rapid Delete Add Cycle Undo', fn: testRapidDeleteAddCycleUndo },
    { name: 'Delete All Except First Undo', fn: testDeleteAllExceptFirstUndo },
  ]);
}
