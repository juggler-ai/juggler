//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Queued messages (type-while-busy)
 *
 * RED / CONTRACT TESTS for the "queue a message during a live turn" feature.
 *
 * Today the composer REFUSES a send while the conversation is processing
 * (`composer.js` -> `conversation.isProcessing` guard, mirrored by the
 * `conversation.sendMessage` guard). `UIDriver.typeAndSend` turns that refusal
 * into a thrown error, so every test here currently fails at the second
 * `send-message-no-wait` — that throw IS the red signal for the behaviour we
 * are about to build.
 *
 * The target behaviour (see design discussion):
 *
 *   - A message sent while busy is ACCEPTED and parked in a per-thread
 *     `pendingItems` staging array (a child of the thread's Y.Map), rendered
 *     below the status footer. `composer.sendMessage()` returns falsy (not a
 *     block reason) when it enqueues.
 *   - `promote(pendingItems)` is the single worker-owned transition: it moves
 *     pending entries into `items` as real user messages (chronologically last)
 *     at one of four boundaries:
 *       1. turn boundary   -> promote + continue the loop  (TEST 1, TEST 2)
 *       2. approval resolve -> held during approval, then drains (TEST 4)
 *       3. Stop / Esc      -> promote + (continue iff blocked only by approvals,
 *                             else park idle)               (TEST 3, TEST 4b/4c)
 *       4. end-of-run      -> promote + start a new run     (covered implicitly)
 *   - Pending items are first-class for SELECTION + PROPERTIES + DELETE
 *     (TEST 6), via `MessageThread.removeItemById`.
 *   - `clear` is the one mutator that must also wipe pending (TEST 5).
 *
 * Contract API these tests pin (to be implemented):
 *   - `MessageThread.pendingItems` : Y.Map[]  (mirror of `.items`)
 *   - `MessageThread.removeItemById(itemId)` : container-aware remove
 *
 * CANCEL-WITH-QUEUE policy (decided): when the user cancels (deny a card, or
 * Escape) while the turn is blocked ONLY by approvals — every non-terminal tool
 * is `pending`, nothing is executing — a queued message means "drop these, run
 * what I just said": the denied/cancelled tools settle, the queued message
 * promotes, and the loop CONTINUES with a fresh turn (TEST 4b deny, TEST 4c
 * Escape). If anything is actually executing (an approved/running tool, an open
 * sub-thread), cancel must PARK instead: promote the queue and stay idle so the
 * interrupted work isn't silently re-driven (TEST 3 Stop-during-execution). With
 * NO queued message, cancel/deny always parks at idle (approval-flow-tests.js).
 * @module integration-tests/queued-message-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';
import { waitFor } from '../utilities/test-helpers.js';

// README.md content as returned by the read tool (cat -n style), matching the
// unit-test-fixture used across the approval suite.
const README_MD = '<file path="README.md">\n' +
	'1\t# Test Fixture Project\n' +
	'2\t\n' +
	'3\tA simple test fixture used for integration tests.\n' +
	'4\t\n' +
	'5\t## Structure\n' +
	'6\t- `src/main.go` - Main Go source file\n' +
	'7\t- `config.json` - Configuration file\n' +
	'8\t\n' +
	'</file>\n' +
	'(8 lines total)';

/**
 * Read the pending staging array for the root thread. Throws a clear message
 * if the contract accessor is missing (the expected RED state pre-implementation).
 * @param {any} conversation
 * @returns {any[]} Array of pending user-message Y.Maps
 */
function pendingItemsOf(conversation) {
  const thread = conversation.rootMessageThread;
  if (!thread || !('pendingItems' in thread)) {
    throw new Error('MessageThread.pendingItems accessor is not implemented yet');
  }
  return thread.pendingItems || [];
}

// ============================================================================
// TEST 1: queued message drains at the next turn boundary
// ============================================================================

/**
 * Turn 1 streams a read (auto-approved) and pauses at the mock barrier. While
 * paused the user sends a second message — it must be queued, not dropped, not
 * injected mid-tool. After release, the read executes and the queue promotes at
 * the tool-result boundary: the queued message is spliced in AFTER the completed
 * tool action, riding the SAME continuation turn that delivers the tool result —
 * the earliest opportunity, not deferred to end-of-run. One turn answers both.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const queueDrainsAtTurnBoundaryTest = {
  name: 'queue-drains-at-turn-boundary',
  description: 'A message sent mid-turn is queued and injected at the next turn boundary',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'read', { file_path: 'README.md' }, 'Reading.', { pauseBeforeReturn: true }),
    textResponse('On it.')
  ],

  operations: [
    { type: 'send-message-no-wait', message: 'first message' },
    { type: 'wait-for-mock-paused' },
    // Sent while the turn is live — must enqueue (today: typeAndSend throws).
    { type: 'send-message-no-wait', message: 'queued steer' },
    { type: 'release-mock' },
    { type: 'wait-for-idle' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'first message' },
      { type: 'assistant', content: 'Reading.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'read',
        toolInput: { file_path: 'README.md' },
        state: 'completed',
        result: { content: README_MD, isError: false }
      },
      // The queued message promotes at the tool-result boundary and rides the
      // continuation turn, which answers the tool result and the steer together.
      { type: 'user', content: 'queued steer' },
      { type: 'assistant', content: 'On it.' }
    ]
  },

  customAssertions: (conversation) => {
    const pending = pendingItemsOf(conversation);
    if (pending.length !== 0) {
      throw new Error(`Expected pending queue drained to empty, got ${pending.length}`);
    }
  }
};

// ============================================================================
// TEST 2: two queued messages promote as adjacent user items
// ============================================================================

/**
 * Two messages queued during the same live turn both promote at the next turn
 * boundary, as two ADJACENT user items, and the loop handles them without
 * merging. Pins the "don't special-case merging — emit N user messages, the
 * regular handler copes with adjacency" decision. As in TEST 1, both steers are
 * spliced in after the completed tool action and ride the same continuation turn.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const twoQueuedMessagesAdjacentTest = {
  name: 'two-queued-messages-adjacent',
  description: 'Two messages queued mid-turn promote as adjacent user items',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'read', { file_path: 'README.md' }, 'Reading.', { pauseBeforeReturn: true }),
    textResponse('On it.')
  ],

  operations: [
    { type: 'send-message-no-wait', message: 'first message' },
    { type: 'wait-for-mock-paused' },
    { type: 'send-message-no-wait', message: 'steer A' },
    { type: 'send-message-no-wait', message: 'steer B' },
    { type: 'release-mock' },
    { type: 'wait-for-idle' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'first message' },
      { type: 'assistant', content: 'Reading.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'read',
        toolInput: { file_path: 'README.md' },
        state: 'completed',
        result: { content: README_MD, isError: false }
      },
      // Both steers promote adjacently at the tool-result boundary and ride
      // the continuation turn.
      { type: 'user', content: 'steer A' },
      { type: 'user', content: 'steer B' },
      { type: 'assistant', content: 'On it.' }
    ]
  }
};

// ============================================================================
// TEST 3: Stop promotes the queue into the thread, then stays idle
// ============================================================================

/**
 * A read turn is paused at the barrier. The user queues a message, then hits
 * Stop (Escape). Stop must: cancel the live turn, promote the queued message
 * into `items` as a plain user message at the end, and stay IDLE (no new turn).
 * Nothing is dropped; the user can edit/continue from there.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const stopPromotesQueuedIdleTest = {
  name: 'stop-promotes-queued-idle',
  description: 'Stop with a queued message promotes it into the thread and stays idle',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'read', { file_path: 'README.md' }, 'Reading.', { pauseBeforeReturn: true })
  ],

  operations: [
    { type: 'send-message-no-wait', message: 'do work' },
    { type: 'wait-for-mock-paused' },
    { type: 'send-message-no-wait', message: 'never mind, do this instead' },
    { type: 'cancel' },
    { type: 'wait-for-state', condition: { processingStatus: 'idle' } }
  ],

  customAssertions: (conversation) => {
    // The queue is drained into the thread (not left pending, not dropped).
    const pending = pendingItemsOf(conversation);
    if (pending.length !== 0) {
      throw new Error(`Stop must promote the queue; still pending: ${pending.length}`);
    }

    // The promoted message is the LAST item, a real user message.
    const items = conversation.rootMessageThread.items;
    const last = items[items.length - 1];
    const lastType = last?.get?.('type');
    const lastContent = last?.get?.('content');
    if (lastType !== 'user' || lastContent !== 'never mind, do this instead') {
      throw new Error(
        `Expected last item to be the promoted user message; got type=${lastType} content=${JSON.stringify(lastContent)}`
      );
    }

    // Stayed idle — no further turn was driven.
    if (conversation.isProcessing) {
      throw new Error('Stop must leave the conversation idle, but it is still processing');
    }
  }
};

// ============================================================================
// TEST 4a: queued during approval — held, then drains after APPROVE
// ============================================================================

/**
 * A bash command stalls the loop waiting for manual approval. The user types a
 * follow-up while the approval is up. A tool_use cannot be followed by a user
 * message before its tool_result, so the queued message must be HELD (not
 * injected) until the approval resolves. After approve, the tool runs and the
 * queue promotes at the tool-result boundary: the queued message is spliced in
 * after the completed tool action and rides the SAME continuation turn — a
 * message typed at an approval prompt predates the tool even running, so it is
 * steering and lands at the earliest opportunity, not after the whole run.
 * Ordering (queued user AFTER the tool action, BEFORE the reply) proves the
 * sequencing.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const queuedDuringApprovalDrainsOnApproveTest = {
  name: 'queued-during-approval-drains-on-approve',
  description: 'A message queued while waiting for approval drains after the tool is approved',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash', { command: 'env echo go' }, 'Running.'),
    textResponse('On it.')
  ],

  operations: [
    { type: 'send-message-no-wait', message: 'run it' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    // Queued while the loop is parked on approval.
    { type: 'send-message-no-wait', message: 'also do X' },
    { type: 'approve', toolUseId: 'call_1' },
    { type: 'wait-for-idle' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'run it' },
      { type: 'assistant', content: 'Running.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env echo go' },
        state: 'completed',
        result: { content: 'go', isError: false }
      },
      // The queued message promotes at the tool-result boundary and rides the
      // continuation turn that delivers the tool result.
      { type: 'user', content: 'also do X' },
      { type: 'assistant', content: 'On it.' }
    ]
  }
};

// ============================================================================
// TEST 4b: queued during approval — DENY drops the approval and CONTINUES
// ============================================================================

/**
 * Same setup, but the tool is DENIED while a message is queued. The block was
 * pure approval (a single pending bash, nothing executing), so a queued message
 * means "drop that, run what I just said": the denied tool settles cancelled,
 * the queued message promotes into `items`, and the loop CONTINUES with a fresh
 * turn that consumes the second LLM response. (With nothing queued, deny still
 * stops at idle — see approval-flow-tests.js `approval-deny-stops-loop`.)
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const queuedDuringApprovalContinuesOnDenyTest = {
  name: 'queued-during-approval-continues-on-deny',
  description: 'Denying a tool with a queued message drops the approval and continues the turn',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash', { command: 'env echo go' }, 'Running.'),
    // Consumed — the queued message continues the turn after the deny.
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message-no-wait', message: 'run it' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'send-message-no-wait', message: 'redirect please' },
    // The deny promotes whatever is queued when the worker handles it, so the
    // queued message must be in the doc first.
    { type: 'wait-for-state', condition: { pendingContent: 'redirect please' } },
    { type: 'deny', toolUseId: 'call_1' },
    { type: 'wait-for-idle' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'run it' },
      { type: 'assistant', content: 'Running.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env echo go' },
        state: 'cancelled',
        result: { content: 'Action was cancelled.', isError: false }
      },
      // Promoted on deny, then the loop continues into a fresh turn.
      { type: 'user', content: 'redirect please' },
      { type: 'assistant', content: 'Done.' }
    ]
  },

  customAssertions: (conversation) => {
    const pending = pendingItemsOf(conversation);
    if (pending.length !== 0) {
      throw new Error(`Deny must promote the queue; still pending: ${pending.length}`);
    }
    if (conversation.isProcessing) {
      throw new Error('Continue should have run to completion, but it is still processing');
    }
  }
};

// ============================================================================
// TEST 4c: queued during approval — ESCAPE drops the approval and CONTINUES
// ============================================================================

/**
 * Escape variant of TEST 4b. A bash command is parked on manual approval (the
 * worker is in `awaiting_llm`, nothing executing). The user queues a follow-up
 * and hits Escape. Because the block is pure approval, Escape behaves like deny:
 * the worker cancels the pending tool, the queued message promotes, and the loop
 * continues into a fresh turn. The worker is the single canceller here, so the
 * cancelled tool carries the worker's interrupted result.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const escapeOnApprovalContinuesWithQueuedTest = {
  name: 'escape-on-approval-continues-with-queued',
  description: 'Escape while parked purely on approval, with a queued message, cancels the tool and continues',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'bash', { command: 'env echo go' }, 'Running.'),
    // Consumed — the queued message continues the turn after Escape.
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message-no-wait', message: 'run it' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'send-message-no-wait', message: 'redirect please' },
    { type: 'cancel' },
    { type: 'wait-for-idle' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'run it' },
      { type: 'assistant', content: 'Running.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env echo go' },
        state: 'cancelled',
        result: { content: 'Interrupted', isError: false }
      },
      // Promoted on Escape, then the loop continues into a fresh turn.
      { type: 'user', content: 'redirect please' },
      { type: 'assistant', content: 'Done.' }
    ]
  },

  customAssertions: (conversation) => {
    const pending = pendingItemsOf(conversation);
    if (pending.length !== 0) {
      throw new Error(`Escape must promote the queue; still pending: ${pending.length}`);
    }
    if (conversation.isProcessing) {
      throw new Error('Continue should have run to completion, but it is still processing');
    }
  }
};

// ============================================================================
// TEST 5: clear wipes the pending queue (the one drift guard)
// ============================================================================

/**
 * `clear` is the single mutator that must remember the staging array. Queue a
 * message mid-turn, then clear the thread; the pending queue must be empty.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const clearWipesPendingTest = {
  name: 'clear-wipes-pending',
  description: 'Clearing the thread also empties the pending queue',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'read', { file_path: 'README.md' }, 'Reading.', { pauseBeforeReturn: true })
  ],

  operations: [
    { type: 'send-message-no-wait', message: 'work' },
    { type: 'wait-for-mock-paused' },
    { type: 'send-message-no-wait', message: 'queued, will be cleared' },
    // /clear mutates the conversation, so mid-turn it asks before stopping the
    // turn. Armed ahead of the command, which is blocked on the answer.
    { type: 'expect-confirm', answer: true },
    { type: 'run-command', command: 'clear' },
    { type: 'assert-confirm-shown', titleContains: 'Stop the current turn?' },
    { type: 'wait-for-state', condition: { processingStatus: 'idle' } }
  ],

  customAssertions: (conversation) => {
    const pending = pendingItemsOf(conversation);
    if (pending.length !== 0) {
      throw new Error(`clear must empty the pending queue; still pending: ${pending.length}`);
    }
  }
};

// ============================================================================
// TEST 6: a queued item is selectable + deletable like any other item
// ============================================================================

/**
 * The critical UX: a queued message is a first-class item. It must render with
 * a `message-id` (so click-selection + the properties panel find it), and
 * `MessageThread.removeItemById` must remove it from the queue. This test pins
 * DOM selectability plus the inline trashcan's container-aware delete path.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const queuedItemSelectableAndDeletableTest = {
  name: 'queued-item-selectable-and-inline-deletable',
  description: 'A queued item renders selectably and can be removed via its inline trashcan',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'read', { file_path: 'README.md' }, 'Reading.', { pauseBeforeReturn: true }),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message-no-wait', message: 'work' },
    { type: 'wait-for-mock-paused' },
    { type: 'send-message-no-wait', message: 'queued to delete' }
  ],

  customAssertions: async (conversation) => {
    // The worker is the single writer of pendingItems; wait for its write to
    // sync back to this doc (deterministic condition, not a fixed delay).
    const target = await waitFor(() => pendingItemsOf(conversation).find(
      (/** @type {any} */ it) => it.get?.('content') === 'queued to delete'),
    { timeoutMs: 3000, intervalMs: 20, description: 'the queued message to land in pendingItems' });
    const itemId = target.get('itemId');

    // Selection parity: the queued item must render with a message-id so the
    // id+DOM selection path (and the properties panel) can target it, plus the
    // queue-only inline trashcan affordance.
    const queuedEl = () => document.querySelector(`[message-id="${itemId}"]`);
    const inlineDeleteOf = (/** @type {Element|null} */ el) => (el
      ? /** @type {HTMLButtonElement|null} */ (el.querySelector('.queued-message-delete-btn .icon-trashcan')?.closest('button'))
      : null);
    const { el, inlineDelete } = await waitFor(() => {
      const found = queuedEl();
      const button = inlineDeleteOf(found);
      return found && button ? { el: found, inlineDelete: button } : null;
    }, {
      timeoutMs: 3000,
      intervalMs: 20,
      description: () => (queuedEl()
        ? `queued item ${itemId} to render an inline trashcan delete button`
        : `queued item ${itemId} to render with a message-id (selectable)`),
    });

    if (!el.classList.contains('queued-message')) {
      throw new Error('Queued item did not get the queued-message class');
    }

    // Inline delete removes it from the queue without requiring the properties panel.
    inlineDelete.click();

    await waitFor(() => !pendingItemsOf(conversation).some(
      (/** @type {any} */ it) => it.get?.('itemId') === itemId
    ), { timeoutMs: 2000, intervalMs: 20, description: 'the inline trashcan to remove the queued item from pendingItems' });
  }
};

