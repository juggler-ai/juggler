//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Thread Cancellation & Auto-Resume
 *
 * Tests that cancellation propagates correctly through nested threads:
 * - Escape/cancel during a thread stops all loops (no auto-resume)
 * - Tool denial in a thread stops everything (denial = user said "no")
 * - Escape during pending approval stops all loops (no auto-resume)
 * - Cancelled threads can be manually resumed, triggering auto-resume of parents
 * - Denial in thread does NOT auto-resume parent with fabricated result
 * @module integration-tests/thread-cancellation-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';
import { itemRunRecord } from '../../js/model/thread-alias.js';
import { getThreadStatus } from '../../js/utils/thread-display.js';

/**
 * The command every case here cancels. It says when it has started, and the
 * cancel waits for that (`wait-for-action-output`), so the cancel lands on a
 * command that is running rather than one still being spawned. It then runs
 * far longer than any cancel takes to arrive, however slow the core: a command
 * that could finish on its own first would turn "cancelled" into "completed"
 * whenever the cancel was slow, and the case would be testing the core.
 */
const CANCELLED_COMMAND = 'env echo "started"; sleep 120';

/**
 * Assert a thread's open run was settled as cancelled — the signal a parked
 * parent reads to stop waiting. A stop writes no summary, so this is the only
 * record that the run is over.
 * @param {any} conversation - The conversation under test.
 * @param {string} label - Test name, for the failure message.
 * @returns {void}
 */
function assertRunCancelled(conversation, label) {
  const thread = conversation.rootMessageThread.items.find(
    (/** @type {any} */ it) => it.get?.('type') === 'thread'
  );
  if (!thread) throw new Error(`${label}: thread item missing`);
  const sub = thread.get('items');
  const arr = sub && typeof sub.toArray === 'function' ? sub.toArray() : [];
  const statuses = arr
    .filter((/** @type {any} */ it) => it.get?.('type') === 'user')
    .map((/** @type {any} */ it) => it.get('runStatus'));
  if (!statuses.includes('cancelled')) {
    throw new Error(`${label}: expected a run settled as 'cancelled', got runStatus values [${statuses}]`);
  }
  if (thread.get('result')) {
    throw new Error(`${label}: a stop must not write a summary, got '${thread.get('result')}'`);
  }
}

// ============================================================================
// TEST 1: Cancel during thread stops all loops
// ============================================================================

