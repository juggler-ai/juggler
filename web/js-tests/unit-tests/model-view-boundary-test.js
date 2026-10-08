//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The model and its services announce what happened; the view decides what to
 * paint.
 *
 * A conversation, the session and LLMState hold no element and call no method
 * on one. A status change reaches a tab because the tab subscribed to its
 * conversation's status feed. A send scrolls the transcript because the tab
 * hears `conversation:turn-requested` on the session feed. Session events go
 * out on the session's own feed and are not mirrored onto `document`. The
 * reverse direction is the view's to own as well: the tab hands its root column
 * the conversation, and the conversation never writes into a column.
 *
 * The first three cases are structural. The last two drive a real
 * conversation-tab, because "the tab subscribed" is only true if a status
 * change actually reaches one, and stops reaching it once it is gone.
 * @module unit-tests/model-view-boundary-test
 */

import {
  initializeRegistries,
  createTestSession,
  createApprovalTestConversation,
  trackTestSession,
  assert
} from '../utilities/test-helpers.js';
import LLMState from '../../js/services/llm-state.js';
import Session from '../../js/model/session.js';
import Conversation from '../../js/model/conversation.js';
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
   * @param {string} label - Case under test, used to label a failure.
   * @param {() => Promise<void>|void} fn - Assertions; throws to fail.
   * @returns {Promise<void>} Resolves once the case has run.
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

  await run('LLMState holds no view', () => {
    const proto = /** @type {any} */ (LLMState.prototype);
    const strays = ['registerConversationTab', 'unregisterConversationTab', '_getConversationArea', '_notifyConversationArea']
      .filter((name) => name in proto);
    assert(strays.length === 0, `LLMState still reaches for a tab: ${strays.join(', ')}`);
    assert(typeof proto.registerConversation === 'function' && typeof proto.unregisterConversation === 'function',
      'LLMState must register a conversation, not a conversation and its tab');
    const state = /** @type {any} */ (new LLMState());
    assert(!('_conversationTabs' in state), 'LLMState keeps a map of tab elements');
  });

  await run('a conversation writes nothing into the view it is shown in', () => {
    /** @type {any} */
    const area = {};
    /** @type {any} */
    const conv = Object.create(Conversation.prototype);
    conv.id = 'model-view-boundary';
    conv._llmState = { registerConversation() {} };
    conv.setTabElement(/** @type {any} */ ({ getConversationArea: () => area, getComposer: () => null }));
    assert(!('conversation' in area), 'setTabElement wrote the conversation into the tab\'s column');
    assert(!('_conversationArea' in conv), 'the conversation keeps a reference to a column of its own');
  });

  await run('session events stay on the session feed', () => {
    const session = /** @type {any} */ (trackTestSession(new Session(/** @type {any} */ ({}))));
    const type = 'model-view-boundary:probe';
    let onDocument = 0;
    let onFeed = 0;
    const listener = () => { onDocument++; };
    document.addEventListener(type, listener);
    const unsubscribe = session.subscribe((/** @type {{type: string}} */ event) => {
      if (event.type === type) onFeed++;
    });
    try {
      session.notifyConversationChange(type, {});
    } finally {
      document.removeEventListener(type, listener);
      unsubscribe();
    }
    assert(onFeed === 1, `the session feed heard the event ${onFeed} time(s), want 1`);
    assert(onDocument === 0, `the event was mirrored onto document ${onDocument} time(s)`);
  });

  const host = document.createElement('div');
  host.style.cssText = 'position:absolute;left:-9999px;top:-9999px;width:1600px;height:800px;';
  document.body.appendChild(host);

  /** @type {any} */
  let session = null;
  /** @type {any} */
  let conversation = null;

  try {
    session = await createTestSession();
    conversation = await createApprovalTestConversation(session);
    const tab = /** @type {any} */ (document.createElement('conversation-tab'));
    host.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    const llmState = conversation.llmState;

    await run('a requested turn scrolls the tab\'s own root column', () => {
      const root = /** @type {any} */ (tab.querySelector('conversation-area'));
      assert(!!root, 'test setup: the root conversation column should exist');
      /** @type {boolean[]} */
      const scrolls = [];
      root.scrollToBottom = (/** @type {boolean} */ force = false) => { scrolls.push(force); };
      session.notifyConversationChange('conversation:turn-requested', { conversationId: 'some-other-conversation' });
      assert(scrolls.length === 0, 'another conversation\'s turn scrolled this tab');
      session.notifyConversationChange('conversation:turn-requested', { conversationId: conversation.id });
      assert(scrolls.length === 1 && scrolls[0] === true,
        `the root column was scrolled ${JSON.stringify(scrolls)}, want one forced scroll`);
    });

    // Last, because it detaches the tab.
    await run('a status change reaches the tab through its own subscription, and stops when it goes', () => {
      /** @type {Array<string|null>} */
      const synced = [];
      tab.syncWithStatus = (/** @type {string|null} */ threadId = null) => { synced.push(threadId); };
      llmState.updateStatus(conversation.id, 'custom', { message: 'Working' }, null);
      llmState.stop(conversation.id);
      assert(synced.length >= 2, `the tab was synced ${synced.length} time(s) across a start and a stop, want 2`);

      host.removeChild(tab);
      synced.length = 0;
      llmState.updateStatus(conversation.id, 'custom', { message: 'Working' }, null);
      llmState.stop(conversation.id);
      assert(synced.length === 0, `a detached tab was still synced ${synced.length} time(s)`);
    });
  } catch (e) {
    failed++;
    errors.push(`setup: ${e instanceof Error ? e.message : String(e)}`);
  } finally {
    host.remove();
    // Conversations live in a session shared by every lane, so a test that
    // creates one deletes it.
    if (conversation) {
      try {
        await session?.deleteConversation(conversation.id, 'model-view-boundary:cleanup');
      } catch { /* the assertions have already been recorded */ }
    }
  }

  return { passed, failed, errors };
}
