//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * @file Test for the quit/close draft-flush handshake.
 *
 * Typing and immediately quitting used to lose the text: it lived only in the
 * textarea until the keystroke debounce fired, and the native shell announced
 * the close without waiting for anything, so termination raced the rescue.
 *
 * The fix has two halves and this pins both:
 *
 *  A. flushDraft() reports which conversation it rescued. The close handler
 *     forces exactly those to disk, so a wrong answer here means either a lost
 *     draft (false negative) or a pointless synchronous write on every open
 *     conversation (false positive).
 *
 *  B. rescue + flushPersistence puts the text on disk *inside* the debounce
 *     window. This is the sequence the close handler runs, asserted the only
 *     way that means anything: destroy the worker and reload from the backend.
 *
 * The debounce is deliberately never allowed to fire — if any assertion here
 * passes because the timer got there first, the test proves nothing.
 * @module unit-tests/draft-close-flush-test
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  waitFor,
} from '../utilities/test-helpers.js';
import workerManager from '../../js/services/worker-manager.js';
import logger from '../utilities/test-logger.js';
import '../../js/components/conversation-tab.js';

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated results.
 */
export async function runTests() {
  await initializeRegistries();

  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /**
   * @param {boolean} cond
   * @param {string} msg
   */
  const check = (cond, msg) => {
    if (cond) { passed++; } else { failed++; errors.push(msg); }
  };

  const container = document.createElement('div');
  container.style.cssText = 'position:absolute;left:0;top:0;width:1400px;height:900px;';
  document.body.appendChild(container);

  try {
    const session = await createTestSession();
    const conversation = await createTestConversation(session);
    const convId = conversation.id;

    const tab = /** @type {any} */ (document.createElement('conversation-tab'));
    container.appendChild(tab);
    tab.setConversation(conversation);
    tab.setActive();

    await waitFor(
      () => !!tab.querySelector('composer-box textarea'),
      { description: 'root composer-box textarea to build' }
    );

    const box = /** @type {any} */ (tab.querySelector('composer-box'));
    if (!box._messageThread) box.setMessageThread(conversation.rootMessageThread);
    const textarea = /** @type {HTMLTextAreaElement} */ (box.querySelector('textarea'));

    // ---- A: an idle composer has nothing to rescue --------------------------
    box.clearInput();
    check(
      box.flushDraft() === null,
      'flushDraft must report nothing rescued when no debounced save is pending; ' +
      'otherwise every quit forces a synchronous disk write per open conversation'
    );

    // ---- B: a composer mid-debounce reports its conversation ----------------
    // Simulate typing: value set plus an armed, NOT-yet-fired debounce. This is
    // exactly the state a fast typist is in when they hit Cmd+Q.
    const typed = 'typed a moment before quitting';
    textarea.value = typed;
    box._scheduleDraftSave(typed);

    const rescued = box.flushDraft();
    check(
      rescued === convId,
      `flushDraft must report the conversation it rescued so the close handler ` +
      `can force it to disk; expected ${JSON.stringify(convId)}, got ${JSON.stringify(rescued)}`
    );

    const draft = conversation.rootMessageThread.draft;
    check(
      !!draft && draft.text === typed,
      `flushDraft must persist the live text to the model without waiting out the ` +
      `debounce; expected ${JSON.stringify(typed)}, got ${JSON.stringify(draft && draft.text)}`
    );

    // ---- C: the rescued draft reaches disk ----------------------------------
    // The rest of the close handler: push the write to the worker, then force
    // the save and wait for the ack. The ack is a real barrier — the worker
    // takes messages serially, so the yjs-sync above is already applied, and
    // the handler saves inline before acking.
    conversation._doc.flushPendingUpdates();
    await workerManager.flushPersistence(convId);

    await workerManager.loader.destroy(conversation);
    session.conversations.delete(convId);
    await session.load();
    await session.ensureConversationLoaded(convId);

    const reloaded = session.conversations.get(convId);
    if (!reloaded) {
      check(false, 'Conversation did not reload from backend');
    } else {
      const persisted = reloaded.rootMessageThread.draft;
      check(
        !!persisted && persisted.text === typed,
        `A draft rescued at close must survive quit/restart; expected ` +
        `${JSON.stringify(typed)}, got ${JSON.stringify(persisted && persisted.text)}`
      );
    }

    if (failed === 0) {
      logger.info('[draft-close-flush-test] Test PASSED - draft rescued inside the debounce window reached disk');
    }
    return { passed, failed, errors };
  } finally {
    container.remove();
  }
}
