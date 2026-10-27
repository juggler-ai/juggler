//     ▄▄ ▄▄ ▄▄  ▄▄▄▄  ▄▄▄▄ ▄▄    ▄▄▄▄▄ ▄▄▄▄
//     ██ ██ ██ ██ ▄▄ ██ ▄▄ ██    ██▄▄  ██▄█▄   Copyright (c) 2026 Julian Storer
//   ▄▄█▀ ▀███▀ ▀███▀ ▀███▀ ██▄▄▄ ██▄▄▄ ██ ██   AGPL-3.0-or-later - see LICENSE

/**
 * The engine's wait for a context item whose sync is still in flight.
 *
 * The engine renders a turn's context, and an item the worker has sent but
 * this realm has not applied yet would be left out of what the model is given.
 * How long to wait for it is answered by the document, not the clock: while
 * syncs keep landing the item may be among them, and once the document has
 * gone quiet it is not coming. A fixed span rendered without the item whenever
 * a slow core took longer than the span to apply the syncs in front of it.
 *
 * Driven on a virtual clock through a fake conversation, so each case says
 * what the wait does at the instant it would give up rather than how fast this
 * core runs a timer.
 * @module unit-tests/context-sync-wait-test
 */

import { assert } from '../utilities/test-helpers.js';
import { waitForSyncedItems } from '../../js/model/session-worker-callbacks.js';

/**
 * @typedef {object} TestResult
 * @property {number} passed - Number of passed tests.
 * @property {number} failed - Number of failed tests.
 * @property {string[]} errors - Error messages for failed tests.
 */

/**
 * A conversation whose document changes on a script, on a clock that moves
 * only when the wait waits.
 * @param {number[]} changesAt - Virtual times the document changes at.
 * @param {number} arrivesAt - Virtual time the awaited item lands (Infinity for never).
 * @returns {{conv: any, now: () => number, present: () => boolean, waited: number[]}} The fake, its clock, the question, and every span the wait asked for.
 */
function scriptedConversation(changesAt, arrivesAt) {
  let clock = 0;
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @type {number[]} */
  const waited = [];
  const present = () => clock >= arrivesAt;
  const conv = {
    flushPendingSyncs() {},
    onDocumentChange(/** @type {() => void} */ listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    // As the real one: it ends when ready() holds or its span runs out, and
    // every change on the way is heard by the document's listeners.
    whenDocument(/** @type {() => boolean} */ ready, /** @type {number} */ ms) {
      waited.push(ms);
      if (ready()) return Promise.resolve(true);
      const end = Math.min(clock + ms, arrivesAt);
      for (const t of changesAt.filter((c) => c > clock && c <= end)) {
        clock = t;
        for (const l of listeners) l();
      }
      clock = end;
      if (clock === arrivesAt) for (const l of listeners) l();
      return Promise.resolve(ready());
    }
  };
  return { conv, now: () => clock, present, waited };
}

/**
 * Run the context-sync-wait cases.
 * @param {object} _ctx - Test context (unused).
 * @returns {Promise<TestResult>} Test results.
 */
export async function runTests(_ctx) {
  let passed = 0;
  let failed = 0;
  /** @type {string[]} */
  const errors = [];
  /**
   * @param {string} name - The case.
   * @param {() => Promise<void>} fn - Its body.
   */
  const run = async (name, fn) => {
    try {
      await fn();
      passed++;
    } catch (e) {
      failed++;
      errors.push(`${name}: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

  await run('an item behind a stream of syncs is waited for past the quiet span', async () => {
    // Syncs every second for six seconds, the item landing at 6.5s: never
    // three quiet seconds in a row, so the item is still coming throughout.
    const { conv, now, present } = scriptedConversation([1000, 2000, 3000, 4000, 5000, 6000], 6500);
    const got = await waitForSyncedItems(conv, present, { quietMs: 3000, ceilingMs: 120_000, now });
    assert(got === true, `the item landed at 6.5s behind syncs that never went quiet, but the wait gave up at ${now()}ms`);
  });

  await run('a document gone quiet ends the wait', async () => {
    const { conv, now, present } = scriptedConversation([1000], Infinity);
    const got = await waitForSyncedItems(conv, present, { quietMs: 3000, ceilingMs: 120_000, now });
    assert(got === false, 'an item that never lands was reported present');
    assert(now() === 4000, `the wait ends 3s after the last change (at 4000ms), not at ${now()}ms`);
  });

  await run('a document that never goes quiet is bounded by the ceiling', async () => {
    const changes = Array.from({ length: 200 }, (_, i) => (i + 1) * 1000);
    const { conv, now, present } = scriptedConversation(changes, Infinity);
    const got = await waitForSyncedItems(conv, present, { quietMs: 3000, ceilingMs: 30_000, now });
    assert(got === false, 'an item that never lands was reported present');
    assert(now() <= 30_000, `the wait ran to ${now()}ms past its 30s ceiling`);
  });

  return { passed, failed, errors };
}
