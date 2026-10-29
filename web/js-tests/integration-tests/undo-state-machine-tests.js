//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: undo / engine state-machine interaction
 *
 * Reproduces a class of bugs where the engine's tool-action reducer
 * (`reconcileNestedTools` / `handleNewToolAction`) reacts to undo-induced
 * remote items changes and immediately re-derives state — making undo of a
 * pending approval (or of a deletion that uncovers a half-resolved
 * tool-action) silently bounce back.
 * @module integration-tests/undo-state-machine-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';
import logger from '../utilities/test-logger.js';

/**
 * Pressing undo while a tool-action is waiting for approval must keep the
 * tool-action gone — the engine must NOT re-pend it.
 *
 * Pre-fix bug: after worker.Undo() tombstones the tool-action, the engine's
 * items observer runs reconcileNestedTools, which scans for tool-actions with
 * empty state and calls handleNewToolAction. If the tool-action's revival via
 * Yjs sync exposes any empty-state intermediate (or if the engine's per-thread
 * scan trips on the synced delete event ordering), the engine writes
 * state='pending' back into the doc and the modal reappears.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const undoPendingApprovalStaysUndoneTest = {
  name: 'undo-pending-approval-stays-undone',
  description: 'Undo of a pending tool-approval removes the tool-action and keeps it removed',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'bash',
      { command: 'env echo undo-pending-test' },
      'Running command.'
    )
  ],

  operations: [
    { type: 'send-message', message: 'Run the test command' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    // Bash undo five times. With the bug live, each undo either (a)
    // only reverts a field write (state cleared, item still there)
    // AND the engine immediately re-pends it, or (b) deletes the
    // items AND the worker's stale awaiting_llm activity makes the
    // strategy loop re-fire and re-insert. Either way, the tool-action
    // keeps reappearing and undo "does nothing". With the fix, the
    // stack drains and the tool-action turn is gone.
    // Each undo is let land in the worker before the next.
    { type: 'undo' }, { type: 'ping-worker' },
    { type: 'undo' }, { type: 'ping-worker' },
    { type: 'undo' }, { type: 'ping-worker' },
    { type: 'undo' }, { type: 'ping-worker' },
    { type: 'undo' }, { type: 'ping-worker' }
  ],

  // After five undos the assistant + tool-action turn is gone. The
  // user message and the system-prompt remain (each is its own undo
  // group; with five undos there's headroom). Critically: the tool-action
  // must NOT be present.
  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' }
    ]
  },

  // Regression check via customAssertions. The expectedDocument match
  // above only checks the items it lists (golden-comparator filters
  // actual fields by expected) — that's no good here because the bug
  // leaves EXTRA items in the doc. Assert exact-length and undo-state
  // here.
  customAssertions: (/** @type {any} */ conversation) => {
    // Y.Array doesn't have filter — iterate manually.
    const yarr = conversation._doc.root.get('items');
    const items = [];
    if (yarr && yarr.toArray) {
      for (const it of yarr.toArray()) items.push(it);
    }
    const types = items.map((/** @type {any} */ it) =>
      `${it.get('type')}${it.get('state') ? ':' + it.get('state') : ''}`
    );
    const canUndo = conversation.canUndo();
    const canRedo = conversation.canRedo();
    const summary = `items=[${types.join(',')}] canUndo=${canUndo} canRedo=${canRedo}`;
    logger.debug(`[undo-pending-test] ${summary}`);
    // Bug detector #1: no tool-action should be present after undo.
    if (types.some((/** @type {string} */ t) => t.startsWith('tool-action'))) {
      throw new Error(`Tool-action re-appeared after undo: ${summary}`);
    }
    // Bug detector #2: assistant message shouldn't be present either —
    // it's part of the same undo group as the tool-action.
    if (types.some((/** @type {string} */ t) => t === 'assistant')) {
      throw new Error(`Assistant message re-appeared after undo: ${summary}`);
    }
    // Bug detector #3: redo must be available — the undone turns
    // should be on the redo stack.
    if (!canRedo) {
      throw new Error(`Expected canRedo=true after undo; ${summary}`);
    }
  },

  timeoutMs: 10000
};

