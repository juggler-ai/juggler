//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Read File Operations
 *
 * Tests read through the full pipeline: sendMessage → worker → mock LLM → tool execution → Yjs sync
 * @module integration-tests/read-file-tests
 */

import { textResponse, toolUseResponse, multiToolResponse } from '../utilities/integration-test-runner.js';
import { isToolActionMessage } from '../../sdk/lib/message.js';

// ============================================================================
// GOLDEN DATA - Expected file contents
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

/** config.json content formatted with line numbers (cat -n style) */
const CONFIG_JSON = '<file path="config.json">\n' +
	'1\t{\n' +
	'2\t  "name": "test-project",\n' +
	'3\t  "version": "1.0.0",\n' +
	'4\t  "settings": {\n' +
	'5\t    "debug": true,\n' +
	'6\t    "logLevel": "info"\n' +
	'7\t  }\n' +
	'8\t}\n' +
	'9\t\n' +
	'</file>\n' +
	'(9 lines total)';

// ============================================================================
// TEST DEFINITIONS
// ============================================================================

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const readFileSingleTest = {
  name: 'read-file-single',
  description: 'Read a single file - content returned in tool-result',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'read',
      { file_path: 'src/main.go' },
      'Let me read that file.'
    ),
    textResponse('I\'ve read the Go source file.')
  ],

  operations: [
    { type: 'send-message', message: 'Read src/main.go' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Read src/main.go' },
      { type: 'assistant', content: 'Let me read that file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'read',
        toolInput: { file_path: 'src/main.go' },
        state: 'completed',
        result: {
          content: MAIN_GO,
          isError: false
        }
      },
      { type: 'assistant', content: 'I\'ve read the Go source file.' }
    ]
  }
};

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const readFileNonExistentTest = {
  name: 'read-file-non-existent',
  description: 'Read non-existent file - returns helpful error',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'read',
      { file_path: 'does-not-exist.txt' },
      'Let me read that file.'
    ),
    textResponse('The file does not exist.')
  ],

  operations: [
    { type: 'send-message', message: 'Read does-not-exist.txt' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Read does-not-exist.txt' },
      { type: 'assistant', content: 'Let me read that file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'read',
        toolInput: { file_path: 'does-not-exist.txt' },
        state: 'completed',
        result: {
          content: 'File does not exist: does-not-exist.txt. Do not attempt to read it again.',
          isError: false
        }
      },
      { type: 'assistant', content: 'The file does not exist.' }
    ]
  }
};

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const readFileParallelTest = {
  name: 'read-file-parallel',
  description: 'Read multiple files in parallel',
  fixture: 'unit-test-fixture',

  llmResponses: [
    multiToolResponse([
      { toolUseId: 'call_1', toolName: 'read', toolInput: { file_path: 'src/main.go' } },
      { toolUseId: 'call_2', toolName: 'read', toolInput: { file_path: 'config.json' } }
    ], 'Let me read both files.'),
    textResponse('I\'ve read both files.')
  ],

  operations: [
    { type: 'send-message', message: 'Read main.go and config.json' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Read main.go and config.json' },
      { type: 'assistant', content: 'Let me read both files.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'read',
        toolInput: { file_path: 'src/main.go' },
        state: 'completed',
        result: {
          content: MAIN_GO,
          isError: false
        }
      },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'read',
        toolInput: { file_path: 'config.json' },
        state: 'completed',
        result: {
          content: CONFIG_JSON,
          isError: false
        }
      },
      { type: 'assistant', content: 'I\'ve read both files.' }
    ]
  }
};

