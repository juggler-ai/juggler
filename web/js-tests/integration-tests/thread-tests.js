//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Threads
 *
 * Tests the thread lifecycle: /thread command, create_thread tool, and undo.
 * Completed thread (via compaction) is covered by compaction-tests.js.
 * @module integration-tests/thread-tests
 */

import { textResponse, toolUseResponse, multiToolResponse } from '../utilities/integration-test-runner.js';
import { tabFor } from '../utilities/conversation-tab-lookup.js';

// ============================================================================
// TEST DEFINITIONS
// ============================================================================

/**
 * /thread command creates an empty thread item.
 *
 * Items with itemId (registered in normalizer first pass):
 *   system-prompt=$ITEM_1, user=$ITEM_2, assistant=$ITEM_3, thread=$ITEM_4
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadCommandBasicTest = {
  name: 'thread-command-basic',
  description: '/thread command creates empty thread with given goal',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Hi there.')
  ],

  operations: [
    { type: 'send-message', message: 'Hello' },
    { type: 'run-command', command: 'thread', args: 'Research topic' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } }
  ],

  // A user-driven /thread stamps canSpawnThreads: true at creation, so its LLM may
  // itself call create_thread. Other threads omit it at birth and gain it only when
  // a human sends a message into them (promoteThreadSpawnCapable in the worker);
  // until then the worker withholds the tool (filterToolsForThread in llm_request.go).
  customAssertions: (conversation) => {
    const thread = conversation.rootMessageThread.items.find(
      (/** @type {any} */ it) => it.get?.('type') === 'thread'
    );
    if (!thread) throw new Error('thread-command-basic: thread item missing');
    if (thread.get('canSpawnThreads') !== true) {
      throw new Error(`thread-command-basic: expected canSpawnThreads=true on /thread Y.Map, got ${JSON.stringify(thread.get('canSpawnThreads'))}`);
    }
  },

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Hi there.' },
      { type: 'thread', itemId: '$ITEM_4' }
    ]
  }
};

/**
 * LLM uses create_thread tool to create a thread with nested prompt.
 *
 * The create_thread action has requiresApproval: false, so it auto-executes.
 * The result is formatted by the action executor (getSummary), not the raw return value.
 * The thread item is inserted during tool execution, before the continuation turn.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadCreateToolTest = {
  name: 'thread-create-tool',
  description: 'LLM create_thread tool creates thread with nested prompt, runs thread, returns result',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // Mock 1: Root LLM calls create_thread
    toolUseResponse('call_1', 'create_thread', { goal: 'Analyze code', prompt: 'Review the auth module' }),
    // Mock 2: Thread LLM replies; the run rests on it (consumed by nested loop)
    textResponse('Analysis complete'),
    // Mock 3: Root LLM continues after thread completes
    textResponse("I've created a thread to analyze the code.")
  ],

  operations: [
    { type: 'send-message', message: 'Analyze the auth module' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Analyze the auth module' },
      { type: 'thread', itemId: '$ITEM_3', result: 'Analysis complete' },
      { type: 'assistant', content: "I've created a thread to analyze the code." }
    ]
  }
};

/**
 * create_thread's optional `resultSpec` is the caller's return contract: what
 * the thread's last message must contain. It is structural, not advisory — stored on
 * the thread Y.Map at creation and appended to the thread's seed message so the
 * child acts on it. Omitting it is tolerated (other tests cover the no-spec
 * path); this asserts both when it IS supplied.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadResultSpecTest = {
  name: 'thread-result-spec',
  description: 'create_thread resultSpec is stored and appended to the seed message',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', {
      goal: 'Find usages',
      prompt: 'Locate every call site',
      resultSpec: 'each call site as file:line - caller'
    }),
    textResponse('Found 3 call sites'),
    textResponse('Done locating call sites.')
  ],

  operations: [
    { type: 'send-message', message: 'Where is this used?' },
    // The seed message carries BOTH the prompt and the appended return contract.
    {
      type: 'validate-thread-context',
      threadIndex: 0,
      expectedMessages: [
        { role: 'user', contentIncludes: 'Locate every call site' },
        { role: 'user', contentIncludes: 'Your last message is what the caller receives. It must contain: each call site as file:line - caller' }
      ]
    }
  ],

  customAssertions: (conversation) => {
    const thread = conversation.rootMessageThread.items.find(
      (/** @type {any} */ it) => it.get?.('type') === 'thread'
    );
    if (!thread) throw new Error('thread-result-spec: thread item missing');
    const spec = thread.get('resultSpec');
    if (spec !== 'each call site as file:line - caller') {
      throw new Error(`thread-result-spec: expected resultSpec stored on thread Y.Map, got ${JSON.stringify(spec)}`);
    }
  },

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Where is this used?' },
      { type: 'thread', itemId: '$ITEM_3', result: 'Found 3 call sites' },
      { type: 'assistant', content: 'Done locating call sites.' }
    ]
  }
};

