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
    // Mock 2: Thread LLM calls return_result (consumed by nested loop)
    toolUseResponse('call_2', 'return_result', { result: 'Analysis complete' }),
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
 * the thread's summary must contain. It is structural, not advisory — stored on
 * the thread Y.Map at creation, appended to the thread's seed message so the
 * child acts on it, and surfaced as a read-only block at the top of the thread
 * column (under the context toggle). Omitting it is tolerated (other tests cover
 * the no-spec path); this asserts all three when it IS supplied.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadResultSpecTest = {
  name: 'thread-result-spec',
  description: 'create_thread resultSpec is stored, appended to the seed message, and surfaced in the column',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', {
      goal: 'Find usages',
      prompt: 'Locate every call site',
      resultSpec: 'each call site as file:line - caller'
    }),
    toolUseResponse('call_2', 'return_result', { result: 'Found 3 call sites' }),
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
        { role: 'user', contentIncludes: 'call return_result with: each call site as file:line - caller' }
      ]
    },
    // Drilling into the thread surfaces the contract block in its column.
    { type: 'click-dom', selector: 'thread-message' },
    { type: 'assert-dom', global: true, selector: '.thread-result-spec .result-spec-text' }
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
 * Single thread: create_thread → thread LLM runs → return_result → parent continues.
 *
 * Mock response order (FIFO, consumed by recursive runStrategyLoop):
 *   1. Root: create_thread tool call
 *   2. Thread: return_result with "Task done"
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
  description: 'Single thread: create, run, return_result, parent continues with result in context',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Do task', prompt: 'Execute the task' }),
    toolUseResponse('call_2', 'return_result', { result: 'Task done' }),
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
 * Two-level nested threads:
 *   Root → create_thread("L1") → L1 → create_thread("L2") → L2 → return_result → L1 → return_result → Root
 *
 * Mock response order:
 *   1. Root: create_thread L1
 *   2. L1: create_thread L2
 *   3. L2: return_result "L2 result"
 *   4. L1: return_result "L1 result"
 *   5. Root: text "All done"
 *
 * Verifies both threads have results and proper nesting.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const nestedThreadLifecycleTest = {
  name: 'thread-lifecycle-nested',
  description: 'Two-level nested threads with proper result flow visible in parent context',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Level 1', prompt: 'Start L1' }),
    toolUseResponse('call_2', 'create_thread', { goal: 'Level 2', prompt: 'Start L2' }),
    toolUseResponse('call_3', 'return_result', { result: 'L2 result' }),
    toolUseResponse('call_4', 'return_result', { result: 'L1 result' }),
    textResponse('All done.')
  ],

  operations: [
    { type: 'send-message', message: 'Begin nested work' },
    // Root's continuation (after L1 completes) must include L1's result
    {
      type: 'validate-context-snapshot',
      expectedContent: ['L1 result']
    },
    // L1's continuation (after L2 completes) must include L2's result
    {
      type: 'validate-thread-context',
      threadIndex: 0,
      expectedContent: ['L2 result']
    }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Begin nested work' },
      { type: 'thread', itemId: '$ITEM_3', result: 'L1 result' },
      { type: 'assistant', content: 'All done.' }
    ]
  }
};

