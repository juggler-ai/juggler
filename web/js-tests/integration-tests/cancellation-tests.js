//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Mid-Execution Cancellation
 *
 * Tests that cancelling commands while they're running works correctly:
 * - Cancellation produces a result with cancelled state
 * - Partial output is preserved in the result
 * - LLM loop stops after cancellation (no further responses consumed)
 *
 * Note: Mid-execution cancellation transitions state to 'cancelled'.
 * The cancellation is also reflected in result.fullResult.cancelled=true.
 * @module integration-tests/cancellation-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';

// ============================================================================
// TEST 1: Cancel during execution
// ============================================================================

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const cancelDuringExecutionTest = {
  name: 'cancel-during-execution',
  description: 'Cancel a long-running command mid-execution',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash',
      { command: 'env echo "started"; sleep 10' },
      'Running long command.'
    ),
    // Second response: should NOT be consumed if cancellation works
    textResponse('Should not appear.')
  ],

  operations: [
    { type: 'send-message', message: 'Run long command' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'start-capture-progress', toolUseId: 'call_1' },
    { type: 'approve-no-wait', toolUseId: 'call_1' },
    // Wait for output to confirm execution has started
    { type: 'wait-for-progress', toolUseId: 'call_1', minEvents: 1 },
    // Cancel mid-execution
    { type: 'cancel' }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'Run long command' },
    { type: 'assistant', content: 'Running long command.' },
    {
      type: 'tool-action',
      toolName: 'bash',
      toolInput: { command: 'env echo "started"; sleep 10' },
      state: 'cancelled'
    }
  ]
};

// ============================================================================
// TEST 2: Cancel preserves partial output
// ============================================================================

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const cancelPreservesPartialOutputTest = {
  name: 'cancel-preserves-partial-output',
  description: 'Cancel a command that has already produced output',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash',
      { command: 'env echo "before"; sleep 10' },
      'Running.'
    ),
    textResponse('Should not appear.')
  ],

  operations: [
    { type: 'send-message', message: 'Run output command' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    // Start capturing progress to detect when output arrives
    { type: 'start-capture-progress', toolUseId: 'call_1' },
    { type: 'approve-no-wait', toolUseId: 'call_1' },
    // Wait for "before" to actually reach the action's output. The point of
    // the test is that cancelling keeps output already produced, so there has
    // to BE output already produced when the cancel lands. Waiting on a count
    // of progress events instead cancels during the start status — while the
    // command is still between its echo and its sleep — and then blames the
    // product for losing output it had not yet emitted.
    { type: 'wait-for-action-output', toolUseId: 'call_1', contains: 'before' },
    // Cancel after partial output
    { type: 'cancel' }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'Run output command' },
    { type: 'assistant', content: 'Running.' },
    {
      type: 'tool-action',
      toolName: 'bash',
      toolInput: { command: 'env echo "before"; sleep 10' },
      state: 'cancelled'
    }
  ],

  // The two writes this test spans come from different writers and arrive here
  // by different routes: the worker stamps state='cancelled' straight into the
  // doc, while the partial output is flushed by the bash item in the engine as
  // it unwinds, and only then syncs through to this viewer. The expectedItems
  // fence is satisfied by the first, so a one-shot read of displayData races
  // the second — fence on the output itself.
  settleUntil: (conversation) => cancelledPartialOutput(conversation).includes('before'),

  customAssertions: (conversation) => {
    const output = cancelledPartialOutput(conversation);
    if (!output.includes('before')) {
      throw new Error(`Cancelled bash lost its partial output; displayData.output was ${JSON.stringify(output)}`);
    }
  }
};

/**
 * The partial output the cancelled `call_1` bash action left in the document.
 * @param {import('../../js/model/conversation.js').default} conversation
 * @returns {string} The action's displayData.output, or '' when there is none yet.
 */
function cancelledPartialOutput(conversation) {
  const action = conversation.rootMessageThread.items.find(
    (item) => item.get?.('type') === 'tool-action' && item.get('toolUseId') === 'call_1'
  );
  const displayData = action?.get('displayData');
  return (displayData?.toJSON ? displayData.toJSON() : displayData)?.output || '';
}

