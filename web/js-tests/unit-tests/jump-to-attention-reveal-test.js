//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Jump-to-attention must land on the approval wherever it is parked.
 *
 * The approval that needs the user is often in a sub-thread, and the columns on
 * screen are whatever the user last looked at — a different sub-thread, or an
 * item's properties. Two things have to happen for the jump to be any use:
 *
 *  1. The column chain is rebuilt to lead to the approval: its thread opens and
 *     the approval is selected there, replacing whatever was open.
 *  2. That column is scrolled into view horizontally. Selecting the approval in
 *     a column that sits off to the right gives it the keyboard but leaves the
 *     user looking at something else.
 *
 * The horizontal move is observed by recording which column
 * `_scrollToActiveColumn` was asked to bring into view: the real scroll is a
 * smooth scroll a frame later, which a hidden pool window may never paint.
 * @module unit-tests/jump-to-attention-reveal-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  assert
} from '../utilities/test-helpers.js';
import {
  createUserMessage,
  createAssistantMessage,
  createToolActionMessage,
  TOOL_STATES
} from '../../sdk/lib/message.js';
import { isToolGroupingEnabled, setToolGroupingEnabled } from '../../js/utils/tool-grouping-pref.js';
import '../../js/components/conversation-tab.js';

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1200px;height:800px;';
  document.body.appendChild(container);

  /** @type {any} */
  let conversation = null;
  /** @type {any} */
  let session = null;
  const originalGrouping = isToolGroupingEnabled();
  setToolGroupingEnabled(false);

  try {
    session = await createTestSession();
    conversation = await createApprovalTestConversation(session);

    const tab = /** @type {any} */ (document.createElement('conversation-tab'));
    container.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();

    const root = conversation.rootMessageThread;
    const doc = conversation._doc.doc;
    const author = conversation._doc.authorId;

    // Two sub-threads: one the user is reading, one parked on an approval.
    const approval = createToolActionMessage({
      toolUseId: 'call_jump_reveal',
      toolName: 'write',
      toolInput: { file_path: 'answer.txt', content: 'hello' },
      state: TOOL_STATES.PENDING
    });
    const finishedRead = createToolActionMessage({
      toolUseId: 'call_jump_reveal_read',
      toolName: 'read',
      toolInput: { file_path: 'answer.txt' },
      state: TOOL_STATES.COMPLETED
    });
    let reading = '';
    let parked = '';
    doc.transact(() => {
      root.addEvent(createUserMessage('Look into both of these'));
      reading = root.createSubThread({
        goal: 'The one being read',
        initialItems: [createAssistantMessage('Found it.')],
        extra: { result: 'Done.' }
      }).threadId;
      // The finished read before the approval makes a foldable run of two.
      parked = root.createSubThread({
        goal: 'The one waiting on you',
        initialItems: [createAssistantMessage('Writing.'), finishedRead, approval]
      }).threadId;
    }, author);
    const approvalId = /** @type {string} */ (approval.itemId);

    /** @type {HTMLElement[]} */
    const scrolledTo = [];
    const realScroll = tab._scrollToActiveColumn.bind(tab);
    tab._scrollToActiveColumn = () => {
      scrolledTo.push(tab._columns[tab._selection.activeColumnIndex]);
      realScroll();
    };

    /** @returns {any} The thread column holding the parked approval, if open. */
    const parkedColumn = () => Array.from(tab.querySelectorAll('conversation-area.thread-column'))
      .find((/** @type {any} */ col) => col.getMessageThread?.()?.threadItemId === parked);

    // --- Another sub-thread is open: the jump must open the parked one ---
    tab.openThread(reading);
    assert(!parkedColumn(), 'test setup: only the sub-thread being read should be open');
    scrolledTo.length = 0;

    tab.revealAttention(true);

    const col = parkedColumn();
    assert(!!col,
      'jump-to-attention must open the sub-thread holding the approval, but the ' +
      'open thread columns are ' + JSON.stringify(
        Array.from(tab.querySelectorAll('conversation-area.thread-column'))
          .map((/** @type {any} */ c) => c.getMessageThread?.()?.threadItemId)));
    assert(col.getSelectedItemId() === approvalId,
      `the approval must be selected in its column, got ${col.getSelectedItemId()}`);
    assert(scrolledTo.includes(col),
      'the column holding the approval must be scrolled into view');

    // --- The parked thread is already open: the jump must still scroll to it ---
    scrolledTo.length = 0;
    tab.revealAttention(true);
    assert(scrolledTo.includes(parkedColumn()),
      'with the approval already selected, jump-to-attention must still scroll its ' +
      'column into view — it may be off screen');

    // --- The approval is folded into a tool group: land inside the group ---
    setToolGroupingEnabled(true);
    tab.openThread(reading);
    scrolledTo.length = 0;

    tab.revealAttention(true);

    const groupCol = /** @type {any} */ (Array.from(tab.querySelectorAll('conversation-area'))
      .find((/** @type {any} */ c) => c.isGroupColumn));
    assert(!!groupCol,
      'with the approval folded into a tool group, jump-to-attention must open the group');
    assert(groupCol.getSelectedItemId() === approvalId,
      `the approval must be selected inside its group, got ${groupCol.getSelectedItemId()}`);
    assert(scrolledTo.includes(groupCol),
      'the group column holding the approval must be scrolled into view');

    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    // Awaited: a lane that loads before the restore reaches the server reads the
    // value set above and keeps it, folding every tool run it draws.
    await setToolGroupingEnabled(originalGrouping);
    container.remove();
    if (conversation && session) {
      try {
        await session.deleteConversation(conversation.id, 'jump-to-attention-reveal:cleanup');
      } catch { /* cleanup is best-effort; the suite's leak check reports the rest */ }
    }
  }

  return { passed, failed, errors };
}