/**
 * A thread whose turn ends on a plain assistant message — with NO return_result
 * call — stays OPEN. It does not auto-close on the trailing text (a thread
 * closes only on an explicit return_result call or a hard error), so the tile
 * is not closed and the input box stays in the thread for continued interaction.
 *
 * Uses a user-created /thread (the interactive case): after the thread replies
 * in text, the thread column must remain open and the thread must carry no
 * result.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadStaysOpenWithoutReturnResultTest = {
  name: 'thread-stays-open-without-return-result',
  description: 'A thread ending in assistant text (no return_result) stays open, not auto-closed',
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
    // The thread ended its turn on assistant text with no return_result.
    // It must NOT close: assert no thread acquires a result in this window.
    { type: 'wait-for-state', condition: { maxCompletedThreadCount: 0 }, timeoutMs: 500 }
  ],

  customAssertions: (conversation) => {
    const thread = conversation.rootMessageThread.items.find(
      (/** @type {any} */ it) => it.get?.('type') === 'thread'
    );
    if (!thread) throw new Error('thread-stays-open: thread item missing');
    if (thread.get('result')) {
      throw new Error(`thread-stays-open: thread should stay OPEN, got result ${JSON.stringify(thread.get('result'))}`);
    }
    // The thread column stays open (input box stays in the thread) — it must
    // not snap back to the parent.
    const tab = conversation.getTabElement?.();
    const cols = Array.from(tab?.querySelectorAll('conversation-area.thread-column') || []);
    if (cols.length === 0) {
      throw new Error('thread-stays-open: thread column closed — the input box did not stay in the thread');
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
 * The footer's "Close with last message" closes an open thread by promoting its
 * trailing assistant reply as the result — with NO extra LLM turn. Only two mock
 * responses are provided (the root turn and the thread turn); if the close
 * triggered a summarisation turn it would exhaust the mocks and fail.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadCloseWithLastMessageTest = {
  name: 'thread-close-with-last-message',
  description: 'Close with last message stamps the trailing assistant reply as the result, no extra LLM turn',
  fixture: 'unit-test-fixture',

  llmResponses: [
    textResponse('Hi.'),
    textResponse('Here is my final answer.')
  ],

  operations: [
    { type: 'send-message', message: 'Hello' },
    { type: 'run-command', command: 'thread', args: 'Interactive' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } },
    { type: 'send-thread-message', message: 'Do work' },
    // Open thread, last item is an assistant reply → the footer offers the
    // cheap close. Click it; the thread closes with that exact text.
    { type: 'wait-for-state', condition: { maxCompletedThreadCount: 0 }, timeoutMs: 300 },
    // Scope to the thread column's footer — the root footer also contains a
    // (hidden) close button, and a bare global selector would match it first.
    { type: 'click-dom', global: true, selector: 'conversation-area.thread-column .close-thread-last-btn' },
    { type: 'wait-for-state', condition: { completedThreadCount: 1 } }
  ],

  customAssertions: (conversation) => {
    const thread = conversation.rootMessageThread.items.find(
      (/** @type {any} */ it) => it.get?.('type') === 'thread'
    );
    if (!thread) throw new Error('thread-close-with-last-message: thread item missing');
    if (thread.get('result') !== 'Here is my final answer.') {
      throw new Error(`thread-close-with-last-message: expected result 'Here is my final answer.', got ${JSON.stringify(thread.get('result'))}`);
    }
  },

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Hello' },
      { type: 'assistant', content: 'Hi.' },
      { type: 'thread', itemId: '$ITEM_4', result: 'Here is my final answer.' }
    ]
  }
};

