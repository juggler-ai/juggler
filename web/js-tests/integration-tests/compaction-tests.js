//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration tests: compaction
 *
 * /compact collapses the *entire* conversation into a single sub-thread.
 * The worker's strategy loop summarises the thread via `return_result`,
 * after which the parent conversation contains one thread tile whose
 * `result` is the summary. There is no retention window — undo restores
 * the original.
 * @module integration-tests/compaction-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';

const SUMMARY_TEXT = 'Summary: The conversation discussed reading and running commands.';
const COMPACT_UP_TO_SUMMARY = 'Summary: Messages 1-3 discussed initial setup.';

/**
 * @param {string} result
 * @returns {import('../utilities/integration-test-runner.js').MockResponse} A return_result tool response.
 */
function returnResultResponse(result) {
  return toolUseResponse('tu-summary', 'return_result', { result }, undefined);
}

/**
 * Basic compaction — every content item is moved into the thread and the
 * worker writes a summary. The parent ends with exactly one thread tile.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const compactionBasicTest = {
  name: 'compaction-basic',
  description: 'Compaction moves the entire conversation into one summary thread',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Response 1.'),
    textResponse('Response 2.'),
    textResponse('Response 3.'),
    returnResultResponse(SUMMARY_TEXT)
  ],

  operations: [
    { type: 'send-message', message: 'Message 1' },
    { type: 'send-message', message: 'Message 2' },
    { type: 'send-message', message: 'Message 3' },
    { type: 'run-command', command: 'compact' },
    { type: 'wait-for-state', condition: { hasCompactionBarrier: true } }
  ],

  // Context items (system-prompt and similar) stay at the parent level —
  // compaction only sweeps conversational content into the thread, so the
  // parent retains its working context across compactions. The thread
  // itself must contain every original message (no orphans left at the
  // parent) — only the parent's items field is asserted here; the thread's
  // nested item list is asserted separately below to make the failure
  // mode visible.
  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      {
        type: 'thread',
        result: SUMMARY_TEXT,
        boundedCompaction: true,
        compactionPromptItemId: '$ITEM_3',
        itemId: '$ITEM_2'
      }
    ]
  }
};

/**
 * compactUpTo() — context-menu-triggered partial compaction. This path is
 * unchanged by the refactor (the helper still takes an explicit index).
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const compactionUpToTest = {
  name: 'compaction-up-to',
  description: 'compactUpTo() creates a thread covering the first N items',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Response 1.'),
    textResponse('Response 2.'),
    textResponse('Response 3.'),
    textResponse('Response 4.'),
    textResponse('Response 5.'),
    returnResultResponse(COMPACT_UP_TO_SUMMARY)
  ],

  operations: [
    { type: 'send-message', message: 'Message 1' },
    { type: 'send-message', message: 'Message 2' },
    { type: 'send-message', message: 'Message 3' },
    { type: 'send-message', message: 'Message 4' },
    { type: 'send-message', message: 'Message 5' },
    { type: 'compact-up-to', index: 7 },
    { type: 'wait-for-state', condition: { hasCompactionBarrier: true } }
  ],

  expectedDocument: {
    items: [
      { type: 'thread', result: COMPACT_UP_TO_SUMMARY, itemId: '$ITEM_1' },
      { type: 'user', content: 'Message 4' },
      { type: 'assistant', content: 'Response 4.' },
      { type: 'user', content: 'Message 5' },
      { type: 'assistant', content: 'Response 5.' }
    ]
  }
};

/**
 * Compaction must sweep every conversational message type into the thread,
 * not only user/assistant/tool-action. A long conversation contains
 * `thinking` blocks (and may contain `system-reminder`/`error`/`guidance`
 * items); leaving any of them at the parent level is a data-shape bug — the
 * parent should reduce to one thread tile + the original context items.
 *
 * RED test: with the previous allowlist filter (`user, assistant,
 * tool-action, thread, error`), the assistant's thinking block was a
 * separate top-level item with `type: 'thinking'` and stayed at the parent
 * after compact. The fix expands the filter to MESSAGE_TYPES.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const compactionSweepsThinkingTest = {
  name: 'compaction-sweeps-thinking',
  description: 'Compaction moves thinking blocks into the thread alongside user/assistant',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // Assistant turn that streams a thinking block then a text answer.
    {
      blocks: [
        { type: 'thinking', thinking: 'Considering options.' },
        { type: 'text', content: 'Answer 1.' }
      ],
      stopReason: 'end_turn',
      inputTokens: 0, outputTokens: 0, cachedTokens: 0
    },
    // Second assistant turn (no thinking).
    textResponse('Answer 2.'),
    // Summary turn for the compaction thread.
    returnResultResponse('Summary covers thinking + answers.')
  ],

  operations: [
    { type: 'send-message', message: 'Question 1' },
    { type: 'send-message', message: 'Question 2' },
    { type: 'run-command', command: 'compact' },
    { type: 'wait-for-state', condition: { hasCompactionBarrier: true } }
  ],

  // After compaction the parent must contain only the system-prompt context
  // item + the summary thread — no leftover thinking block.
  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'thread', result: 'Summary covers thinking + answers.', itemId: '$ITEM_2' }
    ]
  }
};

/**
 * Pressing undo right after a compaction completes must restore the parent
 * conversation to its pre-compact state — not just revert one operation and
 * then have the worker's strategy loop re-trigger off the restored
 * `needsStrategyRun` flag.
 *
 * RED: without the "cancel running loops before applying undo" guard, the
 * worker's checkForNewThreads sees the restored thread + needsStrategyRun
 * after undo and immediately re-runs the strategy loop, writing the result
 * again — the user perceives undo as a no-op. The fix: handleUndo cancels
 * in-flight processing first.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const compactionUndoRestoresConversationTest = {
  name: 'compaction-undo-restores',
  description: 'Undo after compaction restores the pre-compact conversation',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Response 1.'),
    textResponse('Response 2.'),
    returnResultResponse('Summary.')
  ],

  operations: [
    { type: 'send-message', message: 'Message 1' },
    { type: 'send-message', message: 'Message 2' },
    { type: 'run-command', command: 'compact' },
    { type: 'wait-for-state', condition: { hasCompactionBarrier: true } },
    { type: 'undo' },
    // After undo the conversation must be back to the original messages
    // AND must stay that way — the strategy loop must not re-trigger.
    { type: 'wait-for-state', condition: { hasThreadItem: false } }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Message 1' },
      { type: 'assistant', content: 'Response 1.' },
      { type: 'user', content: 'Message 2' },
      { type: 'assistant', content: 'Response 2.' }
    ]
  }
};

/**
 * Compaction must sweep EVERY conversational item — first and last
 * included — into the thread. The user-observed bug was that a long
 * conversation compacted into:
 *   [system-prompt, FIRST_msg, thread, LAST_msg]
 * instead of the expected:
 *   [system-prompt, thread]
 * with the thread containing every message in order.
 *
 * This test asserts the FULL document shape — both the parent's items and
 * the thread's nested items — so the "X items left orphaned at parent /
 * thread is missing X" failure mode is impossible to slip past.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const compactionSweepsAllItemsTest = {
  name: 'compaction-sweeps-all-items',
  description: 'Compaction sweeps the first AND last messages into the thread, leaving none at parent',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Response 1.'),
    textResponse('Response 2.'),
    textResponse('Response 3.'),
    textResponse('Response 4.'),
    textResponse('Response 5.'),
    returnResultResponse('Summary of five turns.')
  ],

  operations: [
    { type: 'send-message', message: 'Message 1' },
    { type: 'send-message', message: 'Message 2' },
    { type: 'send-message', message: 'Message 3' },
    { type: 'send-message', message: 'Message 4' },
    { type: 'send-message', message: 'Message 5' },
    { type: 'run-command', command: 'compact' },
    { type: 'wait-for-state', condition: { hasCompactionBarrier: true } }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      {
        type: 'thread',
        result: 'Summary of five turns.',
        itemId: '$ITEM_2',
        items: [
          // Every original message — first and last included.
          { type: 'user', content: 'Message 1' },
          { type: 'assistant', content: 'Response 1.' },
          { type: 'user', content: 'Message 2' },
          { type: 'assistant', content: 'Response 2.' },
          { type: 'user', content: 'Message 3' },
          { type: 'assistant', content: 'Response 3.' },
          { type: 'user', content: 'Message 4' },
          { type: 'assistant', content: 'Response 4.' },
          { type: 'user', content: 'Message 5' },
          { type: 'assistant', content: 'Response 5.' },
          // Compaction plugin appends a user message asking for a
          // summary; the bounded reducer summarizes it with a hidden
          // call (no visible item), so the summary lives on the thread
          // tile's result — no meta-tool-result inside the thread.
          { type: 'user' }
        ]
      }
    ]
  }
};

/**
 * The user's bug: a long conversation with **tool calls** in it compacts
 * into [SP, FIRST_msg, thread, LAST_msg] instead of [SP, thread]. This
 * test reproduces the shape — assistant turns that emit a tool_use, with
 * the resulting tool-action items interleaving the user/assistant items.
 *
 * Asserts the FULL nested structure to surface "items left at parent" /
 * "items missing from thread" as a clear mismatch.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const compactionSweepsToolActionsTest = {
  name: 'compaction-sweeps-tool-actions',
  description: 'Long conversation with tool calls compacts without orphans',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'glob', { pattern: '**/*.go' }, 'Searching.'),
    textResponse('Found.'),
    toolUseResponse('call_2', 'glob', { pattern: '**/*.js' }, 'Searching JS.'),
    textResponse('Found JS.'),
    returnResultResponse('Summary including tool calls.')
  ],

  operations: [
    { type: 'send-message', message: 'Find Go files' },
    { type: 'send-message', message: 'Find JS files' },
    { type: 'run-command', command: 'compact' },
    { type: 'wait-for-state', condition: { hasCompactionBarrier: true } }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      {
        type: 'thread',
        result: 'Summary including tool calls.',
        itemId: '$ITEM_2',
        items: [
          { type: 'user', content: 'Find Go files' },
          { type: 'assistant', content: 'Searching.' },
          { type: 'tool-action', toolName: 'glob' },
          { type: 'assistant', content: 'Found.' },
          { type: 'user', content: 'Find JS files' },
          { type: 'assistant', content: 'Searching JS.' },
          { type: 'tool-action', toolName: 'glob' },
          { type: 'assistant', content: 'Found JS.' },
          // Compaction's summarization prompt; the bounded reducer
          // summarizes via a hidden call, so no meta-tool-result lands
          // inside the thread — the summary is the thread's result.
          { type: 'user' }
        ]
      }
    ]
  }
};

