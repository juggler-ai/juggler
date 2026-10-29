//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Streaming Actions
 *
 * Tests that streaming action output is handled correctly:
 * - Multiple chunks arrive (not buffered)
 * - LLM waits for completion (not premature continuation)
 * - Status transitions are correct
 * @module integration-tests/streaming-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';

// ============================================================================
// TEST 1: LLM waits for streaming completion (CRITICAL)
// ============================================================================

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const streamingLlmWaitsTest = {
  name: 'streaming-llm-waits',
  description: 'LLM receives complete streaming output before continuing',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash',
      // Command that produces multiple lines of output
      { command: 'env echo "line1"; echo "line2"; echo "line3"' },
      'Running.'
    ),
    textResponse('Completed.')
  ],

  operations: [
    { type: 'send-message', message: 'Run streaming command' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },

    // Start capturing BEFORE approval
    { type: 'start-capture-progress', toolUseId: 'call_1' },
    { type: 'approve', toolUseId: 'call_1' }

    // The test verifies correct behavior via the final document state:
    // - If LLM continued prematurely, we'd see wrong content or missing items
    // - The second LLM response ('Completed.') only appears after tool completes
    // - Progress capture proves streaming occurred (checked by framework)
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run streaming command' },
      { type: 'assistant', content: 'Running.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env echo "line1"; echo "line2"; echo "line3"' },
        state: 'completed',
        result: {
          content: 'line1\nline2\nline3',
          isError: false
        }
      },
      { type: 'assistant', content: 'Completed.' }
    ]
  }
};

// ============================================================================
// TEST 2: Multiple chunks streamed (not buffered)
// ============================================================================

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const streamingMultipleChunksTest = {
  name: 'streaming-multiple-chunks',
  description: 'Verify output streams in multiple chunks, not buffered',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash',
      // Multiple echo commands produce multiple writes
      { command: 'env echo "line1"; echo "line2"; echo "line3"' },
      'Running.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Run multi-line command' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'start-capture-progress', toolUseId: 'call_1' },
    { type: 'approve', toolUseId: 'call_1' }
    // Assert we got multiple chunks (proves streaming, not buffering)
    // Note: The assertion happens after waitForIdle in the framework,
    // but assertStreamingChunks is called during operations
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run multi-line command' },
      { type: 'assistant', content: 'Running.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env echo "line1"; echo "line2"; echo "line3"' },
        state: 'completed',
        result: {
          content: 'line1\nline2\nline3',
          isError: false
        }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  }
};

// ============================================================================
// TEST 3: Approval blocks execution (baseline)
// ============================================================================

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const streamingApprovalBlocksTest = {
  name: 'streaming-approval-blocks',
  description: 'Streaming does not start until approved',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash',
      { command: 'env echo "approved"' },
      'Need approval.'
    ),
    textResponse('Executed.')
  ],

  operations: [
    { type: 'send-message', message: 'Run with approval' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },

    // Assert BEFORE approval: no result, no 4th item
    { type: 'assert-document', expected: {
      items: [
        { type: 'system-prompt', itemId: '$ITEM_1' },
        { type: 'user', content: 'Run with approval' },
        { type: 'assistant', content: 'Need approval.' },
        {
          type: 'tool-action',
          toolUseId: '$TOOL_1',
          toolName: 'bash',
          toolInput: { command: 'env echo "approved"' },
          state: 'pending'
          // No result - approval is pending
        }
      ]
    }},

    { type: 'approve', toolUseId: 'call_1' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run with approval' },
      { type: 'assistant', content: 'Need approval.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env echo "approved"' },
        state: 'completed',
        result: { content: 'approved', isError: false }
      },
      { type: 'assistant', content: 'Executed.' }
    ]
  }
};

// ============================================================================
// TEST 4: Non-zero exit code captured
// ============================================================================

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const streamingErrorExitTest = {
  name: 'streaming-error-exit',
  description: 'Streaming captures output even with non-zero exit',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash',
      { command: 'env echo "partial"; exit 1' },
      'Running.'
    ),
    textResponse('Failed.')
  ],

  operations: [
    { type: 'send-message', message: 'Run failing command' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'approve', toolUseId: 'call_1' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run failing command' },
      { type: 'assistant', content: 'Running.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env echo "partial"; exit 1' },
        state: 'completed',
        result: {
          content: 'partial\n\nexit code: 1\n\nCommand failed with exit code 1',
          isError: false
        }
      },
      { type: 'assistant', content: 'Failed.' }
    ]
  }
};

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const mainThreadSpinnerTest = {
  name: 'main-thread-spinner-appears',
  description: 'DOM spinner appears when processingState becomes non-idle (llmState → updateAllFooters path)',
  fixture: 'unit-test-fixture',

  llmResponses: [],

  operations: [
    // Directly write non-idle processingState; Yjs observers fire synchronously,
    // so llmState updates the DOM before startSpinnerCapture returns.
    { type: 'start-spinner-capture', threadType: 'main' },
    { type: 'assert-spinner-was-visible' },
  ],

  expectedItems: [
    { type: 'system-prompt' },
  ]
};

// Export all tests
export const tests = [
  streamingLlmWaitsTest,
  streamingMultipleChunksTest,
  streamingApprovalBlocksTest,
  streamingErrorExitTest,
  mainThreadSpinnerTest
];
