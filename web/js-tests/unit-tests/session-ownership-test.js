//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Unit tests: who owns what between a Session and its Conversations, and the
 * background promises the session starts.
 *
 * - A switch that fetches a context window in the background handles its
 *   failure, and leaves the announcement to the conversation, which makes it
 *   only when it resolved a window.
 * - The one-shot assistant-file scan records itself through the metadata patch
 *   API, and only once the seeding succeeded; a failed seeding is handled.
 * - Releasing a conversation cancels its local actions through the
 *   conversation, not its private executor field.
 * - A head-of-bar stub whose load failed is destroyed, not merely forgotten.
 * - Building a conversation does not write the session's name cache; the
 *   session seeds it, in `Session.buildConversation`.
 * @module unit-tests/session-ownership
 */

import { assert, createTestSession, createTestConversation, nextTask } from '../utilities/test-helpers.js';
import Conversation from '../../js/model/conversation.js';
import SessionPersistence from '../../js/model/session-persistence.js';
import workerManager from '../../js/services/worker-manager.js';

/**
 * A promise that records whether anyone attached a rejection handler to it.
 * @returns {{Tracked: typeof Promise, handled: () => boolean}} The class and its record
 */
function trackedPromise() {
  let handled = false;
  class Tracked extends Promise {
    /**
     * @param {any} [onFulfilled]
     * @param {any} [onRejected]
     * @returns {any} The chained promise
     */
    then(onFulfilled, onRejected) {
      if (typeof onRejected === 'function') handled = true;
      return super.then(onFulfilled, onRejected);
    }
  }
  return { Tracked: /** @type {any} */ (Tracked), handled: () => handled };
}

/**
 * Pin a value over a prototype getter on one instance; returns the restorer.
 * @param {any} obj
 * @param {string} key
 * @param {any} value
 * @returns {() => void} Removes the pin
 */
function pin(obj, key, value) {
  Object.defineProperty(obj, key, { value, writable: true, configurable: true });
  return () => { delete obj[key]; };
}

/**
 * @returns {Promise<{passed: number, failed: number, errors: string[]}>} Aggregated test results.
 */
