//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * Selecting an unhydrated tab hydrates it, with or without a load queue.
 *
 * The load queue is built by Session._doLoad from the conversationOrder the
 * server returned, so a session that opened with no conversations has none. It
 * can still acquire unhydrated stubs afterwards — from a restore, or from
 * another viewer's create — and those reach the user as a tab that shows a
 * spinner until something asks for the load. Selecting the tab is that ask, and
 * so is the panel's Retry button; neither may depend on a queue that a given
 * session never built.
 *
 * The queue is cleared explicitly rather than by arranging an empty session:
 * what is under test is the queue-less path, and asserting it needs that state
 * to be certain rather than inherited from whatever the lane's session held.
 *
 * The last test covers the other half of the same stub: it has to be announced
 * when it lands in the map, not when its worker arrives, or the tab is invisible
 * for the whole load and there is nothing to select.
 * @module unit-tests/unloaded-tab-hydration
 */

import {
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';

/**
 * Reduce a live conversation to the state a restore leaves behind: no worker,
 * and a fresh stub in the map carrying only its id and name. This is what
 * Session._loadAndInsertConversation builds, and what the user clicks on.
 * @param {any} session - The session holding it
 * @param {string} id - Conversation to park
 * @param {string} name - Its folder name
 * @param {'unloaded'|'error'} loadState - State to park it in
 * @returns {Promise<any>} The stub now standing in for the conversation
 */
async function parkAsStub(session, id, name, loadState) {
  await session.releaseConversation(id);
  const Conversation = (await import('../../js/model/conversation.js')).default;
  const stub = new Conversation(
    id, name, session, session.getServices(),
    { skipBuiltInContextItems: true, loadState }
  );
  session.conversations.set(id, stub);
  return stub;
}

/**
 * Resolve once `predicate` holds, or reject at the deadline — so a regression
 * fails the test rather than hanging the lane to its budget.
 * @param {() => boolean} predicate - Condition to wait for
 * @param {string} what - Message for the timeout
 * @param {number} [ms] - Patience budget
 * @returns {Promise<void>} Resolves when the predicate holds
 */
async function until(predicate, what, ms = 8000) {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(what);
    await new Promise((r) => { setTimeout(r, 20); });
  }
}

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run all unloaded-tab hydration tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results with pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const session = await createTestSession();

  // Test 1: switching to an 'unloaded' conversation hydrates it even though the
  // session has no load queue. This is the restored tab: a stub in the map, a
  // row in the bar, and a click that has to reach the worker manager.
  {
    /** @type {string[]} */
    const created = [];
    try {
      const live = await createTestConversation(session);
      created.push(live.id);
      const other = await createTestConversation(session);
      created.push(other.id);

      /** @type {any} */ (session)._loadQueue = null;
      const parked = await parkAsStub(session, live.id, live.name, 'unloaded');
      session.switchConversation(other.id);

      const switched = session.switchConversation(parked.id);
      assert(switched === true, 'precondition: the switch itself must succeed');
      await until(() => parked.loadState === 'loaded',
        'selecting an unhydrated tab never loaded it — with no load queue the selection is dropped and the panel spins forever');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`selecting an unhydrated tab hydrates it: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      for (const id of created) await session.deleteConversation(id);
    }
  }

  // Test 2: the panel's Retry button re-attempts a failed load on the same
  // queue-less session. An error card whose only control does nothing is worse
  // than the spinner it replaced.
  {
    /** @type {string[]} */
    const created = [];
    try {
      const live = await createTestConversation(session);
      created.push(live.id);

      /** @type {any} */ (session)._loadQueue = null;
      const failedConv = await parkAsStub(session, live.id, live.name, 'error');

      session.retryConversationLoad(failedConv.id);
      await until(() => failedConv.loadState === 'loaded',
        'Retry did nothing — the button is wired to a queue this session never built');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`Retry re-attempts a failed load: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      for (const id of created) await session.deleteConversation(id);
    }
  }

  // Test 3: the reported flow end to end — bin a conversation, restore it, then
  // click its tab. Every layer is real: the bin cancels the queue entry and
  // tears down the worker, the server moves the folder and lifts its block on
  // the id, and the restore puts back a stub that the selection has to hydrate.
  // The broadcast is applied directly because a unit-test session has no app.js
  // websocket wiring; applyConversationRestored is exactly what that dispatch
  // calls.
  //
  // The conversation is hydrated THROUGH a load queue first, which is the state
  // a session that opened with conversations is in. The queue's memory of the
  // id is what the bin has to clear; without that, the tab restored below is
  // one the queue declines to load again.
  {
    /** @type {string|null} */
    let restoredId = null;
    try {
      const conv = await createTestConversation(session);
      const name = conv.name;
      restoredId = conv.id;
      const other = await createTestConversation(session);

      // Park it first so the queue drives a real load from disk: a conversation
      // this session created still has its original worker, which has no disk
      // metadata to replay.
      await parkAsStub(session, restoredId, name, 'unloaded');

      const workerManager = (await import('../../js/services/worker-manager.js')).default;
      const ConversationLoadQueue =
        (await import('../../js/services/conversation-load-queue.js')).default;
      const queue = new ConversationLoadQueue({ session, workerManager });
      /** @type {any} */ (session)._loadQueue = queue;
      queue.enqueueAll([restoredId]);
      await queue.whenLoaded(restoredId);

      const binned = await session.binConversation(restoredId);
      assert(binned === true, 'precondition: the bin must succeed');
      assert(!session.conversations.has(restoredId), 'precondition: binning drops the conversation');

      await session.bin.restore(restoredId);
      await session.applyConversationRestored(restoredId, name);
      assert(session.conversations.has(restoredId),
        'a restored conversation must be back in the map — its tab is showing');

      // A restored tab can also reach the user unhydrated: a refresh that kept
      // the stub, or a restore whose load has not landed yet. That is the state
      // the click has to resolve, and the only route left is the load queue —
      // which has been carrying its memory of this id since before the bin.
      await parkAsStub(session, restoredId, name, 'unloaded');

      session.switchConversation(other.id);
      session.switchConversation(restoredId);
      await until(() => session.conversations.get(restoredId)?.loadState === 'loaded',
        'the restored conversation never finished loading — this is the tab stuck on the spinner');

      await session.deleteConversation(other.id);
      passed++;
    } catch (e) {
      failed++;
      errors.push(`a restored conversation loads when selected: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (restoredId && session.conversations.has(restoredId)) {
        await session.deleteConversation(restoredId);
      }
    }
  }

  // Test 4: the restored tab is announced the moment its stub is in the map,
  // without waiting for the worker. The bar paints a row for every
  // `session.conversations` entry, but only ever inside a render, and it renders
  // on notifies — so a restore that announces itself only once the load lands
  // leaves the tab strip visibly unchanged for the length of a worker spawn, and
  // forever if the load fails. The user bins something, hits Undo, and nothing
  // happens until an unrelated event (clicking another tab) repaints the bar.
  //
  // The apply is deliberately not awaited: an async function runs to its first
  // await synchronously, and everything before the worker spawn — the stub, its
  // ordering, and the announcement owed for it — belongs on that side of the
  // yield. Asserting before the await is what pins it there.
  {
    /** @type {string|null} */
    let restoredId = null;
    /** @type {Function|null} */
    let unsubscribe = null;
    try {
      const conv = await createTestConversation(session);
      const name = conv.name;
      restoredId = conv.id;

      const binned = await session.binConversation(restoredId);
      assert(binned === true, 'precondition: the bin must succeed');
      assert(!session.conversations.has(restoredId), 'precondition: binning drops the conversation');

      /** @type {string[]} */
      const announced = [];
      unsubscribe = session.subscribe(/** @param {any} event */ (event) => {
        if (event.type === 'conversation:created' && event.data?.id === restoredId) {
          announced.push(session.conversations.get(restoredId)?.loadState);
        }
      });

      await session.bin.restore(restoredId);
      const applied = session.applyConversationRestored(restoredId, name);
      assert(announced.length > 0,
        'a restore put the conversation in the map and told nobody — the tab strip stays unchanged until something unrelated renders it');
      assert(announced[0] !== 'loaded',
        'the announcement waited for the worker: the tab is missing for the whole load');
      await applied;

      passed++;
    } catch (e) {
      failed++;
      errors.push(`a restored conversation reaches the bar before its worker: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (unsubscribe) unsubscribe();
      if (restoredId && session.conversations.has(restoredId)) {
        await session.deleteConversation(restoredId);
      }
    }
  }

  return { passed, failed, errors };
}
