//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: move / copy items primitive
 *
 * conversation.moveItems / copyItems are the single relocation shape (snapshot →
 * rebuild → insert → delete-on-move). Same-doc relocations are ONE atomic,
 * undoable transaction; copy mints fresh itemIds. These tests cover a root→thread
 * round-trip, the fresh-id property of copy, and undo reversal of a move.
 * @module integration-tests/move-copy-tests
 */

import { textResponse } from '../utilities/integration-test-runner.js';

/**
 * Move a root message into an (empty) sub-thread. Same-doc → atomic; the item
 * leaves root and appears in the thread's items.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const moveItemsRootToThreadTest = {
  name: 'move-items-root-to-thread',
  description: 'moveItems relocates a root item into a sub-thread atomically',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Reply A.')
  ],

  operations: [
    { type: 'send-message', message: 'Message A' },
    { type: 'run-command', command: 'thread' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } },
    // Move the user message (index 1) out of root into the thread.
    { type: 'move-items', from: 'root', indices: [1], to: 'thread' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'assistant', content: 'Reply A.' },
      { type: 'thread', itemId: '$ITEM_3', items: [
        // Sub-thread carries no SYSTEM_1 — just the moved item.
        { type: 'user', content: 'Message A' }
      ] }
    ]
  }
};

/**
 * Copy a root message into a sub-thread: the original stays put and a fresh
 * copy (new itemId) appears in the thread.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const copyItemsRootToThreadTest = {
  name: 'copy-items-root-to-thread',
  description: 'copyItems duplicates a root item into a sub-thread with a fresh itemId',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Reply A.')
  ],

  operations: [
    { type: 'send-message', message: 'Message A' },
    { type: 'run-command', command: 'thread' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } },
    { type: 'copy-items', from: 'root', indices: [1], to: 'thread' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Message A' },
      { type: 'assistant', content: 'Reply A.' },
      { type: 'thread', itemId: '$ITEM_4', items: [
        // Sub-thread carries no SYSTEM_1 — just the copied item.
        { type: 'user', content: 'Message A' }
      ] }
    ]
  },

  customAssertions: (conversation) => {
    const root = conversation.rootMessageThread.items;
    const original = root.find((/** @type {any} */ it) => it.get?.('type') === 'user');
    const thread = root.find((/** @type {any} */ it) => it.get?.('type') === 'thread');
    const nested = thread?.get('items')?.toArray?.() || [];
    const copy = nested.find((/** @type {any} */ it) => it.get?.('type') === 'user');
    if (!original || !copy) throw new Error('copy-items: original or copy missing');
    const origId = original.get('itemId');
    const copyId = copy.get('itemId');
    if (!copyId || copyId === origId) {
      throw new Error(`copy-items: copy must have a fresh itemId; original=${origId} copy=${copyId}`);
    }
  }
};

/**
 * A same-doc move is one undoable transaction: undo restores the original
 * document exactly.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const moveItemsUndoTest = {
  name: 'move-items-undo',
  description: 'Undo reverses a same-doc move in one step',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Reply A.')
  ],

  operations: [
    { type: 'send-message', message: 'Message A' },
    { type: 'run-command', command: 'thread' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } },
    // Separate the /thread creation from the move so the undo capture window
    // doesn't merge them into one group (undo must reverse ONLY the move).
    { type: 'stop-undo-capturing' },
    { type: 'move-items', from: 'root', indices: [1], to: 'thread' },
    { type: 'undo' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Message A' },
      { type: 'assistant', content: 'Reply A.' },
      // Thread restored; nested items intentionally not asserted (partial).
      { type: 'thread', itemId: '$ITEM_4' }
    ]
  },

  customAssertions: (conversation) => {
    const thread = conversation.rootMessageThread.items.find(
      (/** @type {any} */ it) => it.get?.('type') === 'thread'
    );
    const nested = thread?.get('items')?.toArray?.() || [];
    // After undo the moved item returns to root; the isolated thread (which
    // carries no SYSTEM_1 of its own) is left empty.
    const content = nested.filter((/** @type {any} */ it) => it.get?.('type') !== 'system-prompt');
    if (content.length !== 0) {
      throw new Error(`move-items-undo: thread should be empty after undo, has ${content.length} item(s)`);
    }
  }
};

/**
 * Expand is the inverse of folding a selection into a thread: move items into a
 * thread, then expand → the document returns to its original shape (items back
 * in the parent at the thread's index, tile gone).
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const moveThenExpandRoundTripTest = {
  name: 'move-then-expand-round-trip',
  description: 'Expanding a thread reverses a move-into-thread, restoring the parent shape',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Reply A.')
  ],

  operations: [
    { type: 'send-message', message: 'Message A' },
    { type: 'run-command', command: 'thread' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } },
    // Fold the two content items into the thread.
    { type: 'move-items', from: 'root', indices: [1, 2], to: 'thread' },
    // Expand it straight back.
    { type: 'expand-thread' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Message A' },
      { type: 'assistant', content: 'Reply A.' }
    ]
  },

  customAssertions: (conversation) => {
    const threads = conversation.rootMessageThread.items.filter(
      (/** @type {any} */ it) => it.get?.('type') === 'thread'
    );
    if (threads.length !== 0) {
      throw new Error(`move-then-expand: expected no thread tile after expand, found ${threads.length}`);
    }
  }
};

