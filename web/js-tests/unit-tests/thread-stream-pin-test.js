//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Opening a sub-thread must not retire the pin that opening it sets.
 *
 * Rule 15 moves the keyboard when a column opens: the new thread's box is the
 * one to type into. It named that column and then asked _focusInput() to find
 * it again, which answers "where is the user working" — and during a reveal
 * that is still the column they clicked in, the PARENT. So the parent's
 * composer took the keyboard, rule B read a composer taking focus as the user
 * turning to compose, and the pin was gone. Not at the click: the re-assert
 * runs on a 30ms timer, so the pin died a few frames after the reader set it,
 * which is why every test that selected a tile and asserted in the same tick
 * saw it held.
 *
 * What made it visible is a question parked in the parent. A pending approval
 * is rule 2b's standing target and rule 2b is asked on EVERY
 * conversation:changed — which a working sub-thread produces several times a
 * second. With the pin gone the first of those packets hands the selection
 * back to the question, and ColumnSelectionState.selectItem truncates the
 * chain, closing the transcript the reader had opened. Clicking the tile again
 * re-ran the whole sequence, so the column could not be kept open at all.
 * @module unit-tests/thread-stream-pin-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  assert,
  waitFor
} from '../utilities/test-helpers.js';
import {
  createUserMessage,
  createAssistantMessage,
  createToolActionMessage,
  TOOL_STATES
} from '../../sdk/lib/message.js';
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

    // A sub-thread is working, and a question sits unanswered in the parent.
    /** @type {string} */
    let threadA = '';
    const question = createToolActionMessage({
      toolUseId: 'call_stream_ask',
      toolName: 'write',
      toolInput: { file_path: 'answer.txt', content: 'which one?' },
      state: TOOL_STATES.PENDING
    });
    doc.transact(() => {
      root.addEvent(createUserMessage('Investigate this'));
      threadA = root.createSubThread({
        goal: 'First look',
        initialItems: [createAssistantMessage('Looking.')]
      }).threadId;
      root.addEvent(question);
    }, author);
    const questionId = /** @type {string} */ (question.itemId);

    const rootCol = /** @type {any} */ (tab.querySelector('conversation-area'));
    assert(!!rootCol, 'root conversation column should exist');
    assert(root.getPendingApprovalMessages().length === 1,
      'test setup: the parent should hold one unanswered approval');
    assert(rootCol.getSelectedItemId() === questionId,
      `test setup: the arriving approval should be selected first — that is ` +
      `the state the reader clicks from, got ${rootCol.getSelectedItemId()}`);

    // The reader clicks the sub-thread tile to read its transcript. A real
    // click, not selectItem(): it is the click that makes the parent the active
    // column, which is what the focus move then resolves through.
    const tileEl = /** @type {HTMLElement|null} */ (
      rootCol.querySelector(`thread-message[message-id="${threadA}"]`)
    );
    assert(!!tileEl, 'the sub-thread should have a tile in the parent column');
    tileEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    tileEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    assert(rootCol.getSelectedItemId() === threadA,
      `test setup: clicking the tile should select it, got ` +
      `${rootCol.getSelectedItemId()}`);
    assert(rootCol.selectionOrigin === 'user',
      'test setup: selecting a sub-thread tile must pin the parent column');

    const openThreadIds = () => Array.from(tab.querySelectorAll('conversation-area.thread-column'))
      .map((/** @type {any} */ col) => col.getMessageThread?.()?.threadItemId);
    assert(openThreadIds().includes(threadA),
      'test setup: the sub-thread column should be open');
    const threadCol = /** @type {any} */ (
      tab.querySelector('conversation-area.thread-column')
    );
    const childThread = threadCol.getMessageThread();

    // The reveal's own focus move is re-asserted on a timer across a short
    // window. Nothing the app does for itself may retire a pin the reader set,
    // so wait for that window to close and then look.
    await waitFor(() => tab.pendingFocusReasserts === 0, 'the reveal\'s focus re-assert window to close');
    assert(rootCol.selectionOrigin === 'user',
      'the pin must survive the focus move that opening the sub-thread makes: ' +
      'the keyboard belongs to the new column\'s box, and the parent\'s box ' +
      'taking it instead reads as the reader turning to compose (rule B)');

    /**
     * One packet's worth of traffic: the worker's processing frame for the
     * running thread, then the token it appends to the message it is streaming.
     * @param {number} n - Packet number, 0-based.
     */
    const streamPacket = (n) => {
      conversation._doc.setMetadata('processingState', {
        status: 'streaming',
        threadItemId: threadA,
        startedAt: 1,
        runs: {
          [threadA]: {
            status: 'streaming',
            threadItemId: threadA,
            startedAt: 1,
            outputTokens: n * 137
          }
        }
      });
      if (n === 0) {
        childThread.addEvent(createAssistantMessage('Thinking'));
        return;
      }
      const items = childThread.items;
      const last = items[items.length - 1];
      doc.transact(() => {
        last.set('content', 'Thinking' + ' more'.repeat(n));
      }, author);
    };

    for (let n = 0; n < 12; n++) {
      streamPacket(n);
      assert(rootCol.getSelectedItemId() === threadA,
        `packet ${n}: an unanswered approval must not take the parent column ` +
        `off the sub-thread tile the reader selected (selection moved to ` +
        `${rootCol.getSelectedItemId()}, origin ${rootCol.selectionOrigin})`);
      assert(openThreadIds().includes(threadA),
        `packet ${n}: the sub-thread being read must stay open, got ` +
        `${JSON.stringify(openThreadIds())}`);
    }

    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    conversation?.llmState?.stop?.(conversation.id);
    container.remove();
    if (conversation && session) {
      try {
        await session.deleteConversation(conversation.id, 'thread-stream-pin:cleanup');
      } catch { /* cleanup is best-effort; the suite's leak check reports the rest */ }
    }
  }

  return { passed, failed, errors };
}
