//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * What a session refresh is entitled to change.
 *
 * Session.refreshFromServer rebuilds the conversation map from the manifest,
 * and the rebuild spans several awaits: the GET, then a worker load for every
 * conversation this realm doesn't hold yet. The map is shared, and a restore
 * arriving on the websocket writes its stub into it during exactly that window.
 * A rebuild that assumes it had the map to itself throws that stub away — or
 * tears down the worker loading it — and the tab the user just pulled out of the
 * bin never finishes loading.
 *
 * The race is driven through the session's own apiService rather than by timing:
 * the arrival happens inside the GET, so it lands in the middle of the rebuild
 * every run. The wrapper is per-session; the apiService module is a singleton
 * every lane in the pool shares, and patching that would change a sibling's
 * answers.
 * @module unit-tests/refresh-merge
 */

import {
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';

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
 * Give this session its own apiService whose getSession runs `duringGet` before
 * answering. The wrapper delegates everything else to the real service through
 * the prototype chain.
 * @param {any} session - Session to wrap
 * @param {() => void} duringGet - Runs while the refresh is awaiting the manifest
 * @returns {any} The real apiService, to put back afterwards
 */
function interceptGetSession(session, duringGet) {
  const real = session._apiService;
  const wrapper = Object.create(real);
  wrapper.getSession = async () => {
    duringGet();
    return real.getSession();
  };
  session._apiService = wrapper;
  return real;
}

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run all refresh-merge tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results with pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const session = await createTestSession();
  const Conversation = (await import('../../js/model/conversation.js')).default;

  // Test 1: a conversation inserted while the refresh is in flight survives it.
  // This is the restore: the sync reducer's `restored` claims the head of the bar
  // with an unloaded stub and then awaits a worker spawn, so the stub is in the
  // map for the whole of any refresh that overlaps it.
  {
    const arrivalId = 'refresh-merge-arrival';
    /** @type {any} */
    let realApi = null;
    /** @type {string[]} */
    const created = [];
    try {
      const held = await createTestConversation(session);
      created.push(held.id);

      realApi = interceptGetSession(session, () => {
        const stub = new Conversation(
          arrivalId, 'Arrival', session, session.getServices(),
          { skipBuiltInContextItems: true, loadState: 'unloaded' }
        );
        session.conversations.set(arrivalId, stub);
      });

      await session.refreshFromServer();

      assert(session.conversations.has(arrivalId),
        'a conversation that arrived during the refresh was dropped by it — a restore racing a refresh loses the tab it just brought back');
      assert(session.conversations.has(held.id),
        'the refresh must keep the conversations the server still lists');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`an arrival during a refresh survives it: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (realApi) session._apiService = realApi;
      session.conversations.delete(arrivalId);
      for (const id of created) await session.deleteConversation(id);
    }
  }

  // Test 2: a refresh hydrates an unloaded stub the manifest lists. The stub is
  // a tab showing a spinner; leaving it parked means the refresh saw the
  // conversation, agreed it exists, and left it spinning anyway.
  {
    /** @type {string[]} */
    const created = [];
    try {
      const live = await createTestConversation(session);
      created.push(live.id);
      const name = live.name;

      await session.releaseConversation(live.id);
      const stub = new Conversation(
        live.id, name, session, session.getServices(),
        { skipBuiltInContextItems: true, loadState: 'unloaded' }
      );
      session.conversations.set(live.id, stub);

      await session.refreshFromServer();
      await until(() => session.conversations.get(live.id)?.loadState === 'loaded',
        'the refresh left an unloaded stub parked — it listed the conversation and hydrated nothing');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`a refresh hydrates an unloaded stub: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      for (const id of created) await session.deleteConversation(id);
    }
  }

  return { passed, failed, errors };
}