// ============================================================================
// TEST 7: queueing is PER-THREAD — a message queued in a sub-thread drains into
//         that sub-thread, not the root
// ============================================================================

/**
 * Scope check. A sub-thread turn is in flight (read paused at the barrier). The
 * user queues a message targeting that sub-thread. It must land in the
 * SUB-THREAD's pendingItems (not the root's), and drain into the SUB-THREAD's
 * items at the thread's turn boundary — proving the queue is per-thread, keyed
 * off the thread's own Y.Map. The thread then returns its result and closes.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const queueDrainsIntoSubThreadTest = {
  name: 'queue-drains-into-sub-thread',
  description: 'A message queued during a sub-thread turn drains into that sub-thread, not the root',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // Sub-thread turn 1: read (auto-approved), paused at the barrier.
    toolUseResponse('call_1', 'read', { file_path: 'README.md' }, 'Reading in thread.', { pauseBeforeReturn: true }),
    // Sub-thread turn 2 (after the queued message drains): the run comes to rest.
    textResponse('Thread done.')
  ],

  operations: [
    { type: 'run-command', command: 'thread' },
    { type: 'wait-for-state', condition: { hasThreadItem: true } },
    { type: 'send-thread-message-no-wait', message: 'work in thread' },
    { type: 'wait-for-mock-paused' },
    // Queue a second message into the (busy) sub-thread.
    { type: 'send-thread-message-no-wait', message: 'queued in thread' },
    { type: 'release-mock' },
    { type: 'wait-for-state', condition: { completedThreadCount: 1 } }
  ],

  customAssertions: (conversation) => {
    const threads = conversation.rootMessageThread.items.filter(
      (/** @type {any} */ it) => it.get?.('type') === 'thread');
    if (threads.length !== 1) {
      throw new Error(`Expected exactly 1 thread, got ${threads.length}`);
    }
    const threadId = threads[0].get('itemId');
    const subThread = conversation.resolveMessageThread(threadId);

    // The queued message drained into the SUB-THREAD's items.
    const inThread = subThread.items.some(
      (/** @type {any} */ it) => it.get?.('type') === 'user' && it.get?.('content') === 'queued in thread');
    if (!inThread) {
      throw new Error('Queued message did not drain into the sub-thread items');
    }

    // ...and NOT into the root.
    const inRoot = conversation.rootMessageThread.items.some(
      (/** @type {any} */ it) => it.get?.('type') === 'user' && it.get?.('content') === 'queued in thread');
    if (inRoot) {
      throw new Error('Queued sub-thread message leaked into the root thread');
    }

    // The sub-thread queue drained empty.
    const subPending = ('pendingItems' in subThread) ? subThread.pendingItems : [];
    if (subPending.length !== 0) {
      throw new Error(`Sub-thread pending queue not drained: ${subPending.length}`);
    }
  }
};