/**
 * /thread with no args uses default goal "Thread".
 * Requires a prior message to initialize the worker (runCommand needs _waitForIdle).
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadDefaultGoalTest = {
  name: 'thread-default-goal',
  description: '/thread with no args creates thread with default goal',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Hi.')
  ],

  operations: [
    { type: 'send-message', message: 'Hello' },
    { type: 'run-command', command: 'thread' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Hi.' },
      { type: 'thread', itemId: '$ITEM_4' }
    ]
  }
};

/**
 * Undo reverts thread creation.
 *
 * Uses hasThreadItem condition instead of itemCount since transaction markers
 * make item counts non-obvious.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadUndoTest = {
  name: 'thread-undo',
  description: 'Undo reverts thread creation',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Response.')
  ],

  operations: [
    { type: 'send-message', message: 'Hello' },
    { type: 'run-command', command: 'thread', args: 'Test thread' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } },
    { type: 'undo' },
    { type: 'wait-for-state', condition: { hasThreadItem: false } }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Response.' }
    ]
  },

  expectedUndoState: { canUndo: true, canRedo: true }
};

/**
 * LLM error inside a thread does NOT leak into root items.
 *
 * Reproduces a bug where the Go worker correctly inserts the error into
 * the thread's Y.Array, but the JS WebSocket handler also added a duplicate
 * error to the root items (because the ErrorMessage had no threadItemId).
 *
 * Flow:
 * 1. Send message → LLM responds (consumes mock response 1)
 * 2. /thread creates a thread
 * 3. Send message to thread → mock responses exhausted → LLM error
 * 4. Assert: root items have NO error items (error is only in the thread via Yjs)
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadErrorNotInRootTest = {
  name: 'thread-error-not-in-root',
  description: 'LLM error in thread does not create error item in root',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Hi there.')
    // No response for thread message — will trigger "mock responses exhausted" error
  ],

  operations: [
    { type: 'send-message', message: 'Hello' },
    { type: 'run-command', command: 'thread', args: 'Test error routing' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } },
    { type: 'send-thread-message', message: 'Do something' }
  ],

  // Root items should contain NO error items: the error from the exhausted
  // mock is written by the Go worker into the thread's nested Y.Array only.
  // The thread itself stays OPEN — the worker never fabricates a result on a
  // thread's behalf. An error is just an item in the thread's history (here
  // the trailing nested item), so the thread carries no `result` and remains
  // resumable; the user reviews the error and resumes or closes it.
  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Hi there.' },
      { type: 'thread', itemId: '$ITEM_4', items: [
        // Sub-thread is seeded (lazily, on its first turn) with a cloned system
        // prompt (a fresh id — never the literal SYSTEM_1), then its own message,
        // then the error.
        { type: 'system-prompt' },
        { type: 'user', content: 'Do something' },
        { type: 'error' }
      ] }
    ]
  }
};

/**
 * Deleting a thread item removes it from root items (no stale "waiting" state).
 *
 * Reproduces a bug where after deleting a sub-thread, the parent conversation
 * still showed "Waiting for sub-thread" because footer state was not re-derived.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadDeleteClearsBusyStateTest = {
  name: 'thread-delete-clears-busy-state',
  description: 'Deleting a thread item removes it from root items',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Hi there.')
  ],

  operations: [
    { type: 'send-message', message: 'Hello' },
    { type: 'run-command', command: 'thread' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } },
    { type: 'delete-last-item' },
    { type: 'wait-for-state', condition: { hasThreadItem: false } }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Hi there.' }
    ]
  }
};

/**
 * Single thread: create_thread → thread LLM runs → comes to rest → parent continues.
 *
 * Mock response order (FIFO, consumed by recursive runStrategyLoop):
 *   1. Root: create_thread tool call
 *   2. Thread: text "Task done" — the run rests on it and returns it
 *   3. Root: text continuation after thread completes
 *
 * Verifies:
 *   - Thread Y.Map has result set
 *   - Root conversation continues after thread
 *
 * Note: create_thread is a sync tool — it creates a thread item directly,
 * not a tool-action. The thread item appears in the items array.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const singleThreadLifecycleTest = {
  name: 'thread-lifecycle-single',
  description: 'Single thread: create, run, come to rest, parent continues with result in context',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Do task', prompt: 'Execute the task' }),
    textResponse('Task done'),
    textResponse('Thread finished, moving on.')
  ],

  operations: [
    { type: 'send-message', message: 'Start work' },
    // Root's second LLM call (after thread completes) must include the thread result
    {
      type: 'validate-context-snapshot',
      expectedContent: ['Task done']
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
 * Two-level nested threads, rooted at an interactive thread that may spawn:
 *   Root → /thread("L1") → L1 → create_thread("L2") → L2 rests → L1 rests
 *
 * A model-created thread is a leaf until a person steers it, so the outer
 * thread is created explicitly before its turn asks for L2. A later root turn
 * verifies that L1's result reaches the parent context.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const nestedThreadLifecycleTest = {
  name: 'thread-lifecycle-nested',
  description: 'A spawn-capable interactive thread nests one child and returns its result to root',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_2', 'create_thread', { goal: 'Level 2', prompt: 'Start L2' }),
    textResponse('L2 result'),
    textResponse('L1 result'),
    textResponse('All done.')
  ],

  operations: [
    { type: 'run-command', command: 'thread', args: 'Level 1' },
    { type: 'send-thread-message', message: 'Start L1' },
    {
      type: 'validate-thread-context',
      threadIndex: 0,
      expectedContent: ['L2 result']
    },
    { type: 'send-message', message: 'Summarize the thread result' },
    {
      type: 'validate-context-snapshot',
      expectedContent: ['L1 result']
    }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'thread', itemId: '$ITEM_2', result: 'L1 result' },
      { type: 'user', content: 'Summarize the thread result' },
      { type: 'assistant', content: 'All done.' }
    ]
  },

  customAssertions: async (conversation) => {
    const level1 = findChildThreadByGoal(conversation, null, 'Level 1');
    if (level1.get('canSpawnThreads') !== true) {
      throw new Error('interactive Level 1 thread must be spawn-capable');
    }
    assertChildResult(conversation, level1.get('itemId'), 'Level 2', 'L2 result');
  }
};

/**
 * A thread whose turn ends on a plain assistant message settles its run on that
 * reply and writes it as the thread's summary — the answer is the message the
 * run came to rest on, with no tool involved.
 *
 * Writing a summary ends nothing. Uses a user-created /thread (the interactive
 * case): the thread column stays, with its composer, ready for the next thing
 * the user types.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadSettlesOnTrailingTextTest = {
  name: 'thread-settles-on-trailing-text',
  description: 'A thread ending in assistant text summarises with that reply and stays usable',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Hi.'),
    textResponse('I did the work.')
  ],

  operations: [
    { type: 'send-message', message: 'Hello' },
    { type: 'run-command', command: 'thread', args: 'Interactive' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } },
    { type: 'send-thread-message', message: 'Do work' },
    { type: 'wait-for-state', condition: { anyThreadResultIncludes: 'I did the work.' } }
  ],

  customAssertions: (conversation) => {
    const thread = conversation.rootMessageThread.items.find(
      (/** @type {any} */ it) => it.get?.('type') === 'thread'
    );
    if (!thread) throw new Error('thread-settles-on-trailing-text: thread item missing');
    if (thread.get('result') !== 'I did the work.') {
      throw new Error(
        `thread-settles-on-trailing-text: summary should be the reply the run rested on, got ${JSON.stringify(thread.get('result'))}`
      );
    }
    // A summary is not an ending: the thread column stays, composer and all.
    const tab = tabFor(conversation);
    const cols = Array.from(tab?.querySelectorAll('conversation-area.thread-column') || []);
    if (cols.length === 0) {
      throw new Error('thread-settles-on-trailing-text: thread column gone — a summary must not end the thread');
    }
  },

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Hi.' },
      { type: 'thread', itemId: '$ITEM_4' }
    ]
  }
};

/**
 * A completed thread must surface its result as a VISIBLE terminal element in
 * its own transcript (the open thread column) — not only on the parent tile.
 *
 * The summary IS the reply the run came to rest on, so the message standing at
 * the bottom of the column is the whole of it. The column must therefore show
 * that text exactly once: no synthesized `.thread-result-final` block repeating
 * the message immediately above it, and no `thinking-message` (the original WTF)
 * either.
 *
 * Mock response order:
 *   1. Root: create_thread (sub-thread carries no system-prompt of its own)
 *   2. Thread: text — the run rests on it and it becomes the summary
 *   3. Root: text continuation
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadResultVisibleInTranscriptTest = {
  name: 'thread-result-visible-in-transcript',
  description: 'Completed thread shows its result once in the open thread column, as the message it rested on',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Do task', prompt: 'Execute the task' }),
    textResponse('Final summary of the work.'),
    textResponse('Thread finished, moving on.')
  ],

  operations: [
    { type: 'send-message', message: 'Start work' },
    // Drill into the completed thread so its transcript renders in a column.
    { type: 'click-dom', selector: 'thread-message' }
  ],

  customAssertions: (conversation) => {
    const tab = tabFor(conversation);
    if (!tab) throw new Error('thread-result-visible: no tab element');
    const cols = Array.from(tab.querySelectorAll('conversation-area.thread-column'));
    if (cols.length === 0) {
      throw new Error('thread-result-visible: no open thread column after drilling into the thread');
    }
    const text = cols.map((/** @type {Element} */ c) => c.textContent || '').join('\n');
    if (!text.includes('Final summary of the work.')) {
      throw new Error(`thread-result-visible: open thread column missing the run's reply; got "${text.slice(0, 200)}"`);
    }
    const blocks = cols.flatMap((/** @type {Element} */ c) =>
      Array.from(c.querySelectorAll('.thread-result-final')));
    if (blocks.length > 0) {
      throw new Error('thread-result-visible: a Summary block repeats the message it sits under');
    }
    // Regression: the result must NOT render as a thinking bubble.
    const thinking = cols.flatMap((/** @type {Element} */ c) =>
      Array.from(c.querySelectorAll('thinking-message')));
    if (thinking.length > 0) {
      throw new Error('thread-result-visible: result rendered as a thinking-message (the original WTF)');
    }
  }
};