/**
 * return_result called with a MIS-NAMED argument (`summary` instead of the
 * schema's `result`) must still close the thread with that text as the result —
 * NOT discard the work and fabricate "No result provided".
 *
 * Observed in the wild: a close/compaction summary the model emitted under
 * `summary` produced a thread tile reading "Thread result: No result provided"
 * and the real summary was lost. Models mis-name this argument often enough that
 * the worker tolerates common aliases rather than rejecting the call.
 *
 * Mock response order:
 *   1. Root: create_thread
 *   2. Thread: return_result {summary: ...} — alias key, recovered → thread closes
 *   3. Root: text continuation (sees the recovered result in context)
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadReturnResultAliasArgTest = {
  name: 'thread-return-result-alias-arg',
  description: 'return_result with a mis-named arg (summary) still closes the thread with that text',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Do task', prompt: 'Execute the task' }),
    toolUseResponse('call_2', 'return_result', { summary: 'Summary under the wrong key' }),
    textResponse('Thread finished, moving on.')
  ],

  operations: [
    { type: 'send-message', message: 'Start work' },
    // Root's continuation must carry the recovered thread result, never the
    // fabricated fallback that the old swallow-the-malformed-call path emitted.
    {
      type: 'validate-context-snapshot',
      expectedContent: ['Summary under the wrong key'],
      unexpectedContent: ['No result provided']
    }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Start work' },
      { type: 'thread', itemId: '$ITEM_3', result: 'Summary under the wrong key' },
      { type: 'assistant', content: 'Thread finished, moving on.' }
    ]
  }
};

/**
 * return_result called with an EMPTY argument object but the summary in an
 * accompanying assistant text block (the model "answered, then called the tool")
 * must close the thread with that text — not "No result provided".
 *
 * This is the second wild shape: the model writes its summary as prose and calls
 * return_result with nothing useful in the args. The worker falls back to the
 * turn's assistant text so the summary is never lost.
 *
 * Mock response order:
 *   1. Root: create_thread
 *   2. Thread: text "Completed the analysis: all green." + return_result {}
 *   3. Root: text continuation
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadReturnResultTextFallbackTest = {
  name: 'thread-return-result-text-fallback',
  description: 'return_result with empty args falls back to the turn\'s assistant text as the result',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Do task', prompt: 'Execute the task' }),
    toolUseResponse('call_2', 'return_result', {}, 'Completed the analysis: all green.'),
    textResponse('Thread finished, moving on.')
  ],

  operations: [
    { type: 'send-message', message: 'Start work' },
    {
      type: 'validate-context-snapshot',
      expectedContent: ['Completed the analysis: all green.'],
      unexpectedContent: ['No result provided']
    }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Start work' },
      { type: 'thread', itemId: '$ITEM_3', result: 'Completed the analysis: all green.' },
      { type: 'assistant', content: 'Thread finished, moving on.' }
    ]
  }
};

/**
 * A completed thread must surface its result as a VISIBLE terminal element in
 * its own transcript (the open thread column) — not only on the parent tile.
 *
 * The result lives on the thread Y.Map's `result` field (source of truth, also
 * rendered by the tile), NOT as an item in the thread's items array. So the
 * open-thread view synthesizes a terminal "Result" element from that field at
 * the end of the transcript. This is the elegant alternative to making the
 * meta-tool-result visible: one source of truth, uniform across every way a
 * thread concludes (explicit return_result, alias recovery, text fallback,
 * error placeholder).
 *
 * The element must be correctly typed — a distinct `.thread-result-final`
 * terminal marker, NOT a `thinking-message` (the original WTF) and NOT a plain
 * assistant bubble.
 *
 * Mock response order:
 *   1. Root: create_thread (sub-thread carries no system-prompt of its own)
 *   2. Thread: return_result {result: ...}
 *   3. Root: text continuation
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadResultVisibleInTranscriptTest = {
  name: 'thread-result-visible-in-transcript',
  description: 'Completed thread shows its result as a visible terminal element in the open thread column',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Do task', prompt: 'Execute the task' }),
    toolUseResponse('call_2', 'return_result', { result: 'Final summary of the work.' }),
    textResponse('Thread finished, moving on.')
  ],

  operations: [
    { type: 'send-message', message: 'Start work' },
    // Drill into the completed thread so its transcript (including the
    // synthesized terminal Result element) renders in a thread column.
    { type: 'click-dom', selector: 'thread-message' }
  ],

  customAssertions: (conversation) => {
    const tab = conversation.getTabElement?.();
    if (!tab) throw new Error('thread-result-visible: no tab element');
    const cols = Array.from(tab.querySelectorAll('conversation-area.thread-column'));
    if (cols.length === 0) {
      throw new Error('thread-result-visible: no open thread column after drilling into the thread');
    }
    const resultEls = cols.flatMap((/** @type {Element} */ c) =>
      Array.from(c.querySelectorAll('.thread-result-final')));
    if (resultEls.length === 0) {
      throw new Error('thread-result-visible: open thread column has no .thread-result-final terminal element');
    }
    const text = resultEls.map((/** @type {Element} */ e) => e.textContent || '').join('\n');
    if (!text.includes('Final summary of the work.')) {
      throw new Error(`thread-result-visible: terminal element missing summary text; got "${text.slice(0, 200)}"`);
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
 * Reopening a completed thread (clearing its `result`) must remove the terminal
 * Result block from the open thread column — because the block is DERIVED from
 * the `result` field at render time, not stored as an item. This is the payoff
 * of approach (b): no cached state to leave stale; reopen/undo/redo/peer-sync
 * all just re-derive from `result`.
 *
 * Flow: thread completes → drill in (block visible, covered by the sibling
 * test) → reopen (result cleared) → block must be gone while the column stays
 * open.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadResultBlockClearedOnReopenTest = {
  name: 'thread-result-block-cleared-on-reopen',
  description: 'Reopening a thread removes the synthesized terminal Result block from the open column',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Quick task', prompt: 'Do it' }),
    toolUseResponse('call_2', 'return_result', { result: 'Done working.' }),
    textResponse('All done.')
  ],

  operations: [
    { type: 'send-message', message: 'Go' },
    { type: 'wait-for-state', condition: { completedThreadCount: 1 } },
    // Drill into the completed thread so its column (with the terminal Result
    // block) is rendered and stays open.
    { type: 'click-dom', selector: 'thread-message' },
    // Reopen clears the thread's `result`.
    { type: 'reopen-thread' },
    // Same guard as thread-reopen: the reducer must NOT re-write a result.
    { type: 'wait-for-state', condition: { maxCompletedThreadCount: 0 }, timeoutMs: 500 }
  ],

  customAssertions: (conversation) => {
    const tab = conversation.getTabElement?.();
    if (!tab) throw new Error('thread-result-reopen: no tab element');
    const cols = Array.from(tab.querySelectorAll('conversation-area.thread-column'));
    if (cols.length === 0) {
      throw new Error('thread-result-reopen: thread column closed on reopen — cannot prove the block was removed while open');
    }
    const stale = cols.flatMap((/** @type {Element} */ c) =>
      Array.from(c.querySelectorAll('.thread-result-final')));
    if (stale.length > 0) {
      throw new Error(`thread-result-reopen: ${stale.length} stale .thread-result-final block(s) remain after reopen (result cleared but block not removed)`);
    }
  },

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Go' },
      { type: 'thread', itemId: '$ITEM_3' },
      { type: 'assistant', content: 'All done.' }
    ]
  }
};