/**
 * Schema-driven coercion: the LLM emitted numeric params as JSON strings
 * ("5"/"3" instead of 5/3). Because the `read` tool's input_schema declares
 * offset/limit as numbers, the framework coerces the cleanly-parsing strings
 * at the prepare() boundary, so the partial read succeeds. The raw string
 * values the model emitted are preserved verbatim in the stored toolInput.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const readFileStringOffsetTest = {
  name: 'read-file-string-offset',
  description: 'Numeric offset/limit sent as strings are coerced via schema',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'read',
      { file_path: 'src/main.go', offset: '5', limit: '3' },
      'Let me read the middle of that file.'
    ),
    textResponse('Read lines 5-7.')
  ],

  operations: [
    { type: 'send-message', message: 'Read lines 5-7 of src/main.go' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Read lines 5-7 of src/main.go' },
      { type: 'assistant', content: 'Let me read the middle of that file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'read',
        toolInput: { file_path: 'src/main.go', offset: '5', limit: '3' },
        state: 'completed',
        result: {
          content: '<file path="src/main.go">\n' +
						'5\tfunc main() {\n' +
						'6\t\tfmt.Println("Hello, World!")\n' +
						'7\t}\n' +
						'</file>\n' +
						'(Showing lines 5-7 of 12. Use offset=8 to read more.)',
          isError: false
        }
      },
      { type: 'assistant', content: 'Read lines 5-7.' }
    ]
  }
};

/**
 * Coercion boundary: a string that does NOT cleanly parse to a number
 * ("5px") is left untouched, so the tool's own validation still rejects it.
 * Coercion must not mask genuinely malformed values.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const readFileNonNumericOffsetTest = {
  name: 'read-file-non-numeric-offset',
  description: 'Non-numeric offset string is not coerced and still errors',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'read',
      { file_path: 'src/main.go', offset: '5px' },
      'Let me read that file.'
    ),
    textResponse('I see, the offset was invalid.')
  ],

  operations: [
    { type: 'send-message', message: 'Read src/main.go from 5px' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Read src/main.go from 5px' },
      { type: 'assistant', content: 'Let me read that file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'read',
        toolInput: { file_path: 'src/main.go', offset: '5px' },
        state: 'completed',
        result: {
          content: 'Parameter "offset" must be a positive integer (1-indexed line number)',
          isError: true
        }
      },
      { type: 'assistant', content: 'I see, the offset was invalid.' }
    ]
  }
};

/**
 * Reading an image uploads its bytes to the conversation asset store from the
 * engine, so the pixels ride the tool result to a multimodal model. The upload
 * is the one leg no Go test sees: it is a fetch from the engine realm, and a
 * wrong URL degrades silently to a warning in an otherwise successful read.
 * The bytes need not decode — the read op recognises an image by extension and
 * the asset store keeps an undecodable image without dimensions.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const readFileImageAttachesTest = {
  name: 'read-file-image-attaches',
  description: 'Read a PNG - bytes are uploaded and the tool-action carries the asset',
  fixture: 'unit-test-fixture',
  setupFiles: { 'read-file-image-attaches.png': 'not really a png' },

  llmResponses: [
    toolUseResponse(
      'call_1',
      'read',
      { file_path: 'read-file-image-attaches.png' },
      'Let me look at that image.'
    ),
    textResponse('I\'ve seen the image.')
  ],

  operations: [
    { type: 'send-message', message: 'Look at read-file-image-attaches.png' }
  ],

  customAssertions(conversation) {
    const action = [...conversation.rootItems].find(
      item => isToolActionMessage(/** @type {any} */ (item)) &&
      /** @type {any} */ (item).get('toolName') === 'read'
    );
    if (!action) {
      throw new Error('read tool-action not found in items');
    }
    const rawResult = action.get('result');
    const result = rawResult?.toJSON ? rawResult.toJSON() : rawResult;
    const rawAttachments = action.get('attachments');
    const attachments = rawAttachments?.toJSON ? rawAttachments.toJSON() : rawAttachments;
    if (!Array.isArray(attachments) || attachments.length !== 1) {
      throw new Error(`expected one attachment on the read tool-action, got ${JSON.stringify(attachments)}; result: ${JSON.stringify(result?.content)}`);
    }
    const [ref] = attachments;
    if (!/^[0-9a-f]{64}$/.test(ref.id) || ref.mime !== 'image/png') {
      throw new Error(`attachment is not a stored PNG asset ref: ${JSON.stringify(ref)}`);
    }
  }
};

/**
 * The batch_read tool-action in a conversation's root items, or undefined.
 * @param {import('../../js/model/conversation.js').default} conversation - The conversation.
 * @returns {any} The tool-action.
 */
function batchReadAction(conversation) {
  return [...conversation.rootItems].find(
    item => isToolActionMessage(/** @type {any} */ (item)) &&
    /** @type {any} */ (item).get('toolName') === 'batch_read'
  );
}

/**
 * A batch_read stores each file's text once: in the result content the model
 * was handed. The per-file outcomes kept beside it still say whether each read
 * succeeded and the hash of what it saw — what the staleness guard and the
 * panel read — but not the text a second time.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const batchReadStoredOnceTest = {
  name: 'batch-read-stored-once',
  description: 'batch_read keeps each file\'s text once, in the result content',
  fixture: 'unit-test-fixture',
  setupFiles: {
    'batch-once-a.txt': 'only-once-alpha\n',
    'batch-once-b.txt': 'only-once-beta\n'
  },

  llmResponses: [
    toolUseResponse(
      'call_1',
      'batch_read',
      { files: [{ file_path: 'batch-once-a.txt' }, { file_path: 'batch-once-b.txt' }] },
      'Reading both.'
    ),
    textResponse('Read both.')
  ],

  operations: [
    { type: 'send-message', message: 'Read both files' }
  ],

  settleUntil(conversation) {
    return batchReadAction(conversation)?.get('state') === 'completed';
  },

  customAssertions(conversation) {
    const action = batchReadAction(conversation);
    if (!action) throw new Error('batch_read tool-action not found in items');
    const raw = action.get('result');
    const result = raw?.toJSON ? raw.toJSON() : raw;
    const stored = JSON.stringify(result);
    for (const marker of ['only-once-alpha', 'only-once-beta']) {
      const copies = stored.split(marker).length - 1;
      if (copies !== 1) {
        throw new Error(`${marker} should be stored once, found ${copies} copies in ${stored}`);
      }
    }
    if (!String(result?.content || '').includes('only-once-alpha')) {
      throw new Error(`the result content lost the file text: ${JSON.stringify(result?.content)}`);
    }
    const outcomes = result?.fullResult?.result?.results;
    if (!Array.isArray(outcomes) || outcomes.length !== 2) {
      throw new Error(`expected two per-file outcomes, got ${JSON.stringify(outcomes)}`);
    }
    for (const outcome of outcomes) {
      if (outcome?.success !== true || !/^[0-9a-f]+$/.test(String(outcome?.result?.contentHash || ''))) {
        throw new Error(`a per-file outcome lost its success or hash: ${JSON.stringify(outcome)}`);
      }
    }
  }
};

// Export all tests
export const tests = [
  readFileSingleTest,
  readFileNonExistentTest,
  readFileParallelTest,
  readFileStringOffsetTest,
  readFileNonNumericOffsetTest,
  readFileImageAttachesTest,
  batchReadStoredOnceTest
];