// ============================================================================
// TEST 8: selecting a queued message opens its properties panel with a working
//         "Remove from queue" delete (the real selection → panel → delete flow)
// ============================================================================

/**
 * The reported bug: a selected queued message showed no properties panel. This
 * drives the actual UI path — select the queued bubble exactly as a click does,
 * assert a properties-panel column renders its content (not the empty state) and
 * exposes a delete button, click it, and assert the message left the queue.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
const queuedItemPropertiesPanelTest = {
  name: 'queued-item-properties-panel',
  description: 'Selecting a queued message shows its properties panel with a working remove-from-queue delete',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'read', { file_path: 'README.md' }, 'Reading.', { pauseBeforeReturn: true })
  ],

  operations: [
    { type: 'send-message-no-wait', message: 'work' },
    { type: 'wait-for-mock-paused' },
    { type: 'send-message-no-wait', message: 'queued message body' }
  ],

  customAssertions: async (conversation) => {
    const thread = conversation.rootMessageThread;
    const pendingOf = () => (('pendingItems' in thread) ? thread.pendingItems : []);

    // Wait for the worker's pending write to sync back.
    const target = await waitFor(
      () => pendingOf().find((/** @type {any} */ it) => it.get?.('content') === 'queued message body'),
      { timeoutMs: 3000, intervalMs: 20, description: 'the queued message to land in pendingItems' });
    const itemId = target.get('itemId');

    // Select it via the real selection path (what a click ultimately calls).
    const area = /** @type {any} */ (document.querySelector('conversation-area'));
    if (!area || typeof area._selectItem !== 'function') {
      throw new Error('No conversation-area available to select the queued message in');
    }
    area.selectItem(itemId);

    // The properties-panel column should appear and render the message content
    // plus a delete button (panel render is debounced ~150ms).
    const panelOf = () => /** @type {any} */ (document.querySelector('properties-panel'));
    const showsQueued = (/** @type {any} */ panel) => {
      const text = panel ? (panel.textContent || '') : '';
      return text.includes('queued message body') && !text.includes('Select an item to view details');
    };
    const removeBtn = await waitFor(() => {
      const panel = panelOf();
      const btn = panel ? panel.querySelector('.properties-panel-btn.danger') : null;
      return showsQueued(panel) ? btn : null;
    }, {
      timeoutMs: 3000,
      intervalMs: 30,
      description: () => {
        const panel = panelOf();
        if (!panel) return 'a properties-panel for the selected queued message';
        if (!showsQueued(panel)) return 'the properties panel to render the queued message content';
        return 'a delete button for the queued message in the properties panel';
      },
    });

    // Click delete → the message leaves the queue.
    removeBtn.click();
    await waitFor(() => !pendingOf().some((/** @type {any} */ it) => it.get?.('itemId') === itemId),
      { timeoutMs: 2000, intervalMs: 20, description: 'remove-from-queue to remove the message from pendingItems' });
  }
};

// Export all tests
export const tests = [
  queueDrainsAtTurnBoundaryTest,
  twoQueuedMessagesAdjacentTest,
  stopPromotesQueuedIdleTest,
  queuedDuringApprovalDrainsOnApproveTest,
  queuedDuringApprovalContinuesOnDenyTest,
  escapeOnApprovalContinuesWithQueuedTest,
  clearWipesPendingTest,
  queuedItemSelectableAndDeletableTest,
  queueDrainsIntoSubThreadTest,
  queuedItemPropertiesPanelTest
];
