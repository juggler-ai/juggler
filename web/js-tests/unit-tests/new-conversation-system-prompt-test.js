//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A conversation created through `workerManager.loader.createNew` owns the
 * canonical `SYSTEM_1` system-prompt item — including when the create joins a
 * load that is already in flight for the same id.
 *
 * That join is not a corner case in the engine. `new_conversation` creates a
 * conversation server-side, and the worker the server spawns flushes its first
 * yjs-sync before the create's HTTP response gets back to the caller. A sync for
 * an unknown conversation makes the engine auto-load it, so by the time the
 * create resolves, a load is already registered and the create attaches to it.
 * The load path seeds no built-in items — it is reading a conversation that
 * exists — so unless the create finishes the job, the conversation is born
 * without a system prompt: nothing to edit in the properties panel, and every
 * sub-thread clones a starting context with no prompt in it.
 * @module unit-tests/new-conversation-system-prompt-test
 */

import {
  initializeRegistries,
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';
import workerManager from '../../js/services/worker-manager.js';

/**
 * Strip the root system-prompt item, leaving the thread in the state the LOAD
 * path produces: items that came from elsewhere, and no built-in seeding done.
 * @param {any} mt - Root message thread
 */
function stripSystemPrompt(mt) {
  mt.transact(() => {
    const index = mt.items.findIndex((/** @type {any} */ it) => it.get('itemId') === 'SYSTEM_1');
    if (index >= 0) mt.ensureYarray().delete(index, 1);
  });
  mt._systemPromptPlaceholderEnsured = false;
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Test results
 */
export async function runTests() {
  await initializeRegistries();

  const session = await createTestSession();
  const conversation = await createTestConversation(session);
  const mt = conversation.rootMessageThread;

  stripSystemPrompt(mt);
  assert(!mt.findByItemId('SYSTEM_1'), 'setup: the system prompt should be gone before the create runs');

  // The engine's race: an auto-load for this id is already registered, so the
  // create attaches to it instead of running its own creation path.
  workerManager.loader._inFlight.set(conversation.id, Promise.resolve(conversation));
  try {
    const returned = await workerManager.loader.createNew(conversation.id, conversation.name, session);

    assert(returned === conversation, 'a create that joins an in-flight load must return that conversation');
    assert(!!mt.findByItemId('SYSTEM_1'),
      'a create that joined an in-flight load left the conversation with no system prompt');
    const first = mt.items[0];
    assert(first && first.get('itemId') === 'SYSTEM_1',
      `the system prompt must be the first root item; got "${first && first.get('type')}"`);
    assert(first.get('preventUserDeletion') === true,
      'the seeded system prompt must be undeletable');
  } finally {
    workerManager.loader._inFlight.delete(conversation.id);
  }

  return { passed: 4, failed: 0, errors: [] };
}