/**
 * A thread invoked again must never sit under a block presenting the PREVIOUS
 * run's answer as this run's conclusion. The block is derived at render time,
 * never stored as an item, so there is no cached state to leave stale — and a
 * thread that records runs answers its callers through those records, so it
 * renders no block at all.
 *
 * Flow: thread rests (summary written) → drill in → send it another message →
 * nothing claiming to be a conclusion while the column stays open.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadResultBlockFollowsTheRunTest = {
  name: 'thread-result-block-follows-the-run',
  description: 'A resumed run never sits under a block presenting the previous run\'s answer',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Quick task', prompt: 'Do it' }),
    textResponse('Done working.'),
    textResponse('All done.'),
    // The resumed run: held at the mock barrier so the assertion runs while it
    // is genuinely in flight.
    textResponse('Second pass done.', { pauseBeforeReturn: true })
  ],

  operations: [
    { type: 'send-message', message: 'Go' },
    { type: 'wait-for-state', condition: { completedThreadCount: 1 } },
    // Drill into the settled thread so its column is rendered and stays open.
    { type: 'click-dom', selector: 'thread-message' },
    { type: 'send-thread-message-no-wait', message: 'one more thing' },
    { type: 'wait-for-mock-paused' }
  ],

  customAssertions: (conversation) => {
    const tab = tabFor(conversation);
    if (!tab) throw new Error('thread-result-block-follows-the-run: no tab element');
    const cols = Array.from(tab.querySelectorAll('conversation-area.thread-column'));
    if (cols.length === 0) {
      throw new Error('thread-result-block-follows-the-run: thread column closed — cannot prove the block was removed while open');
    }
    const stale = cols.flatMap((/** @type {Element} */ c) =>
      Array.from(c.querySelectorAll('.thread-result-final')));
    if (stale.length > 0) {
      throw new Error(`thread-result-block-follows-the-run: ${stale.length} .thread-result-final block(s) still present while the thread is running`);
    }
  }
};