/**
 * return_result must NOT emit a redundant `thinking` item echoing the summary.
 *
 * The thread's result is surfaced through the thread tile (Y.Map `result`) — the
 * same path every thread uses. The worker used to ALSO call addThinkingMessage
 * with the full "Thread result: <summary>" text, which rendered the entire
 * summary as a mis-typed yellow "Thinking" bubble inside the thread (reported in
 * the wild three separate times, including for perfectly-formed calls). The only
 * item return_result should leave behind in the thread is the meta-tool-result
 * (needed for LLM context reconstruction) — never a thinking item.
 *
 * Mock response order:
 *   1. Root: create_thread (prompt becomes the thread's user message)
 *   2. Thread: return_result {result: ...}
 *   3. Root: text continuation
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadReturnResultNoThinkingItemTest = {
  name: 'thread-return-result-no-thinking-item',
  description: 'return_result leaves only a meta-tool-result in the thread, never a thinking echo of the summary',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Do task', prompt: 'Execute the task' }),
    toolUseResponse('call_2', 'return_result', { result: 'Task done summary text' }),
    textResponse('Thread finished, moving on.')
  ],

  operations: [
    { type: 'send-message', message: 'Start work' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Start work' },
      {
        type: 'thread',
        itemId: '$ITEM_3',
        result: 'Task done summary text',
        items: [
          // The sub-thread is seeded with a cloned system prompt (fresh id) at
          // its head, then its own message, then the return_result marker.
          { type: 'system-prompt' },
          { type: 'user', content: 'Execute the task' },
          { type: 'meta-tool-result' }
        ]
      },
      { type: 'assistant', content: 'Thread finished, moving on.' }
    ]
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
 *   2. the sub-thread's return_result turn (clears the thread's result field,
 *      leaving the thread container in place)
 *   3. the thread creation (removes the thread entirely)
 *
 * The critical assertion is the redo that restores the return_result turn — the
 * thread must come back with result='Task done', not as a running thread.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadUndoRedoPreservesResultTest = {
  name: 'thread-undo-redo-preserves-result',
  description: 'After undoing and redoing a completed thread its result is preserved',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Do task', prompt: 'Execute the task' }),
    toolUseResponse('call_2', 'return_result', { result: 'Task done' }),
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
    // Undo 2: reverts the sub-thread's return_result turn — the thread's result
    // is cleared but the thread container remains in place.
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
    // Redo 2: restores the return_result turn — result MUST be preserved (regression)
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
    toolUseResponse('call_2', 'return_result', { result: 'Task done' }),
    textResponse('Thread finished.')
  ],

  operations: [
    { type: 'send-message', message: 'Start' },
    // send-message calls waitForTurnComplete — conversation is fully settled here.
    // Three undos peel a completed thread: assistant continuation, the
    // return_result turn (clears the result), then the thread creation itself.
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
 * Both deletions happen synchronously (<100ms) so the Go worker groups them
 * under a single undo groupID. One undo restores both; one redo removes both.
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
    // Delete both items rapidly (< 100ms) — they get one undo group
    { type: 'delete-last-item-in-thread' },
    { type: 'assert-thread-item-count', count: 1 },
    { type: 'delete-first-item-in-thread' },
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
  // a phantom file-content item. pollutesFixtureRoot tells the Go runner to
  // schedule this test alone (sequential phase, fixture reset around it), so
  // no sibling is ever in flight to observe the transient CLAUDE.md.
  pollutesFixtureRoot: true,

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

// Export all tests
/**
 * Reopening a closed thread must NOT snap back to closed.
 *
 * Bug: after reopen() clears the result field, tryReconcile() walks into the
 * child thread, sees the old assistant message, and calls writeThreadResult()
 * again — re-closing the thread within the same event loop cycle.
 *
 * Fix: decideNextAction() returns ActionNone (not ActionCompleteThread) when
 * activity="" — the strategy loop defer already wrote the result before
 * clearing activity, so ActionCompleteThread with idle activity only fires
 * spuriously after reopen.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
/**
 * After reopening a closed thread, undo must restore the closed state.
 *
 * Bug: reopen() called transact() without authorId, so the UndoManager
 * (which only tracks transactions with authorId as origin) never recorded
 * the change. Pressing undo appeared clickable (old entries on the stack)
 * but did nothing visible because reopen's transaction was untracked.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadReopenUndoTest = {
  name: 'thread-reopen-undo',
  description: 'Undoing a reopen restores the closed thread state',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Quick task', prompt: 'Do it' }),
    toolUseResponse('call_2', 'return_result', { result: 'Done working.' }),
    textResponse('All done.')
  ],

  operations: [
    { type: 'send-message', message: 'Go' },
    { type: 'wait-for-state', condition: { completedThreadCount: 1 } },
    {
      type: 'assert-document',
      expected: {
        items: [
          { type: 'system-prompt', itemId: '$ITEM_1' },
          { type: 'user', content: 'Go' },
          { type: 'thread', itemId: '$ITEM_3', result: 'Done working.' },
          { type: 'assistant', content: 'All done.' }
        ]
      }
    },
    { type: 'reopen-thread' },
    { type: 'wait-for-state', condition: { maxCompletedThreadCount: 0 }, timeoutMs: 500 },
    {
      type: 'assert-document',
      expected: {
        items: [
          { type: 'system-prompt', itemId: '$ITEM_1' },
          { type: 'user', content: 'Go' },
          { type: 'thread', itemId: '$ITEM_3' },
          { type: 'assistant', content: 'All done.' }
        ]
      }
    },
    // Undo must restore the thread result (re-close the thread)
    { type: 'undo' },
    { type: 'wait-for-state', condition: { completedThreadCount: 1 } },
    {
      type: 'assert-document',
      expected: {
        items: [
          { type: 'system-prompt', itemId: '$ITEM_1' },
          { type: 'user', content: 'Go' },
          { type: 'thread', itemId: '$ITEM_3', result: 'Done working.' },
          { type: 'assistant', content: 'All done.' }
        ]
      }
    }
  ],

};

/** @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition} */
export const threadReopenTest = {
  name: 'thread-reopen',
  description: 'Reopened closed thread stays open, does not snap back',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Quick task', prompt: 'Do it' }),
    toolUseResponse('call_2', 'return_result', { result: 'Done working.' }),
    textResponse('All done.')
  ],

  operations: [
    { type: 'send-message', message: 'Go' },
    { type: 'wait-for-state', condition: { completedThreadCount: 1 } },
    {
      type: 'assert-document',
      expected: {
        items: [
          { type: 'system-prompt', itemId: '$ITEM_1' },
          { type: 'user', content: 'Go' },
          { type: 'thread', itemId: '$ITEM_3', result: 'Done working.' },
          { type: 'assistant', content: 'All done.' }
        ]
      }
    },
    { type: 'reopen-thread' },
    // Constraint: the thread must NOT get a result back during this 500ms window.
    // In the broken state the reducer immediately re-writes the result and the
    // constraint throws, failing the test.
    { type: 'wait-for-state', condition: { maxCompletedThreadCount: 0 }, timeoutMs: 500 }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Go' },
      { type: 'thread', itemId: '$ITEM_3' },
      { type: 'assistant', content: 'All done.' }
    ]
  }
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
 *   2. A's LLM call: return_result "A done"
 *   3. B's LLM call: return_result "B done"
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
    toolUseResponse('call_a', 'return_result', { result: 'A done' }),
    toolUseResponse('call_b', 'return_result', { result: 'B done' }),
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
 * Recursive sibling fan-out at multiple depths:
 *
 *   root
 *   ├── A (sub-thread)
 *   │   ├── A1 (sub-sub-thread, leaf)
 *   │   └── A2 (sub-sub-thread, leaf)
 *   └── B (sub-thread, leaf)
 *
 * This test proves the fix isn't a depth-1 special-case. A has TWO sibling
 * grandchildren that both must dispatch. If the walk-down still picks only
 * `last` at any level, A1 (or B) is stranded.
 *
 * Mock FIFO order (assumes fix: spawn-order dispatch):
 *   1. root: multi-tool [create_thread A, create_thread B]
 *   2. A: multi-tool [create_thread A1, create_thread A2]
 *   3. A1: return_result "leaf"
 *   4. A2: return_result "leaf"
 *   5. A wrap-up: return_result "A done"
 *   6. B: return_result "B done"
 *   7. root continuation: text "all complete"
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const siblingThreadsAtMultipleDepthsTest = {
  name: 'thread-lifecycle-siblings-multi-depth',
  description: 'Sibling sub-sub-threads at depth 2 each start and complete',
  fixture: 'unit-test-fixture',

  llmResponses: [
    multiToolResponse([
      { toolUseId: 'r1', toolName: 'create_thread', toolInput: { goal: 'A', prompt: 'Do A' } },
      { toolUseId: 'r2', toolName: 'create_thread', toolInput: { goal: 'B', prompt: 'Do B' } }
    ]),
    multiToolResponse([
      { toolUseId: 'a1c', toolName: 'create_thread', toolInput: { goal: 'A1', prompt: 'Do A1' } },
      { toolUseId: 'a2c', toolName: 'create_thread', toolInput: { goal: 'A2', prompt: 'Do A2' } }
    ]),
    toolUseResponse('a1r', 'return_result', { result: 'leaf' }),
    toolUseResponse('a2r', 'return_result', { result: 'leaf' }),
    toolUseResponse('aw', 'return_result', { result: 'A done' }),
    toolUseResponse('br', 'return_result', { result: 'B done' }),
    textResponse('All complete.')
  ],

  operations: [
    { type: 'send-message', message: 'Begin' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Begin' },
      { type: 'thread', itemId: '$ITEM_3', result: 'A done' },
      { type: 'thread', itemId: '$ITEM_4', result: 'B done' },
      { type: 'assistant', content: 'All complete.' }
    ]
  },

  customAssertions: async (conversation) => {
    // Depth 1: both siblings completed with the right results
    assertChildResult(conversation, null, 'A', 'A done');
    assertChildResult(conversation, null, 'B', 'B done');

    // Depth 2: A has two grandchildren, both completed.
    const threadA = findChildThreadByGoal(conversation, null, 'A');
    const threadAItemId = threadA.get('itemId');
    assertChildResult(conversation, threadAItemId, 'A1', 'leaf');
    assertChildResult(conversation, threadAItemId, 'A2', 'leaf');
  }
};

