//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @file Undo/redo of main-thread deletions, at the edges
 *
 * The boundaries (the first item, an invalid index), file-content data
 * integrity after undo, and the order deleted items come back in, deleted
 * front to back and back to front.
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
  cleanupAutoAddedContextItems,
  assertNoDuplicateMessageIds,
  assertItemCount,
  assertItemContents
} from '../utilities/undo-redo-helpers.js';

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

/**
 * Run the undo-redo-deletion-edges suite.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results
 */
export async function runTests(_ctx) {
  return runUndoRedoSuite('undo-redo-deletion-edges', [
    { name: 'Delete First Item Undo', fn: testDeleteFirstItemUndo },
    { name: 'Invalid Index Deletion', fn: testInvalidIndexDeletion },
    { name: 'File-Content Data Integrity After Undo', fn: testFileContentDataIntegrityAfterUndo },
    { name: 'Reverse-Order Deletion Undo Ordering', fn: testReverseOrderDeletionOrdering },
    { name: 'Forward-Order Deletion Undo Ordering', fn: testForwardOrderDeletionOrdering },
  ]);
}