/**
 * Root creates thread → thread runs bash → user hits Escape while focused IN the
 * sub-thread → the worker turn is interrupted but the thread's run stays OPEN
 * (unsettled, no summary). An own-vantage interrupt never settles the run, so
 * the composer stays in the child column and the user can carry on with it.
 * No further LLM responses are consumed (the worker is idle; nothing re-drives).
 *
 * Mock responses:
 *   1. Root: create_thread
 *   2. Thread: bash tool call (will be interrupted)
 *   3. Thread: should NOT be consumed
 *   4. Root: should NOT be consumed
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const cancelDuringThreadTest = {
  name: 'interrupt-during-thread-keeps-open',
  description: 'Escape inside a sub-thread interrupts it but leaves it open (no result)',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Run task', prompt: 'Execute bash' }),
    toolUseResponse('call_2', 'bash',
      { command: CANCELLED_COMMAND },
      'Running command.'
    ),
    textResponse('Thread should not see this.'),
    textResponse('Root should not see this.')
  ],

  operations: [
    { type: 'send-message', message: 'Start task' },
    { type: 'wait-for-thread-approval', toolUseId: 'call_2' },
    { type: 'start-capture-progress', toolUseId: 'call_2' },
    { type: 'approve-thread-tool-no-wait', toolUseId: 'call_2' },
    { type: 'wait-for-progress', toolUseId: 'call_2', minEvents: 1 },
    { type: 'wait-for-action-output', toolUseId: 'call_2', contains: 'started' },
    { type: 'cancel' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Start task' },
      // Sub-thread interrupted but still OPEN — no result stamped.
      { type: 'thread', itemId: '$ITEM_3' }
    ]
  },

  customAssertions: (conversation) => {
    const thread = conversation.rootMessageThread.items.find(
      (/** @type {any} */ it) => it.get?.('type') === 'thread'
    );
    if (!thread) throw new Error('interrupt-during-thread-keeps-open: thread item missing');
    // Open: the interrupted thread carries no result.
    const result = thread.get('result');
    if (typeof result === 'string' && result.length > 0) {
      throw new Error(
        `interrupt-during-thread-keeps-open: a summary was written (result='${result}') — ` +
				'an own-vantage interrupt must leave the run open and write nothing'
      );
    }
    // The running tool was cancelled (worker-truth interrupt).
    const sub = thread.get('items');
    const arr = sub && typeof sub.toArray === 'function' ? sub.toArray() : [];
    const tool = arr.find((/** @type {any} */ it) => it.get?.('type') === 'tool-action');
    if (!tool) throw new Error('interrupt-during-thread-keeps-open: tool-action missing in thread');
    if (tool.get('state') !== 'cancelled') {
      throw new Error(
        `interrupt-during-thread-keeps-open: expected tool state 'cancelled', got '${tool.get('state')}'`
      );
    }
    // Because the sub-thread is still open, the root remains "busy" — so the
    // composer stays in the child column (the user keeps interacting with it),
    // which is the whole point of interrupt-not-close.
    if (!conversation.rootMessageThread.hasBusyItems()) {
      throw new Error(
        'interrupt-during-thread-keeps-open: root is not busy — the open sub-thread ' +
				'should keep the composer in the child column'
      );
    }
    // An open run with nothing driving it reads as 'unfinished', not 'idle'.
    // The root's Continue is hidden while the run is open, so this tile carries
    // the only way out: the status the Stop button is gated on.
    const items = conversation.rootMessageThread.items;
    const status = getThreadStatus(thread, null, items);
    if (status.kind !== 'unfinished') {
      throw new Error(
        `interrupt-during-thread-keeps-open: tile reports '${status.kind}' ('${status.message}'), ` +
				'want \'unfinished\' — a stopped mid-run thread must not read as resting'
      );
    }
    if (status.spinner || status.showSummary) {
      throw new Error(
        'interrupt-during-thread-keeps-open: an unfinished tile shows neither a spinner nor a summary'
      );
    }
  }
};

// ============================================================================
// TEST 2: Deny tool in thread stops everything
// ============================================================================

/**
 * Root creates thread → thread requests bash → user denies → EVERYTHING stops.
 * Denial = the user explicitly said "no". The thread should NOT get a fabricated
 * result, and the parent should NOT continue or auto-resume.
 *
 * This is the critical fix: previously, denial would fabricate a thread result
 * from the last assistant text and the parent would continue with that result,
 * consuming the next LLM response. Now denial propagates as cancellation.
 *
 * Mock responses:
 *   1. Root: create_thread
 *   2. Thread: bash tool (will be denied)
 *   3. Root: should NOT be consumed (denial stops everything)
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const denyToolInThreadTest = {
  name: 'deny-tool-in-thread-stops-all',
  description: 'Deny tool in thread stops thread AND parent (no auto-resume)',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Run task', prompt: 'Execute bash' }),
    toolUseResponse('call_2', 'bash',
      { command: 'env echo "do something"' },
      'About to run command.'
    ),
    // This response should NOT be consumed — denial stops everything
    textResponse('This should never appear.')
  ],

  operations: [
    { type: 'send-message', message: 'Start work' },
    { type: 'wait-for-thread-approval', toolUseId: 'call_2' },
    { type: 'deny-thread-tool', toolUseId: 'call_2' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Start work' },
      // Thread has NO result — denial does not fabricate a result
      { type: 'thread', itemId: '$ITEM_3' }
      // No assistant message — parent did NOT continue
    ]
  }
};

// ============================================================================
// TEST 3: Cancel during thread pending approval
// ============================================================================

/**
 * Thread has pending bash approval → user hits Escape while focused in the
 * sub-thread → the pending approval is cancelled and the worker stops, but the
 * sub-thread stays OPEN (no result), so the user can keep interacting with it.
 *
 * Mock responses:
 *   1. Root: create_thread
 *   2. Thread: bash tool (pending approval, will be cancelled)
 *   3. Thread: should NOT be consumed
 *   4. Root: should NOT be consumed
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const cancelDuringThreadApprovalTest = {
  name: 'interrupt-during-thread-approval-keeps-open',
  description: 'Escape while a sub-thread awaits approval interrupts it but leaves it open',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Run task', prompt: 'Execute bash' }),
    toolUseResponse('call_2', 'bash',
      { command: 'env echo "hello"' },
      'Need to run this.'
    ),
    textResponse('Should not appear.'),
    textResponse('Root should not appear.')
  ],

  operations: [
    { type: 'send-message', message: 'Go' },
    { type: 'wait-for-thread-approval', toolUseId: 'call_2' },
    // Cancel while approval is pending (simulates Escape inside the sub-thread)
    { type: 'cancel' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Go' },
      // Sub-thread interrupted but still OPEN — no result stamped.
      { type: 'thread', itemId: '$ITEM_3' }
    ]
  },

  customAssertions: (conversation) => {
    const thread = conversation.rootMessageThread.items.find(
      (/** @type {any} */ it) => it.get?.('type') === 'thread'
    );
    if (!thread) throw new Error('interrupt-during-thread-approval-keeps-open: thread item missing');
    const result = thread.get('result');
    if (typeof result === 'string' && result.length > 0) {
      throw new Error(
        `interrupt-during-thread-approval-keeps-open: a summary was written (result='${result}') — ` +
				'an own-vantage interrupt must leave the thread open'
      );
    }
  }
};

