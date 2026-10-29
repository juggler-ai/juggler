//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Glob Operations
 *
 * Tests glob through the full pipeline.
 * @module integration-tests/glob-tests
 */

import { textResponse, toolUseResponse, multiToolResponse } from '../utilities/integration-test-runner.js';

// ============================================================================
// GOLDEN DATA - Expected content
// ============================================================================

/** Single .go file match */
const GLOB_GO_SINGLE = 'src/main.go';

/** No matches result */
const GLOB_NO_MATCHES = 'No files found matching pattern: *.xyz';

/** JSON file match */
const GLOB_JSON_SINGLE = 'config.json';

/** Markdown file match */
const GLOB_MD_SINGLE = 'README.md';

// ============================================================================
// TEST DEFINITIONS
// ============================================================================

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const globGoFilesTest = {
  name: 'glob-go-files',
  description: 'Find .go files with glob pattern',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'glob',
      { pattern: '**/*.go' },
      'Searching for Go files.'
    ),
    textResponse('Found Go files.')
  ],

  operations: [
    { type: 'send-message', message: 'Find all Go files' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Find all Go files' },
      { type: 'assistant', content: 'Searching for Go files.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'glob',
        toolInput: { pattern: '**/*.go' },
        state: 'completed',
        result: {
          content: GLOB_GO_SINGLE,
          isError: false
        }
      },
      { type: 'assistant', content: 'Found Go files.' }
    ]
  }
};

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const globNoMatchesTest = {
  name: 'glob-no-matches',
  description: 'No files match pattern',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'glob',
      { pattern: '*.xyz' },
      'Searching for .xyz files.'
    ),
    textResponse('No files found.')
  ],

  operations: [
    { type: 'send-message', message: 'Find xyz files' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Find xyz files' },
      { type: 'assistant', content: 'Searching for .xyz files.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'glob',
        toolInput: { pattern: '*.xyz' },
        state: 'completed',
        result: {
          content: GLOB_NO_MATCHES,
          isError: false
        }
      },
      { type: 'assistant', content: 'No files found.' }
    ]
  }
};

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const globJsonFilesTest = {
  name: 'glob-json-files',
  description: 'Find JSON files',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'glob',
      { pattern: '*.json' },
      'Searching for JSON files.'
    ),
    textResponse('Found JSON files.')
  ],

  operations: [
    { type: 'send-message', message: 'Find JSON files' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Find JSON files' },
      { type: 'assistant', content: 'Searching for JSON files.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'glob',
        toolInput: { pattern: '*.json' },
        state: 'completed',
        result: {
          content: GLOB_JSON_SINGLE,
          isError: false
        }
      },
      { type: 'assistant', content: 'Found JSON files.' }
    ]
  }
};

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const globWithPathTest = {
  name: 'glob-with-path',
  description: 'Glob with path parameter (subdirectory)',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'glob',
      { pattern: '*.go', path: 'src' },
      'Searching in src.'
    ),
    textResponse('Found files.')
  ],

  operations: [
    { type: 'send-message', message: 'Find Go files in src' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Find Go files in src' },
      { type: 'assistant', content: 'Searching in src.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'glob',
        toolInput: { path: 'src', pattern: '*.go' },
        state: 'completed',
        result: {
          content: 'src/main.go',
          isError: false
        }
      },
      { type: 'assistant', content: 'Found files.' }
    ]
  }
};

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const globMissingPatternTest = {
  name: 'glob-missing-pattern',
  description: 'Glob without pattern returns error',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'glob',
      {},
      'Searching.'
    ),
    textResponse('Error.')
  ],

  operations: [
    { type: 'send-message', message: 'Glob without pattern' }
  ],

  // Note: When a tool fails validation before approval, state may not be set.
  // This is expected behavior - the tool never reached the approval stage.
  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Glob without pattern' },
      { type: 'assistant', content: 'Searching.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'glob',
        toolInput: {},
        state: 'completed',
        result: {
          content: 'Missing required parameter: pattern',
          isError: true
        }
      },
      { type: 'assistant', content: 'Error.' }
    ]
  }
};

/**
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const globParallelTest = {
  name: 'glob-parallel',
  description: 'Multiple parallel glob calls',
  fixture: 'unit-test-fixture',

  llmResponses: [
    multiToolResponse([
      { toolUseId: 'call_1', toolName: 'glob', toolInput: { pattern: '*.json' } },
      { toolUseId: 'call_2', toolName: 'glob', toolInput: { pattern: '*.md' } }
    ], 'Searching for multiple patterns.'),
    textResponse('Found files.')
  ],

  operations: [
    { type: 'send-message', message: 'Find JSON and MD files' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Find JSON and MD files' },
      { type: 'assistant', content: 'Searching for multiple patterns.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'glob',
        toolInput: { pattern: '*.json' },
        state: 'completed',
        result: {
          content: GLOB_JSON_SINGLE,
          isError: false
        }
      },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'glob',
        toolInput: { pattern: '*.md' },
        state: 'completed',
        result: {
          content: GLOB_MD_SINGLE,
          isError: false
        }
      },
      { type: 'assistant', content: 'Found files.' }
    ]
  }
};

// Export all tests
export const tests = [
  globGoFilesTest,
  globNoMatchesTest,
  globJsonFilesTest,
  globWithPathTest,
  globMissingPatternTest,
  globParallelTest
];
