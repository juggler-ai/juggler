//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Framework tests for read_file action execution pipeline.
 * Tests that read_file returns content directly in tool-result (not as a context item).
 *
 * Uses GOLDEN DATA comparison - compares ENTIRE context structure, not substrings.
 * @module unit-tests/read-file-action
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  executeToolsAndGetContext,
  createToolCall,
  assert,
  assertContextGolden
} from '../utilities/test-helpers.js';

/**
 * @typedef {object} TestContext
 * @property {string} fixtureDir - Path to fixture directory
 * @property {function(string): Promise<string>} readFile - Read file helper
 * @property {function(string, number): Promise<{exitCode: number, stdout: string, stderr: string}>} executeCommand - Execute command helper
 */

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

// ============================================================================
// GOLDEN DATA - Expected file contents
// ============================================================================

/** src/main.go content formatted with line numbers (cat -n style: variable-width, right-aligned, tab separator) */
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

/** Empty file warning message */
const EMPTY_FILE_WARNING = '<system-reminder>WARNING: File empty.txt exists but is empty. Do not attempt to read it again.</system-reminder>';

// ============================================================================
// TESTS
// ============================================================================

/**
 * Run all read_file action tests.
 * @param {TestContext} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results with pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  await initializeRegistries();
  const session = await createTestSession();

  // Test 1: read_file returns correct content (single file)
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('read', { file_path: 'src/main.go' });

    const { context } = await executeToolsAndGetContext(
      conversation, session, [toolCall]
    );

    // GOLDEN: The ENTIRE expected context (full production pipeline)
    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'read',
        toolInput: { file_path: 'src/main.go' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: MAIN_GO,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'read single');

    // Also verify NO context item was created
    const readContextItems = conversation.rootMessageThread.contextItems.filter((/** @type {any} */ f) => f.type === 'read-file');
    assert(readContextItems.length === 0, 'read should NOT create a context item');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`single file: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 2: read_file for non-existent file
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('read', { file_path: 'does-not-exist.txt' });

    const { context } = await executeToolsAndGetContext(
      conversation, session, [toolCall]
    );

    // GOLDEN: The ENTIRE expected context (full production pipeline)
    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'read',
        toolInput: { file_path: 'does-not-exist.txt' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: 'File does not exist: does-not-exist.txt. Do not attempt to read it again.',
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'read non-existent');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`non-existent: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 3: Multiple read_file calls in parallel
  try {
    const conversation = await createTestConversation(session);
    const toolCalls = [
      createToolCall('read', { file_path: 'src/main.go' }),
      createToolCall('read', { file_path: 'config.json' })
    ];

    const { context } = await executeToolsAndGetContext(
      conversation, session, toolCalls
    );

    // GOLDEN: The ENTIRE expected context (full production pipeline)
    // Order is: user, then each tool-use followed by its tool-result, then assistant
    // (unified tool-action messages are split into tool-use + tool-result pairs)
    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'read',
        toolInput: { file_path: 'src/main.go' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: MAIN_GO,
        isError: false
      },
      {
        type: 'tool-use',
        toolUseId: '$2',
        toolName: 'read',
        toolInput: { file_path: 'config.json' }
      },
      {
        type: 'tool-result',
        toolUseId: '$2',
        content: CONFIG_JSON,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, toolCalls, 'read parallel');

    // Verify no context items were created
    const readContextItems = conversation.rootMessageThread.contextItems.filter((/** @type {any} */ f) => f.type === 'read-file');
    assert(readContextItems.length === 0, 'parallel read_file should NOT create context items');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`parallel: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 4: Same file read twice (no deduplication for actions)
  try {
    const conversation = await createTestConversation(session);

    const call1 = createToolCall('read', { file_path: 'src/main.go' });
    await executeToolsAndGetContext(conversation, session, [call1]);

    const call2 = createToolCall('read', { file_path: 'src/main.go' });
    const { context } = await executeToolsAndGetContext(conversation, session, [call2]);

    // GOLDEN: The ENTIRE expected context (full production pipeline)
    // Two complete conversation turns, each with user->tools->assistant
    const expected = [
      // First turn
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'read',
        toolInput: { file_path: 'src/main.go' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: MAIN_GO,
        isError: false
      },
      { type: 'assistant', content: 'Done.' },
      // Second turn
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$2',
        toolName: 'read',
        toolInput: { file_path: 'src/main.go' }
      },
      {
        type: 'tool-result',
        toolUseId: '$2',
        content: MAIN_GO,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [call1, call2], 'read no dedup');
    passed++;
  } catch (e) {
    failed++;
    errors.push(`no dedup: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 5: Large file truncation (> 2000 lines)
  // NOTE: Uses behavioral assertions instead of golden data because the content
  // is 2000 lines which would be impractical to define as a constant. This test
  // verifies the truncation BEHAVIOR (header, footer, pagination hint) not exact content.
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('read', { file_path: 'large-file.txt' });

    const { context } = await executeToolsAndGetContext(
      conversation, session, [toolCall]
    );

    // Verify context structure (4 messages: user, tool-use, tool-result, assistant)
    assert(context.messages.length === 4, `Should have 4 messages, got ${context.messages.length}`);
    assert(context.messages[0].type === 'user', 'First should be user');
    assert(context.messages[1].type === 'tool-use', 'Second should be tool-use');
    assert(context.messages[2].type === 'tool-result', 'Third should be tool-result');
    assert(context.messages[3].type === 'assistant', 'Fourth should be assistant');

    // Verify tool-result content has correct truncation markers
    const toolResult = /** @type {{content?: string}} */ (context.messages[2]);
    const content = toolResult.content || '';
    assert(content.startsWith('<file path="large-file.txt">'), 'Should start with file tag');
    assert(content.includes('Showing lines 1-2000 of 3000'), 'Should show line range in footer');
    assert(content.includes('offset=2001'), 'Should suggest how to get more');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`large file truncation: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 6: Long line truncation (line longer than MaxLineLength)
  // NOTE: Uses behavioral assertions instead of golden data because the content
  // is >10000 chars which would be impractical to define as a constant. This test
  // verifies the truncation BEHAVIOR (line gets cut, "[line truncated:" marker added).
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('read', { file_path: 'long-lines.txt' });

    const { context } = await executeToolsAndGetContext(
      conversation, session, [toolCall]
    );

    // Verify context structure (4 messages: user, tool-use, tool-result, assistant)
    assert(context.messages.length === 4, `Should have 4 messages, got ${context.messages.length}`);
    assert(context.messages[0].type === 'user', 'First should be user');
    assert(context.messages[1].type === 'tool-use', 'Second should be tool-use');
    assert(context.messages[2].type === 'tool-result', 'Third should be tool-result');
    assert(context.messages[3].type === 'assistant', 'Fourth should be assistant');

    // Verify tool-result content has truncated line
    const toolResult = /** @type {{content?: string}} */ (context.messages[2]);
    const content = toolResult.content || '';

    // The 12000-char line should be truncated - should NOT contain all 12000 A's
    const fullLongLine = 'A'.repeat(12000);
    assert(!content.includes(fullLongLine), 'Long line should be truncated');
    // Should have the explicit truncation marker (not a bare ellipsis), so the
    // model treats the line as deliberately truncated rather than corrupted.
    assert(content.includes('[line truncated:'), 'Truncated line should have "[line truncated:" marker');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`long line truncation: ${e instanceof Error ? e.message : String(e)}`);
  }

  // Test 7: Empty file warning
  try {
    const conversation = await createTestConversation(session);
    const toolCall = createToolCall('read', { file_path: 'empty.txt' });

    const { context } = await executeToolsAndGetContext(
      conversation, session, [toolCall]
    );

    // GOLDEN: The ENTIRE expected context
    const expected = [
      { type: 'user', content: 'Execute the tools' },
      {
        type: 'tool-use',
        toolUseId: '$1',
        toolName: 'read',
        toolInput: { file_path: 'empty.txt' }
      },
      {
        type: 'tool-result',
        toolUseId: '$1',
        content: EMPTY_FILE_WARNING,
        isError: false
      },
      { type: 'assistant', content: 'Done.' }
    ];

    assertContextGolden(context, expected, [toolCall], 'read empty file');

    passed++;
  } catch (e) {
    failed++;
    errors.push(`empty file warning: ${e instanceof Error ? e.message : String(e)}`);
  }

  return { passed, failed, errors };
}