/**
 * The leading run of pinned file-content context items — the project's
 * ambient instruction files (CLAUDE.md / AGENTS.md / …) that the session
 * auto-loads at the top of every conversation — must STAY at the parent
 * across compaction. They are working context, not conversation history;
 * sweeping them into the summary thread would leave the parent without its
 * agents files after the summary lands.
 *
 * The summarization turn still sees them because the worker always sources
 * context items from the ROOT items array regardless of which thread it is
 * processing — so keeping the file at root is sufficient for the summary turn
 * to read it, and the prompt-cache prefix stays intact. No contextMode
 * plumbing is needed (and adding inherit here would wrongly prepend the
 * parent's message history as duplicate context).
 *
 * Asserts the FULL document shape: the parent keeps [system-prompt,
 * file-content, thread]; the leading file-content is NOT duplicated into the
 * thread; and the summarization turn still produces its result.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const compactionPreservesLeadingAgentsFilesTest = {
  name: 'compaction-preserves-leading-agents-files',
  description: 'Leading file-content (agents) pins stay at the parent across compaction; the summary turn still sees them via root context',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Response 1.'),
    textResponse('Response 2.'),
    returnResultResponse('Summary of the work.')
  ],

  operations: [
    // Pin a file at the top of the conversation via an @-mention in the
    // first message — send-time mention parsing creates the file-content
    // item BEFORE the user message, so it lands leading (right after the
    // system prompt), exactly where addAIAssistantFiles seeds
    // CLAUDE.md/AGENTS.md at creation.
    { type: 'send-message', message: '@src/main.go Message 1' },
    { type: 'send-message', message: 'Message 2' },
    { type: 'run-command', command: 'compact' },
    { type: 'wait-for-state', condition: { hasCompactionBarrier: true } }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'file-content', itemId: '$ITEM_2' },
      {
        type: 'thread',
        result: 'Summary of the work.',
        itemId: '$ITEM_3',
        items: [
          // Only the conversation folds in — the leading agents file
          // is NOT among these.
          { type: 'user', content: '@src/main.go Message 1' },
          { type: 'assistant', content: 'Response 1.' },
          { type: 'user', content: 'Message 2' },
          { type: 'assistant', content: 'Response 2.' },
          { type: 'user' }
        ]
      }
    ]
  },

  customAssertions: (conversation) => {
    const root = conversation.rootMessageThread.items;
    const threadItem = root.find((/** @type {any} */ it) => it.get('type') === 'thread');
    if (!threadItem) {
      throw new Error('compaction-preserves-leading-agents-files: no thread item at parent');
    }
    // Exactly one leading file-content pin must remain at the parent.
    const parentFiles = conversation.rootMessageThread.contextItems.filter(
      (/** @type {any} */ i) => i.type === 'file-content'
    );
    if (parentFiles.length !== 1) {
      throw new Error(
        `compaction-preserves-leading-agents-files: expected 1 leading file-content at parent, found ${parentFiles.length}`
      );
    }
    // ...and it must NOT have leaked into the compaction thread.
    const nested = threadItem.get('items');
    const nestedArr = typeof nested?.toArray === 'function' ? nested.toArray() : [];
    if (nestedArr.some((/** @type {any} */ it) => it.get?.('type') === 'file-content')) {
      throw new Error(
        'compaction-preserves-leading-agents-files: a file-content item leaked into the compaction thread'
      );
    }
  }
};

