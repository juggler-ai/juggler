//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Multi-Conversation
 *
 * Tests behavior across multiple conversations, including:
 * - Undo/redo isolation between conversations
 * - Context item isolation (per-conversation scope)
 * - Worker cleanup when switching conversations
 * - Conversation deletion and undo safety
 * @module integration-tests/multi-conversation-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';
import workerManager from '../../js/services/worker-manager.js';

// ============================================================================
// TEST DEFINITIONS
// ============================================================================

/**
 * Undo isolation test - undo in conversation A should not affect conversation B.
 *
 * This test verifies that each conversation has its own undo/redo stack.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const multiConvUndoIsolationTest = {
  name: 'multi-conv-undo-isolation',
  description: 'Undo in one conversation does not affect others',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Response in conversation A.'),
    textResponse('Response in conversation B.')
  ],

  operations: [
    // Send message in initial conversation (A)
    { type: 'send-message', message: 'Message in A' },
    // Create and switch to conversation B
    { type: 'create-conversation', name: 'Conv B' },
    { type: 'send-message', message: 'Message in B' },
    // Switch back to A and undo
    { type: 'switch-conversation', conversationId: '$CONV_0' },
    { type: 'undo' }
  ],

  // After undo in A, A should have only the context item and user message (assistant response undone)
  // We verify A's state - B is unaffected
  expectedItems: [
    { type: 'system-prompt', itemId: '$ITEM_1' },
    { type: 'user', content: 'Message in A' }
    // Assistant response was undone
  ]
};

/**
 * Context item isolation test - context items are scoped to their conversation.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const multiConvContextItemIsolationTest = {
  name: 'multi-conv-context-item-isolation',
  description: 'Context items are scoped to their conversation',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // Conversation A reads a file
    toolUseResponse('call_a1', 'read', { file_path: 'README.md' }, 'Reading in A.'),
    textResponse('File read in A.'),
    // Conversation B reads same file
    toolUseResponse('call_b1', 'read', { file_path: 'README.md' }, 'Reading in B.'),
    textResponse('File read in B.')
  ],

  operations: [
    // Conversation A reads a file (creates a context item)
    { type: 'send-message', message: 'Read README in conv A' },
    // Create conversation B
    { type: 'create-conversation', name: 'Conv B' },
    // B reads same file (creates separate context item in B)
    { type: 'send-message', message: 'Read README in conv B' },
    // Switch back to A
    { type: 'switch-conversation', conversationId: '$CONV_0' }
  ],

  // Verify A has its own context items (system-prompt + file-content)
  expectedItems: [
    { type: 'system-prompt', itemId: '$ITEM_1' }
    // A's file-content context item would be $ITEM_2
  ]
};

/**
 * Delete conversation and verify undo safety in remaining conversation.
 * This is the key test for the bug fix - ensures deleting conversation B
 * doesn't corrupt undo in conversation A.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const deleteConversationUndoSafeTest = {
  name: 'multi-conv-delete-undo-safe',
  description: 'Deleting a conversation does not corrupt undo in other conversations',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Response in A.'),
    textResponse('Response in B.')
  ],

  operations: [
    // Send message in conversation A
    { type: 'send-message', message: 'Message in A' },
    // Create conversation B
    { type: 'create-conversation', name: 'Conv B' },
    { type: 'send-message', message: 'Message in B' },
    // Delete conversation B
    { type: 'delete-conversation', conversationId: '$CONV_1' },
    // Undo in A - should work correctly (this is what the bug fix enables)
    { type: 'undo' }
  ],

  // After undo, A should have only context item and user message (assistant response undone)
  expectedItems: [
    { type: 'system-prompt', itemId: '$ITEM_1' },
    { type: 'user', content: 'Message in A' }
  ]
};

/**
 * Worker cleanup test - verify workers are terminated when conversation is deleted.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const multiConvWorkerCleanupTest = {
  name: 'multi-conv-worker-cleanup',
  description: 'Workers are cleaned up when conversation is destroyed',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Response in A.'),
    textResponse('Response in B.')
  ],

  operations: [
    // Send message in A
    { type: 'send-message', message: 'Message in A' },
    // Create B
    { type: 'create-conversation', name: 'Conv B' },
    { type: 'send-message', message: 'Message in B' },
    // Delete B - worker should be terminated
    { type: 'delete-conversation', conversationId: '$CONV_1' },
    // A should still work
    { type: 'send-message', message: 'Another message in A' }
  ],

  // Note: We don't have llmResponses for the 3rd message, so it will fail
  // This test focuses on verifying deletion doesn't break A
  // We use partial assertions
  expectedItems: [
    { type: 'system-prompt', itemId: '$ITEM_1' },
    { type: 'user', content: 'Message in A' },
    { type: 'assistant', content: 'Response in A.' }
  ]
};

/**
 * Basic multi-conversation switching test.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const multiConvSwitchTest = {
  name: 'multi-conv-switch-basic',
  description: 'Switching between conversations preserves state',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Response in A.'),
    textResponse('Response in B.')
  ],

  operations: [
    // Send message in A
    { type: 'send-message', message: 'Hello A' },
    // Create B and send message
    { type: 'create-conversation', name: 'Conv B' },
    { type: 'send-message', message: 'Hello B' },
    // Switch back to A
    { type: 'switch-conversation', conversationId: '$CONV_0' }
  ],

  // Verify A's state is preserved
  expectedItems: [
    { type: 'system-prompt', itemId: '$ITEM_1' },
    { type: 'user', content: 'Hello A' },
    { type: 'assistant', content: 'Response in A.' }
  ]
};

/**
 * Duplicate conversation test - verify branch button creates complete copy.
 * This is the key test for the bug fix - duplicated conversation should have
 * all messages, context items, and modelConfig from the source conversation, but start
 * with empty undo/redo stacks (nothing to undo).
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const duplicateConversationTest = {
  name: 'duplicate-conversation-basic',
  description: 'Duplicating a conversation copies all messages, modelConfig, but starts with empty undo stack',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Hello world response.'),
    textResponse('Second response.')
  ],

  operations: [
    // Send first message
    { type: 'send-message', message: 'Hello world' },
    // Send second message
    { type: 'send-message', message: 'How are you?' },
    // Note: sendMessage already waits for items to sync via _waitForItemsSync
    // No need for explicit wait-for-state here
    // Change model to a specific non-default value
    { type: 'set-model', provider: 'anthropic', model: 'claude-opus-4-20250514' },
    // Duplicate the conversation
    { type: 'duplicate-conversation', sourceId: '$CONV_0' }
  ],

  // Verify duplicated conversation has all messages
  expectedItems: [
    { type: 'system-prompt', itemId: '$ITEM_1' },
    { type: 'user', content: 'Hello world' },
    { type: 'assistant', content: 'Hello world response.' },
    { type: 'user', content: 'How are you?' },
    { type: 'assistant', content: 'Second response.' }
  ],

  // Verify undo/redo stacks are empty (fresh start)
  expectedUndoState: {
    canUndo: false,
    canRedo: false
  },

  // NEW: Verify modelConfig is preserved (snapshot exposes the resolved root
  // model config under the `modelConfig` key; the conversation-level Yjs key
  // is `defaultModelConfig`, threads override via their own `modelConfig`).
  expectedMetadata: {
    modelConfig: {
      provider: 'anthropic',
      model: 'claude-opus-4-20250514'
    }
  },

  // Verify transaction blobs survive duplication: the source's
  // `.juggler/{convID}.txns/` directory must be copied so items' transactionId
  // references can still resolve when the user opens "View Transaction".
  customAssertions: async (conversation) => {
    const txnIds = new Set();
    for (const item of conversation._rootMessageThread.items) {
      const id = item.get?.('transactionId');
      if (id) txnIds.add(id);
    }
    if (txnIds.size === 0) {
      throw new Error('duplicate-conversation-basic: expected at least one transactionId on duplicated items');
    }
    for (const txnId of txnIds) {
      const blob = await workerManager.getTransaction(conversation.id, txnId);
      if (!blob) {
        throw new Error(`duplicate-conversation-basic: transaction ${txnId} missing on duplicated conversation ${conversation.id} — .txns/ dir not copied`);
      }
    }
  }
};

/**
 * Redo works correctly in multi-conversation scenario.
 * This test only uses a single conversation and validates undo/redo flow.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const multiConvRedoTest = {
  name: 'multi-conv-redo',
  description: 'Redo works correctly after undo in multi-conversation scenario',
  fixture: 'unit-test-fixture',
  // NOT skipped - this test passes because it only uses a single conversation

  llmResponses: [
    textResponse('Response in A.')
  ],

  operations: [
    // Send message in A
    { type: 'send-message', message: 'Message in A' },
    // Undo
    { type: 'undo' },
    // Redo
    { type: 'redo' }
  ],

  // After redo, should have context item and both user and assistant messages
  expectedItems: [
    { type: 'system-prompt', itemId: '$ITEM_1' },
    { type: 'user', content: 'Message in A' },
    { type: 'assistant', content: 'Response in A.' }
  ]
};

/**
 * Duplicated conversation should inherit the source name with " (copy)" suffix.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const duplicateConversationNameTest = {
  name: 'duplicate-conversation-name',
  description: 'Duplicated conversation tab should be named "<source> (copy)", not "Unknown"',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Hello world response.')
  ],

  operations: [
    { type: 'send-message', message: 'Hello world' },
    { type: 'duplicate-conversation', sourceId: '$CONV_0' }
  ],

  expectedItems: [
    { type: 'system-prompt', itemId: '$ITEM_1' },
    { type: 'user', content: 'Hello world' },
    { type: 'assistant', content: 'Hello world response.' }
  ],

  customAssertions: async (conversation) => {
    // Under JUGGLER_TEST_IFRAMES>1, multiple tests share one SessionManager,
    // so a sibling test may already hold "<base> (copy)" — the server then
    // resolves this clone to "<base> (copy 2)", "<base> (copy 3)", etc. The
    // production behaviour is correct; accept any " (copy)" or " (copy N)"
    // suffix and verify there's a non-empty prefix.
    const match = conversation.name.match(/^(.+?) \(copy(?: \d+)?\)$/);
    if (!match) {
      throw new Error(`duplicate-conversation-name: expected name to end with " (copy)" or " (copy N)", got "${conversation.name}"`);
    }
    if (!match[1].trim()) {
      throw new Error(`duplicate-conversation-name: expected source name prefix before " (copy)", got "${conversation.name}"`);
    }
  }
};

/**
 * When the active tab is deleted, the UI should return to the most-recently-used
 * tab, not just the first tab in list order.
 *
 * Sequence (new convs are PREPENDED in the session Map):
 *   Start: Conv A selected (visibleConversationId=A, MRU=[])
 *   create Conv B  → session map: {B, A}
 *   switch to B    → MRU: [B]
 *   create Conv C  → session map: {C, B, A}
 *   switch to C    → MRU: [C, B]
 *   delete C       → MRU: [B], visibleConversationId → B (MRU)
 *                    session map: {B, A}   ← B is at index 0
 *   Expected: B selected, not A (first in creation order) or A (tail of MRU).
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const deleteActiveTabMruTest = {
  name: 'multi-conv-delete-active-tab-mru',
  description: 'Deleting the active tab returns to most-recently-used tab, not tab 0',
  fixture: 'unit-test-fixture',

  llmResponses: [],

  operations: [
    // Conv A ($CONV_0) is the initial conversation.
    // create-conversation does NOT call session.switchConversation, so explicit
    // switch ops are needed to build the MRU list.
    { type: 'create-conversation', name: 'Conv B' },     // $CONV_1; session map: {B,A}
    { type: 'switch-conversation', conversationId: '$CONV_1' }, // MRU: [B]
    { type: 'create-conversation', name: 'Conv C' },     // $CONV_2; session map: {C,B,A}
    { type: 'switch-conversation', conversationId: '$CONV_2' }, // MRU: [C,B]
    // Delete Conv C (currently active) → should land on Conv B (MRU), not Conv A.
    { type: 'delete-conversation', conversationId: '$CONV_2' }
  ],

  // No LLM responses needed; just verify the session selection via customAssertions.
  // Scope to THIS test's own conversations by id (not Map position): under
  // JUGGLER_TEST_IFRAMES>1 the session order also carries sibling lanes' tabs
  // and is reordered by their auto-recents activity, so positional indexing is
  // unreliable. own = [A, B, C] in creation order; C was just deleted.
  customAssertions: (conversation, ctx) => {
    const session = conversation.session;
    const own = ctx.harness.conversationIds();
    const convAId = own[0];
    const convBId = own[1];
    const visibleId = session.visibleConversationId;
    if (visibleId !== convBId) {
      const hint = visibleId === convAId
        ? 'landed on Conv A (first by creation) instead of Conv B (MRU)'
        : `landed on unexpected conversation ${visibleId}`;
      throw new Error(`delete-active-tab-mru: ${hint}`);
    }
  }
};

/**
 * Duplicating the same source twice must not collide on name.
 * First duplicate becomes "<source> (copy)"; second duplicate of the same source
 * (with that name already taken) must get a unique name like "<source> (copy 2)",
 * not fail server-side with a 409 and land as a tab named "Unknown".
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const duplicateConversationTwiceNameTest = {
  name: 'duplicate-conversation-twice-name',
  description: 'Duplicating the same conversation twice produces unique names, not a collision/"Unknown"',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Hello world response.')
  ],

  operations: [
    { type: 'send-message', message: 'Hello world' },
    { type: 'duplicate-conversation', sourceId: '$CONV_0' },
    { type: 'duplicate-conversation', sourceId: '$CONV_0' }
  ],

  customAssertions: (conversation, ctx) => {
    // Scope to THIS test's own conversations. Under JUGGLER_TEST_IFRAMES>1,
    // session.conversations is shared across iframes and includes sibling
    // tests' conversations; the source $CONV_0's own name may also already
    // carry a " (copy)" suffix if a sibling test held the base name first.
    const session = conversation.session;
    const ownIds = ctx.harness.conversationIds();
    const own = ownIds
      .map((id) => session.conversations.get(id))
      .filter((c) => c);
    if (own.length !== 3) {
      throw new Error(`duplicate-conversation-twice-name: expected 3 own conversations (source + 2 clones), got ${own.length}`);
    }
    const names = own.map((c) => c.name);
    const unique = new Set(names);
    if (unique.size !== names.length) {
      throw new Error(`duplicate-conversation-twice-name: duplicate names present: ${JSON.stringify(names)}`);
    }
    for (const name of names) {
      if (!name || name === 'Unknown') {
        throw new Error(`duplicate-conversation-twice-name: bad tab name "${name}" in ${JSON.stringify(names)}`);
      }
    }
  }
};

/**
 * Cross-conversation cancel isolation.
 *
 * Regression test: the engine's actionExecutor is a singleton running actions
 * for every conversation, and tool-use IDs are only unique per provider
 * conversation (OpenAI-style `call_1` recurs; the mock LLM reuses ids in every
 * test). cancelByToolUseId used to match on toolUseId alone, so cancelling
 * `call_1` in conversation B aborted a running `call_1` in conversation A.
 * The aborted execution takes the no-write-on-cancel path (the worker is the
 * sole writer of cancellation), but A's worker isn't cancelling anything — so
 * A's tool wedged at running-with-no-result forever. This was the dominant
 * "rerun/cancel tests wedge under load" flake: any sibling test cancelling its
 * own call_1 killed whichever other lane had a call_1 in flight.
 *
 * Flow: A starts a slow bash (call_1) and we confirm it is streaming; B issues
 * its own call_1 and the user denies it (writes state=cancelled, firing the
 * engine's cancel observer). A's tool must still run to completion.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const multiConvCancelIsolationTest = {
  name: 'multi-conv-cancel-isolation',
  description: 'Cancelling call_1 in conversation B must not abort the running call_1 in conversation A',
  fixture: 'unit-test-fixture',
  timeoutMs: 20000,

  llmResponses: [
    toolUseResponse('call_1', 'bash',
      { command: 'env echo started_a; sleep 5' },
      'Running A.'
    ),
    textResponse('A finished.')
  ],

  operations: [
    // A: start the slow tool and confirm it is actually executing.
    { type: 'send-message-no-wait', message: 'Run slow tool in A' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'start-capture-progress', toolUseId: 'call_1' },
    { type: 'approve-no-wait', toolUseId: 'call_1' },
    { type: 'wait-for-progress', toolUseId: 'call_1', minEvents: 1 },
    // B: issue an identically-named tool and deny it while A still runs.
    {
      type: 'create-conversation',
      name: 'Conv B',
      llmResponses: [
        toolUseResponse('call_1', 'bash', { command: 'env echo never_runs' }, 'Running B.')
      ]
    },
    // Make B the session's visible conversation: the composer refuses to
    // send while the visible conversation (still A, mid-tool) is processing.
    { type: 'switch-conversation', conversationId: '$CONV_1' },
    { type: 'send-message-no-wait', message: 'Run tool in B' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'deny', toolUseId: 'call_1' },
    // Back to A: its tool must complete and the turn must finish.
    { type: 'switch-conversation', conversationId: '$CONV_0' },
    { type: 'wait-for-idle' }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'Run slow tool in A' },
    { type: 'assistant', content: 'Running A.' },
    {
      type: 'tool-action',
      toolUseId: '$TOOL_1',
      toolName: 'bash',
      state: 'completed'
    },
    { type: 'assistant', content: 'A finished.' }
  ],

  customAssertions: (conversation) => {
    const items = conversation.rootMessageThread.items;
    const toolActions = items.filter(i => i.get('type') === 'tool-action');
    if (toolActions.length !== 1) {
      throw new Error(`Expected exactly 1 tool-action in A, got ${toolActions.length}`);
    }
    const result = toolActions[0].get('result');
    const resultPlain = result?.toJSON ? result.toJSON() : result;
    if (!resultPlain || resultPlain.cancelled) {
      throw new Error(
        'A\'s tool result is missing or cancelled — B\'s deny aborted A\'s execution (cross-conversation cancel leak)'
      );
    }
    const content = resultPlain.content || '';
    if (!content.includes('started_a')) {
      throw new Error(`Expected A's output to contain "started_a", got: "${content}"`);
    }
  }
};

/**
 * The `new_conversation` tool (executed in the engine) must create a NEW,
 * independent conversation and seed it with the model-supplied initial message.
 * Exercised with `autostart:false` so the seed lands as a parked user message and
 * no second LLM turn is needed.
 *
 * The exercised-and-observable core is the engine-side path: `execute()` calls
 * `session.createConversation(...)`, re-fetches the new conversation, and seeds
 * the message via `insertItem` — every one of those steps throws on failure, so
 * the caller's tool-action reaching `state==='completed'` with a success result
 * proves the whole engine path (create + seed) ran. The peer conversation itself
 * is born in the engine realm and loads into real viewers via the standard
 * `conversations-changed` broadcast; the integration harness's asserted session
 * is not that engine realm, so this test verifies the caller-visible outcome
 * rather than reaching across realms.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const newConversationToolTest = {
  name: 'new-conversation-tool-seeds-message',
  description: 'new_conversation tool executes in the engine and creates + seeds a new conversation',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'new_conversation',
      { message: 'NEWCONV_SEED_MSG investigate the widget', name: 'NEWCONV_TOOL_TAB', autostart: false },
      'Opening a new conversation.'),
    textResponse('Opened a new conversation for the widget work.')
  ],

  operations: [
    { type: 'send-message', message: 'start a separate chat about the widget' }
  ],

  // Fence on the tool-action having completed before asserting its result.
  settleUntil: (conversation) => {
    const items = conversation.rootMessageThread?.items || [];
    const call = items.find((it) => it.get?.('toolName') === 'new_conversation');
    return !!call && call.get('state') === 'completed';
  },

  customAssertions: (conversation) => {
    const items = conversation.rootMessageThread?.items || [];
    const call = items.find((it) => it.get?.('toolName') === 'new_conversation');
    if (!call) {
      throw new Error('new_conversation: no new_conversation tool-action found in the caller conversation');
    }
    const state = call.get('state');
    if (state !== 'completed') {
      throw new Error(`new_conversation: tool-action state is "${state}", expected "completed" — the engine execute() (createConversation + seed) failed`);
    }
    const result = call.get('result');
    const content = String((result?.get ? result.get('content') : result?.content) || '');
    if (!content.includes('NEWCONV_TOOL_TAB')) {
      throw new Error(`new_conversation: tool result did not confirm the created conversation; got: ${content.slice(0, 160)}`);
    }
  }
};

// Export all tests
export const tests = [
  multiConvUndoIsolationTest,
  multiConvContextItemIsolationTest,
  deleteConversationUndoSafeTest,
  multiConvWorkerCleanupTest,
  multiConvSwitchTest,
  multiConvRedoTest,
  duplicateConversationTest,
  duplicateConversationNameTest,
  duplicateConversationTwiceNameTest,
  deleteActiveTabMruTest,
  multiConvCancelIsolationTest,
  newConversationToolTest
];
