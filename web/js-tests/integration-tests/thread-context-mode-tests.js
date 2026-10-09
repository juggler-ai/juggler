//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Thread Context
 *
 * Threads are always isolated: a sub-thread gets only its own prompt in its
 * LLM messages and never sees the parent conversation history. These tests
 * validate that isolation, including a sub-thread-only context item rendering
 * into the sub-thread's turn context.
 * @module integration-tests/thread-context-mode-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';

// ============================================================================
// TEST DEFINITIONS
// ============================================================================

/**
 * Isolated context: a thread sees only its own prompt, not the parent history.
 *
 * Mock response order (single send-message, like thread-lifecycle-single):
 *   1. Root: create_thread
 *   2. Thread: text reply
 *   3. Root: text continuation
 *
 * Asserts:
 *   - Thread context snapshot has only 1 user message ("Execute the task")
 *   - Thread context snapshot does NOT contain parent content ("Start work")
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadIsolatedContextTest = {
  name: 'thread-isolated-context',
  description: 'Isolated context: thread sees only its own prompt',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', {
      goal: 'Do task',
      prompt: 'Execute the task'
    }),
    textResponse('Task done'),
    textResponse('Thread finished, moving on.')
  ],

  operations: [
    { type: 'send-message', message: 'Start work' },
    {
      type: 'validate-thread-context',
      threadIndex: 0,
      expectedMessageCount: 1,
      expectedMessages: [
        { role: 'user', contentIncludes: 'Execute the task' }
      ],
      unexpectedContent: ['Start work']
    }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Start work' },
      { type: 'thread', itemId: '$ITEM_3', result: 'Task done' },
      { type: 'assistant', content: 'Thread finished, moving on.' }
    ]
  }
};

/**
 * Regression (Layer 3): a context item that lives ONLY in a sub-thread is
 * rendered into that sub-thread's LLM turn context. Exercises the full path:
 * the Go worker must request the sub-thread's item ids (GetContextItemIDsForThread)
 * and a client that actually holds the sub-thread must answer the render request.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadLocalContextItemRenderedTest = {
  name: 'thread-local-context-item-rendered',
  description: 'A sub-thread-only context item is rendered into that sub-thread turn context',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', {
      goal: 'Work in a thread',
      prompt: 'Do initial work'
    }),
    textResponse('Initial work done'),
    textResponse('Thread finished.'),
    textResponse('Saw the fixture readme.')
  ],

  operations: [
    { type: 'send-message', message: 'Start work' },
    { type: 'add-context-item-to-sub-thread' },
    { type: 'send-thread-message', message: 'Check the readme' },
    {
      type: 'validate-thread-context',
      threadIndex: 0,
      expectedContent: ['A simple test fixture used for integration tests.']
    }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Start work' },
      { type: 'thread', itemId: '$ITEM_3' },
      { type: 'assistant', content: 'Thread finished.' },
      // The run the user started by typing into the child reports to a receipt
      // of its own: the root has already read the answer to the call it made.
      { type: 'thread' }
    ]
  }
};

/**
 * Regression: a sub-thread must NOT inherit the parent/root conversation's
 * context items. Only the basic starting items — system prompt, agents files,
 * project memory — cross the thread boundary; everything else the parent
 * accumulated (files it read, plans, tool outputs) stays out of the child.
 *
 * Setup:
 *   1. Root turn: user "Start work" → assistant text (no thread yet).
 *   2. Pin a plain file-content (README) onto ROOT, mid-conversation. It is
 *      NOT preventUserDeletion and NOT a leading agents-file, so it is a
 *      non-foundational item that must not leak.
 *   3. Root turn: user "Delegate now" → create_thread → sub-thread runs.
 *
 * The sub-thread's first-turn blob must contain its own prompt ("Do the sub
 * task") but MUST NOT contain the README's content — the root file it never
 * asked for. Before the fix, GetContextItemIDsForThread collected every root
 * item for a sub-thread turn, so the README leaked into the child's prompt.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadDoesNotInheritRootContextTest = {
  name: 'thread-does-not-inherit-root-context',
  description: 'A non-foundational root context item does NOT leak into a sub-thread turn',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Working on it.'),
    toolUseResponse('call_1', 'create_thread', {
      goal: 'Do task',
      prompt: 'Do the sub task'
    }),
    textResponse('Sub done'),
    textResponse('Thread finished.')
  ],

  operations: [
    { type: 'send-message', message: 'Start work' },
    { type: 'add-context-item-to-root' },
    { type: 'send-message', message: 'Delegate now' },
    {
      type: 'validate-thread-context',
      threadIndex: 0,
      expectedMessages: [
        { role: 'user', contentIncludes: 'Do the sub task' }
      ],
      unexpectedContent: ['A simple test fixture used for integration tests.']
    }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Start work' },
      { type: 'assistant', content: 'Working on it.' },
      { type: 'file-content', itemId: '$ITEM_4' },
      { type: 'user', content: 'Delegate now' },
      { type: 'thread', itemId: '$ITEM_6', result: 'Sub done' },
      { type: 'assistant', content: 'Thread finished.' }
    ]
  }
};

/**
 * Regression (the OTHER half of isolation): a sub-thread must still INHERIT the
 * basic starting context every thread begins with — the system prompt, the
 * project's agents files (CLAUDE.md / AGENTS.md …), and project memory. The
 * previous isolation fix keyed "foundational" on the `preventUserDeletion` Y.Map
 * flag, but only the system-prompt placeholder actually carries that flag:
 * `addContextItem` never writes it, so the memory item (and any file-content
 * pinned after it) fell outside the leading run and was dropped from the
 * sub-thread turn. Result: the LLM's sub-thread saw the system prompt but no
 * agents file and no memory.
 *
 * Setup seeds a real project layout — CLAUDE.md on disk + `.juggler/MEMORY.md` —
 * then creates a fresh conversation so both auto-seed onto root
 * ([system-prompt, file-content(CLAUDE.md), memory, …]). The LLM then spawns a
 * sub-thread. The sub-thread's first-turn blob (systemPrompt + messages) MUST
 * contain all three foundational markers.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadInheritsFoundationalContextTest = {
  name: 'thread-inherits-foundational-context',
  description: 'An LLM-created sub-thread turn sees the system prompt, agents file, and project memory',
  fixture: 'unit-test-fixture',
  needsExclusiveRun: true,

  setupFiles: {
    'CLAUDE.md': '# Agent Instructions\n\nAGENTFILE_MARKER_ZZZ: follow the house style.\n',
    '.juggler/MEMORY.md': '# Memory\n\n- [2026-06-14] MEMORY_MARKER_ZZZ: build with make build\n'
  },

  llmResponses: [],

  operations: [
    // Created AFTER the files exist so addAIAssistantFiles + seedAutoContextItems
    // seed CLAUDE.md and memory onto root. Per-conversation mock script drives
    // the LLM to spawn a sub-thread.
    {
      type: 'create-conversation',
      name: 'FoundCtx',
      llmResponses: [
        toolUseResponse('call_1', 'create_thread', { goal: 'Do task', prompt: 'Do the sub task' }),
        textResponse('Sub done'),
        textResponse('Thread finished.')
      ]
    },
    { type: 'send-message', message: 'Start work' },
    {
      type: 'validate-thread-context',
      threadIndex: 0,
      expectedMessages: [
        { role: 'user', contentIncludes: 'Do the sub task' }
      ],
      expectedContent: [
        'Keeping intermediate work out of context', // system prompt (extension contribution)
        'AGENTFILE_MARKER_ZZZ',   // agents file (CLAUDE.md)
        'MEMORY_MARKER_ZZZ'       // project memory
      ]
    }
  ]
  // No expectedDocument: seeded CLAUDE.md + memory shift item IDs vs a bare
  // conversation, and the assertion above is on the sub-thread's LLM blob.
};

/**
 * The bug the happy-path test above cannot see. `threadInheritsFoundationalContextTest`
 * passes only because the seed order is [system-prompt, file-content(CLAUDE.md),
 * memory] — the agents file precedes memory, so it survives inside the leading
 * run. But the leading-run predicate was `preventUserDeletion || file-content`,
 * which means a NON-preventUserDeletion, non-file-content standing item (memory)
 * WRONGLY TERMINATES the run: any standing context item positioned after it is
 * dropped from what the sub-thread inherits.
 *
 * This test forces that order. It seeds `.juggler/MEMORY.md` but NO CLAUDE.md, so
 * a fresh conversation's root is [system-prompt, memory]. It then pins a
 * user-position agents-style file (README) onto root BEFORE any message — landing
 * it in the leading run but AFTER memory: [system-prompt, memory, file-content].
 * README content is user-position, so (unlike memory) it does NOT ride the
 * always-root system prompt — it appears in the sub-thread blob ONLY if its id is
 * actually inherited. With the buggy predicate the run ends at memory and README
 * is dropped; the fix (inherit the whole leading run of standing context items)
 * restores it.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadInheritsStandingContextAfterMemoryTest = {
  name: 'thread-inherits-standing-context-after-memory',
  description: 'A leading-run standing context item positioned after memory is still inherited by a sub-thread',
  fixture: 'unit-test-fixture',
  needsExclusiveRun: true,

  setupFiles: {
    '.juggler/MEMORY.md': '# Memory\n\n- [2026-06-14] MEMORY_MARKER_ZZZ: build with make build\n'
  },

  llmResponses: [],

  operations: [
    // Fresh conversation with memory seeded but no CLAUDE.md → root is
    // [system-prompt, memory].
    {
      type: 'create-conversation',
      name: 'AfterMem',
      llmResponses: [
        toolUseResponse('call_1', 'create_thread', { goal: 'Do task', prompt: 'Do the sub task' }),
        textResponse('Sub done'),
        textResponse('Thread finished.')
      ]
    },
    // Pin an agents-style file onto root BEFORE any message → leading run, but
    // AFTER memory: [system-prompt, memory, file-content(README)].
    { type: 'add-context-item-to-root' },
    { type: 'send-message', message: 'Start work' },
    {
      type: 'validate-thread-context',
      threadIndex: 0,
      expectedMessages: [
        { role: 'user', contentIncludes: 'Do the sub task' }
      ],
      expectedContent: [
        'MEMORY_MARKER_ZZZ',                                  // project memory
        'A simple test fixture used for integration tests.'  // leading agents-style file after memory
      ]
    }
  ]
};

// Export all tests
export const tests = [
  threadIsolatedContextTest,
  threadLocalContextItemRenderedTest,
  threadDoesNotInheritRootContextTest,
  threadInheritsFoundationalContextTest,
  threadInheritsStandingContextAfterMemoryTest
];
