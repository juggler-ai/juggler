//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Integration Tests: Selection Rules
 *
 * Tests the auto-selection rules through the real UI layer.
 * These tests require UI mode (--ui-mode) to verify DOM selection state.
 * @module integration-tests/selection-rule-tests
 */

import { textResponse, toolUseResponse } from '../utilities/integration-test-runner.js';

// ============================================================================
// Rule 2: Auto-select tool-actions on insert
// ============================================================================

/**
 * When the LLM inserts a tool-action (write file), the tool-action-message
 * should get the .selected class in the DOM so the properties panel shows the diff.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const selectionAutoSelectToolAction = {
  name: 'selection-auto-select-tool-action',
  description: 'Tool-action gets .selected when inserted by LLM',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'write',
      { file_path: 'sat-file.txt', content: 'hello' },
      'Writing file.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Write a file' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Write a file' },
      { type: 'assistant', content: 'Writing file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: 'hello', file_path: 'sat-file.txt' },
        state: 'completed',
        result: { content: 'Created file: sat-file.txt', isError: false }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  },

  customAssertions(conversation) {
    // UI-mode only: verify a tool-action-message has .selected class
    const tab = conversation.getTabElement?.();
    if (!tab) return; // Non-UI mode — skip
    const rootCol = tab.querySelector('conversation-area');
    if (!rootCol) return;
    const selected = rootCol.querySelector('.conversation-item.selected');
    if (!selected) {
      throw new Error('No item has .selected — expected a tool-action to be auto-selected');
    }
    if (selected.tagName.toLowerCase() !== 'tool-action-message') {
      throw new Error(
        `Expected tool-action-message to be selected, got ${selected.tagName.toLowerCase()}`
      );
    }
    // The hand cursor on an item is a click affordance, and the gesture most
    // likely to start over the item that is already selected is a drag across
    // its text. So a selected item hands the cursor back to the browser, which
    // draws the I-beam only where a selection can actually begin. Unselected
    // items keep the hand.
    const selectedCursor = getComputedStyle(selected).cursor;
    if (selectedCursor !== 'auto') {
      throw new Error(`Selected item must not keep the pointer cursor, got ${selectedCursor}`);
    }
    const unselected = rootCol.querySelector('.conversation-item:not(.selected)');
    const unselectedCursor = unselected ? getComputedStyle(unselected).cursor : null;
    if (unselectedCursor !== null && unselectedCursor !== 'pointer') {
      throw new Error(`Unselected item must keep the pointer cursor, got ${unselectedCursor}`);
    }
  }
};

// ============================================================================
// Rule 2 + Rule 4: Tool-actions override manual selection
// ============================================================================

/**
 * Sequential tool-actions: the last inserted tool-action should be selected,
 * not the first. Each tool-action arrives in a separate LLM turn so
 * onItemsInserted fires once per insertion with only the new IDs.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const selectionToolActionOverridesManual = {
  name: 'selection-tool-action-overrides-manual',
  description: 'Tool-action auto-selects even after user manually selected another item',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // Turn 1: write file #1
    toolUseResponse(
      'call_1',
      'write',
      { file_path: 'stom-a.txt', content: 'aaa' },
      'Writing first file.'
    ),
    // Turn 2: write file #2
    toolUseResponse(
      'call_2',
      'write',
      { file_path: 'stom-b.txt', content: 'bbb' },
      'Writing second file.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Write two files' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Write two files' },
      { type: 'assistant', content: 'Writing first file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: 'aaa', file_path: 'stom-a.txt' },
        state: 'completed',
        result: { content: 'Created file: stom-a.txt', isError: false }
      },
      { type: 'assistant', content: 'Writing second file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'write',
        toolInput: { content: 'bbb', file_path: 'stom-b.txt' },
        state: 'completed',
        result: { content: 'Created file: stom-b.txt', isError: false }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  },

  customAssertions(conversation) {
    // UI-mode only: verify the SECOND tool-action has .selected
    // (the latest tool-action should be selected, not the first one)
    const tab = conversation.getTabElement?.();
    if (!tab) return;
    const rootCol = tab.querySelector('conversation-area');
    if (!rootCol) return;
    const selected = rootCol.querySelector('.conversation-item.selected');
    if (!selected) {
      throw new Error('No item has .selected — expected second tool-action to be auto-selected');
    }
    if (selected.tagName.toLowerCase() !== 'tool-action-message') {
      throw new Error(
        `Expected tool-action-message to be selected, got ${selected.tagName.toLowerCase()}`
      );
    }
    // Verify it's the SECOND tool-action (by checking position)
    const allToolActions = rootCol.querySelectorAll('tool-action-message');
    if (allToolActions.length < 2) {
      throw new Error(`Expected 2 tool-action-messages, got ${allToolActions.length}`);
    }
    if (selected !== allToolActions[allToolActions.length - 1]) {
      throw new Error('Expected the LAST tool-action to be selected, not an earlier one');
    }
  }
};

// ============================================================================
// Rule 3: User message resets auto-follow
// ============================================================================

/**
 * After the user sends a new message, auto-follow should be reset so the
 * next LLM tool-action gets auto-selected.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const selectionUserMessageResets = {
  name: 'selection-user-message-resets',
  description: 'User message resets auto-follow so next tool-action is selected',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // Turn 1: text only (user might browse)
    textResponse('Here is the analysis.'),
    // Turn 2: tool-action after second user message
    toolUseResponse(
      'call_1',
      'write',
      { file_path: 'sumr-file.txt', content: 'content' },
      'Writing file.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Analyze the code' },
    { type: 'send-message', message: 'Now write a file' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Analyze the code' },
      { type: 'assistant', content: 'Here is the analysis.' },
      { type: 'user', content: 'Now write a file' },
      { type: 'assistant', content: 'Writing file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: 'content', file_path: 'sumr-file.txt' },
        state: 'completed',
        result: { content: 'Created file: sumr-file.txt', isError: false }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  },

  customAssertions(conversation) {
    const tab = conversation.getTabElement?.();
    if (!tab) return;
    const rootCol = tab.querySelector('conversation-area');
    if (!rootCol) return;
    const selected = rootCol.querySelector('.conversation-item.selected');
    if (!selected) {
      throw new Error('No item has .selected — expected tool-action to be auto-selected after user message reset');
    }
    if (selected.tagName.toLowerCase() !== 'tool-action-message') {
      throw new Error(
        `Expected tool-action-message to be selected, got ${selected.tagName.toLowerCase()}`
      );
    }
  }
};

// ============================================================================
// Thread: New thread auto-opens
// ============================================================================

/**
 * When the LLM creates a thread via create_thread tool, the thread column
 * should automatically open in the UI.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const selectionNewThreadAutoOpens = {
  name: 'selection-new-thread-auto-opens',
  description: 'LLM-created thread auto-opens as a column',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // Root: create a thread
    toolUseResponse('call_1', 'create_thread', {
      goal: 'Investigate',
      prompt: 'Look at the code'
    }),
    // Thread: reply — the run comes to rest on it and returns it
    textResponse('Found the issue.'),
    // Root: summarize
    textResponse('Thread completed.')
  ],

  operations: [
    { type: 'send-message', message: 'Investigate the code' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Investigate the code' },
      { type: 'thread', itemId: '$ITEM_3', result: 'Found the issue.' },
      { type: 'assistant', content: 'Thread completed.' }
    ]
  },

  customAssertions(conversation) {
    // This test verifies the thread WAS opened during processing.
    // By the time customAssertions runs, the thread may have closed
    // (processing returned to root). We verify the thread-message
    // exists in the DOM as a rendered element.
    const tab = conversation.getTabElement?.();
    if (!tab) return;
    const threadMessages = tab.querySelectorAll('thread-message');
    if (threadMessages.length === 0) {
      throw new Error('No thread-message found in DOM — thread was not rendered');
    }
  }
};

// ============================================================================
// Thread: Continue in new thread auto-selects
// ============================================================================

/**
 * Thread A exists and is idle. A new thread B is created (via continueInNewThread).
 * Thread B's column should open in the DOM.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const selectionContinueInNewThread = {
  name: 'selection-continue-in-new-thread',
  description: 'Continue in new thread auto-opens the new thread column',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // Root turn 1: create thread A
    toolUseResponse('call_1', 'create_thread', {
      goal: 'First task',
      prompt: 'Do the first thing'
    }),
    // Thread A: reply — the run comes to rest on it
    textResponse('First task done.'),
    // Root: summarize thread A result
    textResponse('Task A completed.'),
    // Continuation thread B (created inside thread A by continueInNewThread):
    // its reply settles the run, which is what continueInNewThread awaits.
    textResponse('Continuation complete.')
  ],

  operations: [
    { type: 'send-message', message: 'Do the first task' },
    // Now thread A exists and is idle. Trigger continue-in-new-thread.
    // This creates thread B inside thread A.
    { type: 'continue-in-new-thread' }
  ],

  // Root items: system-prompt, user, thread A, assistant summary.
  // Thread B is nested inside thread A (not a root sibling).
  expectedItems: [
    { type: 'system-prompt' },
    { type: 'user' },
    { type: 'thread' },
    { type: 'assistant' }
  ],

  customAssertions(conversation) {
    const tab = conversation.getTabElement?.();
    if (!tab) return;
    // After continueInNewThread, at least one thread column should be open.
    // The continuation thread B is nested inside thread A, so we expect
    // the thread column chain to include thread A and then thread B.
    const threadColumns = tab.querySelectorAll('conversation-area.thread-column');
    if (threadColumns.length === 0) {
      throw new Error(
        'No thread column is open — expected the continuation thread to be auto-selected'
      );
    }
  }
};

// ============================================================================
// Thread: Auto-select works inside open sub-thread column
// ============================================================================

/**
 * When the LLM inserts a tool-action inside a sub-thread, the tool-action
 * should get the .selected class in the thread column — not just the root.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const selectionAutoSelectInSubThread = {
  name: 'selection-auto-select-in-sub-thread',
  description: 'Tool-action in sub-thread gets .selected in the thread column',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // Root: create thread
    toolUseResponse('call_1', 'create_thread', {
      goal: 'Write a file',
      prompt: 'Write sub-file.txt'
    }),
    // Thread LLM turn 1: write a file (auto-executes, should be auto-selected in thread column)
    toolUseResponse('call_2', 'write', { file_path: 'sub-file.txt', content: 'hello' }, 'Writing...'),
    // Thread LLM turn 2: reply once the write completes, settling the run
    textResponse('File written successfully.'),
    // Root: summarize
    textResponse('Thread finished.')
  ],

  operations: [
    { type: 'send-message', message: 'Write a file in a thread' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Write a file in a thread' },
      { type: 'thread', itemId: '$ITEM_3', result: 'File written successfully.' },
      { type: 'assistant', content: 'Thread finished.' }
    ]
  },

  customAssertions(conversation) {
    const tab = conversation.getTabElement?.();
    if (!tab) return;

    // The root column should have the thread-message selected (it was auto-selected
    // when inserted; the trailing assistant message doesn't displace it).
    // That keeps the thread column open even after the thread completes.
    const threadCols = tab.querySelectorAll('conversation-area.thread-column');
    if (threadCols.length === 0) {
      throw new Error(
        'No thread column is open — expected thread-message to remain selected in root, keeping thread column visible'
      );
    }

    // The thread column should have a tool-action-message selected.
    const threadCol = threadCols[threadCols.length - 1];
    const selected = threadCol.querySelector('.conversation-item.selected');
    if (!selected) {
      throw new Error(
        'No item is selected in the thread column — expected a tool-action to be auto-selected when inserted into the thread'
      );
    }
    if (selected.tagName.toLowerCase() !== 'tool-action-message') {
      throw new Error(
        `Expected tool-action-message to be selected in thread column, got ${selected.tagName.toLowerCase()}`
      );
    }
  }
};

// ============================================================================
// Root: Auto-select still works after a thread completes
// ============================================================================

/**
 * After a sub-thread finishes, the root LLM continues and inserts a tool-action.
 * That root-level tool-action should be auto-selected in the root column.
 * (Sanity check that the fix doesn't break root behaviour.)
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const selectionAutoSelectInRootAfterThread = {
  name: 'selection-auto-select-in-root-after-thread',
  description: 'Root tool-action is auto-selected after sub-thread completes',
  fixture: 'unit-test-fixture',

  llmResponses: [
    // Root: create thread
    toolUseResponse('call_1', 'create_thread', {
      goal: 'Analyse',
      prompt: 'Look around'
    }),
    // Thread: reply, settling the run so the thread finishes
    textResponse('Analysis done.'),
    // Root continues after thread finishes: write a file (should be auto-selected in root column)
    toolUseResponse('call_2', 'write', { file_path: 'root-file.txt', content: 'data' }, 'Writing root file.'),
    textResponse('All done.')
  ],

  operations: [
    { type: 'send-message', message: 'Analyse then write a file' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Analyse then write a file' },
      { type: 'thread', itemId: '$ITEM_3', result: 'Analysis done.' },
      { type: 'assistant', content: 'Writing root file.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: 'data', file_path: 'root-file.txt' },
        state: 'completed',
        result: { content: 'Created file: root-file.txt', isError: false }
      },
      { type: 'assistant', content: 'All done.' }
    ]
  },

  customAssertions(conversation) {
    const tab = conversation.getTabElement?.();
    if (!tab) return;
    const rootCol = tab.querySelector('conversation-area:not(.thread-column)');
    if (!rootCol) return;
    const selected = rootCol.querySelector('.conversation-item.selected');
    if (!selected) {
      throw new Error('No item selected in root column — expected root tool-action to be auto-selected after thread');
    }
    if (selected.tagName.toLowerCase() !== 'tool-action-message') {
      throw new Error(
        `Expected tool-action-message to be selected in root column, got ${selected.tagName.toLowerCase()}`
      );
    }
  }
};

// ============================================================================
// Continue button visible after tool-action completes
// ============================================================================

/**
 * After the LLM runs a tool action and processing stops, the footer should
 * return to idle with the continue button visible.
 *
 * Regression test: tool-action-message's Yjs observer called render() but
 * not updateFooter(), so when a tool transitioned RUNNING→COMPLETED after
 * processing had stopped, isProcessing stayed true and the continue button
 * stayed hidden.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const selectionContinueBtnVisibleAfterToolUse = {
  name: 'selection-continue-btn-visible-after-tool-use',
  description: 'Continue button is visible after tool-action completes',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'write', { file_path: 'cbv-file.txt', content: 'hi' }, 'Writing.'),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Write a file' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Write a file' },
      { type: 'assistant', content: 'Writing.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'write',
        toolInput: { content: 'hi', file_path: 'cbv-file.txt' },
        state: 'completed',
        result: { content: 'Created file: cbv-file.txt', isError: false }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  },

  customAssertions(conversation) {
    const tab = conversation.getTabElement?.();
    if (!tab) return; // Non-UI mode — skip
    const rootCol = tab.querySelector('conversation-area:not(.thread-column)');
    if (!rootCol) return;
    const idle = rootCol.querySelector('footer-idle');
    if (!idle) throw new Error('No footer-idle found in root column');
    if (idle.classList.contains('hidden')) {
      throw new Error(
        'footer-idle is hidden after tool completes — isProcessing is stuck true. ' +
				'Likely cause: tool-action Yjs observer updated render() but not updateFooter().'
      );
    }
    const continueBtn = rootCol.querySelector('.continue-btn');
    if (!continueBtn) throw new Error('No .continue-btn found in root column');
    if (continueBtn.classList.contains('hidden')) {
      throw new Error('continue-btn is hidden — canContinue is false after tool-action completes');
    }
  }
};

// ============================================================================
// Rule 2 (pending-approval path): tool-action gets .selected when it
// transitions to PENDING (approval required).
// ============================================================================

/**
 * When the LLM inserts a tool-action that requires approval (e.g. bash),
 * the item is first inserted with state='' and then asynchronously
 * transitions to PENDING in a separate Yjs transaction.  The second
 * transaction has empty insertedItemIds, so the old onItemsInserted path
 * never fires for it.  The fix must observe the state change and
 * auto-select the item when it reaches PENDING.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const selectionPendingApprovalAutoSelect = {
  name: 'selection-pending-approval-auto-select',
  description: 'Pending-approval tool-action gets .selected while waiting for user to approve',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'bash',
      { command: 'env echo spas-test' },
      'Running command.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Run echo spas-test' },
    // send-message resolves once the tool reaches PENDING (waitForTurnComplete
    // unblocks on pending-approval).  Wait explicitly to be safe.
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    // KEY ASSERTION: the pending tool-action must be auto-selected BEFORE
    // the user approves it so the properties panel shows the diff.
    { type: 'assert-dom', selector: 'tool-action-message.selected' },
    { type: 'approve', toolUseId: 'call_1' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run echo spas-test' },
      { type: 'assistant', content: 'Running command.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env echo spas-test' },
        state: 'completed',
        result: { content: 'spas-test', isError: false }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  }
};

// ============================================================================
// Rule 2b: Approving one pending tool-action hands selection to the next
// remaining pending one.
// ============================================================================

/**
 * Two bash tool-actions arrive in one LLM batch and both reach PENDING.
 * The first (call_1) is initially auto-selected (rule 2 picks the first
 * PENDING tool-action). The user approves call_1; rule 2b must hand
 * selection to call_2 without any user click.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const selectionAutoSelectsNextPendingAfterApprove = {
  name: 'selection-auto-selects-next-pending-after-approve',
  description: 'Approving one pending tool-action auto-selects the next pending one',
  fixture: 'unit-test-fixture',

  llmResponses: [
    {
      blocks: [
        { type: 'text', content: 'Running two.' },
        { type: 'tool_use', toolUseId: 'call_1', toolName: 'bash', toolInput: { command: 'env echo sasnp-a' } },
        { type: 'tool_use', toolUseId: 'call_2', toolName: 'bash', toolInput: { command: 'env echo sasnp-b' } }
      ],
      stopReason: 'tool_use'
    },
    textResponse('Both done.')
  ],

  operations: [
    { type: 'send-message', message: 'Run two commands' },
    // Both tool-actions must reach PENDING before we assert selection.
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'wait-for-approval', toolUseId: 'call_2' },
    // Sanity: call_1 (first PENDING) is the initial auto-select.
    { type: 'assert-dom', selector: 'tool-action-message[data-tool-use-id="call_1"].selected' },
    // Approve call_1. approve-no-wait because the LLM turn is still gated
    // on call_2's pending approval — waitForTurnComplete would deadlock.
    { type: 'approve-no-wait', toolUseId: 'call_1' },
    // Wait for call_1 to leave PENDING (rule 2b fires on the conversation:
    // changed event from the APPROVED→RUNNING→COMPLETED transitions).
    { type: 'wait-for-execution', toolUseId: 'call_1' },
    // KEY ASSERTION: selection has handed off to call_2 — the remaining
    // pending tool-action — without any user click. call_2 is still
    // PENDING at this point (we haven't approved it yet), so its
    // .selected class must be present in the DOM.
    { type: 'assert-dom', selector: 'tool-action-message[data-tool-use-id="call_2"].selected' },
    // Cleanup: approve call_2 so the turn can complete.
    { type: 'approve', toolUseId: 'call_2' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run two commands' },
      { type: 'assistant', content: 'Running two.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env echo sasnp-a' },
        state: 'completed',
        result: { content: 'sasnp-a', isError: false }
      },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_2',
        toolName: 'bash',
        toolInput: { command: 'env echo sasnp-b' },
        state: 'completed',
        result: { content: 'sasnp-b', isError: false }
      },
      { type: 'assistant', content: 'Both done.' }
    ]
  }
};

/**
 * Production regression: user clicks an item to select it (origin='user'),
 * then approves. Rule 2b must still fire — approving is an "advance" act,
 * not navigation, so it clears the user-origin pin.
 *
 * Three pending tool-actions to mirror the real failure case (user reported
 * "I had 3 waiting approvals, did the first one… no selection change").
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const selectionAutoSelectsNextPendingAfterUserClickAndApprove = {
  name: 'selection-auto-selects-next-pending-after-user-click-and-approve',
  description: 'Approving after a manual click still hands selection to the next pending',
  fixture: 'unit-test-fixture',

  llmResponses: [
    {
      blocks: [
        { type: 'text', content: 'Running three.' },
        { type: 'tool_use', toolUseId: 'call_1', toolName: 'bash', toolInput: { command: 'env echo sasn3-a' } },
        { type: 'tool_use', toolUseId: 'call_2', toolName: 'bash', toolInput: { command: 'env echo sasn3-b' } },
        { type: 'tool_use', toolUseId: 'call_3', toolName: 'bash', toolInput: { command: 'env echo sasn3-c' } }
      ],
      stopReason: 'tool_use'
    },
    textResponse('All done.')
  ],

  operations: [
    { type: 'send-message', message: 'Run three commands' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    { type: 'wait-for-approval', toolUseId: 'call_2' },
    { type: 'wait-for-approval', toolUseId: 'call_3' },
    // User clicks to select call_2 (skipping past the auto-selected call_1).
    // This pins origin='user' and would, without the fix, suppress rule 2b.
    { type: 'click-item', toolUseId: 'call_2' },
    { type: 'assert-dom', selector: 'tool-action-message[data-tool-use-id="call_2"].selected' },
    // User approves call_2 — should hand selection to call_1 (first
    // remaining PENDING in document order), not stay on the now-approved
    // call_2.
    { type: 'approve-no-wait', toolUseId: 'call_2' },
    { type: 'wait-for-execution', toolUseId: 'call_2' },
    { type: 'assert-dom', selector: 'tool-action-message[data-tool-use-id="call_1"].selected' },
    // Cleanup
    { type: 'approve-no-wait', toolUseId: 'call_1' },
    { type: 'wait-for-execution', toolUseId: 'call_1' },
    { type: 'approve', toolUseId: 'call_3' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run three commands' },
      { type: 'assistant', content: 'Running three.' },
      { type: 'tool-action', toolUseId: '$TOOL_1', toolName: 'bash', toolInput: { command: 'env echo sasn3-a' }, state: 'completed', result: { content: 'sasn3-a', isError: false } },
      { type: 'tool-action', toolUseId: '$TOOL_2', toolName: 'bash', toolInput: { command: 'env echo sasn3-b' }, state: 'completed', result: { content: 'sasn3-b', isError: false } },
      { type: 'tool-action', toolUseId: '$TOOL_3', toolName: 'bash', toolInput: { command: 'env echo sasn3-c' }, state: 'completed', result: { content: 'sasn3-c', isError: false } },
      { type: 'assistant', content: 'All done.' }
    ]
  }
};

// ============================================================================
// Hit-test race: a click whose press began on an approval button must never
// select the item ABOVE when the approval box shifts before mouseup.
// ============================================================================

/**
 * Production regression: a pending bash approval is auto-selected with an
 * assistant-message directly above it. The user presses the "Yes" button, but
 * the approval box moves (autoscroll while streaming / a pending re-render)
 * before mouseup, so the native click resolves onto the assistant-message
 * above. Selection must stay on the approval item — the press location, not the
 * shifted release target, decides intent.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const selectionApprovalClickShiftKeepsSelection = {
  name: 'selection-approval-click-shift-keeps-selection',
  description: 'A click whose press began on an approval button does not select the item above when layout shifts before release',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse(
      'call_1',
      'bash',
      { command: 'env echo acsks-test' },
      'Running command.'
    ),
    textResponse('Done.')
  ],

  operations: [
    { type: 'send-message', message: 'Run echo acsks-test' },
    { type: 'wait-for-approval', toolUseId: 'call_1' },
    // Rule 2 auto-selects the pending tool-action.
    { type: 'assert-dom', selector: 'tool-action-message[data-tool-use-id="call_1"].selected' },
    // Press on the Yes button, but the box shifts so the click lands on the
    // assistant-message above.
    { type: 'click-approval-shifted', toolUseId: 'call_1', aboveSelector: 'assistant-message' },
    // Selection must stay on the approval item; the item above is untouched.
    { type: 'assert-dom', selector: 'tool-action-message[data-tool-use-id="call_1"].selected' },
    { type: 'assert-dom', selector: 'assistant-message.selected', absent: true },
    // Cleanup: actually approve so the turn completes.
    { type: 'approve', toolUseId: 'call_1' }
  ],

  expectedDocument: {
    items: [
      { type: 'system-prompt', itemId: '$ITEM_1' },
      { type: 'user', content: 'Run echo acsks-test' },
      { type: 'assistant', content: 'Running command.' },
      {
        type: 'tool-action',
        toolUseId: '$TOOL_1',
        toolName: 'bash',
        toolInput: { command: 'env echo acsks-test' },
        state: 'completed',
        result: { content: 'acsks-test', isError: false }
      },
      { type: 'assistant', content: 'Done.' }
    ]
  }
};

// ============================================================================
// Resize-handle visibility must track the LOGICAL rightmost column
// ============================================================================

/**
 * Regression: the column resize handle was hidden via the CSS structural
 * selector `column-container > *:last-child col-resize-handle`. That depends on
 * the DOM child order exactly matching the logical left-to-right column order.
 * If those ever diverge (a column reused in place while another is appended),
 * the WRONG column's handle vanishes — observed as "the 2nd of 3 columns loses
 * its resizer, the 1st never does, and it self-heals on tab switch".
 *
 * Handle visibility is now driven from the logical column array
 * (conversation-tab `_updateColumnLayout` marks the rightmost column with
 * `.column-rightmost`), so it must follow the logical rightmost column even
 * when the DOM child order is out of order. This test builds 3 columns, forces
 * a DOM-order divergence (moves the middle column to the DOM end WITHOUT a
 * logical rebuild), and asserts ONLY the logical rightmost column hides its
 * handle. Red under the old `:last-child` CSS, green once driven from the
 * logical order.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const selectionResizeHandleTracksLogicalOrder = {
  name: 'selection-resize-handle-tracks-logical-order',
  description: 'Resize-handle visibility follows the logical rightmost column, not DOM :last-child',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', {
      goal: 'Write a file',
      prompt: 'Write rh-file.txt'
    }),
    toolUseResponse('call_2', 'write', { file_path: 'rh-file.txt', content: 'hello' }, 'Writing...'),
    textResponse('File written successfully.'),
    textResponse('Thread finished.')
  ],

  operations: [
    { type: 'send-message', message: 'Write a file in a thread' }
  ],

  customAssertions(conversation) {
    const tab = conversation.getTabElement?.();
    if (!tab) return; // Non-UI mode — skip.

    const container = tab.querySelector('column-container');
    if (!container) throw new Error('resize-handle: no column-container');
    const isColumn = (/** @type {Element} */ el) =>
      el.tagName === 'CONVERSATION-AREA' || el.tagName === 'PROPERTIES-PANEL';

    // Root → thread (selected thread-message) → properties (auto-selected
    // tool-action inside the thread) gives three columns.
    const cols = Array.from(container.children).filter(isColumn);
    if (cols.length !== 3) {
      throw new Error(`resize-handle: expected 3 columns, got ${cols.length}`);
    }
    const logicalRightmost = cols[cols.length - 1];

    // Force the DOM-order divergence the bug surfaces as: move the middle
    // column to the END of the container, with NO logical rebuild. The DOM
    // `:last-child` is now the middle (logical-2nd) column.
    container.appendChild(cols[1]);
    void /** @type {HTMLElement} */ (container).offsetHeight; // flush style recalc

    const handleHidden = (/** @type {Element} */ col) => {
      const handle = col.querySelector('col-resize-handle');
      if (!handle) throw new Error('resize-handle: a column is missing its col-resize-handle');
      return getComputedStyle(handle).display === 'none';
    };

    for (const col of cols) {
      const hidden = handleHidden(col);
      const shouldHide = col === logicalRightmost;
      if (hidden !== shouldHide) {
        throw new Error(
          'resize-handle: visibility tracked DOM order, not logical order — ' +
					`${col.tagName.toLowerCase()} hidden=${hidden}, expected ${shouldHide} ` +
					`(${shouldHide ? 'the' : 'not the'} logical rightmost column)`
        );
      }
    }
  }
};