// ============================================================================
// TEST 4: Thread auto-resume parent (manual resume after cancel)
// ============================================================================

/**
 * Root creates thread → thread is interrupted (Escape inside it leaves it OPEN)
 * → user continues it directly (interrupt leaves no summary behind
 * the thread) → thread completes → parent auto-resumes and continues. This is
 * the improved UX: interrupting a sub-thread leaves you in it, ready to type the
 * next message.
 *
 * Mock responses:
 *   1. Root: create_thread
 *   2. Thread (first run): bash tool (will be interrupted)
 *   3. Thread (resumed): text "Task done"
 *   4. Root (auto-resumed): text "All finished."
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadAutoResumeParentTest = {
  name: 'thread-auto-resume-parent',
  description: 'Continuing an interrupted (still-open) thread completes it and auto-resumes parent',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Do task', prompt: 'Run it' }),
    toolUseResponse('call_2', 'bash',
      { command: CANCELLED_COMMAND },
      'Running.'
    ),
    // After interrupt + continue, thread gets this:
    textResponse('Task done'),
    // Parent auto-resumes and gets this:
    textResponse('All finished.')
  ],

  operations: [
    { type: 'send-message', message: 'Begin' },
    { type: 'wait-for-thread-approval', toolUseId: 'call_2' },
    { type: 'start-capture-progress', toolUseId: 'call_2' },
    { type: 'approve-thread-tool-no-wait', toolUseId: 'call_2' },
    { type: 'wait-for-progress', toolUseId: 'call_2', minEvents: 1 },
    { type: 'wait-for-action-output', toolUseId: 'call_2', contains: 'started' },
    // Interrupt during thread execution — the thread stops, and a stopped
    // thread still takes work.
    { type: 'cancel' },
    // Continue the stopped thread directly.
    { type: 'send-thread-message', message: 'Continue please' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Begin' },
      { type: 'thread', itemId: '$ITEM_3', result: 'Task done' },
      { type: 'assistant', content: 'All finished.' }
    ]
  }
};

// ============================================================================
// TEST 4b: Root-vantage stop settles the sub-thread's run
// ============================================================================

/**
 * Same setup as the interrupt test, but the user stops from the ROOT/parent
 * vantage (Escape while focused on the root, or the root footer Stop). From the
 * parent's vantage the running sub-thread is "below" and is stopped with it:
 * the worker turn is preempted, the tool is cancelled, and the sub-thread's run
 * settles as cancelled so the composer returns to the root column.
 *
 * Mock responses:
 *   1. Root: create_thread
 *   2. Thread: bash tool call (will be cancelled)
 *   3. Thread: should NOT be consumed
 *   4. Root: should NOT be consumed
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const cancelFromRootSettlesThreadTest = {
  name: 'root-vantage-stop-settles-subthread',
  description: 'Stopping from the root vantage settles the running sub-thread\'s run as cancelled',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Run task', prompt: 'Execute bash' }),
    toolUseResponse('call_2', 'bash',
      { command: CANCELLED_COMMAND },
      'Running command.'
    ),
    textResponse('Thread should not see this.'),
    textResponse('Root should not see this.')
  ],

  operations: [
    { type: 'send-message', message: 'Start task' },
    { type: 'wait-for-thread-approval', toolUseId: 'call_2' },
    { type: 'start-capture-progress', toolUseId: 'call_2' },
    { type: 'approve-thread-tool-no-wait', toolUseId: 'call_2' },
    { type: 'wait-for-progress', toolUseId: 'call_2', minEvents: 1 },
    { type: 'wait-for-action-output', toolUseId: 'call_2', contains: 'started' },
    { type: 'cancel-from-root' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Start task' },
      // Stopped from the root vantage: the run is settled, and no summary was
      // invented for it.
      { type: 'thread', itemId: '$ITEM_3' }
    ]
  },

  customAssertions: (conversation) => {
    assertRunCancelled(conversation, 'root-vantage-stop-settles-subthread');
    // Settled run → root no longer busy → composer returns to root column.
    if (conversation.rootMessageThread.hasBusyItems()) {
      throw new Error(
        'root-vantage-stop-settles-subthread: root still busy after root-vantage stop — ' +
				'the sub-thread run did not settle'
      );
    }
  }
};

// ============================================================================
// TEST 5: Deny in thread does NOT auto-resume parent
// ============================================================================

/**
 * Root creates thread → thread calls two tools → first succeeds, second denied
 * → thread stops → parent does NOT auto-resume (no fabricated result).
 *
 * This tests the specific edge case where the thread had prior assistant text
 * that could be misused as a fabricated "result". The parent must NOT continue.
 *
 * Mock responses:
 *   1. Root: create_thread
 *   2. Thread: bash tool (auto-approved, succeeds)
 *   3. Thread: bash tool (requires approval, will be denied)
 *   4. Root: should NOT be consumed
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const denyInThreadNoAutoResumeTest = {
  name: 'deny-in-thread-no-auto-resume',
  description: 'Tool denial in thread does not auto-resume parent with fabricated result',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Multi-step task', prompt: 'Do steps' }),
    toolUseResponse('call_2', 'bash',
      { command: 'env echo "dangerous thing"' },
      'First I need to run this dangerous command.'
    ),
    // This response should NOT be consumed — denial stops everything
    textResponse('Parent should NOT see this.')
  ],

  operations: [
    { type: 'send-message', message: 'Do multi-step' },
    { type: 'wait-for-thread-approval', toolUseId: 'call_2' },
    // Deny the tool
    { type: 'deny-thread-tool', toolUseId: 'call_2' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Do multi-step' },
      // Thread has NO result — even though there was prior assistant text
      { type: 'thread', itemId: '$ITEM_3' }
      // No assistant message — parent did NOT auto-resume
    ]
  }
};

// ============================================================================
// TEST 6: Explicit cancel-thread settles the thread's run (worker-truth)
// ============================================================================

/**
 * The user creates a thread, sends a message that runs a long bash tool, then
 * hits the thread's stop affordance (conversation.cancelThread). Expected:
 *   1. The in-flight worker turn is cancelled and the worker goes idle —
 *      cancelThread is worker-truth, not a bare result write.
 *   2. The running tool settles to state='cancelled' (no orphaned running).
 *   3. The thread's run settles as cancelled — the signal a parked parent reads
 *      to stop waiting — with no summary invented for it.
 *
 * RED before the fix: the old cancelThread only wrote a result and never stopped
 * the worker, so the sleep-10 bash kept running and the processing status never
 * reached 'idle' within the test window.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const cancelThreadSettlesRunTest = {
  name: 'cancel-thread-settles-run',
  description: 'Explicit cancelThread stops the worker and settles the thread\'s run as cancelled',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash',
      { command: CANCELLED_COMMAND },
      'Running long command.'
    ),
    // Must NOT be consumed — cancel stops the loop.
    textResponse('Should not appear.')
  ],

  operations: [
    // User-created (empty) thread, then a message that runs the long tool.
    { type: 'run-command', command: 'thread' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } },
    { type: 'send-thread-message-no-wait', message: 'Run long command' },
    { type: 'wait-for-thread-approval', toolUseId: 'call_1' },
    { type: 'start-capture-progress', toolUseId: 'call_1' },
    { type: 'approve-thread-tool-no-wait', toolUseId: 'call_1' },
    { type: 'wait-for-progress', toolUseId: 'call_1', minEvents: 1 },
    { type: 'wait-for-action-output', toolUseId: 'call_1', contains: 'started' },
    // Explicit per-thread stop. Post-fix this cancels the worker turn and
    // settles the thread.
    { type: 'cancel-thread' },
    { type: 'wait-for-state', condition: { processingStatus: 'idle' } }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'thread', itemId: '$ITEM_2' }
    ]
  },

  customAssertions: (conversation) => {
    assertRunCancelled(conversation, 'cancel-thread-settles-run');
    const thread = conversation.rootMessageThread.items.find(
      (/** @type {any} */ it) => it.get?.('type') === 'thread'
    );
    if (!thread) throw new Error('cancel-thread-settles-run: thread item missing');
    const sub = thread.get('items');
    const arr = sub && typeof sub.toArray === 'function' ? sub.toArray() : [];
    const tool = arr.find((/** @type {any} */ it) => it.get?.('type') === 'tool-action');
    if (!tool) throw new Error('cancel-thread-settles-run: tool-action missing in thread');
    const state = tool.get('state');
    if (state !== 'cancelled') {
      throw new Error(
        `cancel-thread-settles-run: expected tool state 'cancelled', got '${state}' ` +
				'(worker turn was not cancelled)'
      );
    }
  }
};