/**
 * After undoing and redoing a completed thread, its result is preserved.
 *
 * Regression test for the threadResult/result key mismatch: the thread-item
 * serializer wrote a "threadResult" key but JS reads the "result" key, so
 * threads restored via redo showed as "running" with no summary.
 *
 * Sub-thread turn content is tracked on the undo stack per turn, so a completed
 * thread peels apart in three undo groups (most-recent first):
 *   1. the root assistant continuation
 *   2. the sub-thread's own turn (clears the thread's result field, leaving the
 *      thread container in place)
 *   3. the thread creation (removes the thread entirely)
 *
 * The critical assertion is the redo that restores the sub-thread's turn — the
 * thread must come back with result='Task done', not as a running thread.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadUndoRedoPreservesResultTest = {
  name: 'thread-undo-redo-preserves-result',
  description: 'After undoing and redoing a completed thread its result is preserved',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Do task', prompt: 'Execute the task' }),
    textResponse('Task done'),
    textResponse('Thread finished.')
  ],

  operations: [
    { type: 'send-message', message: 'Start' },
    // Initial state: 4 items total
    {
      type: 'assert-document',
      expected: {
        items: [
          { type: 'system-prompt', itemId: '$ITEM_1' },
          { type: 'user', content: 'Start' },
          { type: 'thread', itemId: '$ITEM_3', result: 'Task done' },
          { type: 'assistant', content: 'Thread finished.' }
        ]
      }
    },
    // Undo 1: removes the root assistant continuation
    { type: 'undo' },
    { type: 'wait-for-state', condition: { itemCount: 3 } },
    {
      type: 'assert-document',
      expected: {
        items: [
          { type: 'system-prompt', itemId: '$ITEM_1' },
          { type: 'user', content: 'Start' },
          { type: 'thread', itemId: '$ITEM_3', result: 'Task done' }
        ]
      }
    },
    // Undo 2: reverts the sub-thread's turn — the thread's result is cleared
    // but the thread container remains in place.
    { type: 'undo' },
    { type: 'wait-for-state', condition: { completedThreadCount: 0, hasThreadItem: true } },
    {
      type: 'assert-document',
      expected: {
        items: [
          { type: 'system-prompt', itemId: '$ITEM_1' },
          { type: 'user', content: 'Start' },
          { type: 'thread', itemId: '$ITEM_3' }
        ]
      }
    },
    // Undo 3: removes the thread creation entirely
    { type: 'undo' },
    { type: 'wait-for-state', condition: { hasThreadItem: false } },
    {
      type: 'assert-document',
      expected: {
        items: [
          { type: 'system-prompt', itemId: '$ITEM_1' },
          { type: 'user', content: 'Start' }
        ]
      }
    },
    // Redo 1: restores the thread, still without its result
    { type: 'redo' },
    { type: 'wait-for-state', condition: { hasThreadItem: true, completedThreadCount: 0 } },
    {
      type: 'assert-document',
      expected: {
        items: [
          { type: 'system-prompt', itemId: '$ITEM_1' },
          { type: 'user', content: 'Start' },
          { type: 'thread', itemId: '$ITEM_3' }
        ]
      }
    },
    // Redo 2: restores the sub-thread's turn — result MUST be preserved (regression)
    { type: 'redo' },
    { type: 'wait-for-state', condition: { completedThreadCount: 1 } },
    {
      type: 'assert-document',
      expected: {
        items: [
          { type: 'system-prompt', itemId: '$ITEM_1' },
          { type: 'user', content: 'Start' },
          { type: 'thread', itemId: '$ITEM_3', result: 'Task done' }
        ]
      }
    },
    // Redo 3: restores the assistant continuation
    { type: 'redo' },
    { type: 'wait-for-state', condition: { itemCount: 4 } }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Start' },
      { type: 'thread', itemId: '$ITEM_3', result: 'Task done' },
      { type: 'assistant', content: 'Thread finished.' }
    ]
  },

  expectedUndoState: { canUndo: true, canRedo: false }
};

/**
 * Undoing and redoing a completed thread, then deleting it, then undoing the delete,
 * always preserves the exact same document state at each step.
 *
 * Also uses atMostThreadCount to catch the "more threads than started" regression.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadUndoRedoDeleteInterleaveTest = {
  name: 'thread-undo-redo-delete-interleave',
  description: 'Thread undo/redo/delete interleaving always produces correct document state',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Do task', prompt: 'Execute the task' }),
    textResponse('Task done'),
    textResponse('Thread finished.')
  ],

  operations: [
    { type: 'send-message', message: 'Start' },
    // send-message calls waitForTurnComplete — conversation is fully settled here.
    // Three undos peel a completed thread: assistant continuation, the
    // sub-thread's turn (clears the result), then the thread creation itself.
    { type: 'undo' },
    { type: 'undo' },
    { type: 'undo' },
    { type: 'wait-for-state', condition: { hasThreadItem: false } },
    {
      type: 'assert-document',
      expected: {
        items: [
          { type: 'system-prompt', itemId: '$ITEM_1' },
          { type: 'user', content: 'Start' }
        ]
      }
    },
    // Two redos restore the thread and then its result — combined goal+constraint
    // exits as soon as the thread is complete, and never more than one thread.
    { type: 'redo' },
    { type: 'redo' },
    { type: 'wait-for-state', condition: { completedThreadCount: 1, atMostThreadCount: 1 } },
    {
      type: 'assert-document',
      expected: {
        items: [
          { type: 'system-prompt', itemId: '$ITEM_1' },
          { type: 'user', content: 'Start' },
          { type: 'thread', itemId: '$ITEM_3', result: 'Task done' }
        ]
      }
    },
    // Delete the thread manually
    { type: 'delete-last-item' },
    { type: 'wait-for-state', condition: { hasThreadItem: false } },
    {
      type: 'assert-document',
      expected: {
        items: [
          { type: 'system-prompt', itemId: '$ITEM_1' },
          { type: 'user', content: 'Start' }
        ]
      }
    },
    // Undo the delete — thread must come back with its result
    { type: 'undo' },
    { type: 'wait-for-state', condition: { completedThreadCount: 1, atMostThreadCount: 1 } }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Start' },
      { type: 'thread', itemId: '$ITEM_3', result: 'Task done' }
    ]
  }
};

/**
 * Deleting the last item (assistant) from a subthread and undoing restores it; redo removes it again.
 *
 * Thread items after send-thread-message: [user, assistant] (2 items).
 * The bug: detectAndRecordExternalChanges only diffed root-level items,
 * so the deletion inside the nested Y.Array was never recorded in the undo log.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadDeleteLastItemUndoRedoTest = {
  name: 'thread-delete-last-item-undo-redo',
  description: 'Undo/redo restores/removes last item deleted from inside a subthread',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Hi.'),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Hello' },
    { type: 'run-command', command: 'thread', args: 'Test work' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } },
    { type: 'send-thread-message', message: 'Do something' },
    // Thread now has: user("Do something"), assistant("Done.") — 2 items
    { type: 'assert-thread-item-count', count: 2 },
    // Delete the last item (assistant)
    { type: 'delete-last-item-in-thread' },
    { type: 'assert-thread-item-count', count: 1 },
    // Undo — must restore the assistant message
    { type: 'undo' },
    { type: 'assert-thread-item-count', count: 2 },
    // Redo — must delete it again
    { type: 'redo' },
    { type: 'assert-thread-item-count', count: 1 }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Hi.' },
      { type: 'thread', itemId: '$ITEM_4' }
    ]
  }
};

/**
 * Deleting the first item (user message) from a subthread and undoing restores it; redo removes it.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadDeleteFirstItemUndoRedoTest = {
  name: 'thread-delete-first-item-undo-redo',
  description: 'Undo/redo restores/removes first item deleted from inside a subthread',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Hi.'),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Hello' },
    { type: 'run-command', command: 'thread', args: 'Test work' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } },
    { type: 'send-thread-message', message: 'Do something' },
    // Thread now has: user("Do something"), assistant("Done.") — 2 items
    { type: 'assert-thread-item-count', count: 2 },
    // Delete the first item (user message)
    { type: 'delete-first-item-in-thread' },
    { type: 'assert-thread-item-count', count: 1 },
    // Undo — must restore the user message
    { type: 'undo' },
    { type: 'assert-thread-item-count', count: 2 },
    // Redo — must delete it again
    { type: 'redo' },
    { type: 'assert-thread-item-count', count: 1 }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Hi.' },
      { type: 'thread', itemId: '$ITEM_4' }
    ]
  }
};

/**
 * Two rapid thread-item deletions are grouped into one undo step.
 *
 * Both deletions are made together — two edits, at one reading of the
 * conversation's edit clock — so the Go worker groups them under a single undo
 * groupID however late it applies them. One undo restores both; one redo
 * removes both.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadDeleteMiddleItemUndoRedoTest = {
  name: 'thread-delete-middle-item-undo-redo',
  description: 'Two rapid thread-item deletions are grouped and undone together',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Hi.'),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Hello' },
    { type: 'run-command', command: 'thread', args: 'Test work' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } },
    { type: 'send-thread-message', message: 'Do something' },
    // Thread: [user, assistant] — 2 items
    { type: 'assert-thread-item-count', count: 2 },
    // Delete both items together — they get one undo group
    { type: 'delete-thread-items-together', count: 2 },
    { type: 'assert-thread-item-count', count: 0 },
    // One undo restores both (rapid group)
    { type: 'undo' },
    { type: 'assert-thread-item-count', count: 2 },
    // One redo removes both again
    { type: 'redo' },
    { type: 'assert-thread-item-count', count: 0 }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Hi.' },
      { type: 'thread', itemId: '$ITEM_4' }
    ]
  }
};

/**
 * Multiple sequential deletes from a subthread, each independently undoable/redoable.
 *
 * Starting with 4 items, delete last, then undo/redo, then delete index 2, then undo/redo.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadMultiDeleteUndoRedoTest = {
  name: 'thread-multi-delete-undo-redo',
  description: 'Delete-last and delete-first are each independently undoable and redoable',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Hi.'),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Hello' },
    { type: 'run-command', command: 'thread', args: 'Test work' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } },
    { type: 'send-thread-message', message: 'Do something' },
    // Thread: [user, assistant] — 2 items
    { type: 'assert-thread-item-count', count: 2 },
    // Delete last (assistant)
    { type: 'delete-last-item-in-thread' },
    { type: 'assert-thread-item-count', count: 1 },
    // Undo → back to 2
    { type: 'undo' },
    { type: 'assert-thread-item-count', count: 2 },
    // Redo → back to 1
    { type: 'redo' },
    { type: 'assert-thread-item-count', count: 1 },
    // Delete first (user)
    { type: 'delete-first-item-in-thread' },
    { type: 'assert-thread-item-count', count: 0 },
    // Undo → back to 1
    { type: 'undo' },
    { type: 'assert-thread-item-count', count: 1 },
    // Redo → back to 0
    { type: 'redo' },
    { type: 'assert-thread-item-count', count: 0 }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Hi.' },
      { type: 'thread', itemId: '$ITEM_4' }
    ]
  }
};

/**
 * Context item added from sub-thread menu should go to sub-thread, not root.
 *
 * Reproduces a bug where UIEventManager._handleContextItemAddRequested always
 * called conversation.rootMessageThread.executeContextItem(), ignoring which
 * thread's footer dispatched the event.
 *
 * The operation 'add-context-item-to-sub-thread' resolves the sub-thread by its
 * threadItemId and executeContextItem's there (the same routing the footer menu
 * performs), and asserts the item landed in the sub-thread, not root.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadContextItemToSubThreadTest = {
  name: 'thread-context-item-to-sub-thread',
  description: 'Adding a context item from sub-thread menu adds it to sub-thread, not root',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Hi there.')
  ],

  operations: [
    { type: 'send-message', message: 'Hello' },
    { type: 'run-command', command: 'thread', args: 'Test thread' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } },
    { type: 'add-context-item-to-sub-thread' },
    { type: 'assert-thread-item-count', count: 1 }
  ],

  // Root items must NOT include a context-item — it should only be in the sub-thread
  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Hi there.' },
      { type: 'thread', itemId: '$ITEM_4' }
    ]
  }
};

/**
 * AI assistant files added from sub-thread footer must go to the sub-thread, not root.
 * Auto-detection adds CLAUDE.md to root at session startup (correct, expected). This test
 * verifies that the user-initiated "Add AI files" from a sub-thread footer adds to that
 * sub-thread (not a no-op due to root dedup), giving the sub-thread its own copy.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadAIFilesToSubThreadTest = {
  name: 'thread-ai-files-to-sub-thread',
  description: 'AI assistant files added from sub-thread footer go to sub-thread, not root',
  fixture: 'unit-test-fixture',

  llmResponses: [textResponse('Hi there.')],

  // CLAUDE.md lives at the project root because that is where production
  // addAIAssistantFiles looks, and a fixed filename can't hide behind a
  // per-test prefix the way every other test's scratch files do. While it
  // exists, any sibling lane's createConversation auto-detects it and gains
  // a phantom file-content item. needsExclusiveRun tells the Go runner to
  // run this test in a server of its own (fixture reset around it), so no
  // sibling is ever in flight to observe the transient CLAUDE.md.
  needsExclusiveRun: true,

  operations: [
    { type: 'send-message', message: 'Hello' },
    { type: 'run-command', command: 'thread', args: 'Test thread' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } },
    { type: 'write-fixture-file', path: 'CLAUDE.md', content: '# Test AI instructions\n' },
    { type: 'add-ai-files-to-sub-thread' },
    { type: 'delete-fixture-file', path: 'CLAUDE.md' },
    { type: 'assert-thread-item-count', count: 1 }
  ]
};

/**
 * Removing a context item from a sub-thread must remove it from the sub-thread, not silently fail.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadContextItemRemoveFromSubThreadTest = {
  name: 'thread-context-item-remove-from-sub-thread',
  description: 'Removing a context item from sub-thread removes it from sub-thread, not root',
  fixture: 'unit-test-fixture',

  llmResponses: [textResponse('Hi there.')],

  operations: [
    { type: 'send-message', message: 'Hello' },
    { type: 'run-command', command: 'thread', args: 'Test thread' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } },
    { type: 'add-context-item-to-sub-thread' },
    { type: 'assert-thread-item-count', count: 1 },
    { type: 'remove-context-item-from-sub-thread' },
    { type: 'assert-thread-item-count', count: 0 }
  ]
  // No expectedDocument: auto-detection adds CLAUDE.md to root which shifts item IDs.
  // The assert-thread-item-count assertions are sufficient to verify correct behavior.
};

/**
 * Undo of a sub-thread context item deletion must not create a duplicate when the item
 * was re-added between the deletion and the undo.
 *
 * Bug: applyInverse for OpItemsDelete blindly re-inserts at the original index without
 * checking if an item with the same itemId already exists. Since generateUniqueItemId
 * reuses IDs after deletion, re-adding produces a second item with the same ID.
 * The fix is to skip the re-insert when an item with that ID already exists.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadContextItemUndoDeleteNoDuplicateTest = {
  name: 'thread-context-item-undo-delete-no-duplicate',
  description: 'Undo of sub-thread context item deletion does not create duplicate when item was re-added',
  fixture: 'unit-test-fixture',

  llmResponses: [textResponse('Hi there.')],

  operations: [
    { type: 'send-message', message: 'Hello' },
    { type: 'run-command', command: 'thread', args: 'Test thread' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } },
    { type: 'add-context-item-to-sub-thread' },
    { type: 'assert-thread-item-count', count: 1 },
    { type: 'remove-context-item-from-sub-thread' },
    { type: 'assert-thread-item-count', count: 0 },
    { type: 'add-context-item-to-sub-thread' },
    { type: 'assert-thread-item-count', count: 1 },
    // Undo the re-add (T_add2) — item count drops back to 0
    { type: 'undo' },
    { type: 'assert-thread-item-count', count: 0 },
    // Undo the deletion (T_del) — original item restored; no duplicate
    { type: 'undo' },
    { type: 'assert-thread-item-count', count: 1 }
  ]
};

// ============================================================================
// Sibling sub-threads — multiple incomplete child threads under one parent.
// ============================================================================

/**
 * Walk a parent thread's items and find a child thread Y.Map by goal.
 * @param {import('../../model/conversation.js').default} conversation
 * @param {string|null} parentThreadItemId - null for root
 * @param {string} goal
 * @returns {any} The matched thread Y.Map, or null if not found
 */
