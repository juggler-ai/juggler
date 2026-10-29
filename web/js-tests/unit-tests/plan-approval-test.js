//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Framework tests for submit_plan approval flow.
 *
 * Tests the COMPLETE submit_plan approval flow and verifies that
 * tool-use/tool-result pairs are properly formed in LLM context.
 * @module unit-tests/submit-plan
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  executeToolUntilApproval,
  createToolCall,
  buildContext,
  withTimeout,
  assert
} from '../utilities/test-helpers.js';
import { budgetFor } from '../utilities/test-deadline.js';

import { TOOL_STATES } from '../../sdk/lib/message.js';

/**
 * @typedef {import('../../sdk/lib/message.js').Message} Message
 * @typedef {import('../../sdk/lib/message.js').ToolActionMessage} ToolActionMessage
 * @typedef {import('../../sdk/lib/message.js').ToolUseMessage} ToolUseMessage
 * @typedef {import('../../sdk/lib/message.js').ToolResultMessage} ToolResultMessage
 * @typedef {import('../../js/model/conversation.js').default} Conversation
 */

/**
 * @typedef {object} TestContext
 * @property {string} fixtureDir - Path to fixture directory
 * @property {function(string): Promise<string>} readFile - Read file helper
 */

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Find a tool-action message by toolUseId in conversation items
 * @param {Conversation} conversation - The conversation to search
 * @param {string} toolUseId - The tool use ID to find
 * @returns {ToolActionMessage|undefined} The tool-action message or undefined
 */
function findToolActionInConversation(conversation, toolUseId) {
  for (const item of conversation.rootItems) {
    if (item.get('type') === 'tool-action') {
      const toolAction = /** @type {ToolActionMessage} */ (item);
      if (toolAction.get('toolUseId') === toolUseId) {
        return toolAction;
      }
    }
  }
  return undefined;
}

/**
 * Verify that every tool-result in context has a PRECEDING tool-use with matching ID.
 * This is the critical invariant that the bug violates.
 * @param {Message[]} messages - Context messages
 * @returns {{valid: boolean, orphanedResults: string[]}} Validation result
 */
function verifyToolPairing(messages) {
  /** @type {string[]} */
  const orphanedResults = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (msg.type === 'tool-result') {
      const result = /** @type {ToolResultMessage} */ (msg);
      const toolUseId = result.toolUseId;

      // Look for matching tool-use in preceding messages
      let foundToolUse = false;
      for (let j = 0; j < i; j++) {
        const preceding = messages[j];
        if (preceding.type === 'tool-use') {
          const toolUse = /** @type {ToolUseMessage} */ (preceding);
          if (toolUse.toolUseId === toolUseId) {
            foundToolUse = true;
            break;
          }
        }
      }

      if (!foundToolUse) {
        orphanedResults.push(toolUseId);
      }
    }
  }

  return { valid: orphanedResults.length === 0, orphanedResults };
}