/**
 * A file-content pin added *mid-conversation* (not part of the leading
 * agents-file run) is part of the work being folded up, so it MUST be swept
 * into the thread like any other item. This guards the heuristic's boundary:
 * only the leading run is preserved, not every file-content item.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const compactionSweepsMidConversationFileTest = {
  name: 'compaction-sweeps-mid-conversation-file',
  description: 'A file pinned mid-conversation is swept into the thread, not preserved at parent',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Response 1.'),
    textResponse('Response 2.'),
    returnResultResponse('Summary.')
  ],

  operations: [
    { type: 'send-message', message: 'Message 1' },
    // Pin AFTER the first turn via an @-mention — the file-content item is
    // appended after the existing user1/assistant1 items, so it is NOT in
    // the leading run and must be swept like any other content.
    { type: 'send-message', message: '@src/main.go Message 2' },
    { type: 'run-command', command: 'compact' },
    { type: 'wait-for-state', condition: { hasCompactionBarrier: true } }
  ],

  // Parent reduces to system-prompt + thread; the mid-conversation file pin
  // is gone from the parent (swept into the thread).
  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'thread', result: 'Summary.', itemId: '$ITEM_2' }
    ]
  },

  customAssertions: (conversation) => {
    const parentFiles = conversation.rootMessageThread.contextItems.filter(
      (/** @type {any} */ i) => i.type === 'file-content'
    );
    if (parentFiles.length !== 0) {
      throw new Error(
        `compaction-sweeps-mid-conversation-file: mid-conversation file should be swept, ` +
				`but ${parentFiles.length} file-content item(s) remain at parent`
      );
    }
  }
};