function findChildThreadByGoal(conversation, parentThreadItemId, goal) {
  const thread = parentThreadItemId === null
    ? conversation.rootMessageThread
    : conversation.resolveMessageThread(parentThreadItemId);
  const items = thread.items || [];
  for (const item of items) {
    if (item.get && item.get('type') === 'thread' && item.get('goal') === goal) {
      return item;
    }
  }
  return null;
}

/**
 * Assert a thread item exists at a given location and has the expected result.
 * @param {import('../../model/conversation.js').default} conversation
 * @param {string|null} parentId
 * @param {string} goal
 * @param {string} expectedResult
 */
function assertChildResult(conversation, parentId, goal, expectedResult) {
  const item = findChildThreadByGoal(conversation, parentId, goal);
  if (!item) {
    const where = parentId === null ? 'root' : `thread ${parentId}`;
    throw new Error(`Expected child thread with goal="${goal}" under ${where}, but none found`);
  }
  const result = item.get('result');
  if (result !== expectedResult) {
    const where = parentId === null ? 'root' : `thread ${parentId}`;
    throw new Error(`Child thread goal="${goal}" under ${where}: expected result="${expectedResult}", got result=${JSON.stringify(result)}`);
  }
}

/**
 * Parent spawns two sibling sub-threads in one assistant turn (multi-tool-use).
 * Both must start their LLM loops and complete with their own result.
 *
 * Bug: the reducer's walk-down at thread_reducer.go:352-357 picks only the LAST
 * incomplete child thread (`last := effective[len(effective)-1]`), so the first-
 * spawned sibling is stranded. None of the existing thread tests cover this
 * (they're all single-thread or strictly linear-nested).
 *
 * Mock FIFO order (assumes fix-in-place: spawn-order dispatch of siblings):
 *   1. root: multi-tool [create_thread A, create_thread B]
 *   2. A's LLM call: text "A done"
 *   3. B's LLM call: text "B done"
 *   4. root continuation: text "All complete"
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const siblingThreadsLifecycleTest = {
  name: 'thread-lifecycle-siblings',
  description: 'Two sibling sub-threads spawned in one turn both start and complete',
  fixture: 'unit-test-fixture',

  llmResponses: [
    multiToolResponse([
      { toolUseId: 'call_root_1', toolName: 'create_thread', toolInput: { goal: 'Task A', prompt: 'Do A' } },
      { toolUseId: 'call_root_2', toolName: 'create_thread', toolInput: { goal: 'Task B', prompt: 'Do B' } }
    ]),
    textResponse('A done'),
    textResponse('B done'),
    textResponse('All complete.')
  ],

  operations: [
    { type: 'send-message', message: 'Start' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Start' },
      { type: 'thread', itemId: '$ITEM_3', result: 'A done' },
      { type: 'thread', itemId: '$ITEM_4', result: 'B done' },
      { type: 'assistant', content: 'All complete.' }
    ]
  },

  customAssertions: async (conversation) => {
    // Belt-and-braces: explicitly verify both siblings have their own results.
    // expectedDocument enforces the root-level shape; this confirms that
    // the goals route to results correctly (catches the case where order
    // of dispatch causes results to be assigned to the wrong thread).
    assertChildResult(conversation, null, 'Task A', 'A done');
    assertChildResult(conversation, null, 'Task B', 'B done');
  }
};

/**
 * Sibling fan-out below an interactive thread:
 *
 *   root
 *   └── A
 *       ├── A1
 *       └── A2
 *
 * The root-level sibling case above covers fan-out at depth 1. This proves the
 * same reducer path starts every sibling one level deeper, without asking an
 * autonomous model-created thread to spawn children.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const siblingThreadsAtMultipleDepthsTest = {
  name: 'thread-lifecycle-siblings-multi-depth',
  description: 'Nested sibling leaves under an interactive thread each complete',
  fixture: 'unit-test-fixture',

  llmResponses: [
    multiToolResponse([
      { toolUseId: 'a1c', toolName: 'create_thread', toolInput: { goal: 'A1', prompt: 'Do A1' } },
      { toolUseId: 'a2c', toolName: 'create_thread', toolInput: { goal: 'A2', prompt: 'Do A2' } }
    ]),
    textResponse('leaf'),
    textResponse('leaf'),
    textResponse('A done'),
    textResponse('All complete.')
  ],

  operations: [
    { type: 'run-command', command: 'thread', args: 'A' },
    { type: 'send-thread-message', message: 'Do A' },
    { type: 'send-message', message: 'Summarize the thread result' },
    {
      type: 'validate-context-snapshot',
      expectedContent: ['A done']
    }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'thread', itemId: '$ITEM_2', result: 'A done' },
      { type: 'user', content: 'Summarize the thread result' },
      { type: 'assistant', content: 'All complete.' }
    ]
  },

  customAssertions: async (conversation) => {
    const threadA = findChildThreadByGoal(conversation, null, 'A');
    if (threadA.get('canSpawnThreads') !== true) {
      throw new Error('interactive A thread must be spawn-capable');
    }
    assertChildResult(conversation, threadA.get('itemId'), 'A1', 'leaf');
    assertChildResult(conversation, threadA.get('itemId'), 'A2', 'leaf');
  }
};

/**
 * Continue button on a stopped sub-thread restarts its LLM loop.
 *
 * Bug: a sub-thread whose run has settled is not re-dispatched on its own
 * (correctly — the run is over). Clicking Continue inside the sub-thread should
 * explicitly dispatch its LLM, but in production the dispatch never reached the
 * reducer for sub-threads.
 *
 * Mock FIFO order:
 *   1. root: create_thread
 *   2. sub-thread's first LLM call: text "v1"
 *   3. root continuation: text
 *   4. (consumed by continue-sub-thread) sub-thread's resumed LLM call: text "v2"
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const continueStalledSubThreadTest = {
  name: 'thread-continue-stalled-sub-thread',
  description: 'Continue button on a stalled sub-thread restarts its LLM loop',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('c1', 'create_thread', { goal: 'Task', prompt: 'Do it' }),
    textResponse('v1'),
    textResponse('First pass done.'),
    // Consumed after the user clicks Continue on the stalled sub-thread. The
    // continued run comes to rest on this reply, which becomes the new summary.
    textResponse('v2')
  ],

  operations: [
    { type: 'send-message', message: 'Go' },
    { type: 'wait-for-state', condition: { completedThreadCount: 1 } },
    // Click the in-thread Continue button on the (only) sub-thread.
    { type: 'continue-sub-thread', threadIndex: 0 },
    { type: 'wait-for-state', condition: { completedThreadCount: 1 } }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Go' },
      { type: 'thread', itemId: '$ITEM_3', result: 'v2' },
      { type: 'assistant', content: 'First pass done.' },
      // The continued run is one the root never asked for, and the root has
      // already read the answer to the call it did make — so that run reports to
      // a receipt appended here rather than rewriting the tile above.
      { type: 'thread' }
    ]
  }
};

/**
 * A tool-action awaiting approval deep inside a nested sub-thread must
 * propagate the "paused / waiting for approval" status UP to every ancestor
 * tile, so the visual route from the tab down to the required action is
 * unbroken regardless of nesting depth.
 *
 * Structure: root → thread L1 → thread L2 → bash (requires approval, pauses).
 *
 * The deepest tile (L2, in L1's column) is trivially `paused` because it
 * DIRECTLY owns the pending tool-action. The regression target is the L1 tile
 * in the ROOT column: pre-fix `getThreadStatus` only scanned a thread's own
 * direct items, so L1 (which contains the pending action only transitively, via
 * L2) showed `stopped`. The assertion is scoped to the root conversation-area
 * (column 0), so it can only pass if the status bubbled up past L2 to L1.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const nestedApprovalBubblesToAncestorTileTest = {
  name: 'thread-nested-approval-bubbles-to-ancestor-tile',
  description: 'Pending approval in a deeply-nested sub-thread marks ancestor tiles as paused',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Level 1', prompt: 'Start L1' }),
    toolUseResponse('call_2', 'create_thread', { goal: 'Level 2', prompt: 'Start L2' }),
    // Deepest thread requests a bash command that requires approval → pauses.
    toolUseResponse('call_3', 'bash', { command: 'env echo needs-approval' }, 'About to run.'),
    // Must NOT be consumed while the approval is pending.
    textResponse('Should not appear while approval pending.')
  ],

  operations: [
    { type: 'send-message', message: 'Begin nested work' },
    { type: 'wait-for-thread-approval', toolUseId: 'call_3' },
    // Scoped to the root conversation-area (column 0): the only thread tile
    // here is L1, whose pending action lives two levels down. Matching
    // data-kind="paused" proves the status bubbled up the whole chain.
    { type: 'assert-dom', selector: 'thread-message .thread-summary.thread-status[data-kind="paused"]' }
  ]
};

/**
 * Policy: the summary is written once, by the run that came to rest on it, and
 * is never re-derived. Editing thread contents (here, deleting an item) leaves
 * it exactly as the run left it — only a later run replaces it. Guards against
 * any future "recompute the summary from the items" regression, which would
 * make the field disagree with the run record the caller was answered from.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadSummaryNotAutoChangedTest = {
  name: 'thread-summary-not-auto-changed-by-edits',
  description: 'Deleting thread items does not auto-change the summary (the run wrote it, nothing re-derives it)',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Do task', prompt: 'Execute' }),
    textResponse('Locked summary.'),
    textResponse('Moving on.')
  ],

  operations: [
    { type: 'send-message', message: 'Start' },
    { type: 'wait-for-state', condition: { completedThreadCount: 1 } },
    // Edit the thread's contents: delete its first deletable item.
    { type: 'delete-first-item-in-thread' }
  ],

  customAssertions: (conversation) => {
    const thread = conversation.rootMessageThread.items.find(
      (/** @type {any} */ it) => it.get?.('type') === 'thread'
    );
    if (!thread) throw new Error('thread-summary-not-auto-changed: thread item missing');
    if (thread.get('result') !== 'Locked summary.') {
      throw new Error(
        `thread-summary-not-auto-changed: summary changed on item edit — got ${JSON.stringify(thread.get('result'))}; ` +
				'the summary is what the run rested on, never re-derived from the items'
      );
    }
  }
};

