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

import { textResponse, toolUseResponse, multiToolResponse } from '../utilities/integration-test-runner.js';
import { testDirFor } from '../utilities/integration-test-runner.js';

// ============================================================================
// TEST DEFINITIONS
// ============================================================================

const TD_wfc = testDirFor('write-file-create');
/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const writeFileCreateTest = {
  name: 'write-file-create',
  description: 'Create a new file',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'write',
      { file_path: `${TD_wfc}/file.txt`, content: 'Hello, World!' },
      'I\'ll create a file for you.'
    ),
    textResponse('I\'ve created the file.')
  ],

  operations: [
    { type: 'send-message', message: `Create ${TD_wfc}/file.txt with Hello World` }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: `Create ${TD_wfc}/file.txt with Hello World` },
      { type: 'assistant', content: 'I\'ll create a file for you.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: 'Hello, World!', file_path: `${TD_wfc}/file.txt` },
        state: 'completed',
        result: {
          content: `Created file: ${TD_wfc}/file.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'I\'ve created the file.' }
    ]
  },

  fileAssertions: [
    { path: `${TD_wfc}/file.txt`, content: 'Hello, World!' }
  ]
};

const TD_wfnd = testDirFor('write-file-nested-dirs');
/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const writeFileNestedDirsTest = {
  name: 'write-file-nested-dirs',
  description: 'Create file in nested directories (auto-creates parents)',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'write',
      { file_path: `${TD_wfnd}/a/b/c/nested.txt`, content: 'Deep nested content' },
      'Creating nested file.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: `Create ${TD_wfnd}/a/b/c/nested.txt` }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: `Create ${TD_wfnd}/a/b/c/nested.txt` },
      { type: 'assistant', content: 'Creating nested file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: 'Deep nested content', file_path: `${TD_wfnd}/a/b/c/nested.txt` },
        state: 'completed',
        result: {
          content: `Created file: ${TD_wfnd}/a/b/c/nested.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  },

  fileAssertions: [
    { path: `${TD_wfnd}/a/b/c/nested.txt`, content: 'Deep nested content' }
  ]
};

const TD_wfp = testDirFor('write-file-parallel');
/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const writeFileParallelTest = {
  name: 'write-file-parallel',
  description: 'Create multiple files in parallel',
  fixture: 'unit-test-fixture',

  llmResponses: [
    multiToolResponse([
      { toolUseId: 'call_1', toolName: 'write', toolInput: { file_path: `${TD_wfp}/1.txt`, content: 'A' } },
      { toolUseId: 'call_2', toolName: 'write', toolInput: { file_path: `${TD_wfp}/2.txt`, content: 'B' } },
      { toolUseId: 'call_3', toolName: 'write', toolInput: { file_path: `${TD_wfp}/3.txt`, content: 'C' } }
    ], 'Creating three files.'),
    textResponse('All files created.')
  ],

  operations: [
    { type: 'send-message', message: `Create ${TD_wfp}/1.txt, ${TD_wfp}/2.txt, ${TD_wfp}/3.txt` }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: `Create ${TD_wfp}/1.txt, ${TD_wfp}/2.txt, ${TD_wfp}/3.txt` },
      { type: 'assistant', content: 'Creating three files.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: 'A', file_path: `${TD_wfp}/1.txt` },
        state: 'completed',
        result: {
          content: `Created file: ${TD_wfp}/1.txt`,
          isError: false
        }
      },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'write',
        toolInput: { content: 'B', file_path: `${TD_wfp}/2.txt` },
        state: 'completed',
        result: {
          content: `Created file: ${TD_wfp}/2.txt`,
          isError: false
        }
      },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_3',
        toolName: 'write',
        toolInput: { content: 'C', file_path: `${TD_wfp}/3.txt` },
        state: 'completed',
        result: {
          content: `Created file: ${TD_wfp}/3.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'All files created.' }
    ]
  },

  fileAssertions: [
    { path: `${TD_wfp}/1.txt`, content: 'A' },
    { path: `${TD_wfp}/2.txt`, content: 'B' },
    { path: `${TD_wfp}/3.txt`, content: 'C' }
  ]
};

const TD_wfsc = testDirFor('write-file-special-chars');
/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const writeFileSpecialCharsTest = {
  name: 'write-file-special-chars',
  description: 'Write file with special characters',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'write',
      { file_path: `${TD_wfsc}/special.txt`, content: 'x[0] + <tag> & "q"' },
      'Writing special chars.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: `Create ${TD_wfsc}/special.txt with special characters` }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: `Create ${TD_wfsc}/special.txt with special characters` },
      { type: 'assistant', content: 'Writing special chars.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: 'x[0] + <tag> & "q"', file_path: `${TD_wfsc}/special.txt` },
        state: 'completed',
        result: {
          content: `Created file: ${TD_wfsc}/special.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  },

  fileAssertions: [
    { path: `${TD_wfsc}/special.txt`, content: 'x[0] + <tag> & "q"' }
  ]
};

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