/**
 * Expand is one undoable transaction: undo restores the thread with its items.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const expandThreadUndoTest = {
  name: 'expand-thread-undo',
  description: 'Undo reverses an expand in one step (thread + items restored)',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Reply A.')
  ],

  operations: [
    { type: 'send-message', message: 'Message A' },
    { type: 'run-command', command: 'thread' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } },
    { type: 'move-items', from: 'root', indices: [1, 2], to: 'thread' },
    // Separate the move from the expand so undo targets only the expand.
    { type: 'stop-undo-capturing' },
    { type: 'expand-thread' },
    { type: 'undo' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'thread', itemId: '$ITEM_2', items: [
        // Sub-thread carries no SYSTEM_1 — just the moved content.
        { type: 'user', content: 'Message A' },
        { type: 'assistant', content: 'Reply A.' }
      ] }
    ]
  }
};

/**
 * Promote a thread into a new top-level tab. Cross-doc promote is copy-style:
 * the source thread remains, while the new conversation root receives fresh-id
 * copies of the thread's items plus carried state (effective model config and
 * conversation-scoped permission metadata).
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const promoteThreadToNewTabTest = {
  name: 'promote-thread-to-new-tab',
  description: 'Promoting a thread creates a new tab with copied items and defined state carry-over',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Reply A.')
  ],

  operations: [
    { type: 'set-model', provider: 'mock', model: 'promote-model' },
    { type: 'add-execute-pattern', pattern: 'env echo *' },
    { type: 'send-message', message: 'Message A' },
    { type: 'run-command', command: 'thread' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } },
    { type: 'move-items', from: 'root', indices: [1, 2], to: 'thread' },
    { type: 'promote-thread' }
  ],

  customAssertions: (conversation) => {
    // The harness switches to the promoted conversation; it should carry the
    // effective model and conversation-scoped execute permission.
    const cfg = conversation.rootMessageThread.modelConfig;
    if (cfg?.provider !== 'mock' || cfg?.model !== 'promote-model') {
      throw new Error(`promote-thread: modelConfig not carried over: ${JSON.stringify(cfg)}`);
    }
    const rules = conversation.rootMessageThread.getAllRules();
    if (!rules.some((/** @type {any} */ r) => r.itemType === 'execute' && r.kind === 'glob' && r.value === 'env echo *')) {
      throw new Error(`promote-thread: execute permission rule not carried over: ${JSON.stringify(rules)}`);
    }
    const root = conversation.rootMessageThread.items;
    const user = root.find((/** @type {any} */ it) => it.get?.('type') === 'user');
    const assistant = root.find((/** @type {any} */ it) => it.get?.('type') === 'assistant');
    if (!user || !assistant) throw new Error('promote-thread: promoted items missing');
  }
};

/**
 * General Copy to… new tab path: copy a root selection into a new top-level tab,
 * leaving the source untouched.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const copyItemsToNewTabTest = {
  name: 'copy-items-to-new-tab',
  description: 'Copy selection to a new conversation using the cross-doc copy primitive',
  fixture: 'unit-test-fixture',
  llmResponses: [textResponse('Reply A.')],
  operations: [
    { type: 'send-message', message: 'Message A' },
    { type: 'copy-items-new-tab', from: 'root', indices: [1, 2], name: 'Copied selection' }
  ],
  customAssertions: (conversation) => {
    const items = conversation.rootMessageThread.items;
    if (!items.some((/** @type {any} */ it) => it.get?.('type') === 'user' && it.get('content') === 'Message A')) {
      throw new Error('copy-items-to-new-tab: copied user message missing');
    }
    if (!items.some((/** @type {any} */ it) => it.get?.('type') === 'assistant' && it.get('content') === 'Reply A.')) {
      throw new Error('copy-items-to-new-tab: copied assistant missing');
    }
  }
};

/**
 * General Move to… new tab path: copy to the new document and delete from the
 * source. This is intentionally a two-step cross-doc operation, not one undo
 * transaction.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const moveItemsToNewTabTest = {
  name: 'move-items-to-new-tab',
  description: 'Move selection to a new conversation using the cross-doc move primitive',
  fixture: 'unit-test-fixture',
  llmResponses: [textResponse('Reply A.')],
  operations: [
    { type: 'send-message', message: 'Message A' },
    { type: 'move-items-new-tab', from: 'root', indices: [1, 2], name: 'Moved selection' }
  ],
  customAssertions: (conversation) => {
    const items = conversation.rootMessageThread.items;
    if (items.length !== 3) throw new Error(`move-items-to-new-tab: promoted tab expected 3 items, got ${items.length}`);
    if (!items.some((/** @type {any} */ it) => it.get?.('type') === 'user' && it.get('content') === 'Message A')) {
      throw new Error('move-items-to-new-tab: moved user message missing');
    }
    if (!items.some((/** @type {any} */ it) => it.get?.('type') === 'assistant' && it.get('content') === 'Reply A.')) {
      throw new Error('move-items-to-new-tab: moved assistant missing');
    }
  }
};

export const tests = [
  moveItemsRootToThreadTest,
  copyItemsRootToThreadTest,
  moveItemsUndoTest,
  moveThenExpandRoundTripTest,
  expandThreadUndoTest,
  promoteThreadToNewTabTest,
  copyItemsToNewTabTest,
  moveItemsToNewTabTest
];