/**
 * The `<plan>` next-steps footer indicator is per-thread. A sub-thread's plan
 * lives on its own thread Y.Map (like goal/result/resultSpec); the root's lives
 * on conversation metadata (root has no Y.Map). So a sub-thread that emits a
 * `<plan>` must NOT surface it on the ROOT column's footer — it belongs to the
 * sub-thread's own column, and concurrent threads never share one slot.
 *
 * Regression: the plan used to be a single conversation-global `nextSteps`
 * metadata field rendered on every column, so a long sub-thread plan got stuck
 * on the root footer until the next root turn overwrote it.
 *
 * Flow: root spawns a sub-thread; the sub-thread streams a `<plan>` and comes to
 * rest; the root continuation pauses mid-stream — the only state
 * in which the footer renders the indicator. At that frozen point the root
 * column footer must show NO next-steps indicator.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadPlanIndicatorScopedTest = {
  name: 'thread-plan-indicator-scoped-to-emitting-thread',
  description: 'A sub-thread <plan> does not surface on the root column footer',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Sub', prompt: 'Work' }),
    // Sub-thread turn: stream a long rambling <plan>, then come to rest.
    textResponse('<plan>Sub-thread plan: first do A, then B, then a great deal of rambling about C, D and E.</plan>'),
    // Root continuation: pause mid-stream so the root column is processing
    // (the indicator only renders while processing) at the assertion point.
    textResponse('Root continues after the sub-thread.', { pauseBeforeReturn: true })
  ],

  operations: [
    { type: 'send-message-no-wait', message: 'Start' },
    { type: 'wait-for-mock-paused' }
  ],

  // Assert on `_nextSteps` (the single field footer.update renders), not on
  // `.llm-next-steps` DOM visibility: the indicator is only painted into the
  // DOM while a column's footer is in its processing state, so a DOM-absence
  // check passes vacuously at this frozen point. `_nextSteps` is where the
  // pollution lives — pre-fix the sub-thread's plan leaks onto EVERY column
  // (including root); post-fix it stays scoped to the sub-thread's own column.
  customAssertions: (conversation) => {
    const PLAN = 'Sub-thread plan: first do A, then B';
    const tab = tabFor(conversation);
    if (!tab) throw new Error('thread-plan-indicator-scoped: tab element missing');
    const areas = Array.from(tab.querySelectorAll('conversation-area'));
    const root = areas.find((a) => !a.classList.contains('thread-column'));
    const threadCol = areas.find((a) => a.classList.contains('thread-column'));
    if (!root) throw new Error('thread-plan-indicator-scoped: root column missing');
    if (!threadCol) throw new Error('thread-plan-indicator-scoped: sub-thread column missing');

    const rootNext = /** @type {any} */ (root)._nextSteps || '';
    if (rootNext.includes(PLAN)) {
      throw new Error(
        `thread-plan-indicator-scoped: sub-thread plan leaked onto the ROOT column footer ` +
				`(_nextSteps=${JSON.stringify(rootNext.slice(0, 80))}); it must be scoped to the emitting sub-thread`
      );
    }
    // Positive scoping: the plan belongs to the sub-thread's own column.
    const threadNext = /** @type {any} */ (threadCol)._nextSteps || '';
    if (!threadNext.includes(PLAN)) {
      throw new Error(
        `thread-plan-indicator-scoped: sub-thread plan should surface on its OWN column ` +
				`(_nextSteps=${JSON.stringify(threadNext.slice(0, 80))})`
      );
    }
  }
};

