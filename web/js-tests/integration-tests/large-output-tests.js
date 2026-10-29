//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Large bash output
 *
 * Guards the fix for the server-lock-up / performance bug where a command that
 * pumped out megabytes of output flooded the engine with tens of thousands of
 * streaming chunks, wedging the server so later commands hung indefinitely.
 *
 * `ExecuteStreaming` now bounds the streamed output (head + tail) in Go before
 * it crosses to JS. This test runs a genuinely large-output command end-to-end
 * and asserts (a) it completes with a bounded result, and (b) a *subsequent*
 * command still runs — i.e. the server stays responsive.
 * @module integration-tests/large-output-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';

// ============================================================================
// TEST: large-output command is bounded and the server stays responsive
// ============================================================================

/**
 * `seq 1 200000` emits ~1.4 MB across 200k lines — past the head+tail streaming
 * budget — so the result must come back truncated (not 1.4 MB). A second bash
 * command then runs to prove the engine/server wasn't wedged by the flood.
 *
 * Both commands are spelled through `env`, which the approval analyser has no
 * handler for, so each one stops at an approval prompt and the operations below
 * drive the tool through it. Spelled bare, `seq` and `echo` auto-approve and
 * there is no prompt to wait for.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const largeOutputBoundedTest = {
  name: 'large-output-bounded',
  description: 'A large-output bash command is bounded and a subsequent command still runs',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash',
      { command: 'env seq 1 200000' },
      'Running big command.'
    ),
    toolUseResponse('call_2', 'bash',
      { command: 'env echo "SECOND_OK"' },
      'Running second command.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Run it' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'approve', toolUseId: 'call_1' },
    // The flood-prone command finished; the loop must continue to the next
    // tool. If the server wedged, this approval never arrives.
    { type: 'wait-for-approval', toolUseId: 'call_2' },
    { type: 'approve', toolUseId: 'call_2' }
  ],

  customAssertions: (conversation) => {
    const items = conversation.rootMessageThread.items;
    const toolActions = items.filter(i => i.get('type') === 'tool-action');
    if (toolActions.length !== 2) {
      throw new Error(`Expected exactly 2 tool-actions, got ${toolActions.length}`);
    }

    const first = toolActions[0];
    if (first.get('state') !== 'completed') {
      throw new Error(`First (large-output) tool not completed: state=${first.get('state')}`);
    }
    const firstResult = first.get('result');
    const firstPlain = firstResult?.toJSON ? firstResult.toJSON() : firstResult;
    const firstContent = String(firstPlain?.content ?? '');

    // Bounded: the 1.4 MB of output must NOT survive into the result. The
    // smartTruncate budget caps the LLM-facing content well under 64 KB.
    if (firstContent.length > 64_000) {
      throw new Error(
        `Large-output result not bounded: ${firstContent.length} chars ` +
				`(output should have been truncated)`
      );
    }
    // And it must actually be the truncated large output, not empty/error.
    if (!/truncat/i.test(firstContent)) {
      throw new Error(
        `Expected a truncation notice in the large-output result, got ` +
				`${firstContent.length} chars: ${firstContent.slice(0, 120)}…`
      );
    }

    // Server stayed responsive: the second command ran to completion.
    const second = toolActions[1];
    if (second.get('state') !== 'completed') {
      throw new Error(`Second tool not completed (server wedged?): state=${second.get('state')}`);
    }
    const secondResult = second.get('result');
    const secondPlain = secondResult?.toJSON ? secondResult.toJSON() : secondResult;
    const secondContent = String(secondPlain?.content ?? '');
    if (!secondContent.includes('SECOND_OK')) {
      throw new Error(`Second command did not run: result=${secondContent.slice(0, 120)}`);
    }
  }
};

// Export all tests
export const tests = [
  largeOutputBoundedTest
];
