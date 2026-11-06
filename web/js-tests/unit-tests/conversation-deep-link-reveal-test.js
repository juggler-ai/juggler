//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A page opened at a link to a conversation (`?c=`) lands where ⌘J would: on
 * the conversation's first pending approval, selected and given the keyboard,
 * or, with nothing pending, at the end of its thread.
 *
 * The load opens the page on the linked conversation before it has hydrated,
 * so whether it holds an approval is known only once it has; the reveal waits
 * for that, and reveals in that conversation's own tab, never in whichever tab
 * happens to be active by then.
 *
 * The reveal and the tab defer onto requestAnimationFrame, which never fires in
 * the hidden test-pool window, so it is shimmed to a macrotask for the suite.
 * @module unit-tests/conversation-deep-link-reveal-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  waitFor,
  nextTask,
  assert
} from '../utilities/test-helpers.js';
import { createUserMessage, createToolActionMessage, TOOL_STATES } from '../../sdk/lib/message.js';
import { revealLinkedConversation } from '../../js/services/conversation-commands.js';
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

  const realRaf = window.requestAnimationFrame;
  const realCaf = window.cancelAnimationFrame;
  /** @type {Map<number, ReturnType<typeof setTimeout>>} */
  const pendingFrames = new Map();
  let nextFrameId = 1;
  window.requestAnimationFrame = (/** @type {FrameRequestCallback} */ cb) => {
    const id = nextFrameId++;
    pendingFrames.set(id, setTimeout(() => { pendingFrames.delete(id); cb(Date.now()); }, 0));
    return id;
  };
  window.cancelAnimationFrame = (/** @type {number} */ id) => {
    const t = pendingFrames.get(id);
    if (t) { clearTimeout(t); pendingFrames.delete(id); }
  };

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1200px;height:800px;';
  document.body.appendChild(container);

  /** @type {any} */
  let session = null;
  /** @type {any[]} */
  const made = [];

  /**
   * @param {string} label - Test label.
   * @param {() => Promise<void>} fn - Test body.
   */
  const run = async (label, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  /**
   * A conversation on screen in a tab of its own, the active one.
   * @returns {Promise<{conversation: any, tab: any}>} The conversation and its tab.
   */
  const onScreen = async () => {
    const conversation = /** @type {any} */ (await createApprovalTestConversation(session));
    made.push(conversation);
    container.replaceChildren();
    const tab = /** @type {any} */ (document.createElement('conversation-tab'));
    container.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();
    return { conversation, tab };
  };

  try {
    session = await createTestSession();

    await run('a linked conversation parked on an approval lands on it, selected and engaged', async () => {
      const { conversation, tab } = await onScreen();
      const approval = createToolActionMessage({
        toolUseId: 'call_deep_link_reveal',
        toolName: 'write',
        toolInput: { file_path: 'answer.txt', content: 'hello' },
        state: TOOL_STATES.PENDING
      });
      conversation._doc.doc.transact(() => {
        conversation.rootMessageThread.addEvent(createUserMessage('Write the answer'));
        conversation.rootMessageThread.addEvent(approval);
      }, conversation._doc.authorId);
      const approvalId = /** @type {string} */ (approval.itemId);

      /** @type {boolean[]} */
      const asked = [];
      const realReveal = tab.revealAttention.bind(tab);
      tab.revealAttention = (/** @type {boolean} */ selectApproval, /** @type {number} */ attempt) => {
        if (!attempt) asked.push(selectApproval);
        return realReveal(selectApproval, attempt);
      };

      await revealLinkedConversation(session, conversation.id);
      // The tab selects a pending approval of its own accord, so the selection
      // alone says nothing about the reveal: what was asked of the tab does.
      await waitFor(() => asked.length > 0, { description: 'the linked conversation to be revealed' });
      assert(JSON.stringify(asked) === '[true]', `the tab was asked to reveal ${JSON.stringify(asked)}, not the approval once`);
      await waitFor(() => tab._columns[0]?.getSelectedItemId?.() === approvalId,
        { description: 'the linked conversation\'s pending approval to be selected' });
    });

    await run('a linked conversation with nothing pending is revealed at the end of its thread', async () => {
      const { conversation, tab } = await onScreen();
      /** @type {boolean[]} */
      const asked = [];
      tab.revealAttention = (/** @type {boolean} */ selectApproval) => { asked.push(selectApproval); };
      await revealLinkedConversation(session, conversation.id);
      await waitFor(() => asked.length > 0, { description: 'the linked conversation to be revealed' });
      assert(JSON.stringify(asked) === '[false]', `the tab was asked to reveal ${JSON.stringify(asked)}, not the thread's end`);
    });

    await run('a link the user has moved away from before it hydrated reveals nothing', async () => {
      const { conversation, tab } = await onScreen();
      const other = /** @type {any} */ (await createApprovalTestConversation(session));
      made.push(other);
      /** @type {boolean[]} */
      const asked = [];
      tab.revealAttention = (/** @type {boolean} */ selectApproval) => { asked.push(selectApproval); };
      // createApprovalTestConversation selects the conversation it made.
      assert(session.visibleConversationId === other.id, 'test setup: the second conversation should be on screen');
      await revealLinkedConversation(session, conversation.id);
      // Past the frame (a macrotask, shimmed above) a reveal would have run in.
      await nextTask();
      await nextTask();
      assert(asked.length === 0, `a link no longer on screen was revealed (${JSON.stringify(asked)})`);
    });
  } finally {
    window.requestAnimationFrame = realRaf;
    window.cancelAnimationFrame = realCaf;
    for (const t of pendingFrames.values()) clearTimeout(t);
    container.remove();
    for (const conversation of made) {
      try {
        await session.deleteConversation(conversation.id, 'conversation-deep-link-reveal:cleanup');
      } catch { /* cleanup is best-effort; the suite's leak check reports the rest */ }
    }
  }

  return { passed, failed, errors };
}