/**
 * A session called twice reads as two results down the parent transcript.
 *
 * The first call inserts the thread; the second inserts an ALIAS — a tile owning
 * no transcript, pointing at the first, and standing where the second call was
 * made. Each tile shows the result of its OWN run, frozen when that run settled,
 * so the first tile keeps saying what the first call was told. Both open the
 * same column, because both are views of one transcript.
 *
 * Without aliases the parent had one tile whose text was overwritten by every
 * later call, and the wire put the second call's answer back at the first call's
 * position — in the middle of the turn's own history.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadSessionAliasTilesTest = {
  name: 'thread-session-alias-tiles',
  description: 'A resumed session adds a second tile carrying its own result; both open one column',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread',
      { goal: 'Find the auth code', prompt: 'Where is auth?', session: 'hunt' }),
    textResponse('Auth lives in auth.go.'),
    toolUseResponse('call_2', 'create_thread',
      { goal: 'Find the auth code', prompt: 'Who calls it?', session: 'hunt' }),
    textResponse('The server calls it.'),
    textResponse('Thanks.')
  ],

  operations: [
    { type: 'send-message', message: 'Investigate auth' },
    // Drill in through the SECOND tile: an alias opens the thread it is a view
    // of, so the column must carry both runs.
    { type: 'click-dom', selector: 'thread-message', index: 1 }
  ],

  customAssertions: (conversation) => {
    const items = conversation.rootMessageThread.items;
    const threads = items.filter((/** @type {any} */ it) => it.get?.('type') === 'thread');
    if (threads.length !== 2) {
      throw new Error(`thread-session-alias-tiles: expected 2 thread items (the thread and one alias), got ${threads.length}`);
    }
    const [canonical, alias] = threads;
    if (canonical.get('aliasOf')) {
      throw new Error('thread-session-alias-tiles: the first call must insert the thread itself, not an alias');
    }
    if (alias.get('aliasOf') !== canonical.get('itemId')) {
      throw new Error(`thread-session-alias-tiles: the second tile must point at the first; got ${JSON.stringify(alias.get('aliasOf'))}`);
    }
    if (alias.get('items')) {
      throw new Error('thread-session-alias-tiles: an alias owns no transcript');
    }

    const tab = tabFor(conversation);
    if (!tab) throw new Error('thread-session-alias-tiles: no tab element');
    const root = Array.from(tab.querySelectorAll('conversation-area'))
      .find((/** @type {Element} */ a) => !a.classList.contains('thread-column'));
    const tiles = Array.from(root?.querySelectorAll('thread-message') || []);
    if (tiles.length !== 2) {
      throw new Error(`thread-session-alias-tiles: expected 2 tiles in the root column, got ${tiles.length}`);
    }
    const first = tiles[0]?.textContent || '';
    const second = tiles[1]?.textContent || '';
    if (!first.includes('Auth lives in auth.go.') || first.includes('The server calls it.')) {
      throw new Error(`thread-session-alias-tiles: the first tile must keep its own run's result; got "${first.slice(0, 200)}"`);
    }
    if (!second.includes('The server calls it.')) {
      throw new Error(`thread-session-alias-tiles: the second tile must carry its own run's result; got "${second.slice(0, 200)}"`);
    }

    const cols = Array.from(tab.querySelectorAll('conversation-area.thread-column'));
    if (cols.length === 0) {
      throw new Error('thread-session-alias-tiles: clicking an alias must open the thread it is a view of');
    }
    const colText = cols.map((/** @type {Element} */ c) => c.textContent || '').join('\n');
    if (!colText.includes('Where is auth?') || !colText.includes('Who calls it?')) {
      throw new Error(`thread-session-alias-tiles: the column must show the whole transcript; got "${colText.slice(0, 300)}"`);
    }

    // Both runs have settled, so nothing in the root is working. An alias owns
    // no transcript and no summary, so a busy check that asked the THREAD
    // question of it would read it as a child that never finishes — and the
    // root column would stop offering Continue from the first resume onwards.
    if (conversation.rootMessageThread.hasBusyItems()) {
      throw new Error('thread-session-alias-tiles: the root reads as busy with both runs settled — an alias is being taken for a working thread');
    }
  }
};