const TD_wfe = testDirFor('write-file-empty');
/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const writeFileEmptyTest = {
  name: 'write-file-empty',
  description: 'Write empty file',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'write',
      { file_path: `${TD_wfe}/empty.txt`, content: '' },
      'Creating empty file.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: `Create ${TD_wfe}/empty.txt` }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: `Create ${TD_wfe}/empty.txt` },
      { type: 'assistant', content: 'Creating empty file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: '', file_path: `${TD_wfe}/empty.txt` },
        state: 'completed',
        result: {
          content: `Created file: ${TD_wfe}/empty.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  },

  fileAssertions: [
    { path: `${TD_wfe}/empty.txt`, content: '' }
  ]
};

const TD_wfm = testDirFor('write-file-multiline');
/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const writeFileMultilineTest = {
  name: 'write-file-multiline',
  description: 'Write multiline content',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'write',
      { file_path: `${TD_wfm}/multiline.txt`, content: 'line1\nline2\nline3' },
      'Writing multiline.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: `Create ${TD_wfm}/multiline.txt` }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: `Create ${TD_wfm}/multiline.txt` },
      { type: 'assistant', content: 'Writing multiline.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: 'line1\nline2\nline3', file_path: `${TD_wfm}/multiline.txt` },
        state: 'completed',
        result: {
          content: `Created file: ${TD_wfm}/multiline.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  },

  fileAssertions: [
    { path: `${TD_wfm}/multiline.txt`, content: 'line1\nline2\nline3' }
  ]
};

const TD_wfj = testDirFor('write-file-json');
/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const writeFileJsonTest = {
  name: 'write-file-json',
  description: 'Write JSON content',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'write',
      { file_path: `${TD_wfj}/output.json`, content: '{"key": "value"}' },
      'Writing JSON.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: `Create ${TD_wfj}/output.json` }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: `Create ${TD_wfj}/output.json` },
      { type: 'assistant', content: 'Writing JSON.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: '{"key": "value"}', file_path: `${TD_wfj}/output.json` },
        state: 'completed',
        result: {
          content: `Created file: ${TD_wfj}/output.json`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  },

  fileAssertions: [
    { path: `${TD_wfj}/output.json`, content: '{"key": "value"}' }
  ]
};

const TD_wfco = testDirFor('write-file-code');
/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const writeFileCodeTest = {
  name: 'write-file-code',
  description: 'Write code file',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'write',
      { file_path: `${TD_wfco}/output.js`, content: 'function f() {}' },
      'Writing code.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: `Create ${TD_wfco}/output.js` }
  ],

  // Note: When writing code files (.js, .ts, etc.), the result includes
  // a reminder to run tests.
  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: `Create ${TD_wfco}/output.js` },
      { type: 'assistant', content: 'Writing code.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: 'function f() {}', file_path: `${TD_wfco}/output.js` },
        state: 'completed',
        result: {
          content: `Created file: ${TD_wfco}/output.js\n\nConsider running tests to verify your changes`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  },

  fileAssertions: [
    { path: `${TD_wfco}/output.js`, content: 'function f() {}' }
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
  writeFileCreateTest,
  writeFileNestedDirsTest,
  writeFileParallelTest,
  writeFileSpecialCharsTest,
  writeFileUnicodeTest,
  writeFileEmptyTest,
  writeFileMultilineTest,
  writeFileJsonTest,
  writeFileCodeTest,
  writeFileReadThenWriteTest,
  writeFileTargetIsDirTest
];
