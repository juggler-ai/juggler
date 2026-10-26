//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Clicking a running task lands on the tool call that started it, in whichever
 * conversation and thread that was.
 *
 * The task list is the server's, so a row names a tool call — conversation,
 * thread, tool-use id — not a transcript row. Two things have to hold for the
 * click to be any use:
 *
 *  1. The call resolves to its own row. Tool-use ids repeat across threads
 *     (`call_1` is in every sub-thread), so the thread named decides which.
 *  2. A task in another conversation switches to it first — loaded, switched,
 *     and its column up — before anything is pointed at.
 *
 * Asserted at those two seams against a real conversation tab, and through the
 * docked board's own `_revealTask`, rather than by driving the whole window's
 * conversation switch, which a shared lane cannot do without stepping on its
 * neighbours.
 * @module unit-tests/pinboard-task-reveal-test
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
import { revealInConversation, showConversation } from '../../js/components/pinboard-content.js';
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

  /**
   * @param {string} label - Test label.
   * @param {() => (void | Promise<void>)} fn - Test body.
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

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1200px;height:800px;';
  document.body.appendChild(container);

  /** @type {any} */
  let session = null;
  /** @type {any} */
  let conversation = null;

  try {
    session = await createTestSession();
    conversation = await createApprovalTestConversation(session);

    const tab = /** @type {any} */ (document.createElement('conversation-tab'));
    container.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();

    const root = conversation.rootMessageThread;
    const doc = conversation._doc.doc;

    // The same tool-use id in the root and in a sub-thread: only the thread
    // tells the two apart.
    const rootCall = createToolActionMessage({
      toolUseId: 'call_1', toolName: 'bash', toolInput: { command: 'npm run build' }, state: TOOL_STATES.COMPLETED,
    });
    const subCall = createToolActionMessage({
      toolUseId: 'call_1', toolName: 'bash', toolInput: { command: 'npm test' }, state: TOOL_STATES.COMPLETED,
    });
    let sub = '';
    doc.transact(() => {
      root.addEvent(createUserMessage('Build and test'));
      root.addEvent(rootCall);
      sub = root.createSubThread({
        goal: 'Run the tests',
        initialItems: [createAssistantMessage('Testing.'), subCall],
      }).threadId;
    }, conversation._doc.authorId);

    /**
     * @param {string} itemId - The row to look for.
     * @returns {boolean} Whether some column has it selected.
     */
    const selected = (itemId) => Array.from(tab.querySelectorAll('conversation-area'))
      .some((/** @type {any} */ col) => col.getSelectedItemId?.() === itemId);

    await run('a tool call in a sub-thread lands on that thread\'s row, not the root\'s', () => {
      revealInConversation({ kind: 'tool', id: 'call_1', thread: sub });
      assert(selected(/** @type {string} */ (subCall.itemId)),
        'the sub-thread\'s call must be selected');
      assert(!selected(/** @type {string} */ (rootCall.itemId)),
        'the root\'s call_1 is a different call and must not be the one selected');
    });

    await run('the same id with no thread named lands on the root\'s row', () => {
      revealInConversation({ kind: 'tool', id: 'call_1', thread: null });
      assert(selected(/** @type {string} */ (rootCall.itemId)), 'the root\'s call must be selected');
    });

    await run('the docked board reveals a task in the conversation on screen without switching', async () => {
      const content = /** @type {any} */ (document.createElement('pinboard-content'));
      /** @type {string[]} */
      const calls = [];
      content.setSession({
        getConversation: (/** @type {string} */ id) => (id === conversation.id ? conversation : null),
        getVisibleConversation: () => conversation,
        ensureConversationLoaded: async () => { calls.push('load'); },
        switchConversation: () => { calls.push('switch'); return true; },
      });
      revealInConversation({ kind: 'thread', id: null });
      await content._revealTask({
        taskId: 'bg-1', conversationId: conversation.id, threadId: sub, toolUseId: 'call_1',
      });
      assert(calls.length === 0, `a task in the conversation on screen needs no switch, got ${JSON.stringify(calls)}`);
      assert(selected(/** @type {string} */ (subCall.itemId)), 'the task\'s call must be selected');
    });

    await run('a task in another conversation loads it, switches to it, then waits for its column', async () => {
      /** @type {string[]} */
      const calls = [];
      const ready = document.createElement('div');
      ready.id = 'conversation-tab-conv_elsewhere';
      /** @type {any} */ (ready).shown = true;
      container.appendChild(ready);
      try {
        const ok = await showConversation({
          getConversation: () => ({ id: 'conv_elsewhere' }),
          getVisibleConversation: () => conversation,
          ensureConversationLoaded: async (/** @type {string} */ id) => { calls.push(`load ${id}`); },
          switchConversation: (/** @type {string} */ id) => { calls.push(`switch ${id}`); return true; },
        }, 'conv_elsewhere');
        assert(ok, 'a switch that happened must say so');
        assert(JSON.stringify(calls) === JSON.stringify(['load conv_elsewhere', 'switch conv_elsewhere']),
          `expected it loaded before it is switched to, got ${JSON.stringify(calls)}`);
      } finally {
        ready.remove();
      }
    });

    await run('a refused switch stops the reveal', async () => {
      const ok = await showConversation({
        getConversation: () => ({ id: 'conv_locked' }),
        getVisibleConversation: () => conversation,
        ensureConversationLoaded: async () => {},
        switchConversation: () => false,
      }, 'conv_locked');
      assert(ok === false, 'pointing at something in a conversation that did not come up would land nowhere');
    });

    await run('a conversation this viewer does not have is not a failure', async () => {
      const ok = await showConversation({
        getConversation: () => null,
        switchConversation: () => { throw new Error('nothing to switch to'); },
      }, 'conv_unknown');
      assert(ok === true, 'there was nothing to switch to, so nothing failed');
    });
  } finally {
    container.remove();
    if (conversation && session) {
      try {
        await session.deleteConversation(conversation.id, 'pinboard-task-reveal:cleanup');
      } catch { /* cleanup is best-effort; the suite's leak check reports the rest */ }
    }
  }

  return { passed, failed, errors };
}