/**
 * Continue button on a stalled (reopened) sub-thread restarts its LLM loop.
 *
 * Bug: when a sub-thread is reopened (result cleared, no items appended), the
 * worker does not auto-redispatch (correct: threadReopenTest verifies this).
 * Clicking Continue inside the sub-thread should explicitly dispatch its LLM,
 * but in production the dispatch never reaches the reducer for sub-threads.
 *
 * Mock FIFO order:
 *   1. root: create_thread
 *   2. sub-thread's first LLM call: return_result "v1"
 *   3. root continuation: text
 *   4. (consumed by continue-sub-thread) sub-thread's resumed LLM call: text "v2"
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const continueStalledSubThreadTest = {
  name: 'thread-continue-stalled-sub-thread',
  description: 'Continue button on a reopened sub-thread restarts its LLM loop',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('c1', 'create_thread', { goal: 'Task', prompt: 'Do it' }),
    toolUseResponse('c2', 'return_result', { result: 'v1' }),
    textResponse('First pass done.'),
    // Consumed after the user clicks Continue on the reopened sub-thread.
    // The continued turn closes the thread via return_result (a thread no
    // longer auto-closes on a plain text reply).
    toolUseResponse('cv2', 'return_result', { result: 'v2' })
  ],

  operations: [
    { type: 'send-message', message: 'Go' },
    { type: 'wait-for-state', condition: { completedThreadCount: 1 } },
    { type: 'reopen-thread' },
    // After reopen the thread has no result; constraint = thread must NOT
    // auto-complete in this window (otherwise our continue click is moot).
    { type: 'wait-for-state', condition: { maxCompletedThreadCount: 0 }, timeoutMs: 500 },
    // Click the in-thread Continue button on the (only) sub-thread.
    { type: 'continue-sub-thread', threadIndex: 0 },
    { type: 'wait-for-state', condition: { completedThreadCount: 1 } }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Go' },
      { type: 'thread', itemId: '$ITEM_3', result: 'v2' },
      { type: 'assistant', content: 'First pass done.' }
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
 * The terminal Result block in an open thread column is editable: clicking Edit
 * turns the summary into a textarea; Save writes the new text via
 * conversation.completeThread, and the parent tile reflects it. The summary is
 * an explicit authored artifact, so a manual edit simply replaces it.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadSummaryEditableTest = {
  name: 'thread-summary-editable',
  description: 'Editing the terminal Result block updates the thread result and the parent tile',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Do task', prompt: 'Execute' }),
    toolUseResponse('call_2', 'return_result', { result: 'Original summary.' }),
    textResponse('Moving on.')
  ],

  operations: [
    { type: 'send-message', message: 'Start work' },
    { type: 'wait-for-state', condition: { completedThreadCount: 1 } },
    // Drill into the completed thread so its terminal Result block renders.
    { type: 'click-dom', selector: 'thread-message' },
    // The block exposes an Edit affordance (RED until implemented).
    { type: 'assert-dom', global: true, selector: '.thread-result-final .thread-result-edit-btn' },
    { type: 'click-dom', global: true, selector: '.thread-result-edit-btn' },
    { type: 'set-dom-value', global: true, selector: '.thread-result-textarea', value: 'Edited summary.' },
    { type: 'click-dom', global: true, selector: '.thread-result-save-btn' }
  ],

  customAssertions: (conversation) => {
    const thread = conversation.rootMessageThread.items.find(
      (/** @type {any} */ it) => it.get?.('type') === 'thread'
    );
    if (!thread) throw new Error('thread-summary-editable: thread item missing');
    const result = thread.get('result');
    if (result !== 'Edited summary.') {
      throw new Error(`thread-summary-editable: expected result 'Edited summary.', got ${JSON.stringify(result)}`);
    }
    // Parent tile reflects the edited summary.
    const tab = conversation.getTabElement?.();
    const rootArea = tab?.querySelector('conversation-area:not(.thread-column)');
    const tileSummary = rootArea?.querySelector('thread-message .thread-summary');
    const tileText = tileSummary?.textContent || '';
    if (!tileText.includes('Edited summary.')) {
      throw new Error(`thread-summary-editable: parent tile did not reflect edit; got "${tileText.slice(0, 120)}"`);
    }
  }
};

