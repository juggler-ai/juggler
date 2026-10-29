//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Approval Wait Behavior
 *
 * Tests that the LLM loop correctly blocks waiting for approval.
 * CRITICAL: Uses intermediate assert-document operations to verify the loop
 * hasn't continued prematurely.
 * @module integration-tests/approval-wait-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';

// ============================================================================
// GOLDEN DATA - Expected file contents (from read-file-tests.js)
// ============================================================================

/** src/main.go content formatted with line numbers (cat -n style) */
const MAIN_GO = '<file path="src/main.go">\n' +
	' 1\tpackage main\n' +
	' 2\t\n' +
	' 3\timport "fmt"\n' +
	' 4\t\n' +
	' 5\tfunc main() {\n' +
	' 6\t\tfmt.Println("Hello, World!")\n' +
	' 7\t}\n' +
	' 8\t\n' +
	' 9\tfunc add(a, b int) int {\n' +
	'10\t\treturn a + b\n' +
	'11\t}\n' +
	'12\t\n' +
	'</file>\n' +
	'(12 lines total)';

// ============================================================================
// TEST DEFINITIONS
// ============================================================================

/**
 * Test that the LLM loop blocks on pending approval.
 * Uses intermediate assertion to verify loop hasn't continued.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const approvalBlocksLoopTest = {
  name: 'approval-blocks-loop',
  description: 'LLM loop blocks waiting for approval - does not continue prematurely',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash', { command: 'env echo blocked' }, 'Executing.'),
    textResponse('This should NOT appear while approval pending.')
  ],

  operations: [
    { type: 'send-message', message: 'Run echo blocked' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    // KEY: Assert document state WHILE approval is pending
    // If loop continued prematurely, there would be 4 items (second assistant msg)
    {
      type: 'assert-document',
      expected: {
        items: [
          { type: 'system-prompt', itemId: '$ITEM_1' },
          { type: 'user', content: 'Run echo blocked' },
          { type: 'assistant', content: 'Executing.' },
          {
            type: 'tool-action',
            toolUseId: '$TOOL_1',
            toolName: 'bash',
            toolInput: { command: 'env echo blocked' },
            state: 'pending'
            // No result - loop should be blocked
          }
          // NO 4th item - proves loop is blocked
        ]
      }
    },
    // Now approve and verify loop continues
    { type: 'approve', toolUseId: 'call_1' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run echo blocked' },
      { type: 'assistant', content: 'Executing.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env echo blocked' },
        state: 'completed',
        result: { content: 'blocked', isError: false }
      },
      { type: 'assistant', content: 'This should NOT appear while approval pending.' }
    ]
  }
};

/**
 * Test that the LLM loop waits for ALL tools in a batch.
 * After approving first tool, second is still pending - loop should NOT continue.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const approvalBlocksMultiToolTest = {
  name: 'approval-blocks-multi-tool',
  description: 'LLM loop blocks until all tools in batch are resolved',
  fixture: 'unit-test-fixture',

  llmResponses: [
    {
      blocks: [
        { type: 'text', content: 'Running two.' },
        { type: 'tool_use', toolUseId: 'call_1', toolName: 'bash', toolInput: { command: 'env echo first' } },
        { type: 'tool_use', toolUseId: 'call_2', toolName: 'bash', toolInput: { command: 'env echo second' } }
      ],
      stopReason: 'tool_use'
    },
    textResponse('Both done.')
  ],

  operations: [
    { type: 'send-message', message: 'Run two commands' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'approve', toolUseId: 'call_1' },
    // After approving first, second is still pending - loop should NOT continue
    { type: 'wait-for-approval', toolUseId: 'call_2' },
    {
      type: 'assert-document',
      expected: {
        items: [
          { type: 'system-prompt', itemId: '$ITEM_1' },
          { type: 'user', content: 'Run two commands' },
          { type: 'assistant', content: 'Running two.' },
          {
            type: 'tool-action',
            toolUseId: '$TOOL_1',
            toolName: 'bash',
            toolInput: { command: 'env echo first' },
            state: 'completed',
            result: { content: 'first', isError: false }
          },
          {
            type: 'tool-action',
            toolUseId: '$TOOL_2',
            toolName: 'bash',
            toolInput: { command: 'env echo second' },
            state: 'pending'
            // Still pending - no result
          }
          // NO 5th item - loop blocked on second tool
        ]
      }
    },
    { type: 'approve', toolUseId: 'call_2' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run two commands' },
      { type: 'assistant', content: 'Running two.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env echo first' },
        state: 'completed',
        result: { content: 'first', isError: false }
      },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'bash',
        toolInput: { command: 'env echo second' },
        state: 'completed',
        result: { content: 'second', isError: false }
      },
      { type: 'assistant', content: 'Both done.' }
    ]
  }
};

/**
 * Test that the LLM loop blocks for current batch even when previous batch completed.
 * This tests the race condition where:
 * 1. Batch 1: read (file read) executes (no approval needed), gets result, batch completes
 * 2. Batch 2: bash is added (needs approval)
 * 3. BUG: checkBatchComplete sees old read with result, signals completion prematurely
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const approvalBlocksAfterCompletedBatchTest = {
  name: 'approval-blocks-after-completed-batch',
  description: 'LLM loop waits for current batch even when previous batch has completed tools',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // First: read (no approval, executes immediately)
    toolUseResponse('call_1', 'read', { file_path: 'src/main.go' }, 'Reading file.'),
    // Second: bash (needs approval)
    toolUseResponse('call_2', 'bash', { command: 'env echo test' }, 'Running command.'),
    // Third: Should NOT appear until bash approved
    textResponse('Command completed.')
  ],

  operations: [
    { type: 'send-message', message: 'Read file then run command' },
    { type: 'wait-for-approval', toolUseId: 'call_2' },
    // CRITICAL: Assert loop is blocked with bash pending
    {
      type: 'assert-document',
      expected: {
        items: [
          { type: 'system-prompt', itemId: '$ITEM_1' },
          { type: 'user', content: 'Read file then run command' },
          { type: 'assistant', content: 'Reading file.' },
          {
            type: 'tool-action',
            toolUseId: '$TOOL_1',
            toolName: 'read',
            toolInput: { file_path: 'src/main.go' },
            state: 'completed',
            result: { content: MAIN_GO, isError: false }
          },
          { type: 'assistant', content: 'Running command.' },
          {
            type: 'tool-action',
            toolUseId: '$TOOL_2',
            toolName: 'bash',
            toolInput: { command: 'env echo test' },
            state: 'pending'
            // NO result - loop blocked
          }
          // NO 6th item = loop correctly blocked
        ]
      }
    },
    { type: 'approve', toolUseId: 'call_2' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Read file then run command' },
      { type: 'assistant', content: 'Reading file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'read',
        toolInput: { file_path: 'src/main.go' },
        state: 'completed',
        result: { content: MAIN_GO, isError: false }
      },
      { type: 'assistant', content: 'Running command.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'bash',
        toolInput: { command: 'env echo test' },
        state: 'completed',
        result: { content: 'test', isError: false }
      },
      { type: 'assistant', content: 'Command completed.' }
    ]
  }
};

// Export all tests
export const tests = [
  approvalBlocksLoopTest,
  approvalBlocksMultiToolTest,
  approvalBlocksAfterCompletedBatchTest
];
