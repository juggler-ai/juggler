//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Edit (Replace Text) Operations
 *
 * Tests edit through the full pipeline: sendMessage -> worker -> mock LLM -> tool execution -> Yjs sync
 * @module integration-tests/edit-tests
 *
 * Each test uses testDirFor(name) so paths are isolated from sibling tests in the iframe pool.
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';
import { testDirFor } from '../utilities/integration-test-runner.js';
import { isToolActionMessage } from '../../sdk/lib/message.js';
import { diffSnapshotShape, loadDiffSides } from '../../js/utils/diff-snapshot-sides.js';

// ============================================================================
// TEST DEFINITIONS
// ============================================================================

const TD_editBasic = testDirFor('edit-basic');
/**
 * Basic edit: create a file then edit it with search/replace.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const editBasicTest = {
  name: 'edit-basic',
  description: 'Create a file then edit with search/replace',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // Turn 1: Create the file
    toolUseResponse(
      'call_1',
      'write',
      { file_path: `${TD_editBasic}/file.txt`, content: 'Hello foo world' },
      'Creating file.'
    ),
    // Turn 2: Edit the file
    toolUseResponse(
      'call_2',
      'edit',
      { file_path: `${TD_editBasic}/file.txt`, old_string: 'foo', new_string: 'bar' },
      'Editing file.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: `Create ${TD_editBasic}/file.txt then replace foo with bar` }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: `Create ${TD_editBasic}/file.txt then replace foo with bar` },
      { type: 'assistant', content: 'Creating file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: 'Hello foo world', file_path: `${TD_editBasic}/file.txt` },
        state: 'completed',
        result: {
          content: `Created file: ${TD_editBasic}/file.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Editing file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'edit',
        toolInput: { file_path: `${TD_editBasic}/file.txt`, new_string: 'bar', old_string: 'foo' },
        state: 'completed',

        result: {
          content: `Edited file: ${TD_editBasic}/file.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  },

  fileAssertions: [
    { path: `${TD_editBasic}/file.txt`, content: 'Hello bar world' }
  ]
};

const TD_editMultiline = testDirFor('edit-multiline');
/**
 * Multi-line edit on existing fixture file.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const editMultilineTest = {
  name: 'edit-multiline',
  description: 'Multi-line search/replace across newlines',
  fixture: 'unit-test-fixture',

  // Write the file through the tool (turn 1) before editing it (turn 2). The
  // write records the read-before-edit staleness baseline so the edit isn't
  // refused as never-read. A `.txt` target (not `.go`) is deliberate: it keeps
  // this test from racing sibling glob-go-files, which globs **/*.go across the
  // shared fixture root and would see a stray .go file created here.
  llmResponses: [
    toolUseResponse(
      'call_1',
      'write',
      { file_path: `${TD_editMultiline}/snippet.txt`, content: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello, World!")\n}\n\nfunc add(a, b int) int {\n\treturn a + b\n}\n' },
      'Creating file.'
    ),
    toolUseResponse(
      'call_2',
      'edit',
      {
        file_path: `${TD_editMultiline}/snippet.txt`,
        old_string: 'func add(a, b int) int {\n\treturn a + b\n}',
        new_string: 'func add(a, b int) int {\n\treturn a + b // addition\n}'
      },
      'Editing function.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Create snippet.txt then add a comment to the add function' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Create snippet.txt then add a comment to the add function' },
      { type: 'assistant', content: 'Creating file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello, World!")\n}\n\nfunc add(a, b int) int {\n\treturn a + b\n}\n', file_path: `${TD_editMultiline}/snippet.txt` },
        state: 'completed',
        result: {
          content: `Created file: ${TD_editMultiline}/snippet.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Editing function.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'edit',
        toolInput: {
          file_path: `${TD_editMultiline}/snippet.txt`,
          new_string: 'func add(a, b int) int {\n\treturn a + b // addition\n}',
          old_string: 'func add(a, b int) int {\n\treturn a + b\n}'
        },
        state: 'completed',

        result: {
          content: `Edited file: ${TD_editMultiline}/snippet.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  },

  fileAssertions: [
    { path: `${TD_editMultiline}/snippet.txt`, content: 'package main\n\nimport "fmt"\n\nfunc main() {\n\tfmt.Println("Hello, World!")\n}\n\nfunc add(a, b int) int {\n\treturn a + b // addition\n}\n' }
  ]
};

const TD_editNotFound = testDirFor('edit-not-found');
/**
 * Edit not found: search string doesn't exist in file.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const editNotFoundTest = {
  name: 'edit-not-found',
  description: 'Edit with non-existent search string returns structured error',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // Turn 1: Create file
    toolUseResponse(
      'call_1',
      'write',
      { file_path: `${TD_editNotFound}/file.txt`, content: 'some content here' },
      'Creating file.'
    ),
    // Turn 2: Try to edit with non-existent string
    toolUseResponse(
      'call_2',
      'edit',
      { file_path: `${TD_editNotFound}/file.txt`, old_string: 'NONEXISTENT', new_string: 'replacement' },
      'Editing file.'
    ),
    textResponse('Edit failed, sorry.')
  ],

  operations: [
    { type: 'send-message', message: 'Create file then try bad edit' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Create file then try bad edit' },
      { type: 'assistant', content: 'Creating file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: 'some content here', file_path: `${TD_editNotFound}/file.txt` },
        state: 'completed',
        result: {
          content: `Created file: ${TD_editNotFound}/file.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Editing file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'edit',
        toolInput: { file_path: `${TD_editNotFound}/file.txt`, new_string: 'replacement', old_string: 'NONEXISTENT' },
        state: 'completed',

        // Validation rejects mismatched old_string before approval/execute,
        // so the error is the raw LLM-feedback message — no duplicate
        // "Replace text failed: …" wrapper from the post-execute summary.
        result: {
          content: `Search failed in '${TD_editNotFound}/file.txt'. Re-read file and use exact text including whitespace.`,
          isError: true
        }
      },
      { type: 'assistant', content: 'Edit failed, sorry.' }
    ]
  },

  fileAssertions: [
    // File should be unchanged
    { path: `${TD_editNotFound}/file.txt`, content: 'some content here' }
  ]
};

const TD_editAmbiguous = testDirFor('edit-ambiguous');
/**
 * Ambiguous edit: search string matches multiple locations.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const editAmbiguousTest = {
  name: 'edit-ambiguous',
  description: 'Edit with ambiguous search string (multiple matches) returns validation error',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // Turn 1: Create file with repeated content
    toolUseResponse(
      'call_1',
      'write',
      { file_path: `${TD_editAmbiguous}/file.txt`, content: 'foo and foo and foo' },
      'Creating file.'
    ),
    // Turn 2: Try ambiguous edit
    toolUseResponse(
      'call_2',
      'edit',
      { file_path: `${TD_editAmbiguous}/file.txt`, old_string: 'foo', new_string: 'bar' },
      'Editing file.'
    ),
    textResponse('Edit failed.')
  ],

  operations: [
    { type: 'send-message', message: 'Create file then try ambiguous edit' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Create file then try ambiguous edit' },
      { type: 'assistant', content: 'Creating file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: 'foo and foo and foo', file_path: `${TD_editAmbiguous}/file.txt` },
        state: 'completed',
        result: {
          content: `Created file: ${TD_editAmbiguous}/file.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Editing file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'edit',
        toolInput: { file_path: `${TD_editAmbiguous}/file.txt`, new_string: 'bar', old_string: 'foo' },
        state: 'completed',
        result: {
          content: `Error: search string appears 3 times in file '${TD_editAmbiguous}/file.txt'. The old_str is ambiguous - it matches multiple locations in the file. Please provide a longer, unique search string that matches only the specific section you want to replace, or set replace_all to true to replace every occurrence`,
          isError: true
        }
      },
      { type: 'assistant', content: 'Edit failed.' }
    ]
  },

  fileAssertions: [
    // File should be unchanged
    { path: `${TD_editAmbiguous}/file.txt`, content: 'foo and foo and foo' }
  ]
};

const TD_editSpecialChars = testDirFor('edit-special-chars');
/**
 * Special characters: regex metacharacters treated as literal.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const editSpecialCharsTest = {
  name: 'edit-special-chars',
  description: 'Edit with regex metacharacters treated as literal text',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'write',
      { file_path: `${TD_editSpecialChars}/file.txt`, content: 'const x = arr[0];' },
      'Creating file.'
    ),
    toolUseResponse(
      'call_2',
      'edit',
      { file_path: `${TD_editSpecialChars}/file.txt`, old_string: 'arr[0]', new_string: 'arr[1]' },
      'Editing file.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Edit special chars' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Edit special chars' },
      { type: 'assistant', content: 'Creating file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: 'const x = arr[0];', file_path: `${TD_editSpecialChars}/file.txt` },
        state: 'completed',
        result: {
          content: `Created file: ${TD_editSpecialChars}/file.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Editing file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'edit',
        toolInput: { file_path: `${TD_editSpecialChars}/file.txt`, new_string: 'arr[1]', old_string: 'arr[0]' },
        state: 'completed',

        result: {
          content: `Edited file: ${TD_editSpecialChars}/file.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  },

  fileAssertions: [
    { path: `${TD_editSpecialChars}/file.txt`, content: 'const x = arr[1];' }
  ]
};

const TD_editUnicode = testDirFor('edit-unicode');
/**
 * Unicode content handling.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const editUnicodeTest = {
  name: 'edit-unicode',
  description: 'Edit unicode content',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'write',
      { file_path: `${TD_editUnicode}/file.txt`, content: 'Hello 世界 old world' },
      'Creating file.'
    ),
    toolUseResponse(
      'call_2',
      'edit',
      { file_path: `${TD_editUnicode}/file.txt`, old_string: '世界 old', new_string: '世界 new' },
      'Editing file.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Edit unicode' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Edit unicode' },
      { type: 'assistant', content: 'Creating file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: 'Hello 世界 old world', file_path: `${TD_editUnicode}/file.txt` },
        state: 'completed',
        result: {
          content: `Created file: ${TD_editUnicode}/file.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Editing file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'edit',
        toolInput: { file_path: `${TD_editUnicode}/file.txt`, new_string: '世界 new', old_string: '世界 old' },
        state: 'completed',

        result: {
          content: `Edited file: ${TD_editUnicode}/file.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  },

  fileAssertions: [
    { path: `${TD_editUnicode}/file.txt`, content: 'Hello 世界 new world' }
  ]
};

const TD_editEmptyReplacement = testDirFor('edit-empty-replacement');
/**
 * Empty replacement (deletion).
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const editEmptyReplacementTest = {
  name: 'edit-empty-replacement',
  description: 'Delete text by replacing with empty string',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'write',
      { file_path: `${TD_editEmptyReplacement}/file.txt`, content: 'keep DELETE keep' },
      'Creating file.'
    ),
    toolUseResponse(
      'call_2',
      'edit',
      { file_path: `${TD_editEmptyReplacement}/file.txt`, old_string: 'DELETE ', new_string: '' },
      'Deleting text.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Delete text from file' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Delete text from file' },
      { type: 'assistant', content: 'Creating file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: 'keep DELETE keep', file_path: `${TD_editEmptyReplacement}/file.txt` },
        state: 'completed',
        result: {
          content: `Created file: ${TD_editEmptyReplacement}/file.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Deleting text.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'edit',
        toolInput: { file_path: `${TD_editEmptyReplacement}/file.txt`, new_string: '', old_string: 'DELETE ' },
        state: 'completed',

        result: {
          content: `Edited file: ${TD_editEmptyReplacement}/file.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  },

  fileAssertions: [
    { path: `${TD_editEmptyReplacement}/file.txt`, content: 'keep keep' }
  ]
};

const TD_editSequential = testDirFor('edit-sequential');
/**
 * Sequential edits: multiple edits on the same file across LLM turns.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const editSequentialTest = {
  name: 'edit-sequential',
  description: 'Multiple sequential edits on the same file',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'write',
      { file_path: `${TD_editSequential}/file.txt`, content: 'aaa bbb ccc' },
      'Creating file.'
    ),
    toolUseResponse(
      'call_2',
      'edit',
      { file_path: `${TD_editSequential}/file.txt`, old_string: 'aaa', new_string: 'AAA' },
      'First edit.'
    ),
    toolUseResponse(
      'call_3',
      'edit',
      { file_path: `${TD_editSequential}/file.txt`, old_string: 'ccc', new_string: 'CCC' },
      'Second edit.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Create file then edit twice' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Create file then edit twice' },
      { type: 'assistant', content: 'Creating file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: 'aaa bbb ccc', file_path: `${TD_editSequential}/file.txt` },
        state: 'completed',
        result: {
          content: `Created file: ${TD_editSequential}/file.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'First edit.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'edit',
        toolInput: { file_path: `${TD_editSequential}/file.txt`, new_string: 'AAA', old_string: 'aaa' },
        state: 'completed',

        result: {
          content: `Edited file: ${TD_editSequential}/file.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Second edit.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_3',
        toolName: 'edit',
        toolInput: { file_path: `${TD_editSequential}/file.txt`, new_string: 'CCC', old_string: 'ccc' },
        state: 'completed',

        result: {
          content: `Edited file: ${TD_editSequential}/file.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  },

  fileAssertions: [
    { path: `${TD_editSequential}/file.txt`, content: 'AAA bbb CCC' }
  ]
};

const TD_editWhitespace = testDirFor('edit-whitespace');
/**
 * Edit whitespace-sensitive content.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const editWhitespaceTest = {
  name: 'edit-whitespace',
  description: 'Edit with whitespace-sensitive search/replace',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'write',
      { file_path: `${TD_editWhitespace}/file.txt`, content: 'before   foo   after' },
      'Creating file.'
    ),
    toolUseResponse(
      'call_2',
      'edit',
      { file_path: `${TD_editWhitespace}/file.txt`, old_string: '   foo   ', new_string: ' bar ' },
      'Editing file.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Edit whitespace' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Edit whitespace' },
      { type: 'assistant', content: 'Creating file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: 'before   foo   after', file_path: `${TD_editWhitespace}/file.txt` },
        state: 'completed',
        result: {
          content: `Created file: ${TD_editWhitespace}/file.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Editing file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'edit',
        toolInput: { file_path: `${TD_editWhitespace}/file.txt`, new_string: ' bar ', old_string: '   foo   ' },
        state: 'completed',

        result: {
          content: `Edited file: ${TD_editWhitespace}/file.txt`,
          isError: false
        }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  },

  fileAssertions: [
    { path: `${TD_editWhitespace}/file.txt`, content: 'before bar after' }
  ]
};

const TD_editDisplayData = testDirFor('edit-display-data');
/**
 * Verify that auto-approved edits store displayData.diffData on the tool-action YMap.
 * Without this, the properties panel can't render a diff for pre-approved edits.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const editDisplayDataTest = {
  name: 'edit-display-data',
  description: 'Auto-approved edit stores diffData on tool-action YMap for properties panel',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'write',
      { file_path: `${TD_editDisplayData}/file.txt`, content: 'Hello foo world' },
      'Creating file.'
    ),
    toolUseResponse(
      'call_2',
      'edit',
      { file_path: `${TD_editDisplayData}/file.txt`, old_string: 'foo', new_string: 'bar' },
      'Editing file.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: `Create then edit ${TD_editDisplayData}/file.txt` }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: `Create then edit ${TD_editDisplayData}/file.txt` },
      { type: 'assistant', content: 'Creating file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: 'Hello foo world', file_path: `${TD_editDisplayData}/file.txt` },
        state: 'completed',
        result: { content: `Created file: ${TD_editDisplayData}/file.txt`, isError: false }
      },
      { type: 'assistant', content: 'Editing file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'edit',
        toolInput: { file_path: `${TD_editDisplayData}/file.txt`, new_string: 'bar', old_string: 'foo' },
        state: 'completed',
        result: { content: `Edited file: ${TD_editDisplayData}/file.txt`, isError: false }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  },

  async customAssertions(conversation) {
    const items = [...conversation.rootItems];
    const editAction = items.find(
      item => isToolActionMessage(/** @type {any} */ (item)) &&
      /** @type {any} */ (item).get('toolName') === 'edit'
    );
    if (!editAction) {
      throw new Error('edit tool-action not found in items');
    }
    const raw = editAction.get('displayData');
    const dd = raw?.toJSON ? raw.toJSON() : raw;
    const shape = diffSnapshotShape(dd);
    if (!shape) {
      throw new Error(`displayData.diffData missing on edit tool-action YMap — properties panel cannot show diff: ${JSON.stringify(dd)}`);
    }
    // The sides may be inline or stored apart; either way they read back whole.
    const { oldContent, newContent } = await loadDiffSides(conversation.id, shape);
    if (oldContent !== 'Hello foo world' || newContent !== 'Hello bar world') {
      throw new Error(`diff sides read back as ${JSON.stringify({ oldContent, newContent })}`);
    }

    // …and stored exactly once. A diff holds the whole file twice over, so the
    // document must not also keep the copy that arrives nested in the result
    // blob. completeToolAction moves it onto the item rather than copying it;
    // everything renders from the item-level field asserted above.
    for (const item of items) {
      if (!isToolActionMessage(/** @type {any} */ (item))) continue;
      const rawResult = /** @type {any} */ (item).get('result');
      const stored = rawResult?.toJSON ? rawResult.toJSON() : rawResult;
      if (stored?.fullResult?.displayData) {
        throw new Error(
          `${/** @type {any} */ (item).get('toolName')} stored displayData inside result.fullResult as well as on the item — the diff is in the document twice`
        );
      }
    }
  }
};

