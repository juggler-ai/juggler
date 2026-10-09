//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Approval Flow
 *
 * Tests approval workflows through the full pipeline.
 * CRITICAL: Every tool-action must have explicit state assertion.
 * @module integration-tests/approval-flow-tests
 */

import { testDirFor, textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';

// ============================================================================
// GOLDEN DATA - Expected results
// ============================================================================

// Bash now returns real command output (not the generic "Action completed." message)

/** README.md content formatted with line numbers (cat -n style) */
const README_MD = '<file path="README.md">\n' +
	'1\t# Test Fixture Project\n' +
	'2\t\n' +
	'3\tA simple test fixture used for integration tests.\n' +
	'4\t\n' +
	'5\t## Structure\n' +
	'6\t- `src/main.go` - Main Go source file\n' +
	'7\t- `config.json` - Configuration file\n' +
	'8\t\n' +
	'</file>\n' +
	'(8 lines total)';

// ============================================================================
// TEST DEFINITIONS
// ============================================================================

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const approvalApproveTest = {
  name: 'approval-approve',
  description: 'Approve bash command - executes and returns output',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'bash',
      { command: 'env echo approval-test' },
      'Running command.'
    ),
    textResponse('Command completed.')
  ],

  operations: [
    { type: 'send-message', message: 'Run echo approval-test' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'approve', toolUseId: 'call_1' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run echo approval-test' },
      { type: 'assistant', content: 'Running command.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env echo approval-test' },
        state: 'completed',
        result: {
          content: 'approval-test',
          isError: false
        }
      },
      { type: 'assistant', content: 'Command completed.' }
    ]
  }
};

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const approvalDenyTest = {
  name: 'approval-deny',
  description: 'Deny bash command - not executed, result shows cancellation',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'bash',
      { command: 'env echo deny-test' },
      'Running command.'
    )
  ],

  operations: [
    { type: 'send-message', message: 'Run echo deny-test' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'deny', toolUseId: 'call_1' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run echo deny-test' },
      { type: 'assistant', content: 'Running command.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env echo deny-test' },
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
export const approvalMultiToolTest = {
  name: 'approval-multi-tool',
  description: 'Multiple tools with mixed approval — any deny stops the loop',
  fixture: 'unit-test-fixture',

  llmResponses: [
    {
      blocks: [
        { type: 'text', content: 'Running two commands.' },
        { type: 'tool_use', toolUseId: 'call_1', toolName: 'bash', toolInput: { command: 'env echo first' } },
        { type: 'tool_use', toolUseId: 'call_2', toolName: 'bash', toolInput: { command: 'env echo second' } }
      ],
      stopReason: 'tool_use'
    }
  ],

  operations: [
    { type: 'send-message', message: 'Run two commands' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'approve', toolUseId: 'call_1' },
    { type: 'wait-for-approval', toolUseId: 'call_2' },
    { type: 'deny', toolUseId: 'call_2' }
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
        toolInput: { command: 'env echo first' },
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
        toolInput: { command: 'env echo second' },
        state: 'cancelled',
        result: {
          content: 'Action was cancelled.',
          isError: false
        }
      }
      // Loop stops — any denial stops the turn
    ]
  }
};

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const approvalAutoApproveReadTest = {
  name: 'approval-auto-approve-read',
  description: 'Read operations auto-approve without user interaction',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'read',
      { file_path: 'README.md' },
      'Reading file.'
    ),
    textResponse('File read.')
  ],

  // No approval operations needed - read auto-approves
  operations: [
    { type: 'send-message', message: 'Read README.md' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Read README.md' },
      { type: 'assistant', content: 'Reading file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'read',
        toolInput: { file_path: 'README.md' },
        state: 'completed',
        result: {
          content: README_MD,
          isError: false
        }
      },
      { type: 'assistant', content: 'File read.' }
    ]
  }
};

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const approvalMixedAutoAndManualTest = {
  name: 'approval-mixed-auto-manual',
  description: 'Mix of auto-approved and manual approval tools',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // Turn 1: LLM reads (auto) and runs command (manual)
    {
      blocks: [
        { type: 'text', content: 'Reading and running.' },
        { type: 'tool_use', toolUseId: 'call_1', toolName: 'read', toolInput: { file_path: 'README.md' } },
        { type: 'tool_use', toolUseId: 'call_2', toolName: 'bash', toolInput: { command: 'env echo test' } }
      ],
      stopReason: 'tool_use'
    },
    textResponse('Both completed.')
  ],

  operations: [
    { type: 'send-message', message: 'Read README.md and run echo test' },
    // Read auto-approves, but bash needs manual approval
    { type: 'wait-for-approval', toolUseId: 'call_2' },
    { type: 'approve', toolUseId: 'call_2' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Read README.md and run echo test' },
      { type: 'assistant', content: 'Reading and running.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'read',
        toolInput: { file_path: 'README.md' },
        state: 'completed',
        result: {
          content: README_MD,
          isError: false
        }
      },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'bash',
        toolInput: { command: 'env echo test' },
        state: 'completed',
        result: {
          content: 'test',
          isError: false
        }
      },
      { type: 'assistant', content: 'Both completed.' }
    ]
  }
};