// ============================================================================
// TEST 7: Stop affordance on the parent thread tile
// ============================================================================

/**
 * While a sub-thread is running, its PARENT tile (in the root column) must
 * expose a stop button — not only the drilled-in column header. Clicking it
 * routes to the unified cancel (cancel-thread-requested → conversation.cancelThread),
 * settling the thread's run as cancelled.
 *
 * RED before the fix: no `.thread-stop-btn` is rendered on the tile.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const threadTileStopButtonTest = {
  name: 'thread-tile-stop-button',
  description: 'The parent thread tile exposes a stop button that settles the running thread',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Run task', prompt: 'Execute bash' }),
    toolUseResponse('call_2', 'bash',
      { command: CANCELLED_COMMAND },
      'Running command.'
    ),
    textResponse('Thread should not see this.'),
    textResponse('Root should not see this.')
  ],

  operations: [
    { type: 'send-message', message: 'Start task' },
    { type: 'wait-for-thread-approval', toolUseId: 'call_2' },
    { type: 'start-capture-progress', toolUseId: 'call_2' },
    { type: 'approve-thread-tool-no-wait', toolUseId: 'call_2' },
    { type: 'wait-for-progress', toolUseId: 'call_2', minEvents: 1 },
    { type: 'wait-for-action-output', toolUseId: 'call_2', contains: 'started' },
    // The running tile must show a stop button (scoped to the root column).
    { type: 'assert-dom', selector: 'thread-message .thread-stop-btn' },
    // Clicking it settles the thread via the unified cancel.
    { type: 'click-dom', selector: 'thread-message .thread-stop-btn' },
    { type: 'wait-for-state', condition: { completedThreadCount: 1 } }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Start task' },
      { type: 'thread', itemId: '$ITEM_3' }
    ]
  },

  customAssertions: (conversation) => {
    assertRunCancelled(conversation, 'thread-tile-stop-button');
  }
};

// ============================================================================
// TEST 8: Resuming a thread whose run was cancelled reports to its caller
// ============================================================================

/**
 * Root creates a thread → the thread is stopped from the root vantage, which
 * SETTLES its run as cancelled → the user picks it back up by typing into it →
 * the thread finishes → the call that started it reports that answer, and the
 * parent resumes on it.
 *
 * The run the resume starts is one no call named: it is recorded on a plain user
 * message with no tool-use coordinates, so nothing in the parent stands for it
 * except the item still waiting on the thread. Left to the cancelled record, the
 * tile shows "[The run was cancelled before it finished.]" for good and the
 * parent is answered with it while the thread sits there holding the real reply.
 *
 * The sibling case is thread-auto-resume-parent, where the stop came from inside
 * the thread and left the run OPEN — there the resume is absorbed into the run
 * that was already going.
 *
 * Mock responses:
 *   1. Root: create_thread
 *   2. Thread: bash tool call (will be cancelled)
 *   3. Thread (resumed by hand): text "Task done"
 *   4. Root (auto-resumed): text "All finished."
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const resumeAfterCancelReportsToCallerTest = {
  name: 'thread-resume-after-cancel-parent',
  description: 'Resuming a thread whose run settled as cancelled reports the new answer to the call that made it',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Do task', prompt: 'Run it' }),
    toolUseResponse('call_2', 'bash',
      { command: CANCELLED_COMMAND },
      'Running.'
    ),
    textResponse('Task done'),
    textResponse('All finished.')
  ],

  operations: [
    { type: 'send-message', message: 'Begin' },
    { type: 'wait-for-thread-approval', toolUseId: 'call_2' },
    { type: 'start-capture-progress', toolUseId: 'call_2' },
    { type: 'approve-thread-tool-no-wait', toolUseId: 'call_2' },
    { type: 'wait-for-progress', toolUseId: 'call_2', minEvents: 1 },
    { type: 'wait-for-action-output', toolUseId: 'call_2', contains: 'started' },
    // Stopped from the root vantage: unlike an interrupt from inside the
    // thread, this settles the run as cancelled.
    { type: 'cancel-from-root' },
    // The user picks it back up.
    { type: 'send-thread-message', message: 'Keep going' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Begin' },
      { type: 'thread', itemId: '$ITEM_3', result: 'Task done' },
      { type: 'assistant', content: 'All finished.' }
    ]
  },

  customAssertions: (conversation) => {
    const items = conversation.rootMessageThread.items;
    const thread = items.find((/** @type {any} */ it) => it.get?.('type') === 'thread');
    if (!thread) throw new Error('thread-resume-after-cancel-parent: thread item missing');
    const record = itemRunRecord(thread, items);
    if (record?.result !== 'Task done') {
      throw new Error(
        'thread-resume-after-cancel-parent: the call that started the thread reports ' +
				`${JSON.stringify(record)}, want the resumed run's reply`
      );
    }
    if (getThreadStatus(thread, null, items).showSummary !== true) {
      throw new Error('thread-resume-after-cancel-parent: the tile does not show the thread\'s answer');
    }
  }
};

