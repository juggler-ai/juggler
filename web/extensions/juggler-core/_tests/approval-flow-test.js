//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   Apache-2.0 - see LICENSE
// SPDX-License-Identifier: Apache-2.0

/**
 * Framework tests for approval flow pipeline.
 *
 * Tests the COMPLETE approval flow using programmatic resolution.
 * Each test verifies conversation state at each stage.
 * @module unit-tests/approval-flow
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  executeToolUntilApproval,
  createOrphanedApproval,
  createToolCall,
  buildContext,
  withTimeout,
  waitFor,
  assert
} from '../../../js-tests/utilities/test-helpers.js';
import { TOOL_STATES, ACTION_STATES, createToolActionMessage } from '../../../sdk/lib/message.js';
import { observeUntil } from '../../../js-tests/utilities/turn-sync.js';
import { pingWorker } from '../../../js-tests/utilities/worker-test-hooks.js';
import ExecuteContextItem from '../context-items/execute-context-item.js';
import { buildApprovalButtons } from '../../../js/services/approval-options.js';
import '../../../js/components/action-confirmation.js';

/**
 * Ask the real `ExecuteContextItem.isPermitted` whether a command would be
 * auto-approved against the conversation's current rules. Constructs a
 * minimal item instance rather than reimplementing the analyser call —
 * this keeps the security tests honest against any future change to the
 * plugin's isPermitted contract.
 * @param {any} conversation
 * @param {string} command
 * @returns {boolean} Whether the command would be auto-approved against the current rules.
 */
function isExecutePermitted(conversation, command) {
  const item = new ExecuteContextItem({
    id: 'test-probe',
    session: conversation.session,
    conversation,
    messageThread: conversation.rootMessageThread
  });
  return item.isPermitted({ command });
}


// ============================================================================
// GOLDEN DATA - Expected action results
// ============================================================================

/** Cancellation result message (exact match) */
const CANCELLED_RESULT = 'Action was cancelled.';

/**
 * @typedef {import('../../model/message.js').Message} Message
 * @typedef {import('../../model/message.js').ToolActionMessage} ToolActionMessage
 * @typedef {import('../../model/conversation.js').default} Conversation
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
 * Find a tool-action message by toolUseId in conversation items.
 * @param {Conversation} conversation - The conversation to search
 * @param {string} toolUseId - The tool use ID to find
 * @returns {ToolActionMessage|undefined} The message or undefined
 */
function findToolUseInConversation(conversation, toolUseId) {
  for (const item of conversation.rootItems) {
    if (item.get('type') === 'tool-action' && item.get('toolUseId') === toolUseId) {
      return /** @type {ToolActionMessage} */ (item);
    }
  }
  return undefined;
}

/**
 * Find tool result data by toolUseId in conversation items.
 * Extracts result from tool-action if available.
 * Returns synthetic 'running' state when tool-action is approved but not yet complete.
 * @param {Conversation} conversation - The conversation to search
 * @param {string} toolUseId - The tool use ID to find
 * @returns {{toolUseId: string, content: string, isError: boolean, fullResult: object, cancelled?: boolean}|undefined} The result data
 */
function findToolResultInConversation(conversation, toolUseId) {
  for (const item of conversation.rootItems) {
    if (item.get('type') === 'tool-action') {
      const toolAction = /** @type {ToolActionMessage} */ (item);
      if (toolAction.get('toolUseId') === toolUseId) {
        const result = /** @type {any} */ (toolAction.get('result'));
        const state = toolAction.get('state');
        // Check for result (null or undefined means pending - Yjs sync may lose explicit null)
        if (result !== null && result !== undefined) {
          // Result is stored as a Y.Map via convertToYType - use .get() or .toJSON()
          const resultObj = result.toJSON ? result.toJSON() : result;
          // Completed - return result data
          return {
            toolUseId: /** @type {string} */ (toolAction.get('toolUseId')),
            content: resultObj.content || '',
            isError: resultObj.isError || false,
            fullResult: resultObj.fullResult || {},
            cancelled: resultObj.cancelled
          };
        } else if (state === TOOL_STATES.RUNNING || state === TOOL_STATES.APPROVED || !state) {
          // Running state: approved (or no approval needed) but result not yet set
          return {
            toolUseId: /** @type {string} */ (toolAction.get('toolUseId')),
            content: '',
            isError: false,
            fullResult: { state: ACTION_STATES.RUNNING }
          };
        }
      }
    }
  }
  return undefined;
}

/**
 * Find a message by type in context messages
 * @param {Message[]} messages - The messages to search
 * @param {string} type - The message type to find
 * @returns {Message|undefined} The matching message or undefined
 */
function findMessageByType(messages, type) {
  for (const msg of messages) {
    if (msg.type === type) {
      return msg;
    }
  }
  return undefined;
}

