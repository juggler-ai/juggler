//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * A load the server refuses.
 *
 * A conversation can stop existing between the moment a client decides to open
 * it and the moment its init reaches the server: another view bins it, a
 * sibling deletes it, the folder goes. The manager then declines to make a
 * worker for that id, and the server answers the init with an error saying so
 * (realtime_loop.go) — sent for no other reason than that a client waiting on a
 * "ready" which is never coming has nothing else to go on.
 *
 * So the client owes that answer a fast failure: the load rejects with the
 * server's own words, the stub goes to `error` where the panel can offer Retry,
 * and the id is left clean enough for that Retry to mean something. The
 * alternative is a minute of silence — WORKER_READY_TIMEOUT_MS — spent on a
 * spinner over a failure that was fully described in the first second.
 *
 * Silence is also what it costs a test run. Every wait in a unit suite rides
 * the suite's 45s deadline, but the worker's ready timeout is a hard 60s that
 * knows nothing about it, so a load that waits it out cannot be reported as
 * itself: the suite is killed first and the run says only that some suite
 * stopped making progress.
 * @module unit-tests/worker-init-declined
 */

import {
  createTestSession,
  createTestConversation,
  assert
} from '../utilities/test-helpers.js';
import workerManager from '../../js/services/worker-manager.js';
import apiService from '../../js/services/api.js';

/**
 * How long a declined load may take to fail.
 *
 * The refusal is already on its way back when the clock starts, so this is
 * patience for one round trip and nothing else — roughly a hundred times what
 * it costs. What the number has to do is sit clear of BOTH the worker's 60s
 * ready timeout and the 45s suite budget: a bound between those two reports the
 * fault as a wedged suite, and a bound above them cannot report it at all.
 */
const DECLINE_BUDGET_MS = 15000;

/**
 * Run a load to whichever of its three outcomes happens: 'loaded' if it claimed
 * success, the Error if it failed, or a rejection of ours if it did neither in
 * time. The load's own rejection is folded into the value so that a failure
 * this test EXPECTS cannot be confused with the stall it is looking for.
 * @param {any} session - Session to load into
 * @param {string} id - Conversation the server no longer has
 * @returns {Promise<'loaded'|Error>} The load's outcome
 */
async function loadOutcome(session, id) {
  /** @type {Promise<'loaded'|Error>} */
  const attempt = workerManager.loader.loadExisting(id, session)
    .then(() => /** @type {'loaded'} */ ('loaded'), (err) => (err instanceof Error ? err : new Error(String(err))));
  /** @type {ReturnType<typeof setTimeout>|undefined} */
  let timer;
  /** @type {Promise<never>} */
  const stalled = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(
      `the load neither loaded nor failed within ${DECLINE_BUDGET_MS}ms — the client is sitting out its own `
      + 'ready timeout over a refusal the server already sent, which is a spinner for a minute in the app '
      + 'and a suite killed at its budget here')), DECLINE_BUDGET_MS);
  });
  try {
    return await Promise.race([attempt, stalled]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Create a conversation, then take it away from under the client: released
 * here, deleted on the server. A later init for that id is one the server's
 * manager will decline.
 * @param {any} session - Session to create in
 * @returns {Promise<string>} The id of a conversation that no longer exists
 */
async function conversationTheServerNoLongerHas(session) {
  const conv = await createTestConversation(session);
  const id = conv.id;
  await session.releaseConversation(id);
  await apiService.deleteConversation(id, { reason: 'worker-init-declined:setup' });
  return id;
}

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests
 * @property {number} failed - Number of failed tests
 * @property {string[]} errors - Error messages for failed tests
 */

/**
 * Run all worker-init-declined tests.
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Test results with pass/fail counts
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  const session = await createTestSession();

  // Test 1: the refusal ends the load, and arrives intact. The server describes
  // the reason in full; a client that answers it with a timeout of its own has
  // thrown that description away and made the user wait for the privilege.
  {
    /** @type {string|null} */
    let gone = null;
    try {
      gone = await conversationTheServerNoLongerHas(session);

      const outcome = await loadOutcome(session, gone);

      assert(outcome !== 'loaded',
        'a load of a conversation the server no longer has reported success — the tab would show an empty conversation as a real one');
      const message = /** @type {Error} */ (outcome).message;
      assert(/no longer has it/.test(message),
        `the load must fail with the server's reason, so the panel can show it; got: ${message}`);

      const stub = session.conversations.get(gone);
      assert(!!stub && stub.loadState === 'error',
        `a refused load must leave its stub in error, which is what puts a Retry in front of the user; loadState=${stub ? stub.loadState : '(no stub)'}`);
      assert(workerManager.workerState(gone) === 'absent',
        'a refused load must leave no worker entry behind — the next attempt would take it as a live worker and never send an init');

      passed++;
    } catch (e) {
      failed++;
      errors.push(`a refused load fails with the server's reason: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (gone) session.conversations.delete(gone);
    }
  }

  // Test 2: and it leaves nothing poisoned. The load is de-duplicated through
  // an in-flight map keyed by id, which is drained by the promise settling —
  // so a load that never settles doesn't just hang its own caller, it hangs
  // every later attempt on that id for the life of the realm. The Retry the
  // first failure offers is the caller that finds out.
  {
    /** @type {string|null} */
    let gone = null;
    try {
      gone = await conversationTheServerNoLongerHas(session);

      const first = await loadOutcome(session, gone);
      assert(first !== 'loaded', 'precondition: the server refuses the first load');
      session.conversations.delete(gone);

      const retry = await loadOutcome(session, gone);
      assert(retry !== 'loaded', 'the retry of a refused load reported success');
      assert(/no longer has it/.test(/** @type {Error} */ (retry).message),
        `the retry must reach the server too, not a leftover promise from the first attempt; got: ${/** @type {Error} */ (retry).message}`);

      passed++;
    } catch (e) {
      failed++;
      errors.push(`a refused load can be retried: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      if (gone) session.conversations.delete(gone);
    }
  }

  return { passed, failed, errors };
}