// ============================================================================
// TEST 10: Continue on a cancelled thread reports to the caller
// ============================================================================

/**
 * The same recovery as thread-resume-after-cancel-parent, but picked back up
 * with the thread's Continue button rather than by typing into it.
 *
 * The two gestures reach the new run by different routes, which is why both are
 * pinned. Typing appends a user message, and that message IS the new run's
 * record. Continue has no message of its own, so it appends a continuation
 * marker for the run to be recorded on. Without a record the thread never reads
 * as live, never runs, and the parent is answered "[The run was cancelled before
 * it finished.]" with the work sitting undone.
 *
 * Mock responses:
 *   1. Root: create_thread
 *   2. Thread: bash tool call (will be cancelled)
 *   3. Thread (continued): text "Task done"
 *   4. Root (auto-resumed): text "All finished."
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const continueAfterCancelReportsToCallerTest = {
  name: 'thread-continue-after-cancel-parent',
  description: 'Continue on a thread whose run settled as cancelled reports the new answer to the call that made it',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Do task', prompt: 'Run it' }),
    toolUseResponse('call_2', 'bash',
      { command: CANCELLED_COMMAND },
      'Running.'
    ),
    textResponse('Task done'),
    textResponse('All finished.')
  ],

  operations: [
    { type: 'send-message', message: 'Begin' },
    { type: 'wait-for-thread-approval', toolUseId: 'call_2' },
    { type: 'start-capture-progress', toolUseId: 'call_2' },
    { type: 'approve-thread-tool-no-wait', toolUseId: 'call_2' },
    { type: 'wait-for-progress', toolUseId: 'call_2', minEvents: 1 },
    { type: 'wait-for-action-output', toolUseId: 'call_2', contains: 'started' },
    // Stopped from the root vantage, which settles the run as cancelled.
    { type: 'cancel-from-root' },
    // The user opens the stopped thread and clicks Continue.
    { type: 'continue-sub-thread', threadIndex: 0 },
    // Continue only starts the thread's turn; the parent's follows it.
    { type: 'wait-for-idle' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Begin' },
      { type: 'thread', itemId: '$ITEM_3', result: 'Task done' },
      { type: 'assistant', content: 'All finished.' }
    ]
  },

  customAssertions: (conversation) => {
    const items = conversation.rootMessageThread.items;
    const thread = items.find((/** @type {any} */ it) => it.get?.('type') === 'thread');
    if (!thread) throw new Error('thread-continue-after-cancel-parent: thread item missing');
    const record = itemRunRecord(thread, items);
    if (record?.result !== 'Task done') {
      throw new Error(
        'thread-continue-after-cancel-parent: the call that started the thread reports ' +
				`${JSON.stringify(record)}, want the continued run's reply`
      );
    }
    if (getThreadStatus(thread, null, items).showSummary !== true) {
      throw new Error('thread-continue-after-cancel-parent: the tile does not show the thread\'s answer');
    }
  }
};