/**
 * Promote a chosen assistant message inside a thread to be the thread's summary.
 * Selecting the message shows its properties panel; "Use as thread summary"
 * copies its content into the thread's result via completeThread.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadUseMessageAsSummaryTest = {
  name: 'thread-use-message-as-summary',
  description: 'A chosen assistant message inside a thread can be promoted to the thread summary',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Do task', prompt: 'Execute' }),
    toolUseResponse('call_2', 'return_result', { result: 'auto summary' }, 'Key finding: the bug is X.'),
    textResponse('Moving on.')
  ],

  operations: [
    { type: 'send-message', message: 'Start work' },
    { type: 'wait-for-state', condition: { completedThreadCount: 1 } },
    // Drill into the thread, select the assistant message.
    { type: 'click-dom', selector: 'thread-message' },
    { type: 'click-dom', global: true, selector: 'assistant-message', text: 'Key finding' },
    // Properties panel content is debounced ~150ms.
    { type: 'wait-ms', ms: 300 },
    { type: 'assert-dom', global: true, selector: '.use-as-summary-btn' },
    { type: 'click-dom', global: true, selector: '.use-as-summary-btn' }
  ],

  customAssertions: (conversation) => {
    const thread = conversation.rootMessageThread.items.find(
      (/** @type {any} */ it) => it.get?.('type') === 'thread'
    );
    if (!thread) throw new Error('thread-use-message-as-summary: thread item missing');
    const result = thread.get('result');
    if (result !== 'Key finding: the bug is X.') {
      throw new Error(`thread-use-message-as-summary: expected promoted content as result, got ${JSON.stringify(result)}`);
    }
  }
};

