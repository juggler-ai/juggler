//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Re-run Tool Action
 *
 * Tests that re-running a completed tool-action works correctly:
 * - Tool gets re-evaluated (approval check + execution)
 * - LLM loop continues after re-run completes
 * @module integration-tests/rerun-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';
import { testDirFor } from '../utilities/integration-test-runner.js';

const TD_editToolCompletes = testDirFor('edit-tool-completes');

/**
 * The bash command of a cancel-then-rerun test. Its first run prints
 * "started" and then sleeps far longer than any cancel takes to land, so the
 * cancel always finds it running; the rerun finds the marker the first run
 * left and finishes at once. A first run that can end by itself races the
 * cancel, and when it wins, the worker rightly continues the original turn on
 * the result, spending the response the rerun was given.
 *
 * Cancel only once the output shows "started" (wait-for-action-output): the
 * marker is made before it, so that output proves the marker exists. A tool's
 * first progress event comes sooner, and a cancel landing then kills the run
 * before it has left a marker, so the rerun takes the slow branch as well.
 * @param {string} testName
 * @returns {string} the command, with a marker path unique to this realm
 */
function slowFirstRunCommand(testName) {
  const dir = testDirFor(testName);
  const marker = `${dir}/.first-run-${Math.random().toString(36).slice(2)}`;
  return `mkdir -p ${dir}; if [ -e ${marker} ]; then rm -f ${marker}; env echo "rerun"; ` +
    `else touch ${marker}; env echo "started"; sleep 30; fi`;
}

// ============================================================================
// TEST 1: Re-run a completed tool
// ============================================================================