// ============================================================================
// TEST 11: The unfinished tile carries the way out
// ============================================================================

/**
 * An own-vantage interrupt leaves the run OPEN, which is deliberate — but it
 * also leaves the parent parked on it, and while the run is open the root
 * column has no Continue (hasBusyItems), no Stop (nothing is processing) and
 * Escape does nothing (no activity to cancel). Every affordance that could move
 * the conversation on is gone from the column the user is looking at.
 *
 * So the tile carries the way out: a thread stopped mid-run reads as
 * 'unfinished' rather than 'idle', which is what gates its Stop button. That
 * Stop settles the run — releasing the parked caller and bringing the root's
 * Continue back — without the interrupt itself having to settle anything.
 *
 * Mock responses:
 *   1. Root: create_thread
 *   2. Thread: bash tool call (will be interrupted)
 *   3. Thread: should NOT be consumed
 *   4. Root: should NOT be consumed
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const unfinishedTileStopSettlesRunTest = {
  name: 'unfinished-tile-stop-settles-run',
  description: 'A thread stopped mid-run keeps a Stop on its tile, and it settles the run',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Run task', prompt: 'Execute bash' }),
    toolUseResponse('call_2', 'bash',
      { command: CANCELLED_COMMAND },
      'Running command.'
    ),
    textResponse('Thread should not see this.'),
    textResponse('Root should not see this.')
  ],

  operations: [
    { type: 'send-message', message: 'Start task' },
    { type: 'wait-for-thread-approval', toolUseId: 'call_2' },
    { type: 'start-capture-progress', toolUseId: 'call_2' },
    { type: 'approve-thread-tool-no-wait', toolUseId: 'call_2' },
    { type: 'wait-for-progress', toolUseId: 'call_2', minEvents: 1 },
    { type: 'wait-for-action-output', toolUseId: 'call_2', contains: 'started' },
    // Own-vantage interrupt: the run is left open, and nothing is driving it.
    { type: 'cancel' },
    // The tile still offers a Stop — the run is open, so there is a caller to
    // release. An 'idle' tile would render none.
    { type: 'assert-dom', selector: 'thread-message .thread-stop-btn' },
    { type: 'click-dom', selector: 'thread-message .thread-stop-btn' },
    { type: 'wait-for-state', condition: { completedThreadCount: 1 } }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Start task' },
      { type: 'thread', itemId: '$ITEM_3' }
    ]
  },

  customAssertions: (conversation) => {
    assertRunCancelled(conversation, 'unfinished-tile-stop-settles-run');
    // Settled → the root is free again, so its Continue comes back.
    if (conversation.rootMessageThread.hasBusyItems()) {
      throw new Error(
        'unfinished-tile-stop-settles-run: root still busy after settling the run — ' +
				'the parent column stays without a Continue'
      );
    }
  }
};

// ============================================================================
// TEST 12: A resume after the parent has read the answer appends
// ============================================================================

/**
 * The same human resume as thread-resume-after-cancel-parent, but this time the
 * parent has already READ the call's answer and moved on. Rewriting it now would
 * slide every message the parent has sent since, cold-start a stateful provider,
 * and leave the parent's own reply standing after a result that contradicts it —
 * so the new run arrives as a RECEIPT appended at the end instead.
 *
 * The receipt is not a second call: it renders as a tile pointing at the same
 * thread, and reaches the model as a user-role message. Minting a tool_use for
 * it would have the wire claim the model chose to re-run the thread, and on
 * claudecode would cold-start every resume, since the CLI's own transcript has
 * no such call for the result to answer.
 *
 * The receipt does not wake the parent: it is news about work the user did in
 * another column, not the answer to a call, so the parent reads it on its next
 * turn rather than spending one nobody asked for. That ordering is what the mock
 * budget here pins — a spurious turn would eat the last response and leave the
 * final send with nothing.
 *
 * Mock responses:
 *   1. Root: create_thread
 *   2. Thread: text "First answer"
 *   3. Root: text "All finished."   ← the parent reads the call's answer here
 *   4. Thread (resumed by hand): text "Second answer"
 *   5. Root: text "Understood."     ← the turn that finally reads the receipt
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const resumeAfterAnswerAppendsReceiptTest = {
  name: 'thread-resume-after-answer-appends',
  description: 'Resuming a thread whose answer the parent already read appends a receipt instead of rewriting it',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', { goal: 'Do task', prompt: 'Run it' }),
    textResponse('First answer'),
    textResponse('All finished.'),
    textResponse('Second answer'),
    textResponse('Understood.')
  ],

  operations: [
    { type: 'send-message', message: 'Begin' },
    { type: 'wait-for-idle' },
    // The thread ran, the parent answered on it and came to rest. From here the
    // call's result is committed history.
    { type: 'send-thread-message', message: 'Keep going' },
    { type: 'wait-for-idle' },
    // The parent's next turn is the user's, and it carries the receipt.
    { type: 'send-message', message: 'Anything else?' },
    { type: 'wait-for-idle' },
    {
      type: 'validate-context-snapshot',
      expectedMessages: [
        { role: 'user', contentIncludes: 'continued in the thread' },
        { role: 'user', contentIncludes: 'Second answer' }
      ],
      expectedContent: ['First answer']
    }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Begin' },
      { type: 'thread', itemId: '$ITEM_3', result: 'Second answer' },
      { type: 'assistant', content: 'All finished.' },
      { type: 'thread' },
      { type: 'user', content: 'Anything else?' },
      { type: 'assistant', content: 'Understood.' }
    ]
  },

  customAssertions: (conversation) => {
    const label = 'thread-resume-after-answer-appends';
    const items = conversation.rootMessageThread.items;
    const threads = items.filter((/** @type {any} */ it) => it.get?.('type') === 'thread');
    if (threads.length !== 2) {
      throw new Error(`${label}: expected the call's item and one receipt, got ${threads.length} thread items`);
    }
    const [call, receipt] = threads;

    const answered = itemRunRecord(call, items);
    if (answered?.result !== 'First answer') {
      throw new Error(
        `${label}: the call the parent has already read now reports ` +
				`${JSON.stringify(answered)}, want its own run's reply`
      );
    }
    if (call.get('runResultFed') !== true) {
      throw new Error(`${label}: the call's item was never marked as read, so nothing was protecting it`);
    }

    if (receipt.get('aliasOf') !== call.get('itemId')) {
      throw new Error(`${label}: the receipt must point at the thread it is a view of`);
    }
    if (receipt.get('runToolUseId')) {
      throw new Error(`${label}: a receipt must claim no call — nobody made one`);
    }
    const resumed = itemRunRecord(receipt, items);
    if (resumed?.result !== 'Second answer') {
      throw new Error(`${label}: the receipt reports ${JSON.stringify(resumed)}, want the resumed run's reply`);
    }
    if (getThreadStatus(receipt, null, items).showSummary !== true) {
      throw new Error(`${label}: the receipt tile does not show the run it stands for`);
    }
  }
};

// Export all tests
export const tests = [
  cancelDuringThreadTest,
  denyToolInThreadTest,
  cancelDuringThreadApprovalTest,
  threadAutoResumeParentTest,
  cancelFromRootSettlesThreadTest,
  denyInThreadNoAutoResumeTest,
  cancelThreadSettlesRunTest,
  threadTileStopButtonTest,
  resumeAfterCancelReportsToCallerTest,
  continueAfterCancelReportsToCallerTest,
  unfinishedTileStopSettlesRunTest,
  resumeAfterAnswerAppendsReceiptTest
];