const TD_editRefs = testDirFor('edit-diff-refs');
/** Forty numbered lines, so the file dwarfs the one line the edit changes. */
const EDIT_REFS_BEFORE = Array.from({ length: 40 }, (_, i) => `keep-line-${i + 1}`).join('\n') + '\n';
/**
 * An edit's diff is stored as two text assets the document names by id: the
 * tool-action carries the refs and the line counts, and none of the file's text.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const editDiffRefsTest = {
  name: 'edit-diff-refs',
  description: 'An edit stores its diff sides as assets named by id, not inline',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'write',
      { file_path: `${TD_editRefs}/file.txt`, content: EDIT_REFS_BEFORE },
      'Creating file.'
    ),
    toolUseResponse(
      'call_2',
      'edit',
      { file_path: `${TD_editRefs}/file.txt`, old_string: 'keep-line-20\n', new_string: 'changed-line-20\n' },
      'Editing file.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: `Create then edit ${TD_editRefs}/file.txt` }
  ],

  settleUntil(conversation) {
    return [...conversation.rootItems].some(
      item => isToolActionMessage(/** @type {any} */ (item)) &&
      /** @type {any} */ (item).get('toolName') === 'edit' &&
      /** @type {any} */ (item).get('state') === 'completed'
    );
  },

  customAssertions(conversation) {
    const editAction = /** @type {any} */ ([...conversation.rootItems].find(
      item => isToolActionMessage(/** @type {any} */ (item)) &&
      /** @type {any} */ (item).get('toolName') === 'edit'
    ));
    if (!editAction) throw new Error('edit tool-action not found in items');
    const raw = editAction.get('displayData');
    const dd = raw?.toJSON ? raw.toJSON() : raw;
    const diff = dd?.diffData;
    const stored = JSON.stringify(dd);
    const hex = /^[0-9a-f]{64}$/;
    if (!hex.test(String(diff?.oldRef)) || !hex.test(String(diff?.newRef))) {
      throw new Error(`the edit's diff should name both sides by asset id, got ${stored}`);
    }
    if ('oldContent' in diff || 'newContent' in diff || stored.includes('keep-line-30')) {
      throw new Error(`the edit's diff still carries file text inline: ${stored}`);
    }
    if (diff.added !== 1 || diff.removed !== 1) {
      throw new Error(`expected +1 -1 stored with the diff, got ${stored}`);
    }
    // Refs, counts and a path, whatever the file's size: the two sides inline
    // would be twice the file's 500-odd bytes.
    if (stored.length > 300) {
      throw new Error(`the stored diff is ${stored.length} bytes, want at most 300: ${stored}`);
    }
  }
};

