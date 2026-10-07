//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Conversation-bar bin busy-guard
 *
 * The per-tab trash icon, the right-click menu, and the bottom-bar "Move to
 * Bin" all route through `conversation-bar._binConversation`, which refuses
 * while the conversation is busy. "Busy" must mean a turn is GENUINELY in
 * flight (.is-running) — NOT merely parked on a tool approval. A conversation
 * waiting for the user's approval executes nothing and bins reversibly, so it
 * must be binnable; only an actively streaming/executing turn is refused (it
 * would be orphaned at the turn boundary).
 *
 * Historically the guard conflated the two — it refused on
 * `awaiting || running` — so a tab parked on an approval (often deep in a
 * sub-thread) had a silently dead bin button. These tests pin each state and
 * assert the bin decision, using the production `session.conversations` map as
 * the oracle: a binned conversation is removed from it, a refused one stays.
 *
 * Both tests bin a SECONDARY conversation (not the default active tab) so the
 * UI tab the harness drives stays stable regardless of the outcome.
 * @module integration-tests/bin-guard-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';

// ============================================================================
// TEST 1: A conversation parked on a tool approval IS binnable
// ============================================================================

/**
 * Conv B proposes a bash command (requires approval) and parks at the approval
 * gate — awaiting the user, executing nothing. Binning B from the bar must
 * succeed: B leaves the active set and lands in the bin (restorable), proving
 * the guard does NOT treat awaiting-approval as busy.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const binAwaitingApprovalIsAllowedTest = {
  name: 'bin-awaiting-approval-is-allowed',
  description: 'A conversation parked on a tool approval can be moved to the bin',
  fixture: 'unit-test-fixture',

  // Default conversation A ($CONV_0) needs no turns.
  llmResponses: [],

  operations: [
    // Conv B ($CONV_1) proposes a tool that requires approval.
    {
      type: 'create-conversation',
      name: 'Conv B (awaiting)',
      llmResponses: [
        toolUseResponse('call_1', 'bash', { command: 'env echo pending' }, 'Running a command.')
      ]
    },
    // Drive B to the approval gate (it must be active to send + await).
    { type: 'switch-conversation', conversationId: '$CONV_1' },
    { type: 'send-message-no-wait', message: 'Run a command' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    // Return to A so we bin a NON-active tab; the approval on B stays pending.
    { type: 'switch-conversation', conversationId: '$CONV_0' },
    // Attempt the bin through the real conversation-bar guard.
    { type: 'bin-conversation', conversationId: '$CONV_1' }
  ],

  customAssertions: async (conversation, ctx) => {
    const session = conversation.session;
    const binnedId = ctx.harness.conversationIds()[1];
    if (!binnedId) {
      throw new Error('bin-awaiting-approval-is-allowed: could not resolve Conv B id');
    }
    // Oracle: binning removes the conversation from the active set.
    if (session.conversations.has(binnedId)) {
      throw new Error(
        'bin-awaiting-approval-is-allowed: Conv B was NOT binned — the guard ' +
				'wrongly treated an awaiting-approval conversation as busy'
      );
    }
    // And it must be in the bin (restorable), not vanished/deleted.
    const binned = await session.bin.list();
    if (!binned.some((/** @type {{id: string}} */ row) => row.id === binnedId)) {
      throw new Error(
        `bin-awaiting-approval-is-allowed: Conv B (${binnedId}) is gone from the ` +
				'active set but absent from the bin'
      );
    }
    // Clean up so repeated `-count=N` runs don't accumulate bin entries.
    await session.bin.deletePermanently(binnedId);
  }
};

// ============================================================================
// TEST 2: A conversation with a turn genuinely in flight is REFUSED
// ============================================================================

/**
 * Conv B is streaming a reply (mock paused mid-return) — a real in-flight turn.
 * Binning B from the bar must be refused: B stays in the active set so the
 * live turn can't be orphaned at the boundary. The mock is then released and
 * the turn allowed to settle.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const binRunningTurnIsRefusedTest = {
  name: 'bin-running-turn-is-refused',
  description: 'A conversation with a turn in flight cannot be moved to the bin',
  fixture: 'unit-test-fixture',

  llmResponses: [],

  operations: [
    // Conv B ($CONV_1) streams a reply, then pauses — a live in-flight turn.
    {
      type: 'create-conversation',
      name: 'Conv B (running)',
      llmResponses: [
        textResponse('Streaming reply held open.', { pauseBeforeReturn: true })
      ]
    },
    { type: 'switch-conversation', conversationId: '$CONV_1' },
    { type: 'send-message-no-wait', message: 'Work on it' },
    { type: 'wait-for-mock-paused' },
    // Attempt the bin while B is genuinely running — must be refused.
    { type: 'bin-conversation', conversationId: '$CONV_1' },
    // Let the held turn complete so teardown is clean.
    { type: 'release-mock' },
    { type: 'wait-for-idle' }
  ],

  customAssertions: (conversation, ctx) => {
    const session = conversation.session;
    const runningId = ctx.harness.conversationIds()[1];
    if (!runningId) {
      throw new Error('bin-running-turn-is-refused: could not resolve Conv B id');
    }
    // Oracle: a refused bin leaves the conversation in the active set.
    if (!session.conversations.has(runningId)) {
      throw new Error(
        'bin-running-turn-is-refused: Conv B was binned mid-turn — the guard ' +
				'failed to refuse a genuinely running conversation'
      );
    }
  }
};

// Export all tests
export const tests = [
  binAwaitingApprovalIsAllowedTest,
  binRunningTurnIsRefusedTest
];
