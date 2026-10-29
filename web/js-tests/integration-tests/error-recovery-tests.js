//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Error Recovery
 *
 * Tests error handling and recovery scenarios:
 * - Invalid tool parameters
 * - Tool execution failures (e.g., file not found)
 * @module integration-tests/error-recovery-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';

// ============================================================================
// TEST DEFINITIONS
// ============================================================================

/**
 * Invalid tool parameters test.
 *
 * When LLM provides invalid parameters to a tool, the system should:
 * - Return validation error
 * - Not execute the tool
 * - Allow LLM to retry with correct parameters
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const errorInvalidToolParamsTest = {
  name: 'error-invalid-tool-params',
  description: 'Invalid tool parameters are handled gracefully',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // Tool with invalid/missing parameters
    toolUseResponse('call_1', 'read', { }, 'Reading file.'),  // Missing file_path
    textResponse('I see the error, let me fix that.')
  ],

  operations: [
    { type: 'send-message', message: 'Read a file' }
    // read tool should fail due to missing file_path
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Read a file' },
      { type: 'assistant', content: 'Reading file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'read',
        toolInput: { },
        state: 'completed',
        result: {
          content: 'Missing required parameter: file_path',
          isError: true  // Should be error due to missing path
        }
      },
      { type: 'assistant', content: 'I see the error, let me fix that.' }
    ]
  }
};

/**
 * Tool execution error recovery test.
 *
 * When a tool execution fails (e.g., file not found), the system should:
 * - Return error in result
 * - Allow conversation to continue
 * - LLM can decide how to proceed
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const errorToolExecutionFailureTest = {
  name: 'error-tool-execution-failure',
  description: 'Tool execution errors are reported correctly',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // Tool that will fail (non-existent file)
    toolUseResponse('call_1', 'read', { file_path: 'nonexistent.txt' }, 'Reading file.'),
    textResponse('File not found, let me try something else.')
  ],

  operations: [
    { type: 'send-message', message: 'Read nonexistent.txt' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Read nonexistent.txt' },
      { type: 'assistant', content: 'Reading file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'read',
        toolInput: { file_path: 'nonexistent.txt' },
        state: 'completed',
        result: {
          content: 'File does not exist: nonexistent.txt. Do not attempt to read it again.',
          isError: false  // Read returns isError: false with error message
        }
      },
      { type: 'assistant', content: 'File not found, let me try something else.' }
    ]
  }
};

/**
 * Error items appear as type 'error' in the document.
 *
 * When a tool fails (e.g., missing required parameter), the error result
 * should be on the tool-action item. No 'system' type items should appear.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const errorItemTypeTest = {
  name: 'error-item-type',
  description: 'Error items appear as type error, not system',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // Tool with invalid parameters to trigger an error result
    toolUseResponse('call_1', 'read', {}, 'Let me read that.'),  // Missing file_path
    textResponse('Got it, the tool failed.')
  ],

  operations: [
    { type: 'send-message', message: 'Read a file for me' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Read a file for me' },
      { type: 'assistant', content: 'Let me read that.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'read',
        toolInput: {},
        state: 'completed',
        result: {
          content: 'Missing required parameter: file_path',
          isError: true
        }
      },
      { type: 'assistant', content: 'Got it, the tool failed.' }
    ]
  }
};

// Export all tests
export const tests = [
  errorInvalidToolParamsTest,
  errorToolExecutionFailureTest,
  errorItemTypeTest
];
