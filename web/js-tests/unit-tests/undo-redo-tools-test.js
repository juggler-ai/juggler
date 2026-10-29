//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @file Undo/redo across tool execution
 *
 * Undo after a tool is approved, after a file is written, of the approval state
 * itself, and undo followed by a retry.
 *
 * One of five undo/redo suites sharing `utilities/undo-redo-helpers.js`, which
 * says why they are five.
 */

import { TOOL_STATES } from '../../sdk/lib/message.js';
import {
  createTestConversation,
  runUndoRedoSuite,
  waitForUndoStateSync,
  waitForCaptureBoundary,
  cleanupAutoAddedContextItems
} from '../utilities/undo-redo-helpers.js';

/**
 * Test 17: Undo after tool approval - tests undo of approved tool actions.
 *
 * When a tool is approved and executed, the result becomes part of conversation history.
 * Undo should remove the tool-action from the conversation (state undo, not file revert).
 * @param {import('../../js/model/session.js').default} session - Session instance
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
 * @param {import('../../js/model/session.js').default} session - Session instance
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
 * @param {import('../../js/model/session.js').default} session - Session instance
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
 * @param {import('../../js/model/session.js').default} session - Session instance
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

/**
 * Run the undo-redo-tools suite.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results
 */
export async function runTests(_ctx) {
  return runUndoRedoSuite('undo-redo-tools', [
    { name: 'Undo After Tool Approval', fn: testUndoAfterToolApproval },
    { name: 'Undo After Write-File', fn: testUndoAfterWriteFile },
    { name: 'Undo Approval State', fn: testUndoApprovalState },
    { name: 'Undo Then Retry Flow', fn: testUndoRetryFlow },
  ]);
}