export async function runTests() {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label - Test label.
   * @param {() => Promise<void>} fn - Test body.
   */
  const run = async (label, fn) => {
    const priorWarn = console.warn;
    const priorError = console.error;
    console.warn = () => {};
    console.error = () => {};
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      console.warn = priorWarn;
      console.error = priorError;
    }
  };

  const session = /** @type {any} */ (await createTestSession());

  await run('a switch leaves the context-window announcement to the conversation and handles a failed fetch', async () => {
    const a = /** @type {any} */ (await createTestConversation(session));
    const b = await createTestConversation(session);
    const restores = [pin(a, 'contextWindow', undefined)];
    let announced = 0;
    const off = session.subscribe((/** @type {any} */ e) => {
      if (e.type === 'conversation:context-window-updated' && e.data === a) announced++;
    });
    try {
      for (const outcome of ['resolves', 'rejects']) {
        const { Tracked, handled } = trackedPromise();
        a.ensureContextWindow = () => (outcome === 'resolves'
          ? Tracked.resolve(undefined)
          : Tracked.reject(new Error('providers unavailable')));
        session.switchConversation(b.id);
        session.switchConversation(a.id);
        await nextTask();
        assert(handled(), `a background fetch that ${outcome} has no rejection handler`);
      }
      assert(announced === 0, `the session announced a context window the conversation never resolved (${announced}×)`);
    } finally {
      off();
      delete a.ensureContextWindow;
      for (const restore of restores) restore();
      await session.deleteConversation(a.id);
      await session.deleteConversation(b.id);
    }
  });

  await run('the assistant-file scan records itself through the patch API once seeding succeeds', async () => {
    /** @type {any[]} */
    const patches = [];
    let seed = () => Promise.resolve();
    const metadata = Object.freeze({});
    const host = /** @type {any} */ ({
      state: () => ({ metadata }),
      visibleConversation: () => ({ awaitingSetup: false }),
      seedAutoItems: () => seed(),
      patchMetadata: (/** @type {any} */ patch) => { patches.push(patch); },
    });
    const persistence = /** @type {any} */ (new SessionPersistence(host));
    await persistence._scanAssistantFilesOnce();
    assert(JSON.stringify(patches) === JSON.stringify([{ hasScannedAIFiles: true }]),
      `expected one patch recording the scan, got ${JSON.stringify(patches)}`);

    patches.length = 0;
    seed = () => Promise.reject(new Error('seeding failed'));
    await persistence._scanAssistantFilesOnce();
    assert(patches.length === 0, 'a failed seeding was recorded as a completed scan');
  });

  await run('releasing a conversation cancels its actions through the conversation', async () => {
    const conv = /** @type {any} */ (await createTestConversation(session));
    let cancelled = 0;
    conv.cancelLocalActions = () => { cancelled++; };
    await session.releaseConversation(conv.id);
    assert(cancelled === 1, `expected the conversation to be asked once, got ${cancelled}`);
  });

  await run('a head-of-bar stub whose load failed is destroyed', async () => {
    const id = `conv_ownership_${Math.random().toString(36).slice(2)}`;
    const loader = /** @type {any} */ (workerManager.loader);
    const realLoad = loader.loadExisting;
    let destroyed = 0;
    let deleted = 0;
    const off = session.subscribe((/** @type {any} */ e) => {
      if (e.type === 'conversation:created' && e.data?.id === id) {
        const stub = e.data;
        const realDestroy = stub.destroy.bind(stub);
        stub.destroy = () => { destroyed++; realDestroy(); };
      }
      if (e.type === 'conversation:deleted' && e.data?.id === id) deleted++;
    });
    loader.loadExisting = async () => { throw new Error('load failed before it began'); };
    try {
      const result = await session._loadIntoHead(id);
      assert(result === null, 'a failed load returned a conversation');
      assert(!session.conversations.has(id), 'the failed stub is still in the bar');
      assert(deleted === 1, `expected the removal to be announced once, got ${deleted}`);
      assert(destroyed === 1, `the failed stub was dropped without destroy() (${destroyed}×)`);
    } finally {
      loader.loadExisting = realLoad;
      off();
      session.registry.forget?.(id, 'test');
    }
  });

  await run('building a conversation leaves the name cache to the session', async () => {
    /** @type {Map<string, string>} */
    const names = new Map();
    let writes = 0;
    const host = /** @type {any} */ ({
      getConversationName: (/** @type {string} */ key) => names.get(key),
      setConversationName: (/** @type {string} */ key, /** @type {string} */ value) => { writes++; names.set(key, value); },
    });
    const conv = new Conversation('conv-name-owner', host, /** @type {any} */ ({}), { skipBuiltInContextItems: true });
    try {
      assert(writes === 0, 'the Conversation constructor wrote the session\'s name cache');
    } finally {
      conv.destroy();
    }

    const built = session.buildConversation('conv-built-name', 'Built Name', session.getServices(),
      { skipBuiltInContextItems: true, loadState: 'unloaded' });
    try {
      assert(built instanceof Conversation, 'buildConversation did not build a Conversation');
      assert(session.getConversationName('conv-built-name') === 'Built Name',
        `the session did not seed its name cache, got ${JSON.stringify(session.getConversationName('conv-built-name'))}`);
      assert(built.name === 'Built Name', `the built conversation reads its name as ${JSON.stringify(built.name)}`);
    } finally {
      built.destroy();
    }
  });

  await run('a conversation commands its worker through the manager it was built with', async () => {
    /** @type {string[]} */
    const calls = [];
    const fakeManager = /** @type {any} */ ({
      isWorkerReady: () => true,
      canUndo: (/** @type {string} */ id) => { calls.push(`canUndo:${id}`); return true; },
      cancel: (/** @type {string} */ id) => { calls.push(`cancel:${id}`); },
      pause: (/** @type {string} */ id) => { calls.push(`pause:${id}`); },
    });
    const services = { ...session.getServices(), workerManager: fakeManager };
    const conv = /** @type {any} */ (session.buildConversation('conv-injected-wm', '', services,
      { skipBuiltInContextItems: true, loadState: 'unloaded' }));
    try {
      assert(conv.canUndo() === true, 'canUndo did not answer from the injected manager');
      conv.stopProcessing('test');
      assert(calls.includes('canUndo:conv-injected-wm') && calls.includes('cancel:conv-injected-wm'),
        `the injected manager was not the one commanded: ${JSON.stringify(calls)}`);
    } finally {
      conv.destroy();
    }
  });

  return { passed, failed, errors };
}