/**
 * Regression: a conversation-area column is fixed-width (it never flex-fills),
 * so when it ends up rightmost — the deepest thread column, or a folded-run
 * column, with nothing selected in it — there is empty space beside it and the
 * only way to change its width is its own resize handle. Hiding the handle on
 * every rightmost column stranded that column at a width the user couldn't
 * change: click a group, click an item (properties column appears, handle
 * visible), click the column background to deselect (properties column goes,
 * handle goes with it).
 *
 * The handle is dropped only on a rightmost column that grows to fill the space
 * beside it (properties-panel). This test opens root → thread → properties,
 * clears the thread column's selection so the thread column becomes rightmost,
 * and asserts it keeps its handle.
 * @type {import('../utilities/integration-test-runner.js').IntegrationTestDefinition}
 */
export const selectionRightmostConversationKeepsResizeHandle = {
  name: 'selection-rightmost-conversation-keeps-resize-handle',
  description: 'A rightmost conversation-area column stays resizable when its selection is cleared',
  fixture: 'unit-test-fixture',

  llmResponses: [
    toolUseResponse('call_1', 'create_thread', {
      goal: 'Write a file',
      prompt: 'Write rkh-file.txt'
    }),
    toolUseResponse('call_2', 'write', { file_path: 'rkh-file.txt', content: 'hello' }, 'Writing...'),
    textResponse('File written successfully.'),
    textResponse('Thread finished.')
  ],

  operations: [
    { type: 'send-message', message: 'Write a file in a thread' }
  ],

  customAssertions(conversation) {
    const tab = conversation.getTabElement?.();
    if (!tab) return; // Non-UI mode — skip.

    const container = tab.querySelector('column-container');
    if (!container) throw new Error('rightmost-handle: no column-container');
    const columns = () => Array.from(container.children).filter(
      (/** @type {Element} */ el) =>
        el.tagName === 'CONVERSATION-AREA' || el.tagName === 'PROPERTIES-PANEL'
    );

    // Root → thread (selected thread-message) → properties (auto-selected
    // tool-action inside the thread) gives three columns.
    const cols = columns();
    if (cols.length !== 3) {
      throw new Error(`rightmost-handle: expected 3 columns, got ${cols.length}`);
    }

    // Deselect inside the thread column: the properties column drops, leaving
    // the thread column rightmost.
    /** @type {any} */ (cols[1]).clearSelection();
    void /** @type {HTMLElement} */ (container).offsetHeight; // flush style recalc

    const after = columns();
    if (after.length !== 2 || after[1] !== cols[1]) {
      throw new Error(
        `rightmost-handle: expected the thread column to be rightmost of 2, got ${after.length} columns`
      );
    }

    for (const col of after) {
      const handle = col.querySelector('col-resize-handle');
      if (!handle) throw new Error('rightmost-handle: a column is missing its col-resize-handle');
      if (getComputedStyle(handle).display === 'none') {
        throw new Error(
          'rightmost-handle: a fixed-width conversation-area column lost its resize handle — ' +
					'it can no longer be resized'
        );
      }
    }
  }
};

// Export all tests
export const tests = [
  selectionAutoSelectToolAction,
  selectionToolActionOverridesManual,
  selectionUserMessageResets,
  selectionNewThreadAutoOpens,
  selectionContinueInNewThread,
  selectionAutoSelectInSubThread,
  selectionAutoSelectInRootAfterThread,
  selectionContinueBtnVisibleAfterToolUse,
  selectionPendingApprovalAutoSelect,
  selectionAutoSelectsNextPendingAfterApprove,
  selectionAutoSelectsNextPendingAfterUserClickAndApprove,
  selectionApprovalClickShiftKeepsSelection,
  selectionResizeHandleTracksLogicalOrder,
  selectionRightmostConversationKeepsResizeHandle
];