/**
 * Policy: the summary is an explicit authored artifact. Editing thread contents
 * (here, deleting an item) never auto-changes the result; only reopen() clears
 * it. Guards against any future "auto-derive summary from items" regression.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadSummaryNotAutoChangedTest = {
  name: 'thread-summary-not-auto-changed-by-edits',
  description: 'Deleting thread items does not auto-change the summary (explicit-artifact policy)',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Do task', prompt: 'Execute' }),
    toolUseResponse('call_2', 'return_result', { result: 'Locked summary.' }, 'Some assistant content.'),
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
				'the summary must be an explicit artifact, never auto-derived'
      );
    }
  }
};

/**
 * Re-summarise regenerates the summary by re-running the return_result strategy
 * over the thread's current items (reopen + summarise turn).
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadResummariseTest = {
  name: 'thread-resummarise',
  description: 'Re-summarise regenerates the thread summary via a fresh return_result turn',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'return_result', { result: 'Original summary.' }),
    toolUseResponse('call_2', 'return_result', { result: 'Regenerated summary.' })
  ],

  operations: [
    { type: 'run-command', command: 'thread' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } },
    { type: 'send-thread-message', message: 'Do work' },
    // Drill into the completed thread; its Result block exposes Re-summarise.
    { type: 'click-dom', selector: 'thread-message' },
    { type: 'assert-dom', global: true, selector: '.thread-result-resummarise-btn' },
    { type: 'click-dom', global: true, selector: '.thread-result-resummarise-btn' },
    { type: 'wait-for-state', condition: { anyThreadResultIncludes: 'Regenerated summary.' } }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'thread', itemId: '$ITEM_2', result: 'Regenerated summary.' }
    ]
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
 * Flow: root spawns a sub-thread; the sub-thread streams a `<plan>` then closes
 * via return_result; the root continuation pauses mid-stream — the only state
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
    // Sub-thread turn: stream a long rambling <plan>, then close via return_result.
    toolUseResponse('call_2', 'return_result', { result: 'sub done' },
      '<plan>Sub-thread plan: first do A, then B, then a great deal of rambling about C, D and E.</plan>'),
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
    const tab = conversation.getTabElement?.();
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

export const tests = [
  threadCommandBasicTest,
  threadPlanIndicatorScopedTest,
  threadSummaryEditableTest,
  threadUseMessageAsSummaryTest,
  threadSummaryNotAutoChangedTest,
  threadResummariseTest,
  threadCreateToolTest,
  threadResultSpecTest,
  threadDefaultGoalTest,
  threadUndoTest,
  threadErrorNotInRootTest,
  threadDeleteClearsBusyStateTest,
  singleThreadLifecycleTest,
  nestedThreadLifecycleTest,
  threadStaysOpenWithoutReturnResultTest,
  threadCloseWithLastMessageTest,
  threadReturnResultAliasArgTest,
  threadReturnResultTextFallbackTest,
  threadReturnResultNoThinkingItemTest,
  threadResultVisibleInTranscriptTest,
  threadResultBlockClearedOnReopenTest,
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
  threadReopenTest,
  threadReopenUndoTest,
  siblingThreadsLifecycleTest,
  siblingThreadsAtMultipleDepthsTest,
  nestedApprovalBubblesToAncestorTileTest,
  continueStalledSubThreadTest
];
