//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Write File Operations
 *
 * Tests write through the full pipeline: sendMessage → worker → mock LLM → tool execution → Yjs sync
 * @module integration-tests/write-file-tests
 *
 * Each test uses testDirFor(name) so paths are isolated from sibling tests in the iframe pool.
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';
import { testDirFor } from '../utilities/integration-test-runner.js';

// ============================================================================
// TEST DEFINITIONS
// ============================================================================

const TD_wfu = testDirFor('write-file-unicode');
/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const writeFileUnicodeTest = {
  name: 'write-file-unicode',
  description: 'Write file with unicode content',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'write',
      { file_path: `${TD_wfu}/unicode.txt`, content: '世界 😀' },
      'Writing unicode.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: `Create ${TD_wfu}/unicode.txt` }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: `Create ${TD_wfu}/unicode.txt` },
      { type: 'assistant', content: 'Writing unicode.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: '世界 😀', file_path: `${TD_wfu}/unicode.txt` },
        state: 'completed',
        result: {
          content: `Created file: ${TD_wfu}/unicode.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  },

  fileAssertions: [
    { path: `${TD_wfu}/unicode.txt`, content: '世界 😀' }
  ]
};

const TD_wfrtw = testDirFor('write-file-read-then-write');
/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const writeFileReadThenWriteTest = {
  name: 'write-file-read-then-write',
  description: 'Read file first, then overwrite succeeds',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // Turn 1: LLM writes a new file first
    toolUseResponse(
      'call_1',
      'write',
      { file_path: `${TD_wfrtw}/file.txt`, content: 'Original content' },
      'Let me create a file first.'
    ),
    // Turn 2: LLM reads the file
    toolUseResponse(
      'call_2',
      'read',
      { file_path: `${TD_wfrtw}/file.txt` },
      'Now let me read it.'
    ),
    // Turn 3: LLM writes to file (allowed because it was read)
    toolUseResponse(
      'call_3',
      'write',
      { file_path: `${TD_wfrtw}/file.txt`, content: 'Updated content' },
      'Now I can update it.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Create then read then update a file' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Create then read then update a file' },
      { type: 'assistant', content: 'Let me create a file first.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: 'Original content', file_path: `${TD_wfrtw}/file.txt` },
        state: 'completed',
        result: {
          content: `Created file: ${TD_wfrtw}/file.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Now let me read it.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'read',
        toolInput: { file_path: `${TD_wfrtw}/file.txt` },
        state: 'completed',
        result: {
          content: `<file path="${TD_wfrtw}/file.txt">\n1\tOriginal content\n</file>\n(1 lines total)`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Now I can update it.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_3',
        toolName: 'write',
        toolInput: { content: 'Updated content', file_path: `${TD_wfrtw}/file.txt` },
        state: 'completed',

        result: {
          content: `Updated file: ${TD_wfrtw}/file.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  },

  fileAssertions: [
    { path: `${TD_wfrtw}/file.txt`, content: 'Updated content' }
  ]
};

const TD_wftd = testDirFor('write-file-target-is-dir');
/**
 * Write whose target path is an existing directory: the backend file op fails
 * (`path is a directory`) and that failure must bubble all the way out as an
 * isError tool-result the model sees — proving an OS-level write failure is
 * surfaced, not swallowed. Turn 1 creates a file inside `dir/`, which
 * auto-creates `dir/` as a real directory; turn 2 then targets `dir/` itself
 * so the failure is deterministic and OS-independent.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const writeFileTargetIsDirTest = {
  name: 'write-file-target-is-dir',
  description: 'OS-level write failure (target is a directory) surfaces an isError result',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'write',
      { file_path: `${TD_wftd}/dir/keep.txt`, content: 'seed' },
      'Creating a file inside dir/.'
    ),
    toolUseResponse(
      'call_2',
      'write',
      { file_path: `${TD_wftd}/dir`, content: 'cannot write over a directory' },
      'Now writing over the directory.'
    ),
    textResponse('The second write failed.')
  ],

  operations: [
    { type: 'send-message', message: 'Create dir/keep.txt then write over dir' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Create dir/keep.txt then write over dir' },
      { type: 'assistant', content: 'Creating a file inside dir/.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: 'seed', file_path: `${TD_wftd}/dir/keep.txt` },
        state: 'completed',
        result: {
          content: `Created file: ${TD_wftd}/dir/keep.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Now writing over the directory.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'write',
        toolInput: { content: 'cannot write over a directory', file_path: `${TD_wftd}/dir` },
        state: 'completed',
        result: {
          content: `Error: cannot write file '${TD_wftd}/dir': path is a directory`,
          isError: true
        }
      },
      { type: 'assistant', content: 'The second write failed.' }
    ]
  },

  fileAssertions: [
    // The seed file is untouched — the failed write created nothing.
    { path: `${TD_wftd}/dir/keep.txt`, content: 'seed' }
  ]
};

// Export all tests
export const tests = [
  writeFileUnicodeTest,
  writeFileReadThenWriteTest,
  writeFileTargetIsDirTest
];