/**
 * After undo, redo must restore the entire turn — assistant prose, tool-use,
 * and tool-action — with the tool-action back in `pending` state ready for
 * the user to approve.
 *
 * This is the positive twin of `undoPendingApprovalStaysUndoneTest`. It also
 * regression-guards against an over-aggressive fix that suppresses the
 * pending re-derivation on redo too: redo must NOT cause the engine to
 * re-execute the tool, only restore the recorded state.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const undoRedoRestoresPendingTest = {
  name: 'undo-redo-restores-pending',
  description: 'Redo after undo restores the tool-action in pending state',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'bash',
      { command: 'env echo undo-redo-pending' },
      'Running command.'
    )
  ],

  operations: [
    { type: 'send-message', message: 'Run the test command' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'undo' },
    { type: 'ping-worker' },
    { type: 'redo' },
    // Let the redo land before the document is checked. With the bug
    // suppressing this isn't possible; without the bug, the engine must
    // observe the redo and the doc's recorded `state` should still be
    // 'pending'.
    { type: 'ping-worker' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run the test command' },
      { type: 'assistant', content: 'Running command.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env echo undo-redo-pending' },
        state: 'pending'
      }
    ]
  },

  expectedUndoState: { canUndo: true, canRedo: false }
};

/**
 * Undoing while a tool approval is pending must not re-dispatch the LLM.
 *
 * This is the direct regression for the stale-activity bug fixed in the
 * worker's `handleUndoOrRedo` (`cmd/juggler/worker/message_handlers.go`).
 * At the approval prompt the worker is resting with activity=`awaiting_llm`:
 * once the tool resolves, the reducer should continue the LLM loop. If undo
 * rewinds the pending approval but that activity marker / queued doc-change is
 * left live, the reducer sees the post-undo doc and calls the LLM again,
 * fighting the user's undo.
 *
 * RED detector: only one mock response is queued (the original tool call). A
 * spurious post-undo re-dispatch exhausts the queue and the worker writes an
 * `error` item ("mock responses exhausted") into the doc.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const undoPendingApprovalDoesNotRedispatchTest = {
  name: 'undo-pending-approval-does-not-redispatch',
  description: 'Undoing a pending approval clears stale LLM activity and does not call the LLM again',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'bash',
      { command: 'env echo undo-pending-redispatch' },
      'Running command.'
    )
  ],

  operations: [
    { type: 'send-message', message: 'Run the test command' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'undo' },
    // The fence: once the worker has processed the undo, a stale
    // docChangeChan / awaiting_llm marker has had its chance to tickle the
    // reducer. With the regression, an `error` item appears here because
    // the mock response queue is exhausted.
    { type: 'ping-worker' }
  ],

  customAssertions: (/** @type {any} */ conversation) => {
    const yarr = conversation._doc.root.get('items');
    const items = [];
    if (yarr && yarr.toArray) {
      for (const it of yarr.toArray()) items.push(it);
    }
    const types = items.map((/** @type {any} */ it) =>
      `${it.get('type')}${it.get('state') ? ':' + it.get('state') : ''}`
    );
    const contents = items.map((/** @type {any} */ it) => String(it.get('content') || ''));
    const summary = `items=[${types.join(',')}] contents=[${contents.join(' | ')}] canRedo=${conversation.canRedo()}`;
    logger.debug(`[undo-pending-redispatch-test] ${summary}`);

    if (types.some((/** @type {string} */ t) => t.startsWith('error'))) {
      throw new Error(`LLM was re-dispatched after undo (error item present): ${summary}`);
    }
    if (contents.some((/** @type {string} */ c) => c.includes('mock responses exhausted'))) {
      throw new Error(`LLM was re-dispatched after undo (mock queue exhausted): ${summary}`);
    }
    if (!conversation.canRedo()) {
      throw new Error(`Expected canRedo=true after undo; ${summary}`);
    }
  },

  timeoutMs: 10000
};

// The auto-approved redo test below still exercises restoration of a completed
// tool result without re-execution.

/**
 * Redo of an undone auto-approved tool must restore the recorded
 * `completed` + `result` state without re-executing the tool. The result
 * blob is part of the same Yjs delta that undo tombstoned, so redo
 * resurrects it.
 *
 * Pre-fix, the engine's `approved`/`running` writes were separate undo
 * groups, so undo wouldn't pop the entire turn and redo would observe a
 * partial state — potentially triggering re-execution.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const undoRedoAutoApprovedRestoresResultTest = {
  name: 'undo-redo-auto-approved-restores-result',
  description: 'Redo after undo restores the auto-approved tool result without re-executing',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash', { command: 'echo undo-redo-auto' }, 'Running.'),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Run echo' },
    // Each lands in the worker before the next; the final document check
    // waits for the redo-restored items to settle into the doc.
    { type: 'undo' }, { type: 'ping-worker' },
    { type: 'redo' }, { type: 'ping-worker' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run echo' },
      { type: 'assistant', content: 'Running.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'echo undo-redo-auto' },
        state: 'completed',
        result: { content: 'undo-redo-auto', isError: false }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  },

  customAssertions: (/** @type {any} */ conversation) => {
    // The mock LLM only has two responses queued; if redo re-triggered
    // execution, it would consume a third LLM call (or hang). We can't
    // directly observe the mock's call count here, but the recorded
    // `result.content` should match the ORIGINAL execution's stdout
    // exactly — `echo` is deterministic so a re-execution would
    // produce identical bytes; the regression risk is more about
    // engine state machine drift than output drift. Treat this as a
    // smoke check.
    const yarr = conversation._doc.root.get('items');
    const items = yarr && yarr.toArray ? yarr.toArray() : [];
    const ta = items.find((/** @type {any} */ it) => it.get('type') === 'tool-action');
    if (!ta) throw new Error('tool-action not restored by redo');
    if (ta.get('state') !== 'completed') {
      throw new Error(`tool-action state after redo: ${ta.get('state')} (expected completed)`);
    }
  }
};

export const tests = [
  undoPendingApprovalStaysUndoneTest,
  undoPendingApprovalDoesNotRedispatchTest,
  undoRedoRestoresPendingTest,
  undoRedoAutoApprovedRestoresResultTest
];