/**
 * Project memory (and any standing context item positioned AFTER it in the
 * leading run) must STAY at the parent across /compact — the user-reported bug
 * was that a compacted thread came back without the Project Memory block.
 *
 * The old leading-run predicate was `preventUserDeletion || file-content`.
 * Memory is neither: it carries no `preventUserDeletion` flag on its Y.Map
 * (only SYSTEM_1 does) and its type is `memory`, not `file-content`. So the old
 * predicate BOTH swept memory into the summary thread AND — by treating it as
 * the first conversational item — ended the leading run early, dropping any
 * agents file pinned after it too. The fix keys the run on "standing context
 * item" (has itemId, no toolUseId, not a conversational type), mirroring the
 * worker's GetContextItemIDsForThread.
 *
 * Setup seeds `.juggler/MEMORY.md` then creates a fresh conversation so memory
 * auto-instantiates onto root → [system-prompt, memory]. A file-content
 * (README) is then pinned before any message, landing in the leading run but
 * AFTER memory → [system-prompt, memory, file-content]. After /compact BOTH
 * must remain at the parent and NEITHER may leak into the thread.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const compactionPreservesMemoryTest = {
  name: 'compaction-preserves-memory',
  description: 'Project memory (and a standing item after it) stays at the parent across /compact',
  fixture: 'unit-test-fixture',
  pollutesFixtureRoot: true,

  setupFiles: {
    '.juggler/MEMORY.md': '# Memory\n\n- [2026-06-14] MEMORY_MARKER_ZZZ: build with make build\n'
  },

  llmResponses: [],

  operations: [
    // Fresh conversation created AFTER the memory file exists → memory seeds
    // onto root: [system-prompt, memory].
    {
      type: 'create-conversation',
      name: 'CompactMem',
      llmResponses: [
        textResponse('Response 1.'),
        textResponse('Response 2.'),
        returnResultResponse('Summary of the work.')
      ]
    },
    // Pin a file onto root BEFORE any message → leading run, AFTER memory:
    // [system-prompt, memory, file-content(README)].
    { type: 'add-context-item-to-root' },
    { type: 'send-message', message: 'Message 1' },
    { type: 'send-message', message: 'Message 2' },
    { type: 'run-command', command: 'compact' },
    { type: 'wait-for-state', condition: { hasCompactionBarrier: true } }
  ],

  // No expectedDocument: seeded memory + README shift item IDs; the structural
  // guarantees are asserted precisely below.
  customAssertions: (conversation) => {
    const root = conversation.rootMessageThread.items;
    const threadItem = root.find((/** @type {any} */ it) => it.get('type') === 'thread');
    if (!threadItem) {
      throw new Error('compaction-preserves-memory: no thread item at parent (compaction did not run)');
    }
    if (threadItem.get('result') !== 'Summary of the work.') {
      throw new Error(
        `compaction-preserves-memory: thread.result = ${JSON.stringify(threadItem.get('result'))}, ` +
					'want "Summary of the work." — compaction did not complete'
      );
    }

    // Both standing items must remain at the parent.
    const parentCtx = conversation.rootMessageThread.contextItems;
    const parentMemory = parentCtx.filter((/** @type {any} */ i) => i.type === 'memory');
    const parentFiles = parentCtx.filter((/** @type {any} */ i) => i.type === 'file-content');
    if (parentMemory.length !== 1) {
      throw new Error(
        `compaction-preserves-memory: expected 1 memory item at parent after /compact, found ${parentMemory.length} ` +
					'— memory was swept into the summary thread (the reported bug)'
      );
    }
    if (parentFiles.length !== 1) {
      throw new Error(
        `compaction-preserves-memory: expected 1 leading file-content at parent, found ${parentFiles.length} ` +
					'— the standing item positioned after memory was dropped'
      );
    }

    // ...and NEITHER may have leaked into the compaction thread.
    const nested = threadItem.get('items');
    const nestedArr = typeof nested?.toArray === 'function' ? nested.toArray() : [];
    const leaked = nestedArr.filter((/** @type {any} */ it) => {
      const t = it.get?.('type');
      return t === 'memory' || t === 'file-content';
    });
    if (leaked.length !== 0) {
      throw new Error(
        `compaction-preserves-memory: ${leaked.length} standing item(s) leaked into the compaction thread ` +
					`(types: ${leaked.map((/** @type {any} */ it) => it.get?.('type')).join(', ')})`
      );
    }
  }
};