const TD_editNoDouble = testDirFor('edit-no-double-execution');
/**
 * "Insert before" edit executes exactly once (no observer double-dispatch).
 *
 * Regression test for a race condition where two concurrent handleNewToolAction
 * calls (one from _handleToolActionChanges, one from _reconcileNestedTools) could
 * both write APPROVED — with the second arriving after the first had already
 * transitioned to RUNNING — resetting state backward and allowing _claimRunning
 * to succeed a second time.
 *
 * The "insert before" pattern (new_string ends with old_string) makes the bug
 * observable: after the first execution old_string is still present at the end
 * of the inserted block, so a second execution finds it and inserts again,
 * doubling the content.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const editNoDoubleExecutionTest = {
  name: 'edit-no-double-execution',
  description: 'Insert-before edit executes exactly once (no observer race condition)',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // Turn 1: create the file
    toolUseResponse(
      'call_1',
      'write',
      { file_path: `${TD_editNoDouble}/file.txt`, content: 'AAA MARKER BBB' },
      'Creating file.'
    ),
    // Turn 2: "insert before" edit — new_string ends with old_string.
    // If the tool-action executes twice, file ends up with PREFIX twice.
    toolUseResponse(
      'call_2',
      'edit',
      { file_path: `${TD_editNoDouble}/file.txt`, old_string: 'MARKER', new_string: 'PREFIX MARKER' },
      'Editing file.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'start-tool-exec-counter', toolUseId: 'call_2' },
    { type: 'send-message', message: `Create ${TD_editNoDouble}/file.txt then insert PREFIX before MARKER` },
    // Must have executed exactly once — not twice (which would insert PREFIX twice)
    { type: 'assert-tool-exec-count', toolUseId: 'call_2', expectedCount: 1 }
  ],

  fileAssertions: [
    // Correct: PREFIX inserted once. If double-executed: 'AAA PREFIX PREFIX MARKER BBB'
    { path: `${TD_editNoDouble}/file.txt`, content: 'AAA PREFIX MARKER BBB' }
  ]
};

// Export all tests
export const tests = [
  editBasicTest,
  editMultilineTest,
  editNotFoundTest,
  editAmbiguousTest,
  editSpecialCharsTest,
  editUnicodeTest,
  editEmptyReplacementTest,
  editSequentialTest,
  editWhitespaceTest,
  editDisplayDataTest,
  editDiffRefsTest,
  editNoDoubleExecutionTest
];
