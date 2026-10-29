//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * How a session reaches the server: `session.persistence`, the debounced save
 * of session-level state and the one-at-a-time load.
 *
 * - A burst of `session.save()` calls — the call extensions make — is one PUT.
 * - `saveImmediately` takes a pending debounced save with it rather than
 *   leaving it to fire a second PUT behind it, and `destroy()` cancels one.
 * - Concurrent loads share one manifest read.
 * - The API service is read at call time, so a session whose service is
 *   swapped after construction talks to the new one.
 *
 * Every check that something did NOT happen waits for a marker save, made by
 * another session after the case's last call, to reach the server. A browser
 * runs timers of equal delay in the order they were set, so any debounced save
 * the case left armed has fired — and made its PUT — before the marker's does,
 * however slow the core.
 *
 * Runs against a bare Session with a stub API service — no server, no workers.
 * @module unit-tests/session-persistence-test
 */

import { assert, trackTestSession, waitFor } from '../utilities/test-helpers.js';
import Session from '../../js/model/session.js';
import { isEngine } from '../../sdk/lib/client-role.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed Number of passing assertions.
 * @property {number} failed Number of failing assertions.
 * @property {string[]} errors Collected error messages.
 */

/**
 * A stub API service that records every session PUT.
 * @param {Partial<Record<string, Function>>} [overrides] - Methods to replace
 * @returns {{api: any, puts: any[][]}} The service and the PUTs it received
 */
function recordingApi(overrides = {}) {
  /** @type {any[][]} */
  const puts = [];
  const api = {
    updateSession: async (/** @type {any[]} */ ...args) => { puts.push(args); return { success: true }; },
    getSession: async () => ({ conversationOrder: [], conversationNames: {} }),
    ...overrides
  };
  return { api, puts };
}

/**
 * A bare session over `api`, under the suite-end sweep.
 * @param {any} api - Its API service
 * @returns {any} The session
 */
function bareSession(api) {
  return trackTestSession(new Session(api));
}

/**
 * Wait until every debounced save armed before this call has had its turn.
 *
 * A second session's debounced save is armed now, with the same delay as any
 * the case left behind; timers of equal delay fire in the order they were set,
 * and a debounced save makes its PUT inside its timer's task. So once the
 * marker's PUT has landed, every earlier one that was going to fire has.
 * @returns {Promise<void>}
 */
async function pastEveryPendingSave() {
  const marker = recordingApi();
  bareSession(marker.api).save();
  await waitFor(() => marker.puts.length >= 1, { description: 'the marker session\'s debounced save to reach the server' });
}

/**
 * @param {object} _ctx - Test context (unused)
 * @returns {Promise<TestResult>} Aggregated test results
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];

  /**
   * @param {string} label
   * @param {() => Promise<void>} fn
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

  await run('the session has a persistence, and this realm is a viewer that saves', async () => {
    const { api } = recordingApi();
    const session = bareSession(api);
    assert(session.persistence && typeof session.persistence.load === 'function',
      'session.persistence is missing — the load and the save have nowhere to live');
    // The engine never saves session-level state, so every save case below
    // would pass vacuously there.
    assert(!isEngine(), 'precondition: the unit lane runs as a viewer');
  });

  await run('a burst of saves reaches the server once, carrying the session-level state', async () => {
    const { api, puts } = recordingApi();
    const session = bareSession(api);
    session.metadata = { flag: 1 };
    session.save();
    session.save();
    session.save();
    await pastEveryPendingSave();
    assert(puts.length === 1, `three saves inside one debounce window made ${puts.length} PUTs`);
    const [activeId, history, metadata] = puts[0] ?? [];
    assert(activeId === null, `a session with nothing loaded saves a null active id, got ${JSON.stringify(activeId)}`);
    assert(Array.isArray(history) && metadata?.flag === 1,
      `the PUT carries the history and the metadata, got ${JSON.stringify(puts[0])}`);
  });

  await run('saveImmediately takes a pending debounced save with it', async () => {
    const { api, puts } = recordingApi();
    const session = bareSession(api);
    session.save();
    await session.persistence.saveImmediately();
    assert(puts.length === 1, `saveImmediately made ${puts.length} PUTs, expected 1`);
    await pastEveryPendingSave();
    assert(puts.length === 1, `the debounced save fired as well, behind the immediate one: ${puts.length} PUTs`);
  });

  await run('destroy cancels a pending save', async () => {
    const { api, puts } = recordingApi();
    const session = bareSession(api);
    session.save();
    session.destroy();
    await pastEveryPendingSave();
    assert(puts.length === 0, `a destroyed session still saved: ${puts.length} PUTs`);
  });

  await run('concurrent loads share one manifest read', async () => {
    let reads = 0;
    let release = () => {};
    const gate = new Promise((resolve) => { release = () => resolve(undefined); });
    // Rejecting keeps the load from going on to initialise the page's shared
    // worker manager against a bare session.
    const { api } = recordingApi({
      getSession: async () => {
        reads++;
        await gate;
        throw new Error('no manifest here');
      }
    });
    const session = bareSession(api);
    const first = session.persistence.load().then(() => 'resolved', (/** @type {Error} */ e) => e.message);
    const second = session.persistence.load().then(() => 'resolved', (/** @type {Error} */ e) => e.message);
    await waitFor(() => reads >= 1, { description: 'the first load to read the manifest' });
    release();
    const outcomes = await Promise.all([first, second]);
    assert(reads === 1, `two concurrent loads read the manifest ${reads} times`);
    assert(outcomes.every((o) => o === 'no manifest here'),
      `both loads must settle with the one read's failure, got ${JSON.stringify(outcomes)}`);

    // The lock is released once the load settles, so the next load reads again.
    await session.persistence.load().catch(() => {});
    assert(reads === 2, `a load after the first settled must read the manifest again, read ${reads} times`);
  });

  await run('the API service is read at call time', async () => {
    const before = recordingApi();
    const session = bareSession(before.api);
    const after = recordingApi({
      getSession: async () => ({ conversationOrder: [], conversationNames: {}, metadata: { swapped: true } })
    });
    session._apiService = after.api;

    await session.persistence.saveImmediately();
    assert(before.puts.length === 0 && after.puts.length === 1,
      `the save went to the service the session was built with: before=${before.puts.length}, after=${after.puts.length}`);

    await session.persistence.refreshFromServer();
    assert(session.metadata.swapped === true,
      `the refresh read the service the session was built with, metadata ${JSON.stringify(session.metadata)}`);
  });

  return { passed, failed, errors };
}