/**
 * /new opens a fresh, empty conversation in a new tab and switches to it,
 * leaving the source conversation intact. Asserts:
 *   (i)   the active conversation after /new has no conversation turns,
 *   (ii)  the source conversation (with its message) still exists, and
 *   (iii) the new tab is the visible conversation.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const newConversationTest = {
  name: 'new-conversation-command',
  description: '/new opens a fresh empty conversation in a new tab and switches to it',
  fixture: 'unit-test-fixture',

  llmResponses: [textResponse('Response 1.')],

  operations: [
    { type: 'send-message', message: 'Message 1' },
    { type: 'run-command', command: 'new' }
  ],

  // customAssertions only: the harness re-tracks the newly-activated tab, so
  // `conversation` is the fresh empty conversation. The source tab is also in
  // the DOM, so a shared expectedItems/DOM assertion would be ambiguous.
  customAssertions: (conversation) => {
    const session = conversation.session;

    // (i) The new tab carries no conversation turns.
    const hasTurns = conversation.rootMessageThread.items.some((/** @type {any} */ it) => {
      const t = it.get('type');
      return t === 'user' || t === 'assistant';
    });
    if (hasTurns) {
      throw new Error('new-conversation-command: new tab should have no conversation turns');
    }

    // (ii) The source conversation with "Message 1" still exists, untouched.
    const sourceFound = [...session.conversations.values()].some((/** @type {any} */ conv) => {
      if (conv.id === conversation.id) return false;
      return conv.rootMessageThread.items.some((/** @type {any} */ it) =>
        it.get('type') === 'user' && it.get('content') === 'Message 1');
    });
    if (!sourceFound) {
      throw new Error('new-conversation-command: source conversation with "Message 1" not found');
    }

    // (iii) The new tab is the visible conversation.
    if (session.visibleConversationId !== conversation.id) {
      throw new Error('new-conversation-command: new tab should be the visible conversation');
    }
  }
};