/**
 * Run all submit_plan tests.
 * @param {TestContext} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results with pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();

  // =========================================================================
  // Test 1: submit_plan creates tool-use with pending approval
  // =========================================================================
  try {
    const conversation = await createApprovalTestConversation(session);
    const toolCall = createToolCall('plan', {
      action: 'submit',
      title: 'Test Plan',
      items: [
        { content: 'Step 1: Do something', status: 'pending' },
        { content: 'Step 2: Do something else', status: 'pending' }
      ]
    });

    // Start execution (will pause at approval)
    const { toolUseId, executionPromise } = await executeToolUntilApproval(
      conversation, session, toolCall
    );

    // Verify pending state
    const pendingToolUse = findToolActionInConversation(conversation, toolUseId);
    if (!pendingToolUse) {
      throw new Error('should have tool-use message');
    }
    assert(pendingToolUse.get('state') === TOOL_STATES.PENDING, `should be pending, got ${pendingToolUse.get('state')}`);
    assert(pendingToolUse.get('toolName') === 'plan', `should be plan, got ${pendingToolUse.get('toolName')}`);

    // CRITICAL: Verify approvalOptions are set (this is what the UI needs to render buttons)
    const rawApprovalOptions = pendingToolUse.get('approvalOptions');
    assert(rawApprovalOptions !== undefined && rawApprovalOptions !== null,
      'should have approvalOptions for UI rendering');
    if (!rawApprovalOptions) throw new Error('approvalOptions missing');
    // approvalOptions stored as Y.Map via convertToYType - use toJSON() for plain access
    const approvalOptions = /** @type {{options: Array<{value: string}>}} */ (
      rawApprovalOptions.toJSON ? rawApprovalOptions.toJSON() : rawApprovalOptions
    );
    const options = approvalOptions.options;
    if (!Array.isArray(options)) throw new Error('approvalOptions.options should be an array');
    assert(options.some(o => o.value === 'yes'), 'should have approve option (value=yes)');
    assert(options.some(o => o.value === 'no'), 'should have reject option (value=no)');

    // Cancel to cleanup
    conversation.rootMessageThread.resolveApproval(toolUseId, 'cancel');
    await withTimeout(executionPromise, budgetFor(5000), 'execution after cancel');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`submit_plan pending: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 2: Cancelled submit_plan has proper tool-use/tool-result pair
  // =========================================================================
  try {
    const conversation = await createApprovalTestConversation(session);
    const toolCall = createToolCall('plan', {
      action: 'submit',
      title: 'Cancelled Plan',
      items: [{ content: 'Will be cancelled', status: 'pending' }]
    });

    // Start execution (will pause at approval)
    const { toolUseId, executionPromise } = await executeToolUntilApproval(
      conversation, session, toolCall
    );

    // Cancel the approval
    conversation.rootMessageThread.resolveApproval(toolUseId, 'cancel');
    await withTimeout(executionPromise, budgetFor(5000), 'execution after cancel');

    // Verify tool-action exists with cancelled state
    const cancelledToolAction = findToolActionInConversation(conversation, toolUseId);
    if (!cancelledToolAction) {
      throw new Error('should have tool-action message after cancel');
    }
    assert(cancelledToolAction.get('state') === TOOL_STATES.CANCELLED, `should be cancelled, got ${cancelledToolAction.get('state')}`);

    // Verify result exists on tool-action
    const cancelResult = cancelledToolAction.get('result');
    if (cancelResult === null || cancelResult === undefined) {
      throw new Error('should have result after cancel');
    }

    // result stored as Y.Map via convertToYType - use .get() or toJSON()
    const cancelResultObj = cancelResult.toJSON ? cancelResult.toJSON() : cancelResult;
    assert(cancelResultObj.cancelled === true, 'result should have cancelled flag');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`submit_plan cancelled pair: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 3: CRITICAL - Context has no orphaned tool-results
  // This is the test that should FAIL with the current bug
  // =========================================================================
  try {
    const conversation = await createApprovalTestConversation(session);
    const toolCall = createToolCall('plan', {
      action: 'submit',
      title: 'Context Test Plan',
      items: [{ content: 'Testing context pairing', status: 'pending' }]
    });

    // Start execution (will pause at approval)
    const { toolUseId, executionPromise } = await executeToolUntilApproval(
      conversation, session, toolCall
    );

    // Cancel the approval
    conversation.rootMessageThread.resolveApproval(toolUseId, 'cancel');
    await withTimeout(executionPromise, budgetFor(5000), 'execution after cancel');

    // Build context - this is what would be sent to LLM
    const context = await buildContext(conversation.rootMessageThread, session);

    // CRITICAL ASSERTION: Every tool-result must have a preceding tool-use
    const { valid, orphanedResults } = verifyToolPairing(context.messages);

    if (!valid) {
      throw new Error(`Context has orphaned tool-results without matching tool-use: ${orphanedResults.join(', ')}`);
    }

    // Also verify the tool-use appears BEFORE the tool-result in context
    let toolUseIndex = -1;
    let toolResultIndex = -1;
    for (let i = 0; i < context.messages.length; i++) {
      const msg = context.messages[i];
      if (msg.type === 'tool-use' && /** @type {ToolUseMessage} */ (msg).toolUseId === toolUseId) {
        toolUseIndex = i;
      }
      if (msg.type === 'tool-result' && /** @type {ToolResultMessage} */ (msg).toolUseId === toolUseId) {
        toolResultIndex = i;
      }
    }

    assert(toolUseIndex !== -1, 'tool-use should be in context');
    assert(toolResultIndex !== -1, 'tool-result should be in context');
    assert(toolUseIndex < toolResultIndex, `tool-use (index ${toolUseIndex}) should appear before tool-result (index ${toolResultIndex})`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`submit_plan context pairing: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 4: Denied submit_plan has proper pairing in context
  // =========================================================================
  try {
    const conversation = await createApprovalTestConversation(session);
    const toolCall = createToolCall('plan', {
      action: 'submit',
      title: 'Denied Plan',
      items: [{ content: 'Will be denied', status: 'pending' }]
    });

    // Start execution (will pause at approval)
    const { toolUseId, executionPromise } = await executeToolUntilApproval(
      conversation, session, toolCall
    );

    // Deny the approval
    conversation.rootMessageThread.resolveApproval(toolUseId, 'no');
    await withTimeout(executionPromise, budgetFor(5000), 'execution after deny');

    // Build context
    const context = await buildContext(conversation.rootMessageThread, session);

    // Verify pairing
    const { valid, orphanedResults } = verifyToolPairing(context.messages);
    if (!valid) {
      throw new Error(`Denied plan has orphaned tool-results: ${orphanedResults.join(', ')}`);
    }

    passed++;
  } catch (e) {
    failed++;
    errors.push(`submit_plan denied pairing: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 5: removeItemsFrom while approval pending should NOT create orphan
  // This tests the ROOT CAUSE: when removeItemsFrom() is called, it:
  // 1. Removes items (including tool-use)
  // 2. Cancels pending approvals
  // 3. The cancel callback adds tool-result
  // 4. Result: orphaned tool-result (tool-use was removed!)
  // =========================================================================
  try {
    const conversation = await createApprovalTestConversation(session);
    const toolCall = createToolCall('plan', {
      action: 'submit',
      title: 'RemoveItems Test',
      items: [{ content: 'Will be removed', status: 'pending' }]
    });

    // Record the items count before execution
    const itemsCountBefore = conversation.rootItems.length;

    // Start execution (will pause at approval)
    const { toolUseId, executionPromise } = await executeToolUntilApproval(
      conversation, session, toolCall
    );

    // Verify tool-use was added
    const toolUseBeforeRemove = findToolActionInConversation(conversation, toolUseId);
    if (!toolUseBeforeRemove) {
      throw new Error('tool-use should exist before removeItemsFrom');
    }

    // NOW: call removeItemsFrom() which simulates what happens during
    // validation retry or user retry - this should cancel the approval
    // AND remove the tool-use
    conversation.rootMessageThread.cancelPendingApprovals();
    conversation.rootMessageThread.deleteRange(itemsCountBefore);

    // Wait for execution to complete (it should complete immediately since approval was cancelled)
    await withTimeout(executionPromise, budgetFor(5000), 'execution after removeItemsFrom');

    // CRITICAL: After removeItemsFrom + approval cancellation:
    // - The tool-action should be GONE (it was removed)
    // With unified tool-action, there's no risk of orphaned tool-results
    const toolActionAfter = findToolActionInConversation(conversation, toolUseId);

    // The tool-action should be gone (removed by removeItemsFrom)
    assert(toolActionAfter === undefined, `tool-action should be removed, but still exists`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`removeItemsFrom orphan prevention: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
