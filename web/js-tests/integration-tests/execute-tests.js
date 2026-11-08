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

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';
import { isToolActionMessage } from '../../sdk/lib/message.js';

// ============================================================================
// GOLDEN DATA - Expected command output
// Bash now returns real command output (stdout) instead of generic message
// ============================================================================

// ============================================================================
// TEST DEFINITIONS
// ============================================================================

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
  executeOutputStoredOnceTest
];