/**
 * /duplicate clones the current conversation into a new tab placed directly
 * after the source, then switches to the clone. The source is left intact.
 * This is the building block /compact-new used to be (duplicate + compact).
 * Asserts:
 *   (i)   the active conversation is a faithful clone of the source,
 *   (ii)  the untouched source still exists separately,
 *   (iii) the clone sits directly after its source in tab order, and
 *   (iv)  the clone is the visible conversation.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
// Faithful-copy shape shared by both source and clone. Matching by content (not
// id) keeps the assertion robust against sibling lanes in the shared pool, and
// lets `settleUntil` fence on the clone having fully mirrored the source.
const DUPLICATE_EXPECTED_CONTENT = [
  { type: 'system-prompt' },
  { type: 'user', content: 'Message 1' },
  { type: 'assistant', content: 'Response 1.' },
  { type: 'user', content: 'Message 2' },
  { type: 'assistant', content: 'Response 2.' }
];
  /**
   * @param {any} conv
   * @returns {boolean} Whether the conversation's root items match the expected clone content.
   */
function duplicateCopyMatches(conv) {
  if (!conv) return false;
  const items = conv.rootMessageThread.items;
  if (items.length !== DUPLICATE_EXPECTED_CONTENT.length) return false;
  return DUPLICATE_EXPECTED_CONTENT.every((want, i) => {
    const got = items[i];
    return got.get('type') === want.type &&
			(want.content === undefined || got.get('content') === want.content);
  });
}

export const duplicateConversationTest = {
  name: 'duplicate-conversation-command',
  description: '/duplicate clones the conversation into a new tab after the source and switches to it',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Response 1.'),
    textResponse('Response 2.')
  ],

  operations: [
    { type: 'send-message', message: 'Message 1' },
    { type: 'send-message', message: 'Message 2' },
    { type: 'run-command', command: 'duplicate' }
  ],

  // Settle: after `run-command duplicate` the clone is re-tracked immediately,
  // but its mirrored Yjs doc syncs into this viewer a beat later — under pool
  // load a one-shot check can race an empty/partial clone doc. Fence on the
  // clone having fully mirrored the source before asserting. Side-effect-free.
  settleUntil: (conversation) => duplicateCopyMatches(conversation),

  customAssertions: (conversation) => {
    const session = conversation.session;

    // (i) The active conversation (the clone, re-tracked by the harness)
    //     mirrors the source content.
    if (!duplicateCopyMatches(conversation)) {
      throw new Error('duplicate-conversation-command: clone should mirror the source content');
    }

    const ids = [...session.conversations.keys()];

    // (ii) The untouched source still exists as a separate conversation.
    const sourceId = ids.find(id => id !== conversation.id && duplicateCopyMatches(session.getConversation(id)));
    if (!sourceId) {
      throw new Error(
        `duplicate-conversation-command: untouched source conversation not found (order: ${JSON.stringify(ids)})`
      );
    }

    // (iii) The clone sits directly after its source in tab order.
    const sourceIndex = ids.indexOf(sourceId);
    const cloneIndex = ids.indexOf(conversation.id);
    if (cloneIndex !== sourceIndex + 1) {
      throw new Error(
        'duplicate-conversation-command: clone must sit directly after its source ' +
				`(cloneIndex=${cloneIndex}, sourceIndex=${sourceIndex}, order: ${JSON.stringify(ids)})`
      );
    }

    // (iv) The clone is the visible conversation.
    if (session.visibleConversationId !== conversation.id) {
      throw new Error('duplicate-conversation-command: clone should be the visible conversation');
    }
  }
};