/**
 * Deleting one tile of a resumed session deletes ONE tile.
 *
 * A session called twice leaves two items in the parent, and they are separate
 * items: the user selected one of them and pressed Delete, so the other must
 * still be there. The tile that opened the column is the one that goes, not the
 * canonical the column resolves to — every tile opens the same column, so
 * targeting the column's thread would delete a different item than the one that
 * was clicked, and take its siblings with it.
 *
 * Deleting the thread that owns the transcript is the interesting half: the
 * transcript moves to the view that remains rather than the view being swept up
 * with it (promoteThreadView).
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadAliasDeleteRemovesOneTileTest = {
  name: 'thread-alias-delete-removes-one-tile',
  description: 'Deleting one tile of a resumed session removes that tile alone',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread',
      { goal: 'Find the auth code', prompt: 'Where is auth?', session: 'hunt' }),
    textResponse('Auth lives in auth.go.'),
    toolUseResponse('call_2', 'create_thread',
      { goal: 'Find the auth code', prompt: 'Who calls it?', session: 'hunt' }),
    textResponse('The server calls it.'),
    textResponse('Thanks.')
  ],

  operations: [
    { type: 'send-message', message: 'Investigate auth' },
    // Open the column through the SECOND tile, then delete from that column's
    // header. The tile the user opened is the one that must go.
    { type: 'click-dom', selector: 'thread-message', index: 1 },
    {
      type: 'click-dom', global: true, index: 0,
      selector: 'conversation-area.thread-column thread-column-actions .properties-panel-btn.danger'
    }
  ],

  customAssertions: (conversation) => {
    const items = conversation.rootMessageThread.items;
    const threads = items.filter((/** @type {any} */ it) => it.get?.('type') === 'thread');
    if (threads.length !== 1) {
      throw new Error(`thread-alias-delete-removes-one-tile: deleting one tile must leave the other; got ${threads.length} thread items`);
    }
    const survivor = threads[0];
    if (survivor.get('aliasOf')) {
      throw new Error('thread-alias-delete-removes-one-tile: the tile that remains must not point at an item that is gone');
    }
    // The first call's tile is the one that stayed, and it still owns the
    // transcript both calls wrote into.
    if (survivor.get('runToolUseId') !== 'call_1') {
      throw new Error(`thread-alias-delete-removes-one-tile: the wrong tile was deleted; the survivor stands for ${JSON.stringify(survivor.get('runToolUseId'))}`);
    }
    const nested = survivor.get('items');
    const text = (nested?.toArray() || [])
      .map((/** @type {any} */ it) => String(it.get?.('content') || '')).join('\n');
    if (!text.includes('Where is auth?') || !text.includes('Who calls it?')) {
      throw new Error(`thread-alias-delete-removes-one-tile: the surviving tile must keep the whole transcript; got "${text.slice(0, 300)}"`);
    }
  }
};

/**
 * A final response's token counts belong to the thread that produced them.
 *
 * `handleResponse` is handed the MessageThread the response is for, and the
 * status write underneath it must name that thread: a write that omits it makes
 * LLMState.updateStatus fall back to the conversation's *projected* run, the
 * single thread the conversation nominates as its headline. With one thread
 * running those are the same thread and nothing shows. With several running in
 * parallel they routinely are not, and the counts land on a sibling: one
 * thread's meter reports another thread's prompt.
 *
 * The thread is a parameter of the function. Nothing needs to be inferred.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const responseUsageLandsOnItsOwnThreadTest = {
  name: 'response-usage-lands-on-its-own-thread',
  description: 'Token counts from a final response are recorded against the thread that produced them, not the conversation\'s projected run.',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('OK.', { inputTokens: 100 })
  ],

  operations: [
    { type: 'send-message', message: 'hi' }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'hi' },
    { type: 'assistant', content: 'OK.' }
  ],

  async customAssertions(conversation) {
    const conv = /** @type {any} */ (conversation);
    const llmState = conv.llmState;
    const original = llmState.isConversationProcessing;
    try {
      // handleResponse declines to do anything for a settled conversation.
      llmState.isConversationProcessing = () => true;

      // A response for a thread that is NOT the projected run. Only the thread
      // id is needed here: it is all handleResponse reads off the thread.
      conv.handleResponse({ threadItemId: 'msg_sub_thread' }, { inputTokens: 1234, outputTokens: 10, cachedTokens: 500 });

      const own = llmState.getLiveInputUsage(conv.id, 'msg_sub_thread');
      if (!own || own.inputTokens !== 1234) {
        throw new Error(`The responding thread must carry its own count; got ${JSON.stringify(own)}`);
      }

      const projected = llmState.getLiveInputUsage(conv.id, null);
      if (projected && projected.inputTokens === 1234) {
        throw new Error('One thread\'s tokens must not be recorded against the projected run');
      }
    } finally {
      llmState.isConversationProcessing = original;
    }
  }
};

export const tests = [
  responseUsageLandsOnItsOwnThreadTest,
  threadCommandBasicTest,
  threadPlanIndicatorScopedTest,
  threadSummaryNotAutoChangedTest,
  threadCreateToolTest,
  threadResultSpecTest,
  threadDefaultGoalTest,
  threadUndoTest,
  threadErrorNotInRootTest,
  threadDeleteClearsBusyStateTest,
  singleThreadLifecycleTest,
  nestedThreadLifecycleTest,
  threadSettlesOnTrailingTextTest,
  threadResultVisibleInTranscriptTest,
  threadResultBlockFollowsTheRunTest,
  threadSessionAliasTilesTest,
  threadAliasDeleteRemovesOneTileTest,
  threadUndoRedoPreservesResultTest,
  threadUndoRedoDeleteInterleaveTest,
  threadDeleteLastItemUndoRedoTest,
  threadDeleteFirstItemUndoRedoTest,
  threadDeleteMiddleItemUndoRedoTest,
  threadMultiDeleteUndoRedoTest,
  threadContextItemToSubThreadTest,
  threadAIFilesToSubThreadTest,
  threadContextItemRemoveFromSubThreadTest,
  threadContextItemUndoDeleteNoDuplicateTest,
  siblingThreadsLifecycleTest,
  siblingThreadsAtMultipleDepthsTest,
  nestedApprovalBubblesToAncestorTileTest,
  continueStalledSubThreadTest
];
