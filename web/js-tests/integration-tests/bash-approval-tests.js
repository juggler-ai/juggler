//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration tests for the static command-approval pipeline.
 *
 * Proves the wiring: when `ExecuteContextItem.isPermitted` is called from
 * the real approval flow, commands the analyser declares safe — trivially-safe
 * builtins (`echo`, `pwd`) or commands matching an enabled pattern after
 * compound/pipe stripping (`echo X | tail`) — execute without ever
 * surfacing an approval modal. Commands the analyser rejects halt at
 * `wait-for-approval`; the test denies the prompt to keep the run
 * deterministic.
 * @module integration-tests/bash-approval-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';

/**
 * Build a test that asserts a bash command auto-runs (no approval modal).
 * @param {string} name test name
 * @param {string} command bash command to execute
 * @param {string|undefined} pattern optional execute pattern to enable first
 * @param {string} expectedStdout expected exact stdout
 * @returns {import('../utilities/integration-test-runner.js').IntegrationTestDefinition} test def
 */
function autoApproveTest(name, command, pattern, expectedStdout) {
  /** @type {import('../utilities/integration-test-runner.js').TestOperation[]} */
  const operations = [];
  if (pattern) operations.push({ type: 'add-execute-pattern', pattern });
  operations.push({ type: 'send-message', message: `Run: ${command}` });

  return {
    name,
    description: `${command} runs without approval`,
    fixture: 'unit-test-fixture',

    llmResponses: [
      toolUseResponse('call_1', 'bash', { command }, 'Running.'),
      textResponse('Done.')
    ],

    operations,

    expectedDocument: {
      items: [
        { type: 'system-prompt', itemId: '$ITEM_1' },
        { type: 'user', content: `Run: ${command}` },
        { type: 'assistant', content: 'Running.' },
        {
          type: 'tool-action',
          toolUseId: '$TOOL_1',
          toolName: 'bash',
          toolInput: { command },
          state: 'completed',
          result: { content: expectedStdout, isError: false }
        },
        { type: 'assistant', content: 'Done.' }
      ]
    }
  };
}

export const echoAutoApprovesTest = autoApproveTest(
  'cmd-approval-echo-auto',
  'echo hello world',
  undefined,
  'hello world'
);

export const echoPipeTailAutoApprovesTest = autoApproveTest(
  'cmd-approval-echo-pipe-tail',
  'echo line | tail -n 1',
  undefined,
  'line'
);

export const echoStderrMergeAutoApprovesTest = autoApproveTest(
  'cmd-approval-echo-stderr-merge',
  'echo hello 2>&1',
  undefined,
  'hello'
);

export const patternedCommandAutoApprovesTest = autoApproveTest(
  'cmd-approval-pattern-match',
  'echo patterned',
  'echo *',
  'patterned'
);

// Leading whitespace in command output is real output, not noise — only the
// trailing newline is stripped. printf emits no trailing newline, so the
// result must preserve the leading spaces verbatim.
export const leadingWhitespacePreservedTest = autoApproveTest(
  'cmd-approval-leading-whitespace',
  "printf '   indented'",
  undefined,
  '   indented'
);

// `find -newermt <time>` is a read-only time comparison; README.md is the
// oldest stable resident of the fixture, and `!` inverts so the exact stdout
// is knowable without touching mtimes. The search starts AT the file rather
// than at `.`: the fixture root is shared with every other lane's test
// directory, and a `find .` that lists one a sibling is deleting reports
// "No such file or directory" and exits 1.
export const findNewermtAutoApprovesTest = autoApproveTest(
  'cmd-approval-find-newermt',
  'find README.md ! -newermt "2038-01-01"',
  undefined,
  'README.md'
);

/**
 * A command outside the safe set with no matching pattern must prompt;
 * the test denies to keep the run deterministic. The presence of the
 * `wait-for-approval` operation in this test is the proof: if the analyser
 * had auto-approved this command, the wait would time out (no modal ever
 * surfaces).
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const unsafeCommandPromptsTest = {
  name: 'cmd-approval-unsafe-prompts',
  description: 'Command not in the safe set requires approval',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash', { command: 'rm -rf does-not-exist' }, 'Running.')
  ],

  operations: [
    { type: 'send-message', message: 'Run unsafe command' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'deny', toolUseId: 'call_1' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run unsafe command' },
      { type: 'assistant', content: 'Running.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'rm -rf does-not-exist' },
        state: 'cancelled',
        result: { content: 'Action was cancelled.', isError: false }
      }
    ]
  }
};

export const tests = [
  echoAutoApprovesTest,
  echoPipeTailAutoApprovesTest,
  echoStderrMergeAutoApprovesTest,
  patternedCommandAutoApprovesTest,
  leadingWhitespacePreservedTest,
  findNewermtAutoApprovesTest,
  unsafeCommandPromptsTest
];