/**
 * RED test for the cancel-before-mutate architectural fix.
 *
 * Scenario: a turn is in flight (LLM mid-stream, paused at the mock barrier
 * exactly as a real long-running tool action would leave the worker busy).
 * The user fires `/compact` mid-flight. The expected architectural behaviour
 * is:
 *
 *   1. `SlashCommandHandler` notices `/compact` is a `mutatesConversation`
 *      command and the conversation is processing, so it awaits
 *      `conversation.cancelAndSettle()` before invoking the command.
 *   2. `cancelAndSettle()` cancels the worker (the paused mock is abandoned),
 *      cancels any running actions, and resolves only once everything is idle.
 *   3. `/compact` then snapshots a *stable* item list and runs the normal
 *      compaction path. The sub-thread's strategy loop produces the summary.
 *
 * Before the fix `/compact` runs while processing is still live: it snapshots
 * mid-flight items (including the partial assistant text that the worker is
 * about to keep streaming into), moves them into a sub-thread, and leaves the
 * original turn's processing state dangling — the user sees a sub-thread item
 * stuck `state: 'running'` and the parent never settles cleanly until they
 * hit Escape.
 *
 * Asserts the full document shape AND that no item anywhere in the document
 * (parent or nested thread) carries `state: 'running'` once the test settles.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const compactionCancelsRunningTurnTest = {
  name: 'compaction-cancels-running-turn',
  description: '/compact mid-flight cancels the live turn before snapshotting; no item is left stuck running',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // First mock: streams a partial response then pauses, simulating a
    // live in-flight turn at the moment /compact is fired.
    textResponse('Partial response cut short by /compact.', { pauseBeforeReturn: true }),
    // Second mock: the compaction sub-thread's summarisation reply.
    returnResultResponse('Summary after mid-flight compaction.')
  ],

  operations: [
    { type: 'send-message-no-wait', message: 'Message 1' },
    { type: 'wait-for-mock-paused' },
    // Fire /compact while the worker is paused mid-turn. With the fix this
    // awaits cancelAndSettle() before mutating; without it, snapshot races
    // the live turn and leaves orphaned running state.
    { type: 'run-command', command: 'compact' },
    { type: 'wait-for-state', condition: { hasCompactionBarrier: true } }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'thread', result: 'Summary after mid-flight compaction.', itemId: '$ITEM_2' }
    ]
  },

  customAssertions: (conversation) => {
    /**
     * @param {any[]} items
     * @param {string} path
     */
    const assertNoRunning = (items, path) => {
      for (let i = 0; i < items.length; i++) {
        const it = items[i];
        const state = it.get?.('state');
        if (state === 'running') {
          throw new Error(
            `compaction-cancels-running-turn: item ${path}[${i}] (type=${it.get?.('type')}) ` +
						`left in state='running' after settle — the cancel-before-mutate invariant was violated`
          );
        }
        // Recurse into thread sub-items.
        if (it.get?.('type') === 'thread') {
          const sub = it.get?.('items');
          if (sub && typeof sub.toArray === 'function') {
            assertNoRunning(sub.toArray(), `${path}[${i}].items`);
          }
        }
      }
    };
    assertNoRunning(conversation.rootMessageThread.items, 'root');
  }
};

/**
 * The summarization user message that compaction appends inside the thread
 * must be a first-class, selectable/deletable item — exactly like any other
 * user message. The user-observed bug: navigating into the compaction thread,
 * the "Summarize the preceding N messages…" message could not be selected (so
 * it couldn't be deleted). Root cause: compaction built the message via
 * `createUserMessage` and seeded it straight into the thread's Y.Array,
 * bypassing `addEvent` — so it never got an `itemId`. The renderer then set
 * `message-id=""`, and selection filters out empty ids. No conversation item
 * should be above the law.
 *
 * Asserts every item in the thread (the swept snapshots AND the appended
 * summary message) carries a non-empty itemId.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const compactionSummaryMessageSelectableTest = {
  name: 'compaction-summary-message-selectable',
  description: 'The appended summary user message gets an itemId so it is selectable/deletable like any message',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Response 1.'),
    textResponse('Response 2.'),
    returnResultResponse('Summary.')
  ],

  operations: [
    { type: 'send-message', message: 'Message 1' },
    { type: 'send-message', message: 'Message 2' },
    { type: 'run-command', command: 'compact' },
    { type: 'wait-for-state', condition: { hasCompactionBarrier: true } }
  ],

  customAssertions: (conversation) => {
    const root = conversation.rootMessageThread.items;
    const threadItem = root.find((/** @type {any} */ it) => it.get('type') === 'thread');
    if (!threadItem) {
      throw new Error('compaction-summary-message-selectable: no thread item at parent');
    }
    const nested = threadItem.get('items');
    const items = typeof nested?.toArray === 'function' ? nested.toArray() : [];
    if (items.length === 0) {
      throw new Error('compaction-summary-message-selectable: thread has no nested items');
    }
    // EVERY item in the thread must have a non-empty itemId — none above the law.
    items.forEach((/** @type {any} */ it, /** @type {number} */ i) => {
      const id = it.get?.('itemId');
      if (!id || id === '') {
        throw new Error(
          `compaction-summary-message-selectable: thread item [${i}] ` +
					`(type=${it.get?.('type')}) has no itemId — it would render with ` +
					'message-id="" and be unselectable/undeletable'
        );
      }
    });
  }
};

