//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Clear Conversation (/clear)
 *
 * The clear command wipes the conversation's messages but MUST preserve the
 * sticky system-prompt context item (SYSTEM_1, preventUserDeletion) — that
 * item carries the user's system prompt. Regression guard for "/clear also
 * removed the system prompt".
 * @module integration-tests/clear-tests
 */

import { textResponse } from '../utilities/integration-test-runner.js';

/**
 * Send a message, then /clear. Everything conversational is gone, but the
 * system-prompt placeholder survives untouched.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const clearPreservesSystemPromptTest = {
  name: 'clear-preserves-system-prompt',
  description: '/clear wipes messages but keeps the system-prompt context item',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Hello back.')
  ],

  operations: [
    { type: 'send-message', message: 'Hello there' },
    { type: 'run-command', command: 'clear' }
  ],

  // After clear, the ONLY surviving item is the sticky system prompt.
  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' }
    ]
  }
};

/**
 * /clear must leave a conversation in the same shape as a freshly-created one:
 * the always-present auto items (project memory, AI assistant files) re-seeded,
 * not lost. Regression guard for "/clear stripped the memory/CLAUDE.md items and
 * never added them back". Uses the same single source of truth as
 * createConversation (`seedConversationAutoItems`, `conversation-seeder.js`).
 *
 * The default harness conversation is created BEFORE setupFiles writes
 * `.juggler/MEMORY.md`, so it carries no memory item up front; the re-seed on
 * /clear is what brings it in. Touches the fixed project-root memory path, so it
 * is scheduled alone via needsExclusiveRun.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const clearReseedsAutoItemsTest = {
  name: 'clear-reseeds-auto-items',
  description: '/clear re-seeds always-present auto items (project memory), matching a fresh conversation',
  fixture: 'unit-test-fixture',
  needsExclusiveRun: true,

  setupFiles: { '.juggler/MEMORY.md': '# Memory\n\n- [2026-06-14] Seeded fact\n' },

  llmResponses: [
    textResponse('Hello back.')
  ],

  operations: [
    { type: 'send-message', message: 'Hello there' },
    { type: 'run-command', command: 'clear' }
  ],

  // After clear, the surviving sticky system prompt plus the re-seeded memory
  // item — exactly what a fresh conversation would hold with this file present.
  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'memory', itemId: '$ITEM_2' }
    ]
  }
};

/**
 * The whole /clear (wipe history + re-seed auto items) must revert in a SINGLE
 * undo — not one undo per re-seeded item leaving a half-restored conversation.
 * Regression guard for the coalesceUndo bracketing: send a turn, /clear (which
 * deletes the turn and seeds the memory item), then one undo must restore the
 * exact pre-clear document (turn back, seeded memory gone).
 *
 * The default harness conversation is created BEFORE setupFiles writes
 * `.juggler/MEMORY.md`, so the pre-clear state carries no memory item; the
 * single undo therefore lands precisely on [system-prompt, user, assistant].
 * Touches the fixed project-root memory path → scheduled alone via
 * needsExclusiveRun.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const clearUndoesAsSingleGroupTest = {
  name: 'clear-undoes-as-single-group',
  description: '/clear (wipe + re-seed) reverts in one undo to the exact pre-clear document',
  fixture: 'unit-test-fixture',
  needsExclusiveRun: true,

  setupFiles: { '.juggler/MEMORY.md': '# Memory\n\n- [2026-06-14] Seeded fact\n' },

  llmResponses: [
    textResponse('Hello back.')
  ],

  operations: [
    { type: 'send-message', message: 'Hello there' },
    { type: 'run-command', command: 'clear' },
    { type: 'undo' }
  ],

  // One undo restores the full pre-clear conversation: the turn is back and the
  // re-seeded memory item is gone — proving clear + re-seed collapsed into one
  // undo group.
  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Hello there' },
      { type: 'assistant', content: 'Hello back.' }
    ]
  }
};

export const tests = [
  clearPreservesSystemPromptTest,
  clearReseedsAutoItemsTest,
  clearUndoesAsSingleGroupTest
];
