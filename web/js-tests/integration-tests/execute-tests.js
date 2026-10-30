//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Execute (Bash) Operations
 *
 * Tests bash through the full pipeline with approval flow.
 * CRITICAL: Every tool-action must have explicit state and result.
 * @module integration-tests/execute-tests
 */

import { textResponse, toolUseResponse, multiToolResponse } from '../utilities/integration-test-runner.js';
import { isToolActionMessage } from '../../sdk/lib/message.js';

// ============================================================================
// GOLDEN DATA - Expected command output
// Bash now returns real command output (stdout) instead of generic message
// ============================================================================

// ============================================================================
// TEST DEFINITIONS
// ============================================================================

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const executeEchoTest = {
  name: 'execute-echo',
  description: 'Simple echo command with approval',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'bash',
      { command: 'env echo "hello world"' },
      'Running command.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Run echo hello world' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'approve', toolUseId: 'call_1' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run echo hello world' },
      { type: 'assistant', content: 'Running command.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env echo "hello world"' },
        state: 'completed',
        result: {
          content: 'hello world',
          isError: false
        }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  }
};

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const executeMultilineTest = {
  name: 'execute-multiline',
  description: 'Multi-line output captured',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'bash',
      { command: 'env echo "line1"; echo "line2"; echo "line3"' },
      'Running.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Run multiline echo' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'approve', toolUseId: 'call_1' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run multiline echo' },
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

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const executeDeniedTest = {
  name: 'execute-denied',
  description: 'Denied command not executed',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'bash',
      { command: 'env echo "should not run"' },
      'Trying to run.'
    )
  ],

  operations: [
    { type: 'send-message', message: 'Run echo' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'deny', toolUseId: 'call_1' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run echo' },
      { type: 'assistant', content: 'Trying to run.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env echo "should not run"' },
        state: 'cancelled',
        result: {
          content: 'Action was cancelled.',
          isError: false
        }
      }
    ]
  }
};

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const executeCreateFileTest = {
  name: 'execute-create-file',
  description: 'Command creates file (side effect)',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'bash',
      { command: 'env echo "created by bash" > bash-created.txt' },
      'Creating file via bash.'
    ),
    textResponse('File created.')
  ],

  operations: [
    { type: 'send-message', message: 'Create file via bash' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'approve', toolUseId: 'call_1' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Create file via bash' },
      { type: 'assistant', content: 'Creating file via bash.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env echo "created by bash" > bash-created.txt' },
        state: 'completed',
        result: {
          // No stdout because output was redirected to file
          content: '(no output)',
          isError: false
        }
      },
      { type: 'assistant', content: 'File created.' }
    ]
  }
  // Note: File assertion removed because the ops API validates paths against
  // the server's project path, not the test fixture directory. The test still
  // verifies bash command execution and approval flow work correctly.
};

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const executeSequentialTest = {
  name: 'execute-sequential',
  description: 'Multiple commands in sequence',
  fixture: 'unit-test-fixture',

  llmResponses: [
    multiToolResponse([
      { toolUseId: 'call_1', toolName: 'bash', toolInput: { command: 'env echo "first"' } },
      { toolUseId: 'call_2', toolName: 'bash', toolInput: { command: 'env echo "second"' } }
    ], 'Running two commands.'),
    textResponse('Both done.')
  ],

  operations: [
    { type: 'send-message', message: 'Run two commands' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'approve', toolUseId: 'call_1' },
    { type: 'wait-for-approval', toolUseId: 'call_2' },
    { type: 'approve', toolUseId: 'call_2' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run two commands' },
      { type: 'assistant', content: 'Running two commands.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env echo "first"' },
        state: 'completed',
        result: {
          content: 'first',
          isError: false
        }
      },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'bash',
        toolInput: { command: 'env echo "second"' },
        state: 'completed',
        result: {
          content: 'second',
          isError: false
        }
      },
      { type: 'assistant', content: 'Both done.' }
    ]
  }
};

/**
 * A finished command's output is stored once, as the result content. The live
 * preview the panel streams while the command runs (`displayData.output`) is
 * gone once the result lands, and the stored action result keeps the exit code
 * but not a second copy of stdout.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const executeOutputStoredOnceTest = {
  name: 'execute-output-stored-once',
  description: 'Command output is stored once, as the result content',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'bash',
      { command: 'env printf "%s-%s" twice-a twice-b' },
      'Running.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Run printf' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'approve', toolUseId: 'call_1' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run printf' },
      { type: 'assistant', content: 'Running.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env printf "%s-%s" twice-a twice-b' },
        state: 'completed',
        result: {
          content: 'twice-a-twice-b',
          isError: false
        }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  },

  customAssertions(conversation) {
    const action = /** @type {any} */ ([...conversation.rootItems].find(
      item => isToolActionMessage(/** @type {any} */ (item)) &&
      /** @type {any} */ (item).get('toolName') === 'bash'
    ));
    if (!action) throw new Error('bash tool-action not found in items');
    const plainOf = (/** @type {any} */ v) => (v?.toJSON ? v.toJSON() : v);
    const displayData = plainOf(action.get('displayData'));
    const result = plainOf(action.get('result'));
    const stored = JSON.stringify({ displayData, result });
    const copies = stored.split('twice-a-twice-b').length - 1;
    if (copies !== 1) {
      throw new Error(`the output should be stored once, found ${copies} copies in ${stored}`);
    }
    if (displayData && 'output' in displayData) {
      throw new Error(`the live preview outlived the result: displayData = ${JSON.stringify(displayData)}`);
    }
    if (result?.fullResult?.result?.exitCode !== 0) {
      throw new Error(`the stored result lost the exit code: ${JSON.stringify(result?.fullResult)}`);
    }
  }
};

// Export all tests
export const tests = [
  executeEchoTest,
  executeMultilineTest,
  executeDeniedTest,
  executeCreateFileTest,
  executeSequentialTest,
  executeOutputStoredOnceTest
];