/**
 * The user's report: the model "always replies with the summary in an assistant
 * message" instead of calling return_result. Compaction must STILL produce a
 * clean single thread tile whose `result` is that summary — the writeThreadResult
 * fallback turns the trailing assistant text into the thread result.
 *
 * Models frequently treat "summarize, then call return_result" as a plain
 * answer-in-text request and never emit the tool call. The compaction outcome
 * must not depend on the model's cooperation.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const compactionViaPlainTextReplyTest = {
  name: 'compaction-plain-text-reply',
  description: 'Compaction still yields a single summary thread when the model replies in text instead of return_result',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Response 1.'),
    textResponse('Response 2.'),
    // Summarization turn: model answers in plain text, NEVER calls return_result.
    textResponse('Summary: discussed messages one and two.')
  ],

  operations: [
    { type: 'send-message', message: 'Message 1' },
    { type: 'send-message', message: 'Message 2' },
    { type: 'run-command', command: 'compact' },
    { type: 'wait-for-state', condition: { hasCompactionBarrier: true } }
  ],

  // Parent collapses to exactly one thread tile, result taken from the text reply.
  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'thread', result: 'Summary: discussed messages one and two.', itemId: '$ITEM_2' }
    ]
  }
};

/**
 * The /compact plugin must declare the generic forced-tool directive on its
 * summary thread so the worker forces the model to call return_result rather
 * than persuading it via prompt. This asserts the plugin sets the `forceTool`
 * Yjs field (the framework mechanism) — it is not an app-level special case.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const compactionForcesReturnResultToolTest = {
  name: 'compaction-forces-return-result-tool',
  description: 'Compaction sets the generic forceTool=return_result directive on its summary thread',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Response 1.'),
    textResponse('Response 2.'),
    returnResultResponse('Summary of two turns.')
  ],

  operations: [
    { type: 'send-message', message: 'Message 1' },
    { type: 'send-message', message: 'Message 2' },
    { type: 'run-command', command: 'compact' },
    { type: 'wait-for-state', condition: { hasCompactionBarrier: true } }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'thread', result: 'Summary of two turns.', itemId: '$ITEM_2' }
    ]
  },

  customAssertions: (conversation) => {
    const root = conversation.rootMessageThread.items;
    const threadItem = root.find((/** @type {any} */ it) => it.get('type') === 'thread');
    if (!threadItem) {
      throw new Error('compaction-forces-return-result-tool: no thread item at parent');
    }
    const forceTool = threadItem.get('forceTool');
    if (forceTool !== 'return_result') {
      throw new Error(
        `compaction-forces-return-result-tool: thread.forceTool = ${JSON.stringify(forceTool)}, ` +
				'want "return_result" — the /compact plugin must set the generic forced-tool directive'
      );
    }
  }
};

export const tests = [
  compactionBasicTest,
  compactionViaPlainTextReplyTest,
  compactionForcesReturnResultToolTest,
  compactionSummaryMessageSelectableTest,
  compactionUpToTest,
  compactionSweepsThinkingTest,
  compactionUndoRestoresConversationTest,
  compactionSweepsAllItemsTest,
  compactionSweepsToolActionsTest,
  compactionPreservesLeadingAgentsFilesTest,
  compactionSweepsMidConversationFileTest,
  compactionPreservesMemoryTest,
  newConversationTest,
  duplicateConversationTest,
  compactionCancelsRunningTurnTest
];