/**
 * Run all approval flow tests.
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
  // Test 1: Single tool - approve (yes)
  // =========================================================================
  try {
    const conversation = await createApprovalTestConversation(session);
    const toolCall = createToolCall('bash', { command: 'echo approval-test-1' });

    // Start execution (will pause at approval)
    const { toolUseId, executionPromise } = await executeToolUntilApproval(
      conversation, session, toolCall
    );

    // Verify pending state
    const pendingToolUse = findToolUseInConversation(conversation, toolUseId);
    if (!pendingToolUse) {
      throw new Error('should have tool-use message');
    }
    assert(pendingToolUse.get('state') === TOOL_STATES.PENDING, 'should be pending');
    assert(pendingToolUse.get('approvalOptions') !== null && pendingToolUse.get('approvalOptions') !== undefined, 'should have approval options');

    // Programmatically approve
    conversation.rootMessageThread.resolveApproval(toolUseId, 'yes');

    // Wait for execution to complete with timeout
    await withTimeout(executionPromise, 5000, 'execution after approve');

    // Verify completed state
    const approvedToolUse = findToolUseInConversation(conversation, toolUseId);
    if (!approvedToolUse) {
      throw new Error('should still have tool-use message');
    }
    assert(approvedToolUse.get('state') === TOOL_STATES.COMPLETED, `should be completed, got ${approvedToolUse.get('state')}`);

    // Verify tool-result exists with execution output
    const toolResult = findToolResultInConversation(conversation, toolUseId);
    if (!toolResult) {
      throw new Error('should have tool-result');
    }
    // GOLDEN: Echo output is exact string (without trailing newline in result)
    assert(toolResult.content === 'approval-test-1', `result should be 'approval-test-1', got '${toolResult.content}'`);
    assert(toolResult.isError === false, 'should not be error');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`approve (yes): ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 2: Single tool - deny (no)
  // =========================================================================
  try {
    const conversation = await createApprovalTestConversation(session);
    const toolCall = createToolCall('bash', { command: 'env echo cancel-test' });

    // Start execution (will pause at approval)
    const { toolUseId, executionPromise } = await executeToolUntilApproval(
      conversation, session, toolCall
    );

    // Verify pending state
    const pendingToolUse = findToolUseInConversation(conversation, toolUseId);
    if (!pendingToolUse) {
      throw new Error('should have pending tool-use');
    }
    assert(pendingToolUse.get('state') === TOOL_STATES.PENDING, 'should be pending');

    // Programmatically deny
    conversation.rootMessageThread.resolveApproval(toolUseId, 'no');

    // Wait for execution to complete
    await withTimeout(executionPromise, 5000, 'execution after deny');

    // Verify cancelled state
    const cancelledToolUse = findToolUseInConversation(conversation, toolUseId);
    if (!cancelledToolUse) {
      throw new Error('should have cancelled tool-use');
    }
    assert(cancelledToolUse.get('state') === TOOL_STATES.CANCELLED, `should be cancelled, got ${cancelledToolUse.get('state')}`);

    // Verify tool-result exists with cancellation message
    const toolResult = findToolResultInConversation(conversation, toolUseId);
    if (!toolResult) {
      throw new Error('should have tool-result');
    }
    // GOLDEN: Cancellation has exact message
    assert(toolResult.content === CANCELLED_RESULT, `result should be '${CANCELLED_RESULT}', got '${toolResult.content}'`);
    // Cancellation is not an error - it's a user choice
    assert(toolResult.isError === false, 'cancellation should not be marked as error');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`deny (no): ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 3: Single tool - cancel
  // =========================================================================
  try {
    const conversation = await createApprovalTestConversation(session);
    const toolCall = createToolCall('bash', { command: 'env echo cancel-test' });

    // Start execution (will pause at approval)
    const { toolUseId, executionPromise } = await executeToolUntilApproval(
      conversation, session, toolCall
    );

    // Programmatically cancel
    conversation.rootMessageThread.resolveApproval(toolUseId, 'cancel');

    // Wait for execution to complete
    await withTimeout(executionPromise, 5000, 'execution after cancel');

    // Verify cancelled state
    const cancelledToolUse = findToolUseInConversation(conversation, toolUseId);
    if (!cancelledToolUse) {
      throw new Error('should have cancelled tool-use');
    }
    assert(cancelledToolUse.get('state') === TOOL_STATES.CANCELLED, `should be cancelled, got ${cancelledToolUse.get('state')}`);

    // Verify tool-result exists with cancellation message
    const toolResult = findToolResultInConversation(conversation, toolUseId);
    if (!toolResult) {
      throw new Error('should have tool-result');
    }
    // GOLDEN: Cancellation has exact message
    assert(toolResult.content === CANCELLED_RESULT, `result should be '${CANCELLED_RESULT}', got '${toolResult.content}'`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`cancel: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 4: Single tool - yes-always (pattern saved)
  // =========================================================================
  try {
    const conversation = await createApprovalTestConversation(session);
    const toolCall1 = createToolCall('bash', { command: 'echo always-test' });

    // Start execution (will pause at approval)
    const { toolUseId, executionPromise } = await executeToolUntilApproval(
      conversation, session, toolCall1
    );

    // Programmatically approve with "yes-always"
    conversation.rootMessageThread.resolveApproval(toolUseId, 'yes-always');

    // Wait for execution to complete
    await withTimeout(executionPromise, 5000, 'execution after yes-always');

    // Verify completed state
    const approvedToolUse = findToolUseInConversation(conversation, toolUseId);
    if (!approvedToolUse) {
      throw new Error('should have approved tool-use');
    }
    assert(approvedToolUse.get('state') === TOOL_STATES.COMPLETED, `should be completed, got ${approvedToolUse.get('state')}`);

    // Verify command executed
    const toolResult = findToolResultInConversation(conversation, toolUseId);
    if (!toolResult) {
      throw new Error('should have tool-result');
    }
    // GOLDEN: Echo output is exact string
    assert(toolResult.content === 'always-test', `first command should execute with output 'always-test', got '${toolResult.content}'`);

    // Now execute the same command again - should NOT require approval
    // (pattern should have been saved)
    const toolCall2 = createToolCall('bash', { command: 'echo always-test' });

    // Pre-insert tool-action (worker normally does this; test must simulate it)
    conversation.rootMessageThread.addEvent(createToolActionMessage({
      toolUseId: toolCall2.id,
      toolName: toolCall2.name,
      toolInput: toolCall2.input,
      state: TOOL_STATES.RUNNING
    }));

    // This should complete immediately without waiting for approval
    // @ts-ignore - accessing private member for testing
    const responseHandler = conversation._responseHandler;
    const outcomes2 = await withTimeout(
      responseHandler.executeToolCalls([toolCall2], conversation.rootMessageThread),
      5000,
      'second execution should auto-approve'
    );

    // Verify it executed without approval
    assert(outcomes2.length === 1, 'should have one outcome');
    assert(outcomes2[0].success === true, 'should succeed');

    // The second tool-use should also exist (auto-approved by pattern)
    const secondToolUse = findToolUseInConversation(conversation, toolCall2.id);
    // Auto-approved tools may not have state set, or set to 'running'
    // The key is that it executed without waiting
    assert(secondToolUse !== undefined, 'should have second tool-use');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`yes-always: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 5: Adding a permission rule auto-approves matching pending approvals
  // =========================================================================
  try {
    const conversation = await createApprovalTestConversation(session);
    const matchingId = 'pending-rule-match';
    const nonMatchingId = 'pending-rule-miss';

    createOrphanedApproval(
      conversation,
      matchingId,
      'bash',
      { command: 'echo pending-rule-auto-approve' },
      { title: 'Execute Command', message: '', options: [] }
    );
    createOrphanedApproval(
      conversation,
      nonMatchingId,
      'bash',
      { command: 'python -c "print(1)"' },
      { title: 'Execute Command', message: '', options: [] }
    );

    conversation.rootMessageThread.addRule('execute', { kind: 'glob', value: 'echo *', scope: 'conversation' });
    // The rule re-check runs off a Yjs observer; wait for its effect
    // (the matching approval leaving pending) instead of a fixed delay.
    await observeUntil(conversation,
      () => {
        const m = findToolUseInConversation(conversation, matchingId);
        return !!m && m.get('state') !== TOOL_STATES.PENDING;
      },
      { timeoutMs: 15000, label: 'rule re-check auto-approves matching pending tool' });

    const matching = findToolUseInConversation(conversation, matchingId);
    const nonMatching = findToolUseInConversation(conversation, nonMatchingId);
    if (!matching || !nonMatching) throw new Error('should have both pending tool-actions');

    assert(matching.get('state') !== TOOL_STATES.PENDING, `matching pending approval should have been auto-approved, got ${matching.get('state')}`);
    assert(nonMatching.get('state') === TOOL_STATES.PENDING, `non-matching approval should remain pending, got ${nonMatching.get('state')}`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`rule re-check pending approvals: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 6: Orphaned approval - deny creates denial tool-result
  // After page reload, denying an approval creates a denial tool-result.
  // This gives the LLM context about what happened if conversation resumes.
  // =========================================================================
  try {
    const conversation = await createApprovalTestConversation(session);

    // Create orphaned approval (simulates page reload)
    const orphanedToolUseId = 'orphan-deny-test';
    createOrphanedApproval(
      conversation,
      orphanedToolUseId,
      'bash',
      { command: "python -c \"print('orphan-deny')\"" },
      {
        title: 'Execute Command',
        message: 'python orphan-deny',
        options: [
          { label: 'Allow', value: 'yes', style: 'primary' },
          { label: 'Deny', value: 'no', style: 'secondary' }
        ]
      }
    );

    // Barrier: the worker has processed the orphan setup's sync (drained
    // inbound queue + flushed outbound) before the user-style deny below,
    // matching the page-reload scenario where the worker already holds
    // the pending tool when the user clicks.
    await pingWorker(conversation.id);

    // Verify orphaned state
    let orphanedToolUse = findToolUseInConversation(conversation, orphanedToolUseId);
    if (!orphanedToolUse) {
      throw new Error('should have orphaned tool-use');
    }
    assert(orphanedToolUse.get('state') === TOOL_STATES.PENDING, 'should be pending');

    // Resolve the orphaned approval with deny
    conversation.rootMessageThread.resolveApproval(orphanedToolUseId, 'no');

    // The worker is the sole writer of cancellation, so the terminal
    // state plus the denial tool-result appearing in this doc IS the
    // full sync round-trip — wait for that, not a fixed delay.
    await observeUntil(conversation,
      () => findToolUseInConversation(conversation, orphanedToolUseId)?.get('state') === TOOL_STATES.CANCELLED
				&& !!findToolResultInConversation(conversation, orphanedToolUseId),
      { timeoutMs: 15000, label: 'orphaned deny reaches cancelled + denial result' });

    // Re-fetch after sync to get updated state
    orphanedToolUse = findToolUseInConversation(conversation, orphanedToolUseId);
    if (!orphanedToolUse) {
      throw new Error('orphaned tool-use disappeared after resolution');
    }

    // Verify cancelled state
    assert(orphanedToolUse.get('state') === TOOL_STATES.CANCELLED, `should be cancelled, got ${orphanedToolUse.get('state')}`);

    // Tool-result SHOULD exist with cancellation message (gives LLM context)
    const toolResult = findToolResultInConversation(conversation, orphanedToolUseId);
    if (!toolResult) {
      throw new Error('should have tool-result with cancellation message');
    }
    // GOLDEN: Cancellation has exact message
    assert(toolResult.content === CANCELLED_RESULT, `should be '${CANCELLED_RESULT}', got '${toolResult.content}'`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`orphaned deny: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 7: Orphaned approval - approve executes immediately
  // After page reload, approving an orphaned action executes it.
  // This is UX-friendly: user clicks approve, action runs.
  // =========================================================================
  try {
    const conversation = await createApprovalTestConversation(session);

    // Create orphaned approval (simulates page reload)
    const orphanedToolUseId = 'orphan-approve-test';
    createOrphanedApproval(
      conversation,
      orphanedToolUseId,
      'bash',
      { command: 'echo orphan-approve' },
      {
        title: 'Execute Command',
        message: 'echo orphan-approve',
        options: [
          { label: 'Allow', value: 'yes', style: 'primary' },
          { label: 'Deny', value: 'no', style: 'secondary' }
        ]
      }
    );

    // Barrier: the worker holds the orphan before the user-style approve,
    // matching the page-reload scenario.
    await pingWorker(conversation.id);

    // Get reference before resolve
    let orphanedToolUse = findToolUseInConversation(conversation, orphanedToolUseId);
    if (!orphanedToolUse) {
      throw new Error('should have orphaned tool-use');
    }

    // Approve the orphaned approval - should execute
    await conversation.rootMessageThread.resolveApproval(orphanedToolUseId, 'yes');

    // Approval → engine executes the command → result lands → reducer
    // marks the tool completed. Wait for that terminal state rather than
    // a fixed delay; under 9-lane pool load the round trip routinely
    // exceeds any constant chosen here.
    await observeUntil(conversation,
      () => findToolUseInConversation(conversation, orphanedToolUseId)?.get('state') === TOOL_STATES.COMPLETED
				&& !!findToolResultInConversation(conversation, orphanedToolUseId),
      { timeoutMs: 15000, label: 'orphaned approve reaches completed + result' });

    // Re-fetch after sync to get updated state
    orphanedToolUse = findToolUseInConversation(conversation, orphanedToolUseId);
    if (!orphanedToolUse) {
      throw new Error('orphaned tool-use disappeared after approval');
    }

    // Verify it becomes completed
    assert(orphanedToolUse.get('state') === TOOL_STATES.COMPLETED,
      `orphaned approve should become completed, got ${orphanedToolUse.get('state')}`);

    // Tool-result SHOULD exist with execution result
    const toolResult = findToolResultInConversation(conversation, orphanedToolUseId);
    if (!toolResult) {
      throw new Error('should have tool-result after approval');
    }
    // GOLDEN: Echo output is exact string
    assert(toolResult.content === 'orphan-approve', `should have output 'orphan-approve', got '${toolResult.content}'`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`orphaned approve: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 8: ApprovalOptions PRESERVED after resolution (for retry support)
  // =========================================================================
  try {
    const conversation = await createApprovalTestConversation(session);
    const toolCall = createToolCall('bash', { command: 'echo options-preserved-test' });

    // Start execution (will pause at approval)
    const { toolUseId, executionPromise } = await executeToolUntilApproval(
      conversation, session, toolCall
    );

    // Verify approvalOptions exists while pending
    const pendingToolUse = findToolUseInConversation(conversation, toolUseId);
    if (!pendingToolUse) {
      throw new Error('should have pending tool-use');
    }
    assert(pendingToolUse.get('approvalOptions') !== null && pendingToolUse.get('approvalOptions') !== undefined, 'should have approvalOptions while pending');

    // Deny (not approve - to test retry scenario)
    conversation.rootMessageThread.resolveApproval(toolUseId, 'no');
    await withTimeout(executionPromise, 5000, 'execution');

    // CRITICAL: approvalOptions must be PRESERVED for retry to work
    // approvalOptions is configuration (what buttons exist), not state (what happened)
    assert(pendingToolUse.get('approvalOptions') !== null && pendingToolUse.get('approvalOptions') !== undefined,
      'approvalOptions should be PRESERVED after resolution for retry support');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`options preserved: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 9: Context shows correct approval state
  // =========================================================================
  try {
    const conversation = await createApprovalTestConversation(session);
    const toolCall = createToolCall('bash', { command: 'echo context-test' });

    // Start execution and approve
    const { toolUseId, executionPromise } = await executeToolUntilApproval(
      conversation, session, toolCall
    );
    conversation.rootMessageThread.resolveApproval(toolUseId, 'yes');
    await withTimeout(executionPromise, 5000, 'execution');

    // Build context and verify
    const context = await buildContext(conversation.rootMessageThread, session);

    // Find tool-use in context messages
    const toolUseInContext = findMessageByType(context.messages, 'tool-use');
    assert(toolUseInContext !== undefined, 'context should have tool-use');

    // Find tool-result in context messages
    const toolResultInContext = findMessageByType(context.messages, 'tool-result');
    assert(toolResultInContext !== undefined, 'context should have tool-result');
    // GOLDEN: Echo output is exact string
    const resultContent = /** @type {{content?: string}} */ (toolResultInContext).content || '';
    assert(resultContent === 'context-test', `context should show 'context-test', got '${resultContent}'`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`context state: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 10: Approve creates 'running' state IMMEDIATELY (streaming support)
  // This test verifies the streaming regression is fixed.
  // When user approves, a 'running' tool-result must be created BEFORE
  // execution completes - this enables streaming UI.
  // =========================================================================
  try {
    const conversation = await createApprovalTestConversation(session);
    // Use a command that takes some time so we can check intermediate state
    const toolCall = createToolCall('bash', { command: 'sleep 0.5 && echo streaming-test' });

    const { toolUseId, executionPromise } = await executeToolUntilApproval(
      conversation, session, toolCall
    );

    // Set up to capture the 'running' state
    let sawRunningState = false;
    const checkInterval = setInterval(() => {
      const toolResult = findToolResultInConversation(conversation, toolUseId);
      const state = /** @type {{state?: string}|undefined} */ (toolResult?.fullResult)?.state;
      if (state === ACTION_STATES.RUNNING) {
        sawRunningState = true;
      }
    }, 10);

    // Approve the action
    conversation.rootMessageThread.resolveApproval(toolUseId, 'yes');

    // Wait until the 'running' tool-result appears — it must be created the
    // instant approval resolves, well before the 0.5s command finishes. Polling
    // for the actual result (instead of a fixed 100ms sleep) is deterministic:
    // it returns the moment the result lands and stays patient on slow CI
    // runners where 100ms was too short and the assert below read `undefined`.
    await waitFor(
      () => findToolResultInConversation(conversation, toolUseId) !== undefined,
      { description: 'running tool-result to appear immediately after approval' }
    );

    // CRITICAL: Check that 'running' state was seen DURING execution
    const currentToolResult = findToolResultInConversation(conversation, toolUseId);
    assert(currentToolResult !== undefined,
      'tool-result should exist IMMEDIATELY after approval (not after execution)');

    // At this point (100ms in), command is still running, state should be 'running'
    // OR we already saw 'running' during the interval checks
    const currentState = /** @type {{state?: string}|undefined} */ (currentToolResult?.fullResult)?.state;
    assert(sawRunningState || currentState === 'running',
      `should see 'running' state during execution, got: ${currentState}`);

    clearInterval(checkInterval);

    // Wait for completion
    await withTimeout(executionPromise, 5000, 'execution after approve');

    // Verify final state
    const finalToolResult = findToolResultInConversation(conversation, toolUseId);
    assert(/** @type {{state?: string}|undefined} */ (finalToolResult?.fullResult)?.state === ACTION_STATES.COMPLETED,
      'should be completed after execution');
    // GOLDEN: Echo output is exact string
    assert(finalToolResult?.content === 'streaming-test', `should have output 'streaming-test', got '${finalToolResult?.content}'`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`streaming state: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 11: SECURITY - Wildcard patterns do NOT match compound commands
  // Pattern 'cd *' should NOT auto-approve 'cd /path && rm -rf /'
  // This prevents command injection via wildcards.
  // =========================================================================
  try {
    const conversation = await createApprovalTestConversation(session);

    // Add a wildcard pattern for 'cd *'
    conversation.rootMessageThread.addRule('execute', { kind: 'glob', value: 'cd *', scope: 'conversation' });

    // A simple, in-project `cd` is approved.
    const simpleMatch = isExecutePermitted(conversation, 'cd subdir');
    assert(simpleMatch === true, 'cd subdir (inside the project) should be approved');

    // SECURITY: the wildcard does NOT widen where `cd` may go. `cd` declares its
    // target as a path argument, so a move outside the allowed roots is a path
    // obstacle, and the analyser refuses to let a glob paper over one — the same
    // rule that stops `grep *` reading /etc/passwd. It matters most here: `cd`
    // relocates everything that follows it, so a `cd *` grant that escaped the
    // project would hand over the whole filesystem. The honest remedy is a
    // folder grant, which is what the approval prompt offers instead.
    const escapingMatch = isExecutePermitted(conversation, 'cd /safe/path');
    assert(escapingMatch === false, 'cd * should NOT match a cd outside the allowed roots');

    // SECURITY: Compound command should NOT match wildcard
    const compoundMatch = isExecutePermitted(conversation, 'cd /path && rm -rf /');
    assert(compoundMatch === false, 'cd * should NOT match compound command with &&');

    // Other compound operators should also be blocked
    const pipeMatch = isExecutePermitted(conversation, 'cd /path | cat /etc/passwd');
    assert(pipeMatch === false, 'cd * should NOT match command with pipe');

    const semicolonMatch = isExecutePermitted(conversation, 'cd /path; rm -rf /');
    assert(semicolonMatch === false, 'cd * should NOT match command with semicolon');

    const orMatch = isExecutePermitted(conversation, 'cd /path || evil');
    assert(orMatch === false, 'cd * should NOT match command with ||');

    const substMatch = isExecutePermitted(conversation, 'cd $(whoami)');
    assert(substMatch === false, 'cd * should NOT match command with $()');

    const backtickMatch = isExecutePermitted(conversation, 'cd `whoami`');
    assert(backtickMatch === false, 'cd * should NOT match command with backticks');

    // Note: `> /dev/null` is intentionally treated as a safe sink by the
    // static analyser (any other redirect target leaves the operator and
    // rejects the command). So `cd /path > /dev/null` reduces to `cd /path`
    // and the wildcard `cd *` pattern matches it. That is the documented
    // design — no assertion here.

    passed++;
  } catch (e) {
    failed++;
    errors.push(`compound security: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 11 (exact compound pattern matches the full string) was removed:
  // the new analyser segments on top-level `&&`/`||`/`;` and validates each
  // segment independently, so a saved pattern like `cd /path && ls` no
  // longer matches the whole command verbatim. Users approve segments, not
  // glued strings; that is the documented design.

  // =========================================================================
  // Test 12: SECURITY - extractDefaultPattern returns exact for compound
  // When user clicks "yes-always" on a compound command, it should save
  // the exact command, NOT a wildcard pattern.
  // =========================================================================
  try {
    // Import ExecuteContextItem for pattern extraction test
    const { default: ExecuteContextItem } = await import('../context-items/execute-context-item.js');

    // Simple command should get wildcard
    const simplePattern = ExecuteContextItem.extractDefaultPattern('npm install', 'darwin');
    assert(simplePattern === 'npm *', `simple command should get wildcard, got: ${simplePattern}`);

    // Compound command should get exact pattern
    const compoundPattern = ExecuteContextItem.extractDefaultPattern('npm install && npm run build', 'darwin');
    assert(compoundPattern === 'npm install && npm run build',
      `compound command should get exact pattern, got: ${compoundPattern}`);

    // Pipe command should get exact pattern
    const pipePattern = ExecuteContextItem.extractDefaultPattern('cat file | grep test', 'darwin');
    assert(pipePattern === 'cat file | grep test',
      `pipe command should get exact pattern, got: ${pipePattern}`);

    // Semicolon command should get exact pattern
    const semicolonPattern = ExecuteContextItem.extractDefaultPattern('echo a; echo b', 'darwin');
    assert(semicolonPattern === 'echo a; echo b',
      `semicolon command should get exact pattern, got: ${semicolonPattern}`);

    // Redirection should get exact pattern
    const redirectPattern = ExecuteContextItem.extractDefaultPattern('echo test > file.txt', 'darwin');
    assert(redirectPattern === 'echo test > file.txt',
      `redirect command should get exact pattern, got: ${redirectPattern}`);

    passed++;
  } catch (e) {
    failed++;
    errors.push(`extractDefaultPattern compound: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 13: buildApprovalButtons is the SOLE source of "don't ask again".
  // A plugin offering no suggestions yields exactly [Yes, No] — the framework
  // must NEVER invent a bare "yes-always" button with no pattern to remember.
  // =========================================================================
  try {
    const noSuggestions = buildApprovalButtons({ getApprovalSuggestions: () => [] }, {});
    assert(noSuggestions.length === 2, `no-suggestion case should yield 2 buttons, got ${noSuggestions.length}`);
    assert(noSuggestions[0].value === 'yes' && noSuggestions[1].value === 'no',
      `no-suggestion buttons should be [yes, no], got ${noSuggestions.map(o => o.value).join(',')}`);
    assert(!noSuggestions.some(o => String(o.value).startsWith('yes-always')),
      'no-suggestion case must NOT contain any yes-always button');

    // A plugin with no getApprovalSuggestions at all behaves identically.
    const missingApi = buildApprovalButtons({}, {});
    assert(missingApi.length === 2 && !missingApi.some(o => String(o.value).startsWith('yes-always')),
      'plugin without getApprovalSuggestions must yield only [yes, no]');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`buildApprovalButtons no-suggestion: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 14: buildApprovalButtons renders one escalating "don't ask again"
  // button per suggestion, each carrying its rules/itemType and a pattern.
  // =========================================================================
  try {
    const suggestions = [
      { itemType: 'execute', rules: [{ kind: 'glob', value: 'cmake --build x' }], label: 'cmake --build x' },
      { itemType: 'execute', rules: [{ kind: 'glob', value: 'cmake *' }], label: 'cmake *' }
    ];
    const opts = buildApprovalButtons({ getApprovalSuggestions: () => suggestions }, {});
    assert(opts.length === 4, `expected Yes + 2 suggestions + No = 4 buttons, got ${opts.length}`);
    assert(opts[0].value === 'yes' && opts[3].value === 'no', 'first/last must be yes/no');
    assert(opts[1].value === 'yes-always:0' && opts[2].value === 'yes-always:1',
      `escalating buttons should be indexed, got ${opts.map(o => o.value).join(',')}`);
    assert(opts[1].pattern === 'cmake --build x' && opts[2].pattern === 'cmake *',
      'each button must display its suggestion label as the pattern');
    assert(opts[1].rules === suggestions[0].rules && opts[1].itemType === 'execute',
      'each button must carry the exact rules/itemType it will persist');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`buildApprovalButtons escalating: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 15: a suggestion covering several patterns is threaded through as a
  // structured `patterns` array and rendered as one <code> span per pattern,
  // joined by a plain-font "or" — never a single preformatted blob.
  // =========================================================================
  try {
    const suggestions = [
      { itemType: 'execute', rules: [{ kind: 'glob', value: 'go version' }, { kind: 'glob', value: 'go list *' }],
        patterns: ['go version', 'go list -m all'] }
    ];
    const opts = buildApprovalButtons({ getApprovalSuggestions: () => suggestions }, {});
    assert(Array.isArray(opts[1].patterns) && opts[1].patterns.length === 2,
      'multi-pattern suggestion must carry its `patterns` array onto the button');
    assert(opts[1].patterns[0] === 'go version' && opts[1].patterns[1] === 'go list -m all',
      'button `patterns` must preserve the suggestion order');

    // Render the buttons and inspect the "Don't ask again" markup.
    const el = /** @type {any} */ (document.createElement('action-confirmation'));
    el.setOptions({ options: opts }, () => {});
    const alwaysButton = el.querySelector('[data-value="yes-always:0"]');
    assert(alwaysButton, 'rendered a yes-always button');
    const codes = alwaysButton.querySelectorAll('code.pattern-highlight');
    assert(codes.length === 2,
      `each pattern must be its own <code> span, got ${codes.length}`);
    assert(codes[0].textContent === 'go version' && codes[1].textContent === 'go list -m all',
      'each <code> span must hold exactly one pattern');
    // The "or" separator must be plain text outside the <code> spans.
    assert(/<\/code>\s*or\s*<code/.test(alwaysButton.innerHTML),
      `patterns must be joined by a plain-font "or", got: ${alwaysButton.innerHTML}`);
    assert(!/ {2}\+ {2}/.test(alwaysButton.innerHTML),
      'must not fall back to the "  +  " joined blob');

    // A single-pattern suggestion still renders exactly one <code> span, no "or".
    const single = buildApprovalButtons({ getApprovalSuggestions: () =>
      [{ itemType: 'execute', rules: [{ kind: 'glob', value: 'go *' }], patterns: ['go *'] }] }, {});
    const el2 = /** @type {any} */ (document.createElement('action-confirmation'));
    el2.setOptions({ options: single }, () => {});
    const oneBtn = el2.querySelector('[data-value="yes-always:0"]');
    assert(oneBtn.querySelectorAll('code.pattern-highlight').length === 1 && !/\bor\b/.test(oneBtn.textContent),
      'single-pattern suggestion must render one <code> span and no "or"');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`buildApprovalButtons multi-pattern render: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 16: the pencil edit affordance renders ONLY on single-pattern
  // "don't ask again" options when an onRevise bridge is supplied — never on
  // Yes/No, never on multi-pattern options, and never without onRevise.
  // =========================================================================
  try {
    const options = [
      { label: 'Yes', value: 'yes', style: 'primary' },
      { label: "Yes + Don't Ask Again", value: 'yes-always:0', style: 'primary-always',
        rules: [{ kind: 'glob', value: 'git push *' }], patterns: ['git push *'] },
      { label: "Yes + Don't Ask Again", value: 'yes-always:1', style: 'primary-always',
        rules: [{ kind: 'glob', value: 'go version' }, { kind: 'glob', value: 'go list *' }],
        patterns: ['go version', 'go list *'] },
      { label: 'No', value: 'no', style: 'secondary' }
    ];

    // Without onRevise: no pencils anywhere.
    const elNoRevise = /** @type {any} */ (document.createElement('action-confirmation'));
    elNoRevise.setOptions({ options }, () => {});
    assert(elNoRevise.querySelectorAll('.pattern-edit-btn').length === 0,
      'no pencils when onRevise is absent');

    // With onRevise: exactly one pencil, on the single-pattern option.
    const el = /** @type {any} */ (document.createElement('action-confirmation'));
    el.setOptions({ options }, () => {}, { onRevise: () => ({ valid: true, patterns: ['x'], rules: [] }) });
    const pencils = el.querySelectorAll('.pattern-edit-btn');
    assert(pencils.length === 1, `expected exactly one pencil, got ${pencils.length}`);
    assert(pencils[0].dataset.editIndex === '1',
      `pencil must be on the single-pattern option (index 1), got ${pencils[0].dataset.editIndex}`);
    // The multi-pattern row (index 2) and Yes/No rows carry no pencil.
    const row2 = el.querySelector('.action-approval-option[data-index="2"]');
    assert(row2 && !row2.querySelector('.pattern-edit-btn'), 'multi-pattern option must NOT be editable');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`pencil rendering: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 17: clicking the pencil swaps the descriptor for a text input
  // pre-filled with the current pattern.
  // =========================================================================
  try {
    const options = [
      { label: "Yes + Don't Ask Again", value: 'yes-always:0', style: 'primary-always',
        rules: [{ kind: 'glob', value: 'git push *' }], patterns: ['git push *'] },
      { label: 'No', value: 'no', style: 'secondary' }
    ];
    const el = /** @type {any} */ (document.createElement('action-confirmation'));
    document.body.appendChild(el);
    el.setOptions({ options }, () => {}, { onRevise: () => ({ valid: true, patterns: ['git push *'], rules: options[0].rules }) });

    const row = el.querySelector('.action-approval-option[data-index="0"]');
    const input = row.querySelector('.pattern-edit-input');
    const field = row.querySelector('.pattern-edit-field');
    assert(field.hidden, 'edit field starts hidden');
    assert(input.value === 'git push *', `input must be pre-filled with the current pattern, got '${input.value}'`);

    // Enter edit mode via the pencil (reveals the field synchronously).
    row.querySelector('.pattern-edit-btn').click();
    assert(!field.hidden, 'edit field becomes visible after clicking the pencil');
    assert(row.querySelector('.option-descriptor').hasAttribute('hidden'),
      'descriptor is hidden while editing');

    el.remove();
    passed++;
  } catch (e) {
    failed++;
    errors.push(`pencil swaps to input: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 18: live validation — a valid revise enables the button and shows an
  // amber caution notice; an invalid revise disables the button and shows a red
  // reason notice.
  // =========================================================================
  try {
    const options = [
      { label: "Yes + Don't Ask Again", value: 'yes-always:0', style: 'primary-always',
        rules: [{ kind: 'glob', value: 'git push *' }], patterns: ['git push *'] },
      { label: 'No', value: 'no', style: 'secondary' }
    ];
    let next = null;
    const el = /** @type {any} */ (document.createElement('action-confirmation'));
    el.setOptions({ options }, () => {}, { onRevise: () => next });

    const row = el.querySelector('.action-approval-option[data-index="0"]');
    const button = row.querySelector('.action-confirmation-button');
    const notice = row.querySelector('.pattern-edit-notice');

    // Invalid → button disabled, red notice.
    next = { valid: false, notice: 'This pattern wouldn\'t approve this command', patterns: ['nope'], rules: [] };
    await el._runRevise(0, 'nope');
    assert(button.disabled === true, 'invalid revise must disable the button');
    assert(!notice.hidden && notice.classList.contains('error'), 'invalid revise shows a red notice');
    assert(row.classList.contains('revise-invalid'), 'row is flagged revise-invalid');

    // Valid + broad → button enabled, amber caution notice, grant updated.
    next = { valid: true, notice: 'Very broad — approves many commands', patterns: ['*'], rules: [{ kind: 'glob', value: '*' }] };
    await el._runRevise(0, '*');
    assert(button.disabled === false, 'valid revise must enable the button');
    assert(!notice.hidden && notice.classList.contains('caution'), 'valid+broad revise shows an amber caution');
    assert(options[0].rules[0].value === '*', 'valid revise updates the option grant in place');

    // Valid + no notice → notice hidden.
    next = { valid: true, patterns: ['git push origin main'], rules: [{ kind: 'glob', value: 'git push origin main' }] };
    await el._runRevise(0, 'git push origin main');
    assert(notice.hidden, 'a clean valid revise hides the notice');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`live validation: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 19: stale-response guard — when two edits are in flight and the OLDER
  // resolves last, the newer result wins.
  // =========================================================================
  try {
    const options = [
      { label: "Yes + Don't Ask Again", value: 'yes-always:0', style: 'primary-always',
        rules: [{ kind: 'glob', value: 'git push *' }], patterns: ['git push *'] },
      { label: 'No', value: 'no', style: 'secondary' }
    ];
    /** @type {(v:any)=>void} */ let resolveA = () => {};
    /** @type {(v:any)=>void} */ let resolveB = () => {};
    const pA = new Promise((r) => { resolveA = r; });
    const pB = new Promise((r) => { resolveB = r; });
    let call = 0;
    const el = /** @type {any} */ (document.createElement('action-confirmation'));
    el.setOptions({ options }, () => {}, { onRevise: () => (++call === 1 ? pA : pB) });

    const row = el.querySelector('.action-approval-option[data-index="0"]');
    const button = row.querySelector('.action-confirmation-button');

    const p1 = el._runRevise(0, 'aaa'); // older request → pA
    const p2 = el._runRevise(0, 'bbb'); // newer request → pB

    // Newer resolves first (valid), then the older resolves LAST (invalid).
    resolveB({ valid: true, patterns: ['bbb'], rules: [{ kind: 'glob', value: 'bbb' }] });
    await p2;
    resolveA({ valid: false, notice: 'stale reject', patterns: ['aaa'], rules: [] });
    await p1;

    assert(button.disabled === false, 'newer (valid) result must win over the older (invalid) one');
    assert(options[0].rules[0].value === 'bbb', 'the newer revise grant is the one applied');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`stale-response guard: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 20: keyboard — Return in a valid input approves with the revised
  // grant; Return in an invalid input does nothing.
  // =========================================================================
  try {
    const options = [
      { label: "Yes + Don't Ask Again", value: 'yes-always:0', style: 'primary-always',
        rules: [{ kind: 'glob', value: 'git push *' }], patterns: ['git push *'] },
      { label: 'No', value: 'no', style: 'secondary' }
    ];

    // Valid input → Return approves.
    let resolved = /** @type {string|undefined} */ (undefined);
    const reviseResult = { valid: true, patterns: ['git push origin main'], rules: [{ kind: 'glob', value: 'git push origin main' }] };
    const el = /** @type {any} */ (document.createElement('action-confirmation'));
    document.body.appendChild(el);
    el.setOptions({ options }, (v) => { resolved = v; }, { onRevise: () => reviseResult });
    el._enterEditMode(0);
    const input = el.querySelector('.pattern-edit-input');
    input.value = 'git push origin main';
    await el._runRevise(0, input.value);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert(resolved === 'yes-always:0', `Return in a valid input must approve, got '${resolved}'`);
    assert(options[0].rules[0].value === 'git push origin main', 'approval persists the revised grant');

    // Invalid input → Return does nothing.
    const options2 = [
      { label: "Yes + Don't Ask Again", value: 'yes-always:0', style: 'primary-always',
        rules: [{ kind: 'glob', value: 'git push *' }], patterns: ['git push *'] },
      { label: 'No', value: 'no', style: 'secondary' }
    ];
    let resolved2 = /** @type {string|undefined} */ (undefined);
    const el2 = /** @type {any} */ (document.createElement('action-confirmation'));
    document.body.appendChild(el2);
    el2.setOptions({ options: options2 }, (v) => { resolved2 = v; },
      { onRevise: () => ({ valid: false, notice: 'no match', patterns: ['zzz'], rules: [] }) });
    el2._enterEditMode(0);
    const input2 = el2.querySelector('.pattern-edit-input');
    input2.value = 'zzz';
    await el2._runRevise(0, input2.value);
    input2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    assert(resolved2 === undefined, 'Return in an invalid input must NOT approve');

    el.remove();
    el2.remove();
    passed++;
  } catch (e) {
    failed++;
    errors.push(`keyboard revise: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 21: Escape while editing cancels the edit in place — it restores the
  // button (not disengage the whole approval) and discards the typed text,
  // reverting the option's grant to its pre-edit value.
  // =========================================================================
  try {
    const options = [
      { label: "Yes + Don't Ask Again", value: 'yes-always:0', style: 'primary-always',
        rules: [{ kind: 'glob', value: 'git push *' }], patterns: ['git push *'] },
      { label: 'No', value: 'no', style: 'secondary' }
    ];
    let resolved = /** @type {string|undefined} */ (undefined);
    const el = /** @type {any} */ (document.createElement('action-confirmation'));
    document.body.appendChild(el);
    el.setOptions({ options }, (v) => { resolved = v; },
      { onRevise: () => ({ valid: true, patterns: ['git push origin main'], rules: [{ kind: 'glob', value: 'git push origin main' }] }) });

    const row = el.querySelector('.action-approval-option[data-index="0"]');
    const field = row.querySelector('.pattern-edit-field');
    el._enterEditMode(0);
    const input = row.querySelector('.pattern-edit-input');
    input.value = 'git push origin main';
    await el._runRevise(0, input.value);
    assert(!field.hidden && row.classList.contains('editing'), 'is editing before Escape');
    // The valid revise updated the live grant; Escape must roll it back.
    assert(options[0].rules[0].value === 'git push origin main', 'grant updated while editing');

    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

    assert(field.hidden && !row.classList.contains('editing'), 'Escape leaves edit mode');
    assert(!row.querySelector('.option-descriptor').hasAttribute('hidden'),
      'the button descriptor is shown again after Escape');
    assert(options[0].rules[0].value === 'git push *', 'Escape reverts the grant to its pre-edit value');
    assert(resolved === undefined, 'Escape cancels the edit only — it must NOT resolve the approval');

    el.remove();
    passed++;
  } catch (e) {
    failed++;
    errors.push(`escape cancels edit: ${e instanceof Error ? e.message : String(e)}`);
  }

  // =========================================================================
  // Test 22: clicking away from the edit input (focusout) also cancels the
  // edit — restoring the button and reverting the grant, exactly like Escape.
  // =========================================================================
  try {
    const options = [
      { label: "Yes + Don't Ask Again", value: 'yes-always:0', style: 'primary-always',
        rules: [{ kind: 'glob', value: 'git push *' }], patterns: ['git push *'] },
      { label: 'No', value: 'no', style: 'secondary' }
    ];
    const el = /** @type {any} */ (document.createElement('action-confirmation'));
    document.body.appendChild(el);
    el.setOptions({ options }, () => {},
      { onRevise: () => ({ valid: true, patterns: ['git push origin main'], rules: [{ kind: 'glob', value: 'git push origin main' }] }) });

    const row = el.querySelector('.action-approval-option[data-index="0"]');
    const field = row.querySelector('.pattern-edit-field');
    el._enterEditMode(0);
    const input = row.querySelector('.pattern-edit-input');
    input.value = 'git push origin main';
    await el._runRevise(0, input.value);
    assert(row.classList.contains('editing'), 'is editing before blur');

    // Simulate focus leaving the input for somewhere outside the widget.
    // A focusout with no relatedTarget reads as "focus left the widget", which
    // is the click-away case (the handler treats null relatedTarget as outside).
    input.dispatchEvent(new Event('focusout', { bubbles: true }));

    assert(field.hidden && !row.classList.contains('editing'), 'blur leaves edit mode');
    assert(options[0].rules[0].value === 'git push *', 'blur reverts the grant to its pre-edit value');
    assert(!row.querySelector('.option-descriptor').hasAttribute('hidden'),
      'the button descriptor is shown again after blur');

    el.remove();
    passed++;
  } catch (e) {
    failed++;
    errors.push(`click-away cancels edit: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
