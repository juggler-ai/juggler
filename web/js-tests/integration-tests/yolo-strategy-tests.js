//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: YOLO Strategy
 *
 * Proves the YOLO strategy's master-control auto-approval: a `bash` command the
 * static analyser would normally route to approval (`env echo …` — see
 * approval-wait-tests, where the same command halts at `wait-for-approval`)
 * runs to completion under `strategy: 'yolo'` with NO approve operation. The
 * test asserts the full document with the bash tool-action `completed` and its
 * result present, which can only happen if approval was skipped.
 * @module integration-tests/yolo-strategy-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';

// ============================================================================
// TEST DEFINITIONS
// ============================================================================

/**
 * Under YOLO, a normally-approval-gated bash command auto-completes.
 *
 * `env echo yolo` is rejected by the static command analyser (the `env`
 * prefix defeats the trivially-safe builtin check), so under the default
 * strategy it would halt at `wait-for-approval`. With YOLO active,
 * getApprovalPolicy() returns APPROVE for every tool, so the loop runs the
 * command and continues without any user interaction.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const yoloAutoApprovesBashTest = {
  name: 'yolo-auto-approves-bash',
  description: 'YOLO auto-approves a normally-gated bash command — no approval modal',
  fixture: 'unit-test-fixture',
  strategy: 'yolo',
  // Force the non-permissive conversation: without this the harness grants a
  // blanket `execute *` + auto-approve, which would auto-run the command
  // regardless of strategy and mask whether YOLO's getApprovalPolicy() is
  // actually consulted. With it, only the strategy policy can skip approval.
  approvalFlow: true,

  llmResponses: [
    toolUseResponse('call_1', 'bash', { command: 'env echo yolo' }, 'Running.'),
    textResponse('Done.')
  ],

  operations: [
    // No wait-for-approval / approve — YOLO must run the command unattended.
    { type: 'send-message', message: 'Run echo yolo' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run echo yolo' },
      { type: 'assistant', content: 'Running.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env echo yolo' },
        state: 'completed',
        result: { content: 'yolo', isError: false }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  }
};

/**
 * The retroactive case: a tool parks awaiting approval under the DEFAULT
 * strategy, then the user switches to YOLO mid-wait. The already-pending tool
 * must auto-approve and run — without the user clicking anything.
 *
 * This is the exact bug a user hits switching to YOLO mid-loop: the engine
 * decides approval once, at evaluate time, so a tool parked under the old
 * strategy keeps waiting even after the switch. The worker detects the
 * currentStrategyId change and resets the pending tool to unevaluated, so it is
 * re-evaluated under YOLO's APPROVE policy.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const yoloReevaluatesPendingOnSwitchTest = {
  name: 'yolo-reevaluates-pending-on-switch',
  description: 'Switching to YOLO while a tool is parked pending auto-approves it retroactively',
  fixture: 'unit-test-fixture',
  strategy: 'default',
  // Non-permissive: the tool must genuinely park under default, so the only
  // thing that can later release it is the strategy switch.
  approvalFlow: true,

  llmResponses: [
    toolUseResponse('call_1', 'bash', { command: 'env echo switch' }, 'Running.'),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Run echo switch' },
    // Under default, the analyser routes `env echo` to approval — tool parks.
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    {
      type: 'assert-document',
      expected: {
        items: [
          { type: 'system-prompt', itemId: '$ITEM_1' },
          { type: 'user', content: 'Run echo switch' },
          { type: 'assistant', content: 'Running.' },
          {
            type: 'tool-action',
            toolUseId: '$TOOL_1',
            toolName: 'bash',
            toolInput: { command: 'env echo switch' },
            state: 'pending'
            // No result — blocked awaiting approval under default.
          }
        ]
      }
    },
    // Switch to YOLO while the tool is parked. The worker re-evaluates it.
    { type: 'set-strategy', strategy: 'yolo' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run echo switch' },
      { type: 'assistant', content: 'Running.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env echo switch' },
        state: 'completed',
        result: { content: 'switch', isError: false }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  }
};

/**
 * A sub-thread inherits the conversation's (root's) strategy. Root is set to
 * YOLO; the root turn spawns a sub-thread which calls a normally-approval-gated
 * bash (`env echo …`, defeated by the static analyser). With NO approval
 * operation, the sub-thread's bash must auto-run — proving the sub-thread
 * resolves its effective strategy up to root (getEffectiveStrategyId) rather
 * than silently falling back to `default`, which is the bug this guards.
 *
 * If inheritance regresses, the sub-thread bash parks pending forever, the
 * thread never produces a result, the parent never auto-resumes, and this
 * document assertion fails (no thread result, no final assistant message).
 *
 * Mock responses:
 *   1. Root (YOLO): create_thread
 *   2. Thread: bash `env echo subyolo` — normally gated, must auto-approve
 *   3. Thread: text "sub done"
 *   4. Root (auto-resumed): text "All done."
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const yoloInheritedBySubThreadTest = {
  name: 'yolo-inherited-by-sub-thread',
  description: 'A sub-thread inherits root YOLO — a normally-gated bash in the thread auto-approves',
  fixture: 'unit-test-fixture',
  strategy: 'yolo',
  // Non-permissive: only the inherited strategy policy can skip approval.
  approvalFlow: true,

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Do sub task', prompt: 'Run it' }),
    toolUseResponse('call_2', 'bash', { command: 'env echo subyolo' }, 'Running in thread.'),
    textResponse('sub done'),
    textResponse('All done.')
  ],

  operations: [
    // No wait-for-thread-approval / approve — inheritance must auto-run call_2.
    { type: 'send-message', message: 'Begin' },
    { type: 'wait-for-idle' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Begin' },
      { type: 'thread', itemId: '$ITEM_3', result: 'sub done' },
      { type: 'assistant', content: 'All done.' }
    ]
  }
};

// Export all tests
export const tests = [
  yoloAutoApprovesBashTest,
  yoloReevaluatesPendingOnSwitchTest,
  yoloInheritedBySubThreadTest
];