// ============================================================================
// ADDITIONAL TESTS: Timeout/Disconnect/Edge Cases
// ============================================================================

/**
 * Three parallel tools requiring approval.
 * Tests the approval queue handling with multiple pending tools.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const approvalParallel3ToolsTest = {
  name: 'approval-parallel-3-tools',
  description: 'Three parallel tools all requiring approval',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // Three tools in parallel
    {
      blocks: [
        { type: 'text', content: 'Running three commands.' },
        { type: 'tool_use', toolUseId: 'call_1', toolName: 'bash', toolInput: { command: 'env echo first' } },
        { type: 'tool_use', toolUseId: 'call_2', toolName: 'bash', toolInput: { command: 'env echo second' } },
        { type: 'tool_use', toolUseId: 'call_3', toolName: 'bash', toolInput: { command: 'env echo third' } }
      ],
      stopReason: 'tool_use'
    },
    textResponse('All three completed.')
  ],

  operations: [
    { type: 'send-message', message: 'Run three commands' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'approve', toolUseId: 'call_1' },
    { type: 'wait-for-approval', toolUseId: 'call_2' },
    { type: 'approve', toolUseId: 'call_2' },
    { type: 'wait-for-approval', toolUseId: 'call_3' },
    { type: 'approve', toolUseId: 'call_3' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run three commands' },
      { type: 'assistant', content: 'Running three commands.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env echo first' },
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
        toolInput: { command: 'env echo second' },
        state: 'completed',
        result: {
          content: 'second',
          isError: false
        }
      },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_3',
        toolName: 'bash',
        toolInput: { command: 'env echo third' },
        state: 'completed',
        result: {
          content: 'third',
          isError: false
        }
      },
      { type: 'assistant', content: 'All three completed.' }
    ]
  }
};

/**
 * Five parallel tools with mixed approval/deny.
 * More comprehensive test of the approval queue.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const approvalParallel5ToolsTest = {
  name: 'approval-parallel-5-tools',
  description: 'Denying any tool in a 5-tool batch cascades to cancel all pending',
  fixture: 'unit-test-fixture',

  llmResponses: [
    {
      blocks: [
        { type: 'text', content: 'Running five commands.' },
        { type: 'tool_use', toolUseId: 'call_1', toolName: 'bash', toolInput: { command: 'env echo 1' } },
        { type: 'tool_use', toolUseId: 'call_2', toolName: 'bash', toolInput: { command: 'env echo 2' } },
        { type: 'tool_use', toolUseId: 'call_3', toolName: 'bash', toolInput: { command: 'env echo 3' } },
        { type: 'tool_use', toolUseId: 'call_4', toolName: 'bash', toolInput: { command: 'env echo 4' } },
        { type: 'tool_use', toolUseId: 'call_5', toolName: 'bash', toolInput: { command: 'env echo 5' } }
      ],
      stopReason: 'tool_use'
    }
  ],

  operations: [
    { type: 'send-message', message: 'Run five commands' },
    // Approve call_1, then deny call_2 — cascade cancels call_3..5
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'approve', toolUseId: 'call_1' },
    { type: 'wait-for-approval', toolUseId: 'call_2' },
    { type: 'deny', toolUseId: 'call_2' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run five commands' },
      { type: 'assistant', content: 'Running five commands.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env echo 1' },
        state: 'completed',
        result: { content: '1', isError: false }
      },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'bash',
        toolInput: { command: 'env echo 2' },
        state: 'cancelled',
        result: { content: 'Action was cancelled.', isError: false }
      },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_3',
        toolName: 'bash',
        toolInput: { command: 'env echo 3' },
        state: 'cancelled',
        result: { content: 'Action was cancelled.', isError: false }
      },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_4',
        toolName: 'bash',
        toolInput: { command: 'env echo 4' },
        state: 'cancelled',
        result: { content: 'Action was cancelled.', isError: false }
      },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_5',
        toolName: 'bash',
        toolInput: { command: 'env echo 5' },
        state: 'cancelled',
        result: { content: 'Action was cancelled.', isError: false }
      }
    ]
  }
};

/**
 * Out-of-order approval - approve call_2 before call_1.
 * Tests that approval order doesn't matter.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const approvalOutOfOrderTest = {
  name: 'approval-out-of-order',
  description: 'Approvals can be given in any order',
  fixture: 'unit-test-fixture',

  llmResponses: [
    {
      blocks: [
        { type: 'text', content: 'Two commands.' },
        { type: 'tool_use', toolUseId: 'call_1', toolName: 'bash', toolInput: { command: 'env echo first' } },
        { type: 'tool_use', toolUseId: 'call_2', toolName: 'bash', toolInput: { command: 'env echo second' } }
      ],
      stopReason: 'tool_use'
    },
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Two commands' },
    // Wait for BOTH to be pending before approving
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'wait-for-approval', toolUseId: 'call_2' },
    // Approve out of order (second before first)
    { type: 'approve', toolUseId: 'call_2' },
    { type: 'approve', toolUseId: 'call_1' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Two commands' },
      { type: 'assistant', content: 'Two commands.' },
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
      { type: 'assistant', content: 'Done.' }
    ]
  }
};

const TD_ao = testDirFor('approval-ordered-dependent-pair');
const AO_WRITE = `env sh -c 'sleep 0.5; mkdir -p ${TD_ao} && echo made > ${TD_ao}/f.txt; echo wrote'`;
/**
 * One turn writes a file slowly, then reads it. Both are approved while the
 * first is still running: the second must wait for it rather than race it,
 * because calls that are not reads run in emission order. The category the
 * worker orders them by is stamped on each call when it is evaluated.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const approvalOrderedDependentPairTest = {
  name: 'approval-ordered-dependent-pair',
  description: 'A second command approved during the first waits for it to finish',
  fixture: 'unit-test-fixture',

  llmResponses: [
    {
      blocks: [
        { type: 'text', content: 'Write, then read.' },
        { type: 'tool_use', toolUseId: 'call_1', toolName: 'bash', toolInput: { command: AO_WRITE } },
        { type: 'tool_use', toolUseId: 'call_2', toolName: 'bash', toolInput: { command: `env cat ${TD_ao}/f.txt` } }
      ],
      stopReason: 'tool_use'
    },
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Write then read' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'wait-for-approval', toolUseId: 'call_2' },
    { type: 'assert-tool-field', toolUseId: 'call_1', field: 'category', value: 'write' },
    { type: 'assert-tool-field', toolUseId: 'call_2', field: 'category', value: 'write' },
    { type: 'approve-no-wait', toolUseId: 'call_1' },
    { type: 'wait-for-execution', toolUseId: 'call_1' },
    { type: 'approve', toolUseId: 'call_2' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Write then read' },
      { type: 'assistant', content: 'Write, then read.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: AO_WRITE },
        state: 'completed',
        result: { content: 'wrote', isError: false }
      },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'bash',
        toolInput: { command: `env cat ${TD_ao}/f.txt` },
        state: 'completed',
        result: { content: 'made', isError: false }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  }
};

/**
 * Deny single tool - loop should stop entirely (no 2nd LLM turn).
 * The 2nd LLM response is provided but should never be consumed.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const approvalDenyStopsLoopTest = {
  name: 'approval-deny-stops-loop',
  description: 'Denying a tool stops the LLM loop - no further turn',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'bash',
      { command: 'env echo should-not-run' },
      'Running command.'
    ),
    // This response should NEVER be consumed - the loop must stop
    textResponse('This should never appear.')
  ],

  operations: [
    { type: 'send-message', message: 'Run a command' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'deny', toolUseId: 'call_1' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run a command' },
      { type: 'assistant', content: 'Running command.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env echo should-not-run' },
        state: 'cancelled',
        result: {
          content: 'Action was cancelled.',
          isError: false
        }
      }
      // No 5th item - loop stopped
    ]
  }
};

/**
 * Two tools both denied - loop should stop when ALL tools in a batch are cancelled.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const approvalDenyAllMultiToolTest = {
  name: 'approval-deny-all-multi-tool',
  description: 'Denying any tool in a batch cancels all pending tools (cascade policy)',
  fixture: 'unit-test-fixture',

  llmResponses: [
    {
      blocks: [
        { type: 'text', content: 'Running two commands.' },
        { type: 'tool_use', toolUseId: 'call_1', toolName: 'bash', toolInput: { command: 'env echo first' } },
        { type: 'tool_use', toolUseId: 'call_2', toolName: 'bash', toolInput: { command: 'env echo second' } }
      ],
      stopReason: 'tool_use'
    },
    // This response should NEVER be consumed
    textResponse('This should never appear.')
  ],

  operations: [
    { type: 'send-message', message: 'Run two commands' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    // Denying call_1 cascades: all pending tools in the batch are cancelled
    { type: 'deny', toolUseId: 'call_1' }
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
        toolInput: { command: 'env echo first' },
        state: 'cancelled',
        result: {
          content: 'Action was cancelled.',
          isError: false
        }
      },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'bash',
        toolInput: { command: 'env echo second' },
        state: 'cancelled',
        result: {
          content: 'Action was cancelled.',
          isError: false
        }
      }
      // No final assistant item - loop stopped
    ]
  }
};

/**
 * Auto-approved read + denied bash — loop should CONTINUE because the
 * read produced a useful result for the LLM to act on.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const approvalMixedAutoDenyTest = {
  name: 'approval-mixed-auto-deny',
  description: 'Auto-approved read + denied bash stops the loop',
  fixture: 'unit-test-fixture',

  llmResponses: [
    {
      blocks: [
        { type: 'text', content: 'Reading and running.' },
        { type: 'tool_use', toolUseId: 'call_1', toolName: 'read', toolInput: { file_path: 'README.md' } },
        { type: 'tool_use', toolUseId: 'call_2', toolName: 'bash', toolInput: { command: 'env echo denied' } }
      ],
      stopReason: 'tool_use'
    }
  ],

  operations: [
    { type: 'send-message', message: 'Read and run' },
    // Read auto-approves, bash needs manual approval
    { type: 'wait-for-approval', toolUseId: 'call_2' },
    { type: 'deny', toolUseId: 'call_2' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Read and run' },
      { type: 'assistant', content: 'Reading and running.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'read',
        toolInput: { file_path: 'README.md' },
        state: 'completed',
        result: {
          content: README_MD,
          isError: false
        }
      },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'bash',
        toolInput: { command: 'env echo denied' },
        state: 'cancelled',
        result: {
          content: 'Action was cancelled.',
          isError: false
        }
      }
      // Loop stops — any denial stops the turn
    ]
  }
};

/**
 * Three tools all denied — loop must stop.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const approvalDenyAll3ToolsTest = {
  name: 'approval-deny-all-3-tools',
  description: 'Denying any tool in a 3-tool batch cascades to cancel all',
  fixture: 'unit-test-fixture',

  llmResponses: [
    {
      blocks: [
        { type: 'text', content: 'Three commands.' },
        { type: 'tool_use', toolUseId: 'call_1', toolName: 'bash', toolInput: { command: 'env echo 1' } },
        { type: 'tool_use', toolUseId: 'call_2', toolName: 'bash', toolInput: { command: 'env echo 2' } },
        { type: 'tool_use', toolUseId: 'call_3', toolName: 'bash', toolInput: { command: 'env echo 3' } }
      ],
      stopReason: 'tool_use'
    },
    // Should never be consumed
    textResponse('This should never appear.')
  ],

  operations: [
    { type: 'send-message', message: 'Run three commands' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    // Denying call_1 cascades: all pending tools in the batch are cancelled
    { type: 'deny', toolUseId: 'call_1' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run three commands' },
      { type: 'assistant', content: 'Three commands.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env echo 1' },
        state: 'cancelled',
        result: { content: 'Action was cancelled.', isError: false }
      },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'bash',
        toolInput: { command: 'env echo 2' },
        state: 'cancelled',
        result: { content: 'Action was cancelled.', isError: false }
      },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_3',
        toolName: 'bash',
        toolInput: { command: 'env echo 3' },
        state: 'cancelled',
        result: { content: 'Action was cancelled.', isError: false }
      }
      // No final assistant item - loop stopped
    ]
  }
};

// Export all tests
// NOTE: Timeout/disconnect/reconnect tests removed - require complex WebSocket simulation
export const tests = [
  approvalApproveTest,
  approvalDenyTest,
  approvalDenyStopsLoopTest,
  approvalDenyAllMultiToolTest,
  approvalMultiToolTest,
  approvalAutoApproveReadTest,
  approvalMixedAutoAndManualTest,
  approvalMixedAutoDenyTest,
  // Parallel approval tests
  approvalParallel3ToolsTest,
  approvalDenyAll3ToolsTest,
  approvalParallel5ToolsTest,
  approvalOutOfOrderTest,
  approvalOrderedDependentPairTest
];
