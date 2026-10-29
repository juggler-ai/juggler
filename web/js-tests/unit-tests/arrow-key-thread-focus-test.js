//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Arrow-keying onto a sub-thread tile must leave the keyboard in the item list.
 *
 * Selecting a tile opens the thread's column to the right. When the column
 * before it was a properties panel (the previous selection was a leaf item),
 * that column is a freshly created conversation-area, and its composer-box
 * connects while focus sits on <body> — which is exactly where it sits during
 * keyboard navigation. Rule 15 already declines to move focus while the arrow
 * keys are driving, so the composer must not take it for itself either:
 * otherwise the next ↑/↓ lands in the new thread's box instead of the list.
 * @module unit-tests/arrow-key-thread-focus-test
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
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
    conversation = await createTestConversation(session);

    const tab = /** @type {any} */ (document.createElement('conversation-tab'));
    container.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();

    const root = conversation.rootMessageThread;
    const doc = conversation._doc.doc;
    const author = conversation._doc.authorId;

    // A leaf item (whose selection opens a properties panel) directly above a
    // sub-thread tile.
    const leaf = createToolActionMessage({
      toolUseId: 'call_arrow_leaf',
      toolName: 'write',
      toolInput: { file_path: 'a.txt', content: 'a' },
      state: TOOL_STATES.COMPLETED
    });
    /** @type {string} */
    let threadId = '';
    doc.transact(() => {
      root.addEvent(createUserMessage('Go'));
      root.addEvent(leaf);
      threadId = root.createSubThread({
        goal: 'Look around',
        initialItems: [createAssistantMessage('Looking.')]
      }).threadId;
    }, author);
    const leafId = /** @type {string} */ (leaf.itemId);

    const rootCol = /** @type {any} */ (tab.querySelector('conversation-area'));
    assert(!!rootCol, 'root conversation column should exist');

    // Click the leaf: navigating mode, properties panel open beside it.
    const leafEl = /** @type {HTMLElement|null} */ (
      rootCol.querySelector(`[message-id="${leafId}"]`)
    );
    assert(!!leafEl, 'the leaf item should have a tile in the root column');
    leafEl.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    leafEl.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Building the root column opened a Rule 15 window that re-focuses its box
    // whenever focus is lost; let it close before letting go of the keyboard.
    await waitFor(() => tab.pendingFocusReasserts === 0, 'the root column\'s focus re-assert window to close');
    if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    assert(rootCol.getSelectedItemId() === leafId,
      `test setup: clicking the leaf should select it, got ${rootCol.getSelectedItemId()}`);
    assert(!tab.querySelector('conversation-area.thread-column'),
      'test setup: no thread column should be open while the leaf is selected');
    assert(document.activeElement === document.body,
      'test setup: navigating mode leaves focus on <body>');

    // ↓ onto the sub-thread tile.
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }));
    assert(rootCol.getSelectedItemId() === threadId,
      `test setup: ArrowDown should select the sub-thread tile, got ${rootCol.getSelectedItemId()}`);
    assert(!!tab.querySelector('conversation-area.thread-column'),
      'test setup: selecting the tile should open the thread column');

    // The two things that could take the keyboard: the thread column's composer
    // arriving, and a Rule 15 window the rebuild opened. Wait for both to be
    // over, then look where focus is.
    const threadCol = /** @type {HTMLElement} */ (tab.querySelector('conversation-area.thread-column'));
    await waitFor(() => threadCol.querySelector('composer-box textarea') && tab.pendingFocusReasserts === 0,
      'the thread column\'s composer to arrive and any focus re-assert window to close');
    const active = /** @type {HTMLElement|null} */ (document.activeElement);
    assert(!active || active.tagName !== 'TEXTAREA',
      'arrow-keying onto a sub-thread must not move focus into a message box ' +
      `(focus is on ${active?.tagName.toLowerCase()} in ` +
      `${active?.closest('conversation-area')?.className || 'no column'})`);

    passed = 1;
  } catch (e) {
    failed = 1;
    errors.push(e instanceof Error ? e.message : String(e));
  } finally {
    conversation?.llmState?.stop?.(conversation.id);
    container.remove();
    if (conversation && session) {
      try {
        await session.deleteConversation(conversation.id, 'arrow-key-thread-focus:cleanup');
      } catch { /* cleanup is best-effort; the suite's leak check reports the rest */ }
    }
  }

  return { passed, failed, errors };
}