/**
 * Tool completes successfully, then is re-run. The re-run should
 * re-evaluate approval, execute the tool again, and produce a new result.
 *
 * This test catches the bug where handleRetryToolAction used two separate
 * Yjs transactions (one for state, one for result), causing the
 * frontend observer to miss the re-run trigger.
 *
 * Mock responses:
 *   1. bash tool (echo "first") — executes normally
 *   2. text "Done." — loop ends after tool completes
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const rerunCompletedToolTest = {
  name: 'rerun-completed-tool',
  description: 'Re-running a completed tool-action executes it again',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash',
      { command: 'env echo "hello"' },
      'Running command.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Run it' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'approve', toolUseId: 'call_1' },
    // Tool completes, LLM says "Done.", loop ends.
    // Now re-run the tool — should re-evaluate, get approved, and execute again.
    { type: 'rerun-tool', toolUseId: 'call_1' }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'Run it' },
    { type: 'assistant', content: 'Running command.' },
    {
      type: 'tool-action',
      toolUseId: '$TOOL_1',
      toolName: 'bash',
      // After re-run, the tool should have a result (not stuck in Running...)
      state: 'completed',
      result: { content: 'hello', isError: false }
    },
    { type: 'assistant', content: 'Done.' }
  ]
};

/**
 * Re-run a tool that was interrupted mid-execution (CancelStaleToolActions path).
 * This is the scenario when the app crashes/relaunches while a tool is running:
 * CancelStaleToolActions sets result={cancelled:true} but does NOT change state.
 * On re-run, state stays "" (no change), only result changes.
 * The observer must trigger _handleNewToolAction from the result change alone.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const rerunInterruptedToolTest = {
  name: 'rerun-interrupted-tool',
  description: 'Re-running an interrupted tool (CancelStaleToolActions path) works',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash',
      { command: slowFirstRunCommand('rerun-interrupted-tool') },
      'Running command.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Run it' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'start-capture-progress', toolUseId: 'call_1' },
    { type: 'approve-no-wait', toolUseId: 'call_1' },
    { type: 'wait-for-progress', toolUseId: 'call_1', minEvents: 1 },
    { type: 'wait-for-action-output', toolUseId: 'call_1', contains: 'started' },
    // Cancel mid-execution — simulates crash + CancelStaleToolActions
    // This sets result={cancelled:true} but state stays as-is
    { type: 'cancel' },
    // Now re-run the interrupted tool
    { type: 'rerun-tool', toolUseId: 'call_1' }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'Run it' },
    { type: 'assistant', content: 'Running command.' },
    {
      type: 'tool-action',
      toolUseId: '$TOOL_1',
      toolName: 'bash',
      state: 'completed'
      // Result content varies (re-run produces fresh output)
    }
  ]
};

/**
 * Edit tool with valid content should complete (not hang).
 * This tests the full edit lifecycle: LLM sends edit → frontend evaluates →
 * user approves → edit executes via ops API → tool completes.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const editToolCompletesTest = {
  name: 'edit-tool-completes',
  description: 'Edit tool completes execution (does not hang in Running state)',
  fixture: 'unit-test-fixture',
  // Seed our own file so the edit doesn't mutate the shared fixture's
  // README.md (other tests read it and would see the modified content).
  setupFiles: {
    [`${TD_editToolCompletes}/readme.md`]: '# Test Fixture Project\n'
  },

  llmResponses: [
    toolUseResponse('call_1', 'edit',
      { file_path: `${TD_editToolCompletes}/readme.md`, old_string: '# Test Fixture Project', new_string: '# Modified Project' },
      'Editing README.'
    ),
    textResponse('Done editing.')
  ],

  operations: [
    { type: 'send-message', message: 'Edit the README' }
    // Edit tool auto-approves in test env — just wait for completion
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'Edit the README' },
    { type: 'assistant', content: 'Editing README.' },
    {
      type: 'tool-action',
      toolUseId: '$TOOL_1',
      toolName: 'edit',
      state: 'completed'
    },
    { type: 'assistant', content: 'Done editing.' }
  ]
};

/**
 * Edit tool with invalid old_string should fail (not hang).
 * The edit action should return an error when the search text isn't found.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const editToolFailsGracefullyTest = {
  name: 'edit-tool-fails-gracefully',
  description: 'Edit tool with non-matching old_string fails with error (does not hang)',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'edit',
      { file_path: 'README.md', old_string: 'THIS TEXT DOES NOT EXIST IN THE FILE', new_string: 'replacement' },
      'Editing README.'
    ),
    textResponse('I see the error.')
  ],

  operations: [
    { type: 'send-message', message: 'Edit the README' }
    // No approval needed — should fail during validation (prepare)
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'Edit the README' },
    { type: 'assistant', content: 'Editing README.' },
    {
      type: 'tool-action',
      toolUseId: '$TOOL_1',
      toolName: 'edit',
      state: 'completed'
    },
    { type: 'assistant', content: 'I see the error.' }
  ]
};

// ============================================================================
// TEST 5: Re-run a cancelled-mid-execution tool — no duplicates
// ============================================================================

/**
 * Cancel a bash tool while it's running, then re-run it.
 * The re-run must:
 *   - NOT create duplicate tool-action items (Bug 1)
 *   - NOT create a separate error item (Bug 3)
 *   - Actually execute and produce real output (Bug 4)
 *
 * Root cause: auto-continue in _handleApprovalStateChanges fires
 * workerManager.sendMessage('') during rerun, starting a spurious
 * strategy loop that creates extra items.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const rerunCancelledToolNoDuplicateTest = {
  name: 'rerun-cancelled-tool-no-duplicate',
  description: 'Re-running a cancelled tool: strategy loop waits for tool, then LLM continues (no duplicates)',
  fixture: 'unit-test-fixture',

  // 2 responses: (1) initial tool_use, (2) LLM continuation after rerun
  // completes. The strategy loop must wait for the rerunning tool BEFORE
  // calling the LLM — otherwise the LLM would see a tool with no result
  // and re-issue the command, creating a duplicate.
  llmResponses: [
    toolUseResponse('call_1', 'bash',
      { command: slowFirstRunCommand('rerun-cancelled-tool-no-duplicate') },
      'Running command.'
    ),
    textResponse('Done after rerun.')
  ],

  operations: [
    { type: 'send-message', message: 'Run it' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'start-capture-progress', toolUseId: 'call_1' },
    { type: 'approve-no-wait', toolUseId: 'call_1' },
    { type: 'wait-for-progress', toolUseId: 'call_1', minEvents: 1 },
    { type: 'wait-for-action-output', toolUseId: 'call_1', contains: 'started' },
    // Cancel while running
    { type: 'cancel' },
    { type: 'assert-tool-field', toolUseId: 'call_1', field: 'state', value: 'cancelled' },
    // Re-run = "continue from here": tool re-executes, then the strategy
    // loop auto-continues and the LLM sees the new result.
    { type: 'rerun-tool', toolUseId: 'call_1' }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'Run it' },
    { type: 'assistant', content: 'Running command.' },
    {
      type: 'tool-action',
      toolUseId: '$TOOL_1',
      toolName: 'bash',
      state: 'completed'
    }
  ],

  customAssertions: (conversation) => {
    const items = conversation.rootMessageThread.items;
    const toolActions = items.filter(i => i.get('type') === 'tool-action');
    if (toolActions.length !== 1) {
      throw new Error(
        `Expected exactly 1 tool-action item, got ${toolActions.length} — ` +
				`strategy loop called LLM before rerunning tool completed`
      );
    }
    const errorItems = items.filter(i => i.get('type') === 'error');
    if (errorItems.length !== 0) {
      throw new Error(
        `Expected 0 error items, got ${errorItems.length}`
      );
    }
  }
};

// ============================================================================
// TEST 6: Cancelled tool reaches terminal state (not stuck in 'running')
// ============================================================================

/**
 * Cancel a running bash tool. The tool MUST reach a terminal state
 * ('cancelled' or 'completed') — it must NOT remain stuck in 'running'.
 *
 * Root cause: _executeActionCore returns early on cancelled results
 * without calling completeToolAction, leaving the tool in 'running'
 * state with no result. The worker's waitForToolsComplete then
 * deadlocks (waiting for a result that never comes, since
 * CancelStaleToolActions only runs in the defer after the wait).
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const cancelledToolReachesTerminalStateTest = {
  name: 'cancelled-tool-reaches-terminal-state',
  description: 'Cancelled running tool reaches terminal state (not stuck in running)',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash',
      // `env echo` instead of plain `sleep` so the command still requires
      // approval (sleep is in the safe-builtin set; we need the modal).
      { command: 'env echo started; sleep 10' },
      'Running command.'
    )
  ],

  operations: [
    { type: 'send-message', message: 'Run it' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'start-capture-progress', toolUseId: 'call_1' },
    { type: 'approve-no-wait', toolUseId: 'call_1' },
    { type: 'wait-for-progress', toolUseId: 'call_1', minEvents: 1 },
    // Cancel while running — tool must transition to a terminal state
    { type: 'cancel' }
  ],

  customAssertions: (conversation) => {
    const items = conversation.rootMessageThread.items;
    const toolActions = items.filter(i => i.get('type') === 'tool-action');
    if (toolActions.length !== 1) {
      throw new Error(`Expected 1 tool-action, got ${toolActions.length}`);
    }
    const tool = toolActions[0];
    const state = tool.get('state');
    const result = tool.get('result');
    // Tool must be in a terminal state with a result
    if (state !== 'completed' && state !== 'cancelled') {
      throw new Error(
        `Tool stuck in '${state}' after cancel — must reach 'completed' or 'cancelled'. ` +
				`Has result: ${result !== null && result !== undefined}`
      );
    }
    if (result === null || result === undefined) {
      throw new Error(
        `Tool in state '${state}' but has no result — ` +
				`_executeActionCore returned early on cancel without writing result`
      );
    }
  }
};

// ============================================================================
// TEST 7: Rerun completes exactly once (no infinite re-execution)
// ============================================================================

/**
 * Rerun a completed tool. It must execute exactly once and stay completed.
 * After rerun, auto-continue correctly starts a strategy loop. The strategy
 * loop must wait for the tool, call the LLM, and stop — not loop forever.
 *
 * We detect infinite re-execution by checking that exactly 1 tool-action
 * exists and the conversation stabilises with a finite number of items.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const rerunCompletesExactlyOnceTest = {
  name: 'rerun-completes-exactly-once',
  description: 'Rerun executes tool once then stops (no infinite re-execution loop)',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash',
      { command: 'env echo "hello"' },
      'Running command.'
    ),
    // After initial tool completes, LLM says done.
    textResponse('Done.'),
    // After rerun, the strategy loop calls the LLM again.
    textResponse('Done after rerun.')
  ],

  operations: [
    { type: 'send-message', message: 'Run it' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'approve', toolUseId: 'call_1' },
    // Tool completes normally. Now rerun it.
    { type: 'rerun-tool', toolUseId: 'call_1' }
  ],

  customAssertions: (conversation) => {
    const items = conversation.rootMessageThread.items;
    const toolActions = items.filter(i => i.get('type') === 'tool-action');
    if (toolActions.length !== 1) {
      throw new Error(
        `Expected exactly 1 tool-action, got ${toolActions.length} — ` +
				`tool was duplicated or re-created`
      );
    }
    const tool = toolActions[0];
    const state = tool.get('state');
    if (state !== 'completed') {
      throw new Error(
        `Tool in state '${state}' after rerun — expected 'completed'`
      );
    }
    const result = tool.get('result');
    const resultPlain = result?.toJSON ? result.toJSON() : result;
    if (!resultPlain || resultPlain.cancelled) {
      throw new Error('Tool result is cancelled — rerun did not actually execute');
    }
    const content = resultPlain.content || '';
    if (!content.includes('hello')) {
      throw new Error(
        `Expected output containing "hello", got: "${content}"`
      );
    }
    const errorItems = items.filter(i => i.get('type') === 'error');
    if (errorItems.length !== 0) {
      throw new Error(`Expected 0 error items, got ${errorItems.length}`);
    }
  }
};

// ============================================================================
// TEST 8: Cancel-then-rerun cycle works
// ============================================================================

/**
 * Cancel a running bash tool, wait for idle, then rerun it.
 * The rerun must start a new strategy loop immediately (not rely on
 * a delayed auto-continue round-trip), execute the tool, and let
 * the LLM continue. This catches the bug where handleRetryToolAction
 * only reset state/result without starting the strategy loop, causing:
 *   - No spinner after rerun (worker idle)
 *   - Escape unresponsive (cancel only works in StateProcessing)
 *   - Stale auto-continue starting an unwanted LLM call after cancel
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const cancelRerunCycleTest = {
  name: 'cancel-rerun-cycle',
  description: 'Cancel-then-rerun cycle works (strategy loop starts immediately)',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash',
      { command: slowFirstRunCommand('cancel-rerun-cycle') },
      'Running command.'
    ),
    textResponse('Done after rerun.')
  ],

  operations: [
    { type: 'send-message', message: 'Run it' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'start-capture-progress', toolUseId: 'call_1' },
    { type: 'approve-no-wait', toolUseId: 'call_1' },
    { type: 'wait-for-progress', toolUseId: 'call_1', minEvents: 1 },
    { type: 'wait-for-action-output', toolUseId: 'call_1', contains: 'started' },
    // Cancel while running
    { type: 'cancel' },
    // Verify worker goes idle after cancel
    { type: 'wait-for-state', condition: { processingStatus: 'idle' } },
    { type: 'assert-tool-field', toolUseId: 'call_1', field: 'state', value: 'cancelled' },
    // Rerun after cancel — strategy loop must start immediately
    { type: 'rerun-tool', toolUseId: 'call_1' }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'Run it' },
    { type: 'assistant', content: 'Running command.' },
    {
      type: 'tool-action',
      toolUseId: '$TOOL_1',
      toolName: 'bash',
      state: 'completed'
    }
  ],

  customAssertions: (conversation) => {
    const items = conversation.rootMessageThread.items;
    const toolActions = items.filter(i => i.get('type') === 'tool-action');
    if (toolActions.length !== 1) {
      throw new Error(
        `Expected exactly 1 tool-action, got ${toolActions.length}`
      );
    }
    const errorItems = items.filter(i => i.get('type') === 'error');
    if (errorItems.length !== 0) {
      throw new Error(`Expected 0 error items, got ${errorItems.length}`);
    }
  }
};

// ============================================================================
// TEST 9: Rerunning a streaming bash command executes exactly once
// ============================================================================

/**
 * Rerun a bash command that streams many output chunks.
 *
 * During streaming, execute-context-item.js throttles displayData writes
 * to ~4/sec. Each write is its own Yjs transaction, which fires
 * `_handleApprovalStateChanges` on the tool-action Y.Map. Before the fix,
 * the observer inspected only current `state` and `result` values and
 * therefore re-entered `executeToolAction` on *every* displayData update —
 * spawning concurrent bash executions that compounded exponentially
 * ("output clears and restarts" loop the user reported).
 *
 * The fix: gate the observer's execution dispatch on
 * `evt.keysChanged.has('state')`, so only actual state transitions trigger
 * execution.
 *
 * This test counts toolExecutor.executeToolCall invocations for the
 * reran tool between startToolExecCounter and the rerun's completion.
 * With the fix the count must be exactly 1.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const rerunStreamingExecutesOnceTest = {
  name: 'rerun-streaming-executes-once',
  description: 'Rerunning a streaming bash command executes exactly once (no observer cascade)',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // Streams ~10 chunks over ~1s so displayData updates fire the
    // observer many times during execution.
    toolUseResponse('call_1', 'bash',
      { command: 'for i in 1 2 3 4 5 6 7 8 9 10; do echo line_$i; sleep 0.1; done' },
      'Running streaming command.'
    ),
    textResponse('Done.'),
    textResponse('Done after rerun.')
  ],

  operations: [
    { type: 'send-message', message: 'Run it' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'approve', toolUseId: 'call_1' },
    // Initial run complete. Start counting executions and rerun.
    { type: 'start-tool-exec-counter', toolUseId: 'call_1' },
    { type: 'rerun-tool', toolUseId: 'call_1' },
    // Exactly one execution must have been triggered by the rerun.
    { type: 'assert-tool-exec-count', toolUseId: 'call_1', expectedCount: 1 }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'Run it' },
    { type: 'assistant', content: 'Running streaming command.' },
    {
      type: 'tool-action',
      toolUseId: '$TOOL_1',
      toolName: 'bash',
      state: 'completed'
    }
  ],

  customAssertions: (conversation) => {
    const items = conversation.rootMessageThread.items;
    const toolActions = items.filter(i => i.get('type') === 'tool-action');
    if (toolActions.length !== 1) {
      throw new Error(
        `Expected exactly 1 tool-action, got ${toolActions.length}`
      );
    }
    const errorItems = items.filter(i => i.get('type') === 'error');
    if (errorItems.length !== 0) {
      throw new Error(`Expected 0 error items, got ${errorItems.length}`);
    }
  }
};

// ============================================================================
// TEST 10: Re-run a completed grep tool
// ============================================================================

/**
 * Grep tool completes, then is re-run.
 * The re-run must execute the grep again and produce a new result.
 * This covers browser-executed (no-approval) tools that complete near-instantly.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const rerunGrepToolTest = {
  name: 'rerun-grep-tool',
  description: 'Re-running a completed grep tool-action executes it again',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'grep', { pattern: 'func ' }, 'Searching.'),
    textResponse('Found it.'),
    textResponse('Done after rerun.')
  ],

  operations: [
    { type: 'send-message', message: 'Find all functions' },
    { type: 'wait-for-state', condition: { processingStatus: 'idle' } },
    { type: 'rerun-tool', toolUseId: 'call_1' }
  ],

  customAssertions: (conversation) => {
    const items = conversation.rootMessageThread.items;
    const toolActions = items.filter(i => i.get('type') === 'tool-action');
    if (toolActions.length !== 1) {
      throw new Error(`Expected exactly 1 tool-action, got ${toolActions.length}`);
    }
    const tool = toolActions[0];
    const state = tool.get('state');
    if (state !== 'completed') {
      throw new Error(`Tool in state '${state}' after rerun — expected 'completed'`);
    }
    const result = tool.get('result');
    if (result === null || result === undefined) {
      throw new Error('Tool result is nil after rerun — re-execution did not complete');
    }
    const resultPlain = result?.toJSON ? result.toJSON() : result;
    if (resultPlain?.cancelled) {
      throw new Error('Tool result is cancelled after rerun — re-execution did not run');
    }
    const errorItems = items.filter(i => i.get('type') === 'error');
    if (errorItems.length !== 0) {
      throw new Error(`Expected 0 error items, got ${errorItems.length}`);
    }
  }
};

// ============================================================================
// TEST 11: Re-run a completed batch_grep tool
// ============================================================================

/**
 * batch_grep tool completes, then is re-run.
 * Same as rerunGrepToolTest but for the batch variant.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const rerunBatchGrepToolTest = {
  name: 'rerun-batch-grep-tool',
  description: 'Re-running a completed batch_grep tool-action executes it again',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'batch_grep', { searches: [{ pattern: 'func ' }] }, 'Searching.'),
    textResponse('Found it.'),
    textResponse('Done after rerun.')
  ],

  operations: [
    { type: 'send-message', message: 'Find all functions' },
    { type: 'wait-for-state', condition: { processingStatus: 'idle' } },
    { type: 'rerun-tool', toolUseId: 'call_1' }
  ],

  customAssertions: (conversation) => {
    const items = conversation.rootMessageThread.items;
    const toolActions = items.filter(i => i.get('type') === 'tool-action');
    if (toolActions.length !== 1) {
      throw new Error(`Expected exactly 1 tool-action, got ${toolActions.length}`);
    }
    const tool = toolActions[0];
    const state = tool.get('state');
    if (state !== 'completed') {
      throw new Error(`Tool in state '${state}' after rerun — expected 'completed'`);
    }
    const result = tool.get('result');
    if (result === null || result === undefined) {
      throw new Error('Tool result is nil after rerun — re-execution did not complete');
    }
    const resultPlain = result?.toJSON ? result.toJSON() : result;
    if (resultPlain?.cancelled) {
      throw new Error('Tool result is cancelled after rerun — re-execution did not run');
    }
    const errorItems = items.filter(i => i.get('type') === 'error');
    if (errorItems.length !== 0) {
      throw new Error(`Expected 0 error items, got ${errorItems.length}`);
    }
  }
};

// ============================================================================
// TEST 12: Re-run bash command produces different output
// ============================================================================

/**
 * Re-run a bash command that generates different output each execution.
 * Verifies that the result content actually CHANGES after re-run — not just
 * that a result exists. This catches bugs where re-run resets state but
 * replays the original cached result instead of executing fresh.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const rerunBashDifferentOutputTest = {
  name: 'rerun-bash-different-output',
  description: 'Re-running a bash command produces different output each time',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash',
      // The bash tool runs commands through POSIX `sh` (dash on Linux), which
      // has no `$RANDOM` — that bashism expands to empty there, so every rerun
      // printed identical output. Pull fresh random bytes from /dev/urandom
      // instead: portable across dash and macOS's sh, and different every run.
      { command: 'printf "RUN-%s\\n" "$(od -An -N4 -tx1 /dev/urandom | tr -d " ")"' },
      'Running command.'
    ),
    textResponse('Done.'),
    textResponse('Done after rerun.')
  ],

  operations: [
    { type: 'send-message', message: 'Run it' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'approve', toolUseId: 'call_1' },
    // Capture the first result before re-running
    { type: 'capture-tool-result', toolUseId: 'call_1', key: 'before-rerun' },
    // Re-run — should produce fresh output
    { type: 'rerun-tool', toolUseId: 'call_1' },
    // Assert the output actually changed
    { type: 'assert-tool-result-changed', toolUseId: 'call_1', key: 'before-rerun' }
  ],

  customAssertions: (conversation) => {
    const items = conversation.rootMessageThread.items;
    const toolActions = items.filter(i => i.get('type') === 'tool-action');
    if (toolActions.length !== 1) {
      throw new Error(`Expected exactly 1 tool-action, got ${toolActions.length}`);
    }
    const tool = toolActions[0];
    const result = tool.get('result');
    if (result === null || result === undefined) {
      throw new Error('Tool result is nil after rerun');
    }
    const resultPlain = result?.toJSON ? result.toJSON() : result;
    if (resultPlain?.cancelled) {
      throw new Error('Tool result is cancelled after rerun — re-execution did not run');
    }
  }
};

// ============================================================================
// Cancel during rerun (production bug — Escape gate doesn't fire outside LLM turn)
// ============================================================================

/**
 * Production scenario: user clicks "Re-run command" on a completed tool-action
 * (LLM loop is idle). The rerun starts executing — worker activity is
 * 'awaiting_llm', no LLM is streaming, so `isLLMActive()` is false. If the
 * user then wants to cancel because the rerun is stuck, neither the Escape
 * keydown gate (in conversation-tab.js) nor the body of `cancelLLMOperation`
 * (in app.js) currently sends a cancel signal to the worker for this
 * `awaiting_llm` branch — the worker is left in
 * `activity='awaiting_llm'` with the tool-action stuck at `state='running'`.
 *
 * Expected: cancel-via-ui-flow → worker activity clears → tool-action goes to
 * cancelled.
 *
 * Pre-fix this test fails because the worker never receives the cancel
 * message; the wait for processingState='idle' times out.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const cancelDuringRerunTest = {
  name: 'cancel-during-rerun',
  description: 'Cancelling a stuck rerun (outside LLM turn) clears worker activity and marks tool cancelled',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // Long-running bash so the cancel-via-ui-flow window (4s) can land
    // deterministically. sleep 30 gives a wide margin under load; cancel
    // terminates the process well before it would complete naturally.
    // If cancel regresses, the cancel-via-ui-flow op's timeoutMs gates
    // wall time — the slot is not wedged for the full sleep.
    toolUseResponse('call_1', 'bash',
      { command: 'env echo "first"; sleep 30' },
      'Running.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Run it' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'start-capture-progress', toolUseId: 'call_1' },
    { type: 'approve-no-wait', toolUseId: 'call_1' },
    // Tool emits "first", then sleeps — wait for first chunk so we know
    // the engine has actually started executing.
    { type: 'wait-for-progress', toolUseId: 'call_1', minEvents: 1 },
    // First-round cancel uses the existing path (LLM turn is active, so
    // isLLMActive() is true and Escape would fire correctly here).
    { type: 'cancel' },
    // Now the tool-action result is {cancelled:true}, state may be "" or
    // "running" depending on what the worker wrote. Re-run it.
    { type: 'rerun-tool-no-wait', toolUseId: 'call_1' },
    // The rerun starts executing again (sleep 10). Confirm via a new
    // progress event so we know the engine has claimed it.
    { type: 'wait-for-progress', toolUseId: 'call_1', minEvents: 2 },
    // THE BUG: at this point the LLM is NOT streaming — the rerun runs
    // "outside an LLM loop" per the user's report. `isLLMActive()` is
    // false. Escape would do nothing. Even the JS-side cancel flow
    // (`cancelAllPendingApprovals` + `actionExecutor.cancelAllActions`)
    // doesn't tell the worker to clear `activity='awaiting_llm'`, so the
    // tool-action's state never reaches 'cancelled'.
    { type: 'cancel-via-ui-flow', timeoutMs: 4000 }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'Run it' },
    { type: 'assistant', content: 'Running.' },
    {
      type: 'tool-action',
      toolName: 'bash',
      state: 'cancelled'
    }
  ]
};

// ============================================================================
// TEST 13: Re-running an answered question re-asks it
// ============================================================================

/**
 * Production scenario: the LLM asks a question via AskUserQuestion, the user
 * answers it, then clicks "Re-run" on that question item. The expectation is
 * that the question is asked AGAIN (returns to its pending/approval state),
 * letting the user give a fresh answer.
 *
 * The bug: `handleRetryToolAction` always reset the tool to state='approved'
 * and cleared only the result — leaving the prior `approvalResponse` in place.
 * For a tool whose RESULT *is* the user's input (AskUserQuestion), this made
 * the re-run silently re-execute with the same answer and continue the LLM
 * loop, never re-prompting.
 *
 * The fix: tools that override `rerunRequiresReprompt()` are reset to
 * state='pending' with both `result` and `approvalResponse` cleared, so the
 * question form reappears. Pre-fix the `wait-for-approval` after the re-run
 * times out (the tool auto-completes with 'Option A' instead of re-asking).
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const rerunQuestionReasksTest = {
  name: 'rerun-question-reasks',
  description: 'Re-running an answered AskUserQuestion re-asks it instead of reusing the prior answer',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'AskUserQuestion',
      {
        questions: [{
          question: 'Which approach should we use?',
          header: 'Approach',
          options: [
            { label: 'Option A', description: 'First approach' },
            { label: 'Option B', description: 'Second approach' }
          ],
          multiSelect: false
        }]
      },
      'Let me ask about the approach.'
    ),
    textResponse('You chose A.'),
    textResponse('You chose B.')
  ],

  operations: [
    { type: 'send-message', message: 'Help me decide' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    // First answer: Option A.
    { type: 'approve', toolUseId: 'call_1', response: JSON.stringify({ Approach: 'Option A' }) },
    // Re-run the answered question. It must RE-ASK, not silently reuse 'Option A'.
    { type: 'rerun-tool-no-wait', toolUseId: 'call_1' },
    // The question must be pending again — this times out (test fails) if the
    // re-run auto-completed with the cached answer.
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    // The re-asked form must re-render WITH its questions and option buttons.
    // This guards the "0 questions" regression: a re-ask that resets to
    // 'pending' while leaving stale post-completion displayData rendered an
    // empty form (no .question-group / .question-option-btn).
    { type: 'assert-dom', selector: '.multi-question-form' },
    { type: 'assert-dom', selector: '.question-group' },
    { type: 'assert-dom', selector: '.question-option-btn', minCount: 2 },
    // Answer differently this time: Option B.
    { type: 'approve', toolUseId: 'call_1', response: JSON.stringify({ Approach: 'Option B' }) }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'Help me decide' },
    { type: 'assistant', content: 'Let me ask about the approach.' },
    {
      type: 'tool-action',
      toolUseId: '$TOOL_1',
      toolName: 'AskUserQuestion',
      // The re-asked answer (Option B) wins — not the original Option A.
      state: 'completed',
      result: { content: 'Approach: Option B', isError: false }
    }
  ],

  customAssertions: (conversation) => {
    const items = conversation.rootMessageThread.items;
    const toolActions = items.filter(i => i.get('type') === 'tool-action');
    if (toolActions.length !== 1) {
      throw new Error(`Expected exactly 1 tool-action, got ${toolActions.length}`);
    }
    const errorItems = items.filter(i => i.get('type') === 'error');
    if (errorItems.length !== 0) {
      throw new Error(`Expected 0 error items, got ${errorItems.length}`);
    }
  }
};

// ============================================================================
// TEST 14: Re-run while the LLM is mid-reply stops the turn first
// ============================================================================

/**
 * The user clicks "Re-run command" on a completed tool while the turn is still
 * live — here the LLM is mid-reply about that tool's output. A re-run means "go
 * again from here", which the live turn contradicts, so the turn is stopped
 * first and the re-run then drives a fresh LLM call of its own.
 *
 * Without the stop, the worker resets and re-executes the tool but drops the
 * re-run's LLM request (the thread is still calling_llm), and the turn never
 * comes back to read the new result: the re-run's wait for a completed turn
 * times out with the mock still parked.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const rerunDuringLiveTurnTest = {
  name: 'rerun-during-live-turn',
  description: 'Re-running a tool while the LLM is mid-reply stops the turn, re-runs, and continues',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash',
      { command: 'env echo "hello"' },
      'Running command.'
    ),
    // The reply to the first result parks mid-stream: the live turn the
    // re-run lands in.
    textResponse('Reading the first result.', { pauseBeforeReturn: true }),
    // The re-run's own LLM call.
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message-no-wait', message: 'Run it' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'approve-no-wait', toolUseId: 'call_1' },
    { type: 'wait-for-mock-paused' },
    { type: 'rerun-tool', toolUseId: 'call_1' }
  ],

  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user', content: 'Run it' },
    { type: 'assistant', content: 'Running command.' },
    {
      type: 'tool-action',
      toolUseId: '$TOOL_1',
      toolName: 'bash',
      state: 'completed',
      result: { content: 'hello', isError: false }
    },
    { type: 'assistant', content: 'Reading the first result.' },
    { type: 'assistant', content: 'Done.' }
  ]
};

// Export all tests
export const tests = [
  rerunCompletedToolTest,
  rerunInterruptedToolTest,
  editToolCompletesTest,
  editToolFailsGracefullyTest,
  rerunCancelledToolNoDuplicateTest,
  cancelledToolReachesTerminalStateTest,
  rerunCompletesExactlyOnceTest,
  cancelRerunCycleTest,
  rerunStreamingExecutesOnceTest,
  rerunGrepToolTest,
  rerunBatchGrepToolTest,
  rerunBashDifferentOutputTest,
  cancelDuringRerunTest,
  rerunQuestionReasksTest,
  rerunDuringLiveTurnTest
];