// ============================================================================
// TEST 3: Cancel stops LLM loop
// ============================================================================

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const cancelStopsLlmLoopTest = {
  name: 'cancel-stops-llm-loop',
  description: 'Verify the LLM does not continue after cancellation',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash',
      { command: 'env echo "running"; sleep 10' },
      'Starting.'
    ),
    // This response should never be consumed
    textResponse('This text should never appear in the document.')
  ],

  operations: [
    { type: 'send-message', message: 'Run and cancel' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'start-capture-progress', toolUseId: 'call_1' },
    { type: 'approve-no-wait', toolUseId: 'call_1' },
    // Wait for output to confirm execution started
    { type: 'wait-for-progress', toolUseId: 'call_1', minEvents: 1 },
    { type: 'cancel' }
  ],

  // expectedItems verifies the tool is cancelled and the LLM didn't continue.
  // customAssertions enforces the strict 4-item count (no 5th assistant message).
  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'Run and cancel' },
    { type: 'assistant', content: 'Starting.' },
    {
      type: 'tool-action',
      toolUseId: '$TOOL_1',
      toolName: 'bash',
      toolInput: { command: 'env echo "running"; sleep 10' },
      state: 'cancelled'
    }
  ],

  customAssertions: (conversation) => {
    const items = conversation.rootMessageThread.items;
    // Strict: exactly 4 items — no 5th assistant message from the LLM loop
    if (items.length !== 4) {
      throw new Error(
        `Expected exactly 4 items (LLM loop stopped), got ${items.length}`
      );
    }
  }
};

// ============================================================================
// TEST 4: Delete running tool-action doesn't hang
// ============================================================================

/**
 * Tool is approved and running → user deletes the item → strategy loop exits
 * cleanly instead of hanging forever waiting for a batch signal.
 * Without the fix, checkBatchComplete finds toolCount=0 for the deleted tool
 * and returns without signaling → strategy loop blocks on batchCompleteChan
 * until the 2-minute timeout.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const deleteRunningToolTest = {
  name: 'delete-running-tool-no-hang',
  description: 'Deleting a running tool-action does not hang the strategy loop',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash',
      { command: 'env echo "started"; sleep 30' },
      'Running long command.'
    ),
    // Should NOT be consumed — deletion stops the loop
    textResponse('Should not appear.')
  ],

  operations: [
    { type: 'send-message', message: 'Run long command' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'start-capture-progress', toolUseId: 'call_1' },
    { type: 'approve-no-wait', toolUseId: 'call_1' },
    // Wait for output to confirm execution has started
    { type: 'wait-for-progress', toolUseId: 'call_1', minEvents: 1 },
    // Delete the running tool-action (last item in root)
    { type: 'delete-last-item' },
    // Verify the worker goes idle (not hung)
    { type: 'wait-for-state', condition: { processingStatus: 'idle' } }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'Run long command' },
    { type: 'assistant', content: 'Running long command.' }
    // tool-action deleted — NOT present
    // No 4th item — LLM loop stopped
  ]
};

// ============================================================================
// TEST 5: Cancel mid-stream preserves partial text in document
// ============================================================================

/**
 * When the LLM is streaming a text response and the user cancels, the partial
 * streaming text item must remain in the Yjs doc so the user can see what was
 * generated. The partial item is followed by a new user message in the history,
 * so the LLM will not try to "continue" it on the next turn.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const cancelMidStreamPreservesTextTest = {
  name: 'cancel-mid-stream-preserves-text',
  description: 'Cancelling while LLM streams text keeps the partial item visible; next message gets a fresh response',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // First response: streams text then pauses — cancel happens at the pause
    textResponse('Partial streaming text that will be cancelled.', { pauseBeforeReturn: true }),
    // Second response: fresh reply to the new user message
    textResponse('Fresh response to new message.')
  ],

  operations: [
    // Don't wait for turn completion — the mock will pause mid-stream
    { type: 'send-message-no-wait', message: 'First message' },
    // Wait until the mock has streamed its text but not yet returned
    { type: 'wait-for-mock-paused' },
    // Cancel while the text is mid-stream (item exists in Yjs but is not finalised)
    { type: 'cancel' },
    // Worker goes idle after cancel cleanup
    { type: 'wait-for-state', condition: { processingStatus: 'idle' } },
    // Send a new message — partial text stays in history, fresh response follows
    { type: 'send-message', message: 'Second message' }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'First message' },
    { type: 'assistant', content: 'Partial streaming text that will be cancelled.' },
    { type: 'user', content: 'Second message' },
    { type: 'assistant', content: 'Fresh response to new message.' }
  ],

  customAssertions: (conversation) => {
    const items = conversation.rootMessageThread.items;
    // Strict count: 5 items — partial assistant text is preserved between the two user messages
    if (items.length !== 5) {
      throw new Error(
        `Expected exactly 5 items (partial text preserved), got ${items.length}: ` +
				items.map(i => i.type).join(', ')
      );
    }
  }
};

// Export all tests
export const tests = [
  cancelDuringExecutionTest,
  cancelPreservesPartialOutputTest,
  cancelStopsLlmLoopTest,
  deleteRunningToolTest,
  cancelMidStreamPreservesTextTest
];
